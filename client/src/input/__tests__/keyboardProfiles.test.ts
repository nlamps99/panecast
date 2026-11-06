import { encodeKey } from '../../protocol/keys';
import { KeyboardProfileStore, MAX_PROFILE_KEYS, parseKeyboardProfiles, projectKeyboardKey, selectedKeyboardProfile, shortcutAction, shortcutsFor } from '../keyboardProfiles';

function fixture() {
  const values = new Map<string, string>();
  const storage = { getItem: async (key: string) => values.get(key) ?? null, setItem: async (key: string, value: string) => { values.set(key, value); } };
  return { storage, store: new KeyboardProfileStore(storage) };
}
it('persists a reordered custom profile and keeps project assignments isolated between computers', async () => {
  const { store, storage } = fixture(); await store.load();
  store.select('mac', null, 'agent');
  const id = store.create(selectedKeyboardProfile(store.getState(), 'mac'))!;
  store.rename(id, '我的工作流'); store.addKey(id, 'ctrl-r'); store.move(id, 'ctrl-r', -1);
  store.select('mac', 'project', id); store.select('linux', 'project', 'tmux');
  await store.settle();
  const restored = new KeyboardProfileStore(storage); await restored.load();
  const saved = selectedKeyboardProfile(restored.getState(), 'mac', 'project');
  expect(saved.name).toBe('我的工作流'); expect(saved.keys.at(-2)).toBe('ctrl-r');
  expect(selectedKeyboardProfile(restored.getState(), 'mac', 'other').id).toBe('agent');
  expect(selectedKeyboardProfile(restored.getState(), 'linux', 'project').id).toBe('tmux');
  restored.select('mac', 'project', null);
  expect(selectedKeyboardProfile(restored.getState(), 'mac', 'project').id).toBe('agent');
});
it('retains Ctrl + Up through edits and maps named presets without losing existing modifiers', async () => {
  const { store } = fixture(); await store.load();
  store.removeKey('agent', 'ctrl-up'); store.removeKey('agent', 'escape');
  const keys = shortcutsFor(selectedKeyboardProfile(store.getState(), 'mac'));
  const up = shortcutAction(keys.find((key) => key.id === 'ctrl-up')!, true);
  expect(up.kind === 'key' && encodeKey(up.key)).toBe('ctrl-up');
  const agent = shortcutsFor(store.getState().profiles.find((profile) => profile.id === 'agent')!);
  expect(agent.some((key) => key.id === 'ctrl-up')).toBe(true);
  const shiftTab = shortcutAction(agent.find((key) => key.id === 'shift-tab')!, false);
  expect(shiftTab.kind === 'key' && encodeKey(shiftTab.key)).toBe('shift-tab');
  const modified = shortcutAction(agent.find((key) => key.id === 'shift-tab')!, true);
  expect(modified.kind === 'key' && encodeKey(modified.key)).toBe('ctrl-shift-tab');
});
it('deleting a custom profile resets its users and forgetting a computer only clears its assignments', async () => {
  const { store } = fixture(); await store.load();
  const id = store.create(store.getState().profiles[0])!;
  store.select('mac', null, id); store.select('mac', 'a', id); store.select('linux', 'a', 'tmux');
  store.remove(id);
  expect(selectedKeyboardProfile(store.getState(), 'mac', 'a').id).toBe('default');
  store.select('mac', 'b', 'agent'); store.forgetComputer('mac');
  expect(store.getState().projects[projectKeyboardKey('mac', 'b')]).toBeUndefined();
  expect(selectedKeyboardProfile(store.getState(), 'linux', 'a').id).toBe('tmux');
});
it('repairs unknown and duplicate persisted keys and caps untrusted records', () => {
  const parsed = parseKeyboardProfiles({ version: 1, profiles: [{ id: 'default', name: 'Saved', keys: ['tab', 'tab', 'unknown', ...Array.from({ length: 12 }, (_, i) => `f${i + 1}`), 'enter', 'escape', 'up'] }], defaults: { mac: 'gone' }, projects: {} });
  const keys = parsed.profiles[0].keys;
  expect(keys.filter((key) => key === 'tab')).toHaveLength(1); expect(keys).not.toContain('unknown');
  expect(keys).toContain('ctrl-up'); expect(keys.length).toBeLessThanOrEqual(MAX_PROFILE_KEYS);
  expect(parsed.defaults).toEqual({});
});
