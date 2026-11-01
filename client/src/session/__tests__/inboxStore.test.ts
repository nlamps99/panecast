const mockStorage = new Map<string, string>();

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(async (key: string) => mockStorage.get(key) ?? null),
    setItem: jest.fn(async (key: string, value: string) => {
      mockStorage.set(key, value);
    }),
    removeItem: jest.fn(async (key: string) => {
      mockStorage.delete(key);
    }),
  },
}));

// Imported after the mock.
/* eslint-disable import/first */
import AsyncStorage from '@react-native-async-storage/async-storage';

import type { ConnectionStatus } from '../../protocol/connection';
import type { EventFrame, PushFrame } from '../../protocol/frames';
import {
  forgetInbox,
  inboxStorageKey,
  parseStoredInbox,
  serializeInbox,
  settleInboxWrites,
} from '../inboxPersistence';
import { InboxStore, type InboxItem } from '../inboxStore';
import type { RpcChannel } from '../terminalSession';
/* eslint-enable import/first */

const storage = AsyncStorage as jest.Mocked<typeof AsyncStorage>;

class FakeChannel implements RpcChannel {
  isOpen = true;
  private push = new Set<(frame: PushFrame) => void>();
  async call<T>(): Promise<T> {
    throw new Error('unexpected call');
  }
  onPush(listener: (frame: PushFrame) => void) {
    this.push.add(listener);
    return () => this.push.delete(listener);
  }
  onStatus(_listener: (status: ConnectionStatus) => void) {
    return () => {};
  }
  emit(frame: PushFrame) {
    for (const listener of this.push) listener(frame);
  }
  get listenerCount() {
    return this.push.size;
  }
}

const notification = (id: string, extra: Record<string, unknown> = {}): PushFrame => ({
  type: 'event',
  category: 'notification',
  name: 'notification.created',
  payload: { id, workspace_id: 'w1', title: `title ${id}`, body: `body ${id}`, ...extra },
});

/** A Claude Code prompt without an id: SharedKit derives one from its content. */
const prompt = (workspaceId = 'w1', surfaceId = 's1'): PushFrame => ({
  type: 'event',
  category: 'hook',
  name: 'claude.permission_prompt',
  payload: { workspace_id: workspaceId, surface_id: surfaceId, source: 'Claude Code', message: 'approval required' },
});

const item = (id: string, extra: Partial<InboxItem> = {}): InboxItem => ({
  id,
  workspaceId: 'w1',
  surfaceId: null,
  title: `title ${id}`,
  subtitle: null,
  body: '',
  at: 1_000,
  read: false,
  needsInput: false,
  ...extra,
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** A fresh key per test: the persistence module remembers lists per key for the whole run. */
let keyCounter = 0;
const freshKey = () => inboxStorageKey(`computer-${++keyCounter}`);

const stored = (key: string) => parseStoredInbox(mockStorage.get(key) ?? null);

/** `InboxStore` from a fresh module registry: what the app sees after a relaunch. */
function nextLaunch(): typeof InboxStore {
  let Store!: typeof InboxStore;
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    Store = (require('../inboxStore') as typeof import('../inboxStore')).InboxStore;
  });
  return Store;
}

beforeEach(() => {
  mockStorage.clear();
  jest.clearAllMocks();
});

