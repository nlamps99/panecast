import { SnapshotCache } from '../snapshotCache';
import { TerminalRepository, parseTerminalHead, terminalKey } from '../terminalRepository';
import { TerminalConversationStore } from '../terminalConversation';
import { TerminalSession, type RpcChannel } from '../terminalSession';
import type { PushFrame } from '../../protocol/frames';
import type { ConnectionStatus } from '../../protocol/connection';

const a = { workspaceId: 'project', surfaceId: 'a' }, b = { ...a, surfaceId: 'b' }, c = { ...a, surfaceId: 'c' };
const snapshot = (id: string, revision = 'one') => ({ available: true, conversation_id: id, generation: 'file', revision, active: false,
  items: [{ id: `${id}:${revision}`, type: 'agentMessage', text: `${id} cached answer`, sequence: 1, phase: 'final' }], next_cursor: 'older', head_sequence: 2 });
const storage = () => {
  const data = new Map<string, string>();
  return { data, read: jest.fn(async (key: string) => data.get(key) ?? null), write: jest.fn(async (key: string, value: string) => { data.set(key, value); }),
    remove: async (key: string) => { data.delete(key); }, clear: async () => { data.clear(); } };
};
class Channel implements RpcChannel {
  isOpen = true;
  pushes = new Set<(frame: PushFrame) => void>();
  statuses = new Set<(status: ConnectionStatus) => void>();
  read = jest.fn(async (method: string, params: Record<string, unknown>): Promise<unknown> => method === 'terminal.conversation' ? snapshot(String(params.surface_id)) : {});
  async call<T>(method: string, params: Record<string, unknown> = {}) { return await this.read(method, params) as T; }
  onPush(listener: (frame: PushFrame) => void) { this.pushes.add(listener); return () => { this.pushes.delete(listener); }; }
  onStatus(listener: (status: ConnectionStatus) => void) { this.statuses.add(listener); return () => { this.statuses.delete(listener); }; }
  push(frame: PushFrame) { for (const listener of this.pushes) listener(frame); }
}
const tick = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
let channel: Channel, disk: ReturnType<typeof storage>, cache: SnapshotCache<Record<string, unknown>>, repository: TerminalRepository;
beforeEach(() => { jest.useFakeTimers({ now: 100_000 }); channel = new Channel(); disk = storage(); cache = new SnapshotCache(disk, parseTerminalHead); repository = new TerminalRepository(channel, cache); });
afterEach(async () => { repository.dispose(); await cache.flush(); jest.useRealTimers(); });

it('shares the foreground and activity read and keeps its head available immediately and after relaunch', async () => {
  repository.setViewing(a);
  await Promise.all([repository.readHead(a), repository.readHead(a, true)]);
  expect(channel.read.mock.calls.filter(([method]) => method === 'terminal.conversation')).toHaveLength(1);
  expect(repository.peek(a)?.conversation_id).toBe('a');
  await cache.flush();
  const reopened = new SnapshotCache(disk, parseTerminalHead);
  expect((await reopened.get(terminalKey(a)))?.items).toEqual(expect.arrayContaining([expect.objectContaining({ text: 'a cached answer' })]));
  await reopened.clear();
});

it('lets the selected conversation pass queued background reads instead of waiting for every terminal', async () => {
  let finish!: (value: unknown) => void;
  channel.read.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const first = repository.readHead(a);
  const queued = repository.readHead(b).catch(() => null);
  repository.setViewing(c);
  const selected = repository.readHead(c, true);
  finish(snapshot('a')); await first; await selected;
  expect(channel.read.mock.calls.map(([, params]) => params.surface_id)).toEqual(['a', 'c']);
  repository.dispose(); await queued;
});

it('discards a superseded click before sending its queued read', async () => {
  let finish!: (value: unknown) => void;
  channel.read.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const first = repository.readHead(a);
  repository.setViewing(b); const abandoned = repository.readHead(b, true).catch(() => null);
  repository.setViewing(c); const selected = repository.readHead(c, true);
  finish(snapshot('a')); await Promise.all([first, abandoned, selected]);
  expect(channel.read.mock.calls.map(([, params]) => params.surface_id)).toEqual(['a', 'c']);
});

