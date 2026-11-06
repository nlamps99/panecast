import type { ConnectionStatus } from '../../protocol/connection';
import { RpcCallError } from '../../protocol/connection';
import type { PushFrame } from '../../protocol/frames';
import { ConversationCache, type ConversationStorage } from '../conversationCache';
import { SourceStore, type AgentTurn, type SourceInfo } from '../sourceStore';
import type { RpcChannel } from '../terminalSession';

const source: SourceInfo = { id: 'codex', name: 'Codex', type: 'codex', access: 'control', enabled: true, status: 'online', mode: 'attach', capabilities: { read: true, control: true, realtime: true, create: true } };
const turn = (i: number): AgentTurn => ({ id: `turn-${i}`, status: 'completed', items: [{ id: `answer-${i}`, type: 'agentMessage', text: `reply ${i}` }] });
class Channel implements RpcChannel {
  isOpen = true;
  history = Array.from({ length: 30 }, (_, i) => turn(i));
  requests: { method: string; params: Record<string, unknown> }[] = [];
  pushes = new Set<(frame: PushFrame) => void>();
  statuses = new Set<(status: ConnectionStatus) => void>();
  handler: (method: string, params: Record<string, unknown>) => unknown = (method, p) => this.respond(method, p);
  respond(method: string, p: Record<string, unknown>) {
    if (method === 'source.list') return { sources: [source] };
    if (method === 'agent.threads') return { threads: [{ id: 'thread', name: 'Task', cwd: '/project' }], next_cursor: null };
    if (method === 'agent.pending') return { requests: [] };
    if (method === 'agent.read') {
      const end = p.cursor ? Number(p.cursor) : this.history.length, start = Math.max(0, end - Number(p.limit ?? 5));
      return { thread: { id: p.thread_id, name: 'Task', cwd: '/project', live: true, status: { type: 'idle' } }, turns: this.history.slice(start, end), next_cursor: start ? String(start) : null, active_turn_id: null };
    }
    return {};
  }
  async call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> { this.requests.push({ method, params }); return await this.handler(method, params) as T; }
  onPush(listener: (frame: PushFrame) => void) { this.pushes.add(listener); return () => this.pushes.delete(listener); }
  onStatus(listener: (status: ConnectionStatus) => void) { this.statuses.add(listener); return () => this.statuses.delete(listener); }
  event(name: string, payload: object) { for (const fn of this.pushes) fn({ type: 'event', category: 'agent', name, payload: { source_id: 'codex', threadId: 'thread', ...payload } }); }
}
function disk() {
  const files = new Map<string, string>();
  return { read: async (key: string) => files.get(key) ?? null, write: async (key: string, value: string) => { files.set(key, value); },
    remove: async (key: string) => { files.delete(key); }, clear: async () => { files.clear(); } } satisfies ConversationStorage;
}
const tick = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
async function open(channel: Channel, cache?: ConversationCache) {
  const store = new SourceStore(channel, { cache });
  await store.ready; await store.refresh(); await store.selectSource('codex'); await store.openThread('thread'); await tick(); return store;
}

it('shows the complete cached window immediately while latest messages refresh in the background', async () => {
  const cache = new ConversationCache(disk()), channel = new Channel(), store = await open(channel, cache);
  await store.loadOlder(); await tick();
  const cursorsBefore = channel.requests.filter((r) => r.method === 'agent.read' && r.params.cursor).length;
  await store.selectSource('codex');
  let finish!: (value: unknown) => void;
  channel.handler = (method, p) => method === 'agent.read' && !p.cursor ? new Promise((resolve) => { finish = resolve; }) : channel.respond(method, p);
  await store.openThread('thread');
  expect(store.getState()).toMatchObject({ fromCache: true, threadVerified: false });
  expect(store.getState().turns).toHaveLength(20);
  expect(await store.action('agent.send', { text: 'must wait for live confirmation' })).toBe(false);
  const reading = store.readThread();
  finish(channel.respond('agent.read', { thread_id: 'thread', limit: 10 })); await reading; await tick();
  expect(store.getState()).toMatchObject({ fromCache: false, threadVerified: true });
  expect(store.getState().turns).toHaveLength(20);
  expect(channel.requests.filter((r) => r.method === 'agent.read' && r.params.cursor)).toHaveLength(cursorsBefore);
  store.dispose(); await cache.flush();
});

