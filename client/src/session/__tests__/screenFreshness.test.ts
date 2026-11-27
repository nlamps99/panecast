import type { ConnectionStatus } from '../../protocol/connection';
import type { PushFrame } from '../../protocol/frames';
import type { ScreenState } from '../../protocol/screen';
import { SnapshotCache } from '../snapshotCache';
import { parseTerminalScreen } from '../terminalRepository';
import { TerminalSession, type RpcChannel } from '../terminalSession';

class Channel implements RpcChannel {
  isOpen = true;
  private push = new Set<(frame: PushFrame) => void>();
  private statuses = new Set<(status: ConnectionStatus) => void>();
  async call<T>(): Promise<T> { return {} as T; }
  onPush(listener: (frame: PushFrame) => void) { this.push.add(listener); return () => { this.push.delete(listener); }; }
  onStatus(listener: (status: ConnectionStatus) => void) { this.statuses.add(listener); return () => { this.statuses.delete(listener); }; }
  frame(frame: PushFrame) { for (const listener of this.push) listener(frame); }
  status(status: ConnectionStatus) { this.isOpen = status.state === 'open'; for (const listener of this.statuses) listener(status); }
}

function storage() {
  const files = new Map<string, string>();
  return { files, read: async (key: string) => files.get(key) ?? null, write: async (key: string, value: string) => { files.set(key, value); },
    remove: async (key: string) => { files.delete(key); }, clear: async () => { files.clear(); } };
}

const one = { workspaceId: 'w', surfaceId: 's1' }, two = { workspaceId: 'w', surfaceId: 's2' };
const full = (surfaceId: string, rows: string[]): PushFrame => ({ type: 'screen.full', surfaceId, rev: 1, rows, cols: 80, rowsCount: rows.length, cursor: { x: 0, y: 0 } });
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

beforeEach(() => jest.useFakeTimers({ now: 1_000_000 }));
afterEach(() => jest.useRealTimers());

it('dates the screen by its last frame, then by the moment the connection dropped', async () => {
  const channel = new Channel(), disk = storage();
  const cache = new SnapshotCache<ScreenState>(disk, parseTerminalScreen);
  const session = new TerminalSession(channel, { screenCache: cache });
  session.setTarget(one);
  await flush();
  expect(session.getState().screenAt).toBeNull();
  channel.frame(full('s1', ['$ make']));
  expect(session.getState().screenAt).toBe(1_000_000);
  jest.setSystemTime(1_060_000);
  channel.status({ state: 'waiting', attempt: 1, retryAt: 0, reason: 'network' });
  expect(session.getState()).toMatchObject({ subscription: 'none', screenAt: 1_060_000 });
  expect(cache.savedAt(JSON.stringify(['w', 's1']))).toBe(1_060_000);
  session.dispose();
});

it('a cached screen carries the time it was saved, across a relaunch', async () => {
  const channel = new Channel(), disk = storage();
  let cache = new SnapshotCache<ScreenState>(disk, parseTerminalScreen);
  let session = new TerminalSession(channel, { screenCache: cache });
  session.setTarget(one);
  await flush();
  channel.frame(full('s1', ['first']));
  jest.setSystemTime(1_100_000);
  session.setTarget(two);
  await flush();
  // Back to the first terminal, from memory: it was live until it was left.
  session.setTarget(one);
  expect(session.getState()).toMatchObject({ fromCache: true, screenAt: 1_100_000 });
  await cache.flush();
  session.dispose();

  cache = new SnapshotCache<ScreenState>(disk, parseTerminalScreen);
  await cache.ready;
  channel.status({ state: 'waiting', attempt: 1, retryAt: 0, reason: 'network' });
  session = new TerminalSession(channel, { screenCache: cache });
  session.setTarget(one);
  await flush();
  expect(session.getState()).toMatchObject({ fromCache: true, screen: { rows: ['first'] }, screenAt: 1_100_000 });
  session.dispose();
});
