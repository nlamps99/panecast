import { draftKey, InputLibrary, MAX_INPUT_TEXT, parseLibrary } from '../library';
function fixture() {
  const values = new Map<string, string>();
  const storage = { getItem: async (key: string) => values.get(key) ?? null, setItem: async (key: string, value: string) => { values.set(key, value); }, removeItem: async (key: string) => { values.delete(key); } };
  return { values, storage };
}
it('restores the latest draft independently for each terminal and computer', async () => {
  const { storage } = fixture();
  const first = new InputLibrary('computer-a', storage); await first.load();
  const a = draftKey('workspace', 'a'), b = draftKey('workspace', 'b');
  first.setDraft(a, '草'); first.setDraft(a, '草稿'); first.setDraft(b, '另一个终端');
  await first.settle();
  const restored = new InputLibrary('computer-a', storage); await restored.load();
  expect(restored.getState().drafts).toEqual({ [a]: '草稿', [b]: '另一个终端' });
  const other = new InputLibrary('computer-b', storage); await other.load();
  expect(other.getState().drafts).toEqual({});
  await first.forget(); first.setDraft(a, 'must not resurrect');
  const forgotten = new InputLibrary('computer-a', storage); await forgotten.load();
  expect(forgotten.getState().drafts).toEqual({});
});
it('deduplicates history per project and preserves favorites when clearing history', async () => {
  const library = new InputLibrary('computer', fixture().storage); await library.load();
  library.remember('git status', 'a'); library.remember('git status', 'a'); library.remember('git status', 'b');
  expect(library.getState().entries).toHaveLength(2);
  library.favorite(library.getState().entries[0].id); library.clearRecent();
  expect(library.getState().entries).toHaveLength(1);
  expect(library.getState().entries[0]).toMatchObject({ favorite: true, workspaceId: 'b' });
});
it('drops malformed persisted commands', () => {
  expect(parseLibrary({ version: 1, drafts: { x: 3 }, entries: [null, { id: 'a', text: 2 }] })).toEqual({ drafts: {}, entries: [] });
});
it('keeps the previous saved draft instead of silently truncating an oversized edit', async () => {
  const { storage } = fixture();
  const library = new InputLibrary('computer', storage); await library.load();
  library.setDraft('pane', 'previous'); library.setDraft('pane', 'x'.repeat(MAX_INPUT_TEXT + 1));
  await library.settle();
  expect(library.getState().drafts.pane).toBe('previous');
  expect(library.getState().error).toContain('请缩短');
});
it('never evicts saved favorites when the collection is full', async () => {
  const { storage } = fixture();
  const library = new InputLibrary('full', storage); await library.load();
  for (let i = 0; i < 100; i++) library.put({ id: String(i), title: '', text: `command ${i}`, workspaceId: null, favorite: true, at: i });
  expect(library.put({ id: 'overflow', title: '', text: 'new command', workspaceId: null, favorite: true, at: 101 })).toBe(false);
  await library.settle();
  const restored = new InputLibrary('full', storage); await restored.load();
  expect(restored.getState().entries).toHaveLength(100);
  expect(restored.getState().entries.some((e) => e.id === '0')).toBe(true);
});
