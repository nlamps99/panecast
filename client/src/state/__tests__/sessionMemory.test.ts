import { SessionMemory, parseSessionMemory, surfaceMemoryKey } from '../sessionMemory';
const target = { workspaceId: 'w', surfaceId: 's' };
function fixture() {
  const data = new Map<string, string>();
  const storage = { getItem: async (key: string) => data.get(key) ?? null, setItem: async (key: string, value: string) => { data.set(key, value); } };
  return { data, storage, memory: new SessionMemory(storage) };
}
it('restores separate computers, recency, window, pins and hashed reading anchors after relaunch', async () => {
  const { memory, storage, data } = fixture(); await memory.load();
  memory.visit('a', { ...target, title: '编译', workspaceTitle: '项目', windowId: 'window1' });
  memory.pin('a', 'w'); memory.rememberWindow('a', 'window1');
  const reading = { anchor: 'a'.repeat(64), rowFromBottom: 123, segmentFromBottom: 1, horizontalColumns: 12 };
  memory.rememberReading('a', target, reading);
  memory.visit('b', { workspaceId: 'wb', surfaceId: 'sb', title: '服务器', workspaceTitle: '远程', windowId: null });
  memory.rememberSource('b', { sourceId: 'codex', threadId: 'thread1' });
  await memory.settle();
  const restored = new SessionMemory(storage); await restored.load();
  expect(restored.computer('a')).toMatchObject({ lastTarget: target, windowId: 'window1', pinned: ['w'], reading: { [surfaceMemoryKey(target)]: reading } });
  expect(restored.computer('b').lastTarget).toEqual({ workspaceId: 'wb', surfaceId: 'sb' });
  expect(restored.computer('b').source).toEqual({ sourceId: 'codex', threadId: 'thread1' });
  expect([...data.values()].join('')).not.toContain('screen.rows');
});
it('removes stale closed terminals and a removed computer without touching other computers', async () => {
  const { memory } = fixture(); await memory.load();
  for (const id of ['a', 'b']) memory.visit(id, { ...target, title: 'title', workspaceTitle: 'work', windowId: null });
  memory.forgetTarget('a', target);
  expect(memory.computer('a').lastTarget).toBeNull(); expect(memory.computer('a').recent).toEqual([]);
  expect(memory.computer('b').lastTarget).toEqual(target);
  memory.forgetComputer('a'); await memory.settle();
  expect(Object.keys(memory.getState().computers)).toEqual(['b']);
});
it('bounds recent terminals and removes anchors for evicted entries', async () => {
  const { memory } = fixture(); await memory.load();
  for (let i = 0; i < 40; i++) memory.visit('a', { workspaceId: 'w', surfaceId: String(i), title: String(i), workspaceTitle: 'w', windowId: null });
  expect(memory.computer('a').recent).toHaveLength(30);
  expect(memory.computer('a').recent[0].surfaceId).toBe('39');
  memory.visit('a', { workspaceId: 'w', surfaceId: '35', title: 'renamed', workspaceTitle: 'w', windowId: null });
  expect(memory.computer('a').recent).toHaveLength(30);
  expect(memory.computer('a').recent[0].title).toBe('renamed');
});
it('rejects malformed persisted state instead of reusing arbitrary data as an anchor', () => {
  expect(parseSessionMemory('broken')).toEqual({});
  const parsed = parseSessionMemory(JSON.stringify({ version: 1, computers: { a: { recent: [{ ...target }], reading: { [surfaceMemoryKey(target)]: { anchor: 'sensitive output', rowFromBottom: 0 } }, lastTarget: { workspaceId: 'w' } } } }));
  expect(parsed.a.lastTarget).toBeNull(); expect(parsed.a.reading).toEqual({});
});