describe('InboxStore in memory', () => {
  it('keeps its existing behavior without a storage key and never touches storage', async () => {
    const channel = new FakeChannel();
    const inbox = new InboxStore(channel);
    expect(inbox.getState()).toEqual({ items: [], unread: 0, unreadByWorkspace: {}, loaded: true });
    channel.emit(notification('n1'));
    inbox.markAllRead();
    inbox.remove('n1');
    await settleInboxWrites();
    expect(storage.getItem).not.toHaveBeenCalled();
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it('marks needs-input items and counts them like any other', () => {
    const channel = new FakeChannel();
    const inbox = new InboxStore(channel);
    channel.emit(prompt('w2'));
    channel.emit(notification('n1'));
    const [top, second] = inbox.getState().items;
    expect(top).toMatchObject({ id: 'n1', needsInput: false });
    expect(second).toMatchObject({ workspaceId: 'w2', surfaceId: 's1', title: 'Claude Code 需要你回应', needsInput: true });
    expect(inbox.getState().unreadByWorkspace).toEqual({ w1: 1, w2: 1 });
  });

  it('does not pile up a repeated prompt while it is unread, and brings it back once read', () => {
    const channel = new FakeChannel();
    const inbox = new InboxStore(channel);
    const arrived: string[] = [];
    inbox.onNew((i) => arrived.push(i.id));

    channel.emit(prompt());
    channel.emit(prompt());
    expect(inbox.getState().items).toHaveLength(1);
    expect(arrived).toHaveLength(1);
    const promptId = arrived[0];

    channel.emit(notification('n1'));
    inbox.markRead(promptId);
    const now = jest.spyOn(Date, 'now').mockReturnValue(5_000_000);
    channel.emit(prompt());
    now.mockRestore();

    const { items, unread } = inbox.getState();
    expect(items.map((i) => i.id)).toEqual([promptId, 'n1']);
    expect(items[0]).toMatchObject({ read: false, at: 5_000_000 });
    expect(unread).toBe(2);
    expect(arrived).toEqual([promptId, 'n1', promptId]);
  });

  it('ignores a repeated notification id even after it was read', () => {
    const channel = new FakeChannel();
    const inbox = new InboxStore(channel);
    const arrived: string[] = [];
    inbox.onNew((i) => arrived.push(i.id));
    channel.emit(notification('n1'));
    inbox.markRead('n1');
    channel.emit(notification('n1'));
    expect(inbox.getState().items).toHaveLength(1);
    expect(inbox.getState().unread).toBe(0);
    expect(arrived).toEqual(['n1']);
  });

  it('removes one item and clears all', () => {
    const channel = new FakeChannel();
    const inbox = new InboxStore(channel);
    channel.emit(notification('n1'));
    channel.emit(notification('n2', { workspace_id: 'w2' }));
    channel.emit(notification('n3'));
    inbox.remove('n2');
    expect(inbox.getState().items.map((i) => i.id)).toEqual(['n3', 'n1']);
    expect(inbox.getState().unreadByWorkspace).toEqual({ w1: 2 });
    inbox.clear();
    expect(inbox.getState()).toMatchObject({ items: [], unread: 0, unreadByWorkspace: {} });
  });

  it('does not notify subscribers when a change changes nothing', () => {
    const channel = new FakeChannel();
    const inbox = new InboxStore(channel);
    channel.emit(notification('n1'));
    inbox.markRead('n1');
    const listener = jest.fn();
    inbox.subscribe(listener);
    const before = inbox.getState();
    inbox.markRead('n1');
    inbox.markRead('missing');
    inbox.markWorkspaceRead('w1');
    inbox.markAllRead();
    inbox.remove('missing');
    channel.emit(notification('n1'));
    channel.emit({ type: 'event', category: 'workspace', name: 'workspace.renamed', payload: { id: 'w1' } });
    expect(listener).not.toHaveBeenCalled();
    expect(inbox.getState()).toBe(before);
    inbox.clear();
    inbox.clear();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('keeps the newest 200', () => {
    const channel = new FakeChannel();
    const inbox = new InboxStore(channel);
    for (let i = 0; i < 205; i++) channel.emit(notification(`n${i}`));
    const { items } = inbox.getState();
    expect(items).toHaveLength(200);
    expect(items[0].id).toBe('n204');
    expect(items[199].id).toBe('n5');
  });

  it('tells onNew listeners after subscribers have the new state, and stops after dispose', () => {
    const channel = new FakeChannel();
    const inbox = new InboxStore(channel);
    const seen: string[] = [];
    inbox.subscribe(() => seen.push(`state:${inbox.getState().items.length}`));
    const stop = inbox.onNew((i) => seen.push(`new:${i.id}:${inbox.getState().items[0]?.id}`));
    channel.emit(notification('n1'));
    expect(seen).toEqual(['state:1', 'new:n1:n1']);
    stop();
    channel.emit(notification('n2'));
    expect(seen).toEqual(['state:1', 'new:n1:n1', 'state:2']);

    inbox.dispose();
    expect(channel.listenerCount).toBe(0);
    inbox.ingest(notification('n3') as EventFrame);
    inbox.markAllRead();
    inbox.clear();
    expect(inbox.getState().items.map((i) => i.id)).toEqual(['n2', 'n1']);
  });

  it('cuts very long texts', () => {
    const channel = new FakeChannel();
    const inbox = new InboxStore(channel);
    channel.emit(notification('n1', { title: 'T'.repeat(1_000), body: `${'b'.repeat(1_998)}😀😀` }));
    const [only] = inbox.getState().items;
    expect(only.title).toHaveLength(300);
    expect(only.title.endsWith('…')).toBe(true);
    expect(only.body.length).toBeLessThanOrEqual(2_000);
    // No lone surrogate before the ellipsis.
    expect(only.body).toBe(`${'b'.repeat(1_998)}…`);
  });

  it('turns cmux seconds into milliseconds and a missing ts into now', () => {
    const channel = new FakeChannel();
    const inbox = new InboxStore(channel);
    const now = jest.spyOn(Date, 'now').mockReturnValue(9_999);
    channel.emit(notification('s', { ts: 1_700_000_000 }));
    channel.emit(notification('ms', { ts: 1_700_000_000_000 }));
    channel.emit(notification('none'));
    channel.emit(notification('zero', { ts: 0 }));
    now.mockRestore();
    const at = Object.fromEntries(inbox.getState().items.map((i) => [i.id, i.at]));
    expect(at).toEqual({ s: 1_700_000_000_000, ms: 1_700_000_000_000, none: 9_999, zero: 9_999 });
  });
});

describe('InboxStore persistence', () => {
  it('saves items with read state and loads them on the next launch', async () => {
    const key = freshKey();
    const channel = new FakeChannel();
    const first = new InboxStore(channel, { storageKey: key });
    await first.ready;
    channel.emit(notification('n1'));
    channel.emit(prompt());
    first.markRead('n1');
    await settleInboxWrites();
    first.dispose();

    const saved = stored(key);
    expect(saved.map((i) => [i.id.startsWith('needs-input-') ? 'prompt' : i.id, i.read, i.needsInput])).toEqual([
      ['prompt', false, true],
      ['n1', true, false],
    ]);

    // A new launch: nothing in memory, only what storage holds.
    const next = new (nextLaunch())(new FakeChannel(), { storageKey: key });
    expect(next.getState().loaded).toBe(false);
    await next.ready;
    expect(next.getState()).toMatchObject({ loaded: true, unread: 1, unreadByWorkspace: { w1: 1 } });
    expect(next.getState().items).toEqual(saved);
  });

  it('applies events and marks that arrive before the stored inbox is read', async () => {
    const key = freshKey();
    mockStorage.set(key, serializeInbox([item('old-unread'), item('old-read', { read: true }), item('dup', { workspaceId: 'w2' })]));
    const read = deferred<string | null>();
    storage.getItem.mockImplementationOnce(() => read.promise);

    const channel = new FakeChannel();
    const inbox = new InboxStore(channel, { storageKey: key });
    const arrived: string[] = [];
    inbox.onNew((i) => arrived.push(i.id));
    expect(inbox.getState()).toMatchObject({ items: [], loaded: false });

    channel.emit(notification('live-1'));
    channel.emit(notification('dup'));
    inbox.markWorkspaceRead('w1');
    channel.emit(notification('live-2'));
    expect(inbox.getState().items.map((i) => i.id)).toEqual(['live-2', 'dup', 'live-1']);
    expect(inbox.getState().loaded).toBe(false);
    // Nothing is written while the list is partial.
    await Promise.resolve();
    expect(storage.setItem).not.toHaveBeenCalled();

    read.resolve(mockStorage.get(key) ?? null);
    await inbox.ready;

    const { items, unread, loaded } = inbox.getState();
    expect(loaded).toBe(true);
    expect(items.map((i) => [i.id, i.read])).toEqual([
      ['live-2', false],
      ['live-1', true],
      ['old-unread', true],
      ['old-read', true],
      // The stored copy wins over the duplicate that arrived meanwhile.
      ['dup', false],
    ]);
    expect(items.find((i) => i.id === 'dup')?.workspaceId).toBe('w2');
    expect(unread).toBe(2);
    expect(arrived).toEqual(['live-1', 'dup', 'live-2']);

    await settleInboxWrites();
    expect(stored(key)).toEqual(items);
  });

  it('brings back a stored, read prompt that comes again while loading', async () => {
    const key = freshKey();
    const seed = new FakeChannel();
    const first = new InboxStore(seed, { storageKey: key });
    await first.ready;
    seed.emit(prompt());
    seed.emit(notification('n1'));
    first.markAllRead();
    await settleInboxWrites();
    first.dispose();
    const promptId = stored(key)[1].id;

    const channel = new FakeChannel();
    const next = new (nextLaunch())(channel, { storageKey: key });
    channel.emit(prompt());
    await next.ready;
    expect(next.getState().items.map((i) => [i.id, i.read])).toEqual([
      [promptId, false],
      ['n1', true],
    ]);
  });

  it('coalesces a burst of changes into one write of the newest list', async () => {
    const key = freshKey();
    const channel = new FakeChannel();
    const inbox = new InboxStore(channel, { storageKey: key });
    await inbox.ready;
    await settleInboxWrites();
    storage.setItem.mockClear();

    for (let i = 0; i < 5; i++) channel.emit(notification(`n${i}`));
    inbox.markRead('n2');
    await settleInboxWrites();
    expect(storage.setItem).toHaveBeenCalledTimes(1);
    expect(stored(key).map((i) => i.id)).toEqual(['n4', 'n3', 'n2', 'n1', 'n0']);
    expect(stored(key).find((i) => i.id === 'n2')?.read).toBe(true);
  });

  it('writes in order even when a write is slow', async () => {
    const key = freshKey();
    const channel = new FakeChannel();
    const inbox = new InboxStore(channel, { storageKey: key });
    await inbox.ready;
    await settleInboxWrites();

    const slow = deferred<void>();
    storage.setItem.mockImplementationOnce(async (k: string, value: string) => {
      await slow.promise;
      mockStorage.set(k, value);
    });
    channel.emit(notification('first'));
    await Promise.resolve();
    channel.emit(notification('second'));
    slow.resolve();
    await settleInboxWrites();
    expect(stored(key).map((i) => i.id)).toEqual(['second', 'first']);
  });

  it('hands the newest list to the next store for the same computer, even before it is written', async () => {
    const key = freshKey();
    const channel = new FakeChannel();
    const first = new InboxStore(channel, { storageKey: key });
    await first.ready;
    channel.emit(notification('n1'));
    first.dispose();
    storage.getItem.mockClear();

    // Reconnecting creates a new store right away.
    const second = new InboxStore(new FakeChannel(), { storageKey: key });
    expect(second.getState()).toMatchObject({ loaded: true, unread: 1 });
    expect(second.getState().items.map((i) => i.id)).toEqual(['n1']);
    expect(storage.getItem).not.toHaveBeenCalled();
  });

  it('keeps computers apart', async () => {
    const a = freshKey();
    const b = freshKey();
    const channelA = new FakeChannel();
    const channelB = new FakeChannel();
    const inboxA = new InboxStore(channelA, { storageKey: a });
    const inboxB = new InboxStore(channelB, { storageKey: b });
    await Promise.all([inboxA.ready, inboxB.ready]);
    channelA.emit(notification('on-a'));
    channelB.emit(notification('on-b'));
    await settleInboxWrites();
    expect(stored(a).map((i) => i.id)).toEqual(['on-a']);
    expect(stored(b).map((i) => i.id)).toEqual(['on-b']);
  });

  it('stops saving after dispose, also when disposed while loading', async () => {
    const key = freshKey();
    const read = deferred<string | null>();
    storage.getItem.mockImplementationOnce(() => read.promise);
    const channel = new FakeChannel();
    const inbox = new InboxStore(channel, { storageKey: key });
    channel.emit(notification('n1'));
    inbox.dispose();
    read.resolve(null);
    await inbox.ready;
    await settleInboxWrites();
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(inbox.getState().loaded).toBe(false);
  });

  it('forgets a computer’s inbox', async () => {
    const key = freshKey();
    const channel = new FakeChannel();
    const inbox = new InboxStore(channel, { storageKey: key });
    await inbox.ready;
    channel.emit(notification('n1'));
    inbox.dispose();
    await forgetInbox(key);
    expect(mockStorage.has(key)).toBe(false);

    const next = new InboxStore(new FakeChannel(), { storageKey: key });
    await next.ready;
    expect(next.getState()).toMatchObject({ items: [], loaded: true });
  });

  it('starts empty when storage holds garbage or cannot be read', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const garbage = freshKey();
    mockStorage.set(garbage, 'not json');
    const a = new InboxStore(new FakeChannel(), { storageKey: garbage });
    await a.ready;
    expect(a.getState()).toMatchObject({ items: [], loaded: true });

    const failing = freshKey();
    storage.getItem.mockRejectedValueOnce(new Error('disk on fire'));
    const channel = new FakeChannel();
    const b = new InboxStore(channel, { storageKey: failing });
    await b.ready;
    expect(b.getState()).toMatchObject({ items: [], loaded: true });
    channel.emit(notification('n1'));
    expect(b.getState().items).toHaveLength(1);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('keeps working in memory when a write fails', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const key = freshKey();
    const channel = new FakeChannel();
    const inbox = new InboxStore(channel, { storageKey: key });
    await inbox.ready;
    await settleInboxWrites();
    storage.setItem.mockRejectedValueOnce(new Error('quota'));
    channel.emit(notification('n1'));
    await settleInboxWrites();
    expect(warn).toHaveBeenCalled();
    channel.emit(notification('n2'));
    await settleInboxWrites();
    expect(stored(key).map((i) => i.id)).toEqual(['n2', 'n1']);
    warn.mockRestore();
  });
});

describe('stored format', () => {
  it('round-trips and keeps the newest 200', () => {
    const items = Array.from({ length: 210 }, (_, i) => item(`n${i}`, { read: i % 2 === 0, needsInput: i === 3 }));
    const parsed = parseStoredInbox(serializeInbox(items));
    expect(parsed).toHaveLength(200);
    expect(parsed).toEqual(items.slice(0, 200));
  });

  it('drops malformed and repeated entries, and other versions', () => {
    const good = item('good');
    const raw = JSON.stringify({
      version: 1,
      items: [good, { ...good }, { id: 'no-title', body: '', at: 1, read: false }, { ...item('bad-at'), at: 'x' }, 'nope', null, { ...item('ws'), workspaceId: 5 }],
    });
    expect(parseStoredInbox(raw)).toEqual([good]);
    expect(parseStoredInbox(JSON.stringify({ version: 2, items: [good] }))).toEqual([]);
    expect(parseStoredInbox(JSON.stringify([good]))).toEqual([]);
    expect(parseStoredInbox(null)).toEqual([]);
  });

  it('defaults needsInput and nullable fields', () => {
    const { needsInput: _n, subtitle: _s, ...legacy } = item('x');
    expect(parseStoredInbox(JSON.stringify({ version: 1, items: [legacy] }))).toEqual([item('x')]);
  });
});
