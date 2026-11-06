import { ConversationCache, type ConversationStorage } from '../conversationCache';
import type { AgentTurn } from '../sourceStore';

function storage() {
  const files = new Map<string, string>();
  const io = { read: jest.fn(async (key: string) => files.get(key) ?? null), write: jest.fn(async (key: string, value: string) => { files.set(key, value); }),
    remove: jest.fn(async (key: string) => { files.delete(key); }), clear: jest.fn(async () => { files.clear(); }) } satisfies ConversationStorage;
  return { files, io };
}
const turn = (text: string): AgentTurn => ({ id: 'turn', status: 'completed', items: [{ id: 'answer', type: 'agentMessage', text }] });
const entry = (sourceId = 'source', threadId = 'thread', text = 'cached reply') => ({ sourceId, thread: { id: threadId, name: threadId, cwd: '/project' }, turns: [turn(text)], cursor: 'older' });

it('persists sanitized history and the prepared next page across a fresh cache instance', async () => {
  const { io } = storage(), cache = new ConversationCache(io);
  const value = { ...entry(), requests: [{ id: 'approval' }], activeTurnId: 'untrusted', prepared: { cursor: 'older', turns: [turn('prepared reply')], nextCursor: null } };
  cache.save(value); await cache.flush();
  const again = new ConversationCache(io); await again.ready;
  const cached = await again.get('source', 'thread');
  expect(cached?.turns[0].items[0].text).toBe('cached reply');
  expect(cached?.prepared?.turns[0].items[0].text).toBe('prepared reply');
  expect(cached).not.toHaveProperty('requests'); expect(cached).not.toHaveProperty('activeTurnId');
});

it('coalesces streamed updates and never mixes identical thread IDs from different sources', async () => {
  const { io } = storage(), cache = new ConversationCache(io);
  cache.save(entry('a', 'same', 'partial')); cache.save(entry('a', 'same', 'complete')); cache.save(entry('b', 'same', 'other source'));
  await cache.flush();
  expect(io.write.mock.calls.filter(([key]) => key !== 'index.json')).toHaveLength(2);
  const again = new ConversationCache(io);
  expect((await again.get('a', 'same'))?.turns[0].items[0].text).toBe('complete');
  expect((await again.get('b', 'same'))?.turns[0].items[0].text).toBe('other source');
});

it('evicts a whole older conversation without retaining a cursor over missing turns', async () => {
  const { io } = storage(), cache = new ConversationCache(io, { maxEntries: 1 });
  const clock = jest.spyOn(Date, 'now'); clock.mockReturnValue(1); cache.save(entry('source', 'older'));
  clock.mockReturnValue(2); cache.save(entry('source', 'newer'));
  await cache.flush(); clock.mockRestore();
  const again = new ConversationCache(io); await again.ready;
  expect(again.threads('source').map((thread) => thread.id)).toEqual(['newer']);
  expect(await again.get('source', 'older')).toBeNull();
  expect((await again.get('source', 'newer'))?.cursor).toBe('older');
});

it('does not replace a live update with a late disk read', async () => {
  const { io } = storage(), first = new ConversationCache(io); first.save(entry()); await first.flush();
  const again = new ConversationCache(io); await again.ready;
  const original = io.read.getMockImplementation()!;
  let finish!: (value: string | null) => void;
  io.read.mockImplementation((key) => key === 'index.json' ? original(key) : new Promise((resolve) => { finish = resolve; }));
  const reading = again.get('source', 'thread'); await Promise.resolve();
  again.save(entry('source', 'thread', 'new live reply'));
  finish(JSON.stringify({ version: 1, ...entry() }));
  expect((await reading)?.turns[0].items[0].text).toBe('new live reply'); await again.flush();
});

it('removes revoked content even when a disk write was already in flight', async () => {
  const { files, io } = storage(), cache = new ConversationCache(io); await cache.ready;
  const write = io.write.getMockImplementation()!;
  let finish!: () => void;
  io.write.mockImplementationOnce((key, value) => new Promise((resolve) => { finish = () => { void write(key, value).then(resolve); }; }));
  cache.save(entry()); const writing = cache.flush();
  for (let i = 0; i < 5; i++) await Promise.resolve();
  const forgetting = cache.forgetSource('source');
  expect(cache.peek('source', 'thread')).toBeNull();
  finish(); await writing; await forgetting;
  const again = new ConversationCache(io); await again.ready;
  expect(await again.get('source', 'thread')).toBeNull();
  expect([...files.keys()].filter((key) => key !== 'index.json')).toEqual([]);
});

it('falls back from corrupt files and prevents a cleared cache from being resurrected', async () => {
  const { files, io } = storage(), cache = new ConversationCache(io); cache.save(entry()); await cache.flush();
  for (const key of files.keys()) if (key !== 'index.json') files.set(key, '{corrupt');
  expect(await new ConversationCache(io).get('source', 'thread')).toBeNull();
  await cache.clear(); cache.save(entry()); await cache.flush();
  expect(files.size).toBe(0); expect(cache.peek('source', 'thread')).toBeNull();
});

it('allows newly authorized history to be cached after a source is granted again', async () => {
  const { io } = storage(), cache = new ConversationCache(io);
  cache.save(entry()); await cache.flush(); await cache.forgetSource('source');
  cache.rememberSources([{ id: 'source', name: 'Codex', type: 'codex', access: 'read', enabled: true, status: 'online', mode: 'history', capabilities: { read: true, control: false, create: false, realtime: false } }]);
  cache.save(entry('source', 'thread', 'new authorized reply')); await cache.flush();
  expect((await new ConversationCache(io).get('source', 'thread'))?.turns[0].items[0].text).toBe('new authorized reply');
});