it('restores disk history after a new process and reads a prepared page without any connection', async () => {
  const io = disk(), firstCache = new ConversationCache(io), first = await open(new Channel(), firstCache);
  await first.loadOlder(); await tick(); first.dispose(); await firstCache.flush();
  const channel = new Channel(); channel.isOpen = false;
  const cache = new ConversationCache(io), store = new SourceStore(channel, { cache });
  await store.ready; await store.selectSource('codex'); await store.openThread('thread');
  expect(store.getState().sources[0].status).toBe('offline');
  expect(store.getState().turns).toHaveLength(20);
  await store.loadOlder();
  expect(store.getState().turns).toHaveLength(30);
  expect(store.getState()).toMatchObject({ historyCursor: null, threadVerified: false, activeTurnId: null, requests: [] });
  expect(channel.requests).toEqual([]);
  store.dispose(); await cache.flush();
  expect((await new ConversationCache(io).get('codex', 'thread'))?.turns).toHaveLength(30);
});

it('shares the prefetch request with scrolling and does not refetch approvals for older history', async () => {
  const channel = new Channel();
  let finish!: (value: unknown) => void;
  channel.handler = (method, p) => method === 'agent.read' && p.cursor === '20' ? new Promise((resolve) => { finish = resolve; }) : channel.respond(method, p);
  const store = await open(channel);
  const a = store.loadOlder(), b = store.loadOlder(); expect(a).toBe(b);
  channel.event('item/agentMessage/delta', { turnId: 'turn-29', itemId: 'live', delta: 'latest streamed text' });
  finish(channel.respond('agent.read', { thread_id: 'thread', cursor: '20', limit: 10 }));
  await a; await tick();
  expect(store.getState().turns).toHaveLength(20);
  expect(store.getState().turns.at(-1)?.items.some((i) => i.text === 'latest streamed text')).toBe(true);
  expect(channel.requests.filter((r) => r.method === 'agent.read' && r.params.cursor === '20')).toHaveLength(1);
  expect(channel.requests.filter((r) => r.method === 'agent.pending')).toHaveLength(1);
  store.dispose();
});

it('reconciles a gap since the last visit without losing cached older pages or changing order', async () => {
  const cache = new ConversationCache(disk()), firstChannel = new Channel(), first = await open(firstChannel, cache);
  await first.loadOlder(); await first.loadOlder(); first.dispose(); await cache.flush();
  const channel = new Channel(); channel.history = Array.from({ length: 50 }, (_, i) => turn(i));
  const store = await open(channel, cache);
  if (!store.getState().threadVerified) await store.readThread();
  expect(store.getState().turns.map((t) => t.id)).toEqual(Array.from({ length: 50 }, (_, i) => `turn-${i}`));
  expect(store.getState().historyCursor).toBeNull();
  expect(channel.requests.filter((r) => r.method === 'agent.read').map((r) => r.params.cursor ?? 'head')).toEqual(['head', '40', '30']);
  store.dispose(); await cache.flush();
});

it('coalesces head reads and preserves a new streamed turn missing from a stale history response', async () => {
  const channel = new Channel(), store = await open(channel);
  let finish!: (value: unknown) => void;
  channel.handler = (method, p) => method === 'agent.read' && !p.cursor ? new Promise((resolve) => { finish = resolve; }) : channel.respond(method, p);
  const a = store.readThread(), b = store.readThread(); expect(a).toBe(b);
  channel.event('turn/started', { turn: { id: 'turn-30', status: 'inProgress', items: [] } });
  channel.event('item/agentMessage/delta', { turnId: 'turn-30', itemId: 'reply-30', delta: 'must survive' });
  finish(channel.respond('agent.read', { thread_id: 'thread', limit: 10 })); await a;
  expect(store.getState().turns.at(-1)).toMatchObject({ id: 'turn-30', items: [expect.objectContaining({ text: 'must survive' })] });
  expect(store.getState().activeTurnId).toBe('turn-30'); store.dispose();
});

it('keeps current content available when prefetch fails and retries on demand', async () => {
  const channel = new Channel(); let fail = true;
  channel.handler = (method, p) => {
    if (method === 'agent.read' && p.cursor && fail) throw new Error('history temporarily unavailable');
    return channel.respond(method, p);
  };
  const store = await open(channel);
  expect(store.getState().error).toBeNull();
  await store.loadOlder(); expect(store.getState().historyError).toContain('unavailable'); expect(store.getState().turns).toHaveLength(10);
  fail = false; await store.loadOlder(); expect(store.getState().historyError).toBeNull(); expect(store.getState().turns).toHaveLength(20); store.dispose();
});