it('shows cached conversation content while a slow fresh read is pending and replaces a changed binding', async () => {
  cache.set(terminalKey(a), snapshot('previous'));
  let finish!: (value: unknown) => void;
  channel.read.mockImplementation(async (method) => method === 'terminal.conversation' ? new Promise(resolve => { finish = resolve; }) : {});
  const terminal = new TerminalSession(channel); terminal.setTarget(a);
  const conversation = new TerminalConversationStore(channel, terminal, repository);
  conversation.start(); await tick();
  expect(conversation.getState()).toMatchObject({ fromCache: true, loading: false, items: [expect.objectContaining({ text: 'previous cached answer' })] });
  finish(snapshot('replacement')); await conversation.refresh();
  expect(conversation.getState()).toMatchObject({ fromCache: false, conversationId: 'replacement', items: [expect.objectContaining({ text: 'replacement cached answer' })] });
  conversation.dispose(); terminal.dispose();
});

it('returns to the previous terminal screen immediately and waits for a new full frame before applying diffs', () => {
  const terminal = new TerminalSession(channel);
  const full = (surfaceId: string, text: string, rev: number): PushFrame => ({ type: 'screen.full', surfaceId, rev, rows: [text], cols: 80, rowsCount: 1, cursor: { x: 0, y: 0 } });
  terminal.setTarget(a); channel.push(full('a', 'old A', 99));
  terminal.setTarget(b); channel.push(full('b', 'B', 2));
  terminal.setTarget(a);
  expect(terminal.getState()).toMatchObject({ fromCache: true, screen: { rows: ['old A'], rev: 0 } });
  channel.push({ type: 'screen.diff', surfaceId: 'a', rev: 100, ops: [{ op: 'row', y: 0, text: 'stale diff' }] });
  expect(terminal.getState().screen.rows).toEqual(['old A']);
  channel.push(full('a', 'fresh A', 1));
  expect(terminal.getState()).toMatchObject({ fromCache: false, screen: { rows: ['fresh A'], rev: 1 } });
  terminal.dispose();
});

it('does not overwrite a fresh snapshot with a late disk read and enforces whole-entry eviction', async () => {
  cache.set('a', snapshot('old')); await cache.flush();
  const reader = new SnapshotCache(disk, parseTerminalHead, { entries: 2, bytes: 100_000 }); await reader.ready;
  let finish!: (value: string | null) => void;
  disk.read.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const pending = reader.get('a'); await tick();
  reader.set('a', snapshot('fresh')); finish(JSON.stringify(snapshot('old')));
  expect((await pending)?.conversation_id).toBe('fresh');
  await jest.advanceTimersByTimeAsync(1); reader.set('b', snapshot('b'));
  await jest.advanceTimersByTimeAsync(1); reader.set('c', snapshot('c'));
  await reader.flush();
  const restarted = new SnapshotCache(disk, parseTerminalHead, { entries: 2, bytes: 100_000 });
  expect(await restarted.get('a')).toBeNull(); expect((await restarted.get('c'))?.conversation_id).toBe('c');
  await reader.clear(); await restarted.clear();
});

describe('batched head reads', () => {
  it('reads many terminals in one request, caches each head and reports per-terminal failures', async () => {
    channel.read.mockImplementation(async (method: string, params: Record<string, unknown>) => method === 'terminal.conversation.batch'
      ? { results: (params.requests as { surface_id: string }[]).map((request) => request.surface_id === 'c'
        ? { ok: false, error: { code: 'invalid_target', message: 'gone' } } : { ok: true, result: snapshot(request.surface_id) }) }
      : {});
    const seen: string[] = []; repository.watch((target) => seen.push(target.surfaceId));
    const heads = await repository.readHeads([a, b, c]);
    expect(channel.read.mock.calls.map(([method]) => method)).toEqual(['terminal.conversation.batch']);
    expect(channel.read.mock.calls[0][1]).toEqual({ requests: [a, b, c].map((t) => ({ workspace_id: t.workspaceId, surface_id: t.surfaceId, limit: 80 })) });
    expect(heads?.get(terminalKey(a))).toMatchObject({ conversation_id: 'a' });
    expect(heads?.get(terminalKey(c))).toMatchObject({ code: 'invalid_target' });
    expect(seen).toEqual(['a', 'b']);
    expect(repository.peek(b)).toMatchObject({ conversation_id: 'b' });
  });

  it('gives up on the batch for this connection when the gateway predates it', async () => {
    const { RpcCallError } = jest.requireActual('../../protocol/connection');
    channel.read.mockImplementation(async (method: string) => { if (method === 'terminal.conversation.batch') throw new RpcCallError('method_not_found', '统一网关不支持这个操作'); return {}; });
    expect(await repository.readHeads([a, b])).toBeNull();
    jest.advanceTimersByTime(2_000);
    expect(await repository.readHeads([a, b])).toBeNull();
    expect(channel.read.mock.calls.filter(([method]) => method === 'terminal.conversation.batch')).toHaveLength(1);
  });
});