it('recovers an expired pagination cursor without clearing the visible transcript', async () => {
  const channel = new Channel(); let expired = true;
  channel.handler = (method, p) => {
    if (method === 'agent.read' && p.cursor === '20' && expired) { expired = false; throw new RpcCallError('cursor_expired', 'old snapshot'); }
    return channel.respond(method, p);
  };
  const store = await open(channel); await tick(); await store.loadOlder();
  expect(store.getState().turns.map((t) => t.id)).toEqual(Array.from({ length: 20 }, (_, i) => `turn-${10 + i}`));
  expect(store.getState().historyError).toBeNull(); store.dispose();
});

it('ignores a late prefetched page after selecting another conversation', async () => {
  const channel = new Channel(); let finish!: (value: unknown) => void;
  channel.handler = (method, p) => method === 'agent.read' && p.cursor === '20' ? new Promise((resolve) => { finish = resolve; }) : channel.respond(method, p);
  const store = await open(channel), loading = store.loadOlder();
  await store.selectSource(null);
  finish(channel.respond('agent.read', { thread_id: 'thread', cursor: '20', limit: 10 })); await loading;
  expect(store.getState()).toMatchObject({ sourceId: null, thread: null, turns: [] }); store.dispose();
});

it('does not reread conversation history on every completed tool call', async () => {
  jest.useFakeTimers();
  const channel = new Channel(), store = await open(channel);
  try {
    const before = channel.requests.filter((r) => r.method === 'agent.read' && !r.params.cursor).length;
    for (let i = 0; i < 20; i++) channel.event('item/completed', { turnId: 'turn-29', item: { id: `cmd-${i}`, type: 'commandExecution', command: 'read file', status: 'completed' } });
    jest.advanceTimersByTime(1000); await tick();
    expect(channel.requests.filter((r) => r.method === 'agent.read' && !r.params.cursor)).toHaveLength(before);
  } finally { store.dispose(); jest.useRealTimers(); }
});

it('clears revoked disk history even when source verification beats a slow cache index read', async () => {
  const io = disk(), firstCache = new ConversationCache(io), first = await open(new Channel(), firstCache);
  first.dispose(); await firstCache.flush();
  let finish!: () => void;
  const delayed = { ...io, read: (key: string) => key === 'index.json' ? new Promise<string | null>((resolve) => { finish = () => { void io.read(key).then(resolve); }; }) : io.read(key) };
  const cache = new ConversationCache(delayed), channel = new Channel();
  channel.handler = (method, p) => method === 'source.list' ? { sources: [{ ...source, enabled: false, status: 'revoked' }] } : channel.respond(method, p);
  const store = new SourceStore(channel, { cache }), refreshing = store.refresh();
  await tick(); finish(); await refreshing; await tick(); await cache.flush();
  expect(await cache.get('codex', 'thread')).toBeNull();
  expect(await new ConversationCache(io).get('codex', 'thread')).toBeNull(); store.dispose(); await cache.flush();
});

it('finishes local hydration after the network disconnects and does not lose a buffered new message', async () => {
  const io = disk(), firstCache = new ConversationCache(io), first = await open(new Channel(), firstCache);
  first.dispose(); await firstCache.flush();
  let finish!: () => void;
  const delayed = { ...io, read: (key: string) => key === 'index.json' ? io.read(key) : new Promise<string | null>((resolve) => { finish = () => { void io.read(key).then(resolve); }; }) };
  const cache = new ConversationCache(delayed), channel = new Channel(), store = new SourceStore(channel, { cache });
  await store.ready; await store.refresh(); await store.selectSource('codex');
  const opening = store.openThread('thread'); await tick();
  const readsBefore = channel.requests.filter((r) => r.method === 'agent.read').length;
  await store.readThread();
  expect(channel.requests.filter((r) => r.method === 'agent.read')).toHaveLength(readsBefore);
  channel.event('turn/started', { turn: { id: 'turn-30', status: 'inProgress', items: [] } });
  channel.event('item/agentMessage/delta', { turnId: 'turn-30', itemId: 'new-answer', delta: 'arrived while loading the file' });
  channel.isOpen = false;
  for (const fn of channel.statuses) fn({ state: 'idle' });
  finish(); await opening;
  expect(store.getState().fromCache).toBe(true);
  expect(store.getState().turns).toHaveLength(11);
  expect(store.getState().turns.at(-1)?.items[0].text).toBe('arrived while loading the file');
  expect(store.getState().threadVerified).toBe(false); store.dispose(); await cache.flush();
});
