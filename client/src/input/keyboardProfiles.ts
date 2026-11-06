import { useEffect, useSyncExternalStore } from 'react';

import { ctrl, Keys, withModifiers, type Key, type KeyAction } from '../protocol/keys';

export type Shortcut = { id: string; label: string; a11y: string; key: Key; repeat?: boolean; word?: boolean; accent?: boolean };
const shortcut = (id: string, label: string, a11y: string, key: Key, options: Partial<Shortcut> = {}): Shortcut => ({ id, label, a11y, key, ...options });
export const SHORTCUTS: readonly Shortcut[] = [
  shortcut('escape', 'esc', 'Esc', Keys.escape),
  shortcut('ctrl-c', '^C', 'Ctrl C', Keys.ctrlC),
  shortcut('ctrl-up', '^↑', 'Ctrl 上箭头', ctrl(Keys.up)),
  shortcut('tab', 'tab', 'Tab', Keys.tab),
  shortcut('shift-tab', '⇧tab', 'Shift Tab', withModifiers(Keys.tab, ['shift']), { word: true }),
  shortcut('left', '←', '左', Keys.left, { repeat: true }),
  shortcut('up', '↑', '上', Keys.up, { repeat: true }),
  shortcut('down', '↓', '下', Keys.down, { repeat: true }),
  shortcut('right', '→', '右', Keys.right, { repeat: true }),
  shortcut('enter', '↵', '回车', Keys.enter, { accent: true }),
  ...['a', 'b', 'd', 'e', 'k', 'l', 'r', 'u', 'w', 'z'].map((letter) => shortcut(`ctrl-${letter}`, `^${letter.toUpperCase()}`, `Ctrl ${letter.toUpperCase()}`, ctrl(letter))),
  shortcut('ctrl-left', '^←', 'Ctrl 左', ctrl(Keys.left), { repeat: true }),
  shortcut('ctrl-right', '^→', 'Ctrl 右', ctrl(Keys.right), { repeat: true }),
  shortcut('ctrl-down', '^↓', 'Ctrl 下', ctrl(Keys.down)),
  shortcut('alt-left', '⌥←', 'Alt 左', withModifiers(Keys.left, ['alt']), { repeat: true }),
  shortcut('alt-right', '⌥→', 'Alt 右', withModifiers(Keys.right, ['alt']), { repeat: true }),
  shortcut('home', 'Home', '行首', Keys.home, { word: true }),
  shortcut('end', 'End', '行尾', Keys.end, { word: true }),
  shortcut('pgup', 'PgUp', '上一页', Keys.pageUp, { repeat: true, word: true }),
  shortcut('pgdn', 'PgDn', '下一页', Keys.pageDown, { repeat: true, word: true }),
  shortcut('backspace', '⌫', '退格', Keys.backspace, { repeat: true }),
  shortcut('delete', 'Del', '删除', Keys.delete, { word: true }),
  ...Array.from({ length: 12 }, (_, i) => shortcut(`f${i + 1}`, `F${i + 1}`, `F${i + 1}`, { name: `f${i + 1}` }, { word: true })),
];
const catalog = new Map(SHORTCUTS.map((item) => [item.id, item]));
export const MAX_PROFILE_KEYS = 16;
export const MAX_PROFILES = 15;
export type KeyboardProfile = { id: string; name: string; keys: readonly string[] };
export type KeyboardProfileState = {
  loaded: boolean;
  profiles: readonly KeyboardProfile[];
  defaults: Readonly<Record<string, string>>;
  projects: Readonly<Record<string, string>>;
  error: string | null;
};
export const DEFAULT_KEYBOARD_PROFILES: readonly KeyboardProfile[] = [
  { id: 'default', name: '通用', keys: ['escape', 'ctrl-c', 'ctrl-up', 'tab', 'left', 'up', 'down', 'right', 'enter'] },
  { id: 'agent', name: 'AI 任务', keys: ['escape', 'ctrl-c', 'ctrl-up', 'shift-tab', 'tab', 'up', 'down', 'enter'] },
  { id: 'tmux', name: 'tmux', keys: ['ctrl-b', 'ctrl-c', 'ctrl-up', 'escape', 'left', 'up', 'down', 'right', 'enter'] },
];
const builtin = new Set(DEFAULT_KEYBOARD_PROFILES.map((profile) => profile.id));
const STORAGE_KEY = 'panecast.keyboard-profiles.v1';
type Storage = { getItem(key: string): Promise<string | null>; setItem(key: string, value: string): Promise<void> };

export function projectKeyboardKey(computerId: string, workspaceId: string): string { return JSON.stringify([computerId, workspaceId]); }
export function shortcutsFor(profile: KeyboardProfile): Shortcut[] { return profile.keys.flatMap((id) => catalog.has(id) ? [catalog.get(id)!] : []); }
export function shortcutAction(shortcut: Shortcut, withCtrl: boolean): KeyAction {
  return { kind: 'key', key: withCtrl ? withModifiers(shortcut.key, ['ctrl']) : shortcut.key };
}
export function selectedKeyboardProfile(state: KeyboardProfileState, computerId: string, workspaceId?: string | null): KeyboardProfile {
  const id = (workspaceId ? state.projects[projectKeyboardKey(computerId, workspaceId)] : undefined) ?? state.defaults[computerId] ?? 'default';
  return state.profiles.find((profile) => profile.id === id) ?? state.profiles.find((profile) => profile.id === 'default') ?? DEFAULT_KEYBOARD_PROFILES[0];
}
function validKeys(value: unknown): string[] {
  const keys = Array.isArray(value) ? [...new Set(value.filter((id): id is string => typeof id === 'string' && catalog.has(id)))].slice(0, MAX_PROFILE_KEYS) : [];
  if (!keys.includes('ctrl-up')) { if (keys.length === MAX_PROFILE_KEYS) keys.pop(); keys.splice(Math.min(2, keys.length), 0, 'ctrl-up'); }
  return keys;
}
export function parseKeyboardProfiles(value: unknown): Omit<KeyboardProfileState, 'loaded' | 'error'> {
  const empty = { profiles: [...DEFAULT_KEYBOARD_PROFILES], defaults: {}, projects: {} };
  if (!value || typeof value !== 'object' || (value as { version?: unknown }).version !== 1) return empty;
  const input = value as Record<string, unknown>;
  const parsed = new Map<string, KeyboardProfile>();
  if (Array.isArray(input.profiles)) {
    for (const value of input.profiles.slice(0, MAX_PROFILES)) {
      if (!value || typeof value !== 'object' || typeof value.id !== 'string' || !/^[a-z0-9_-]{1,80}$/i.test(value.id) || parsed.has(value.id)) continue;
      if (!builtin.has(value.id) && [...parsed.keys()].filter((id) => !builtin.has(id)).length >= MAX_PROFILES - DEFAULT_KEYBOARD_PROFILES.length) continue;
      parsed.set(value.id, { id: value.id, name: typeof value.name === 'string' && value.name.trim() ? value.name.trim().slice(0, 32) : '自定义', keys: validKeys(value.keys) });
    }
  }
  for (const profile of DEFAULT_KEYBOARD_PROFILES) if (!parsed.has(profile.id)) parsed.set(profile.id, profile);
  const validAssignments = (value: unknown) => !value || typeof value !== 'object' || Array.isArray(value) ? {} : Object.fromEntries(Object.entries(value).filter(([key, id]) => key.length <= 600 && typeof id === 'string' && parsed.has(id)).slice(0, 500));
  return { profiles: [...parsed.values()], defaults: validAssignments(input.defaults), projects: validAssignments(input.projects) };
}

/** Ordered persistence keeps a fast reorder followed by a profile switch across restarts. */
export class KeyboardProfileStore {
  private state: KeyboardProfileState = { loaded: false, profiles: [...DEFAULT_KEYBOARD_PROFILES], defaults: {}, projects: {}, error: null };
  private listeners = new Set<() => void>();
  private loading: Promise<void> | null = null;
  private writing = Promise.resolve();
  constructor(private storage: Storage) {}
  getState = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  load(): Promise<void> { return this.loading ??= this.read(); }
  private async read() {
    try {
      const raw = await this.storage.getItem(STORAGE_KEY);
      this.update({ ...parseKeyboardProfiles(raw ? JSON.parse(raw) : null), loaded: true, error: null });
    } catch { this.update({ ...this.state, loaded: true, error: '没能读取快捷键配置，暂时使用默认配置' }); }
  }
  select(computerId: string, workspaceId: string | null, profileId: string | null): void {
    if (!this.state.loaded || (profileId !== null && !this.state.profiles.some((p) => p.id === profileId))) return;
    if (workspaceId) {
      const projects = { ...this.state.projects }, key = projectKeyboardKey(computerId, workspaceId);
      if (profileId) projects[key] = profileId; else delete projects[key];
      this.save({ projects });
    } else this.save({ defaults: { ...this.state.defaults, [computerId]: profileId ?? 'default' } });
  }
  create(from: KeyboardProfile): string | null {
    if (!this.state.loaded) return null;
    if (this.state.profiles.length >= MAX_PROFILES) { this.update({ ...this.state, error: '最多保存 15 个配置，请先删除一个自定义配置' }); return null; }
    const id = `custom-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    this.save({ profiles: [...this.state.profiles, { id, name: `${from.name} 副本`.slice(0, 32), keys: [...from.keys] }] });
    return id;
  }
  rename(id: string, name: string): void {
    if (!name.trim()) return;
    this.edit(id, (profile) => ({ ...profile, name: name.trim().slice(0, 32) }));
  }
  move(id: string, key: string, direction: -1 | 1): void {
    this.edit(id, (profile) => {
      const keys = [...profile.keys], index = keys.indexOf(key), next = index + direction;
      if (index < 0 || next < 0 || next >= keys.length) return profile;
      [keys[index], keys[next]] = [keys[next], keys[index]];
      return { ...profile, keys };
    });
  }
  removeKey(id: string, key: string): void {
    if (key !== 'ctrl-up') this.edit(id, (profile) => ({ ...profile, keys: profile.keys.filter((item) => item !== key) }));
  }
  addKey(id: string, key: string): void {
    if (!catalog.has(key)) return;
    const profile = this.state.profiles.find((p) => p.id === id);
    if (profile && profile.keys.length >= MAX_PROFILE_KEYS) { this.update({ ...this.state, error: `每个配置最多 ${MAX_PROFILE_KEYS} 个按键` }); return; }
    this.edit(id, (profile) => profile.keys.includes(key) ? profile : { ...profile, keys: [...profile.keys, key] });
  }
  reset(id: string): void { const initial = DEFAULT_KEYBOARD_PROFILES.find((profile) => profile.id === id); if (initial) this.edit(id, () => initial); }
  canRemove(id: string): boolean { return !builtin.has(id); }
  remove(id: string): void {
    if (!this.state.loaded || !this.canRemove(id)) return;
    this.save({ profiles: this.state.profiles.filter((profile) => profile.id !== id), defaults: Object.fromEntries(Object.entries(this.state.defaults).filter(([, profile]) => profile !== id)), projects: Object.fromEntries(Object.entries(this.state.projects).filter(([, profile]) => profile !== id)) });
  }
  forgetComputer(computerId: string): void {
    if (!this.state.loaded) { void this.load().then(() => this.forgetComputer(computerId)); return; }
    const { [computerId]: _old, ...defaults } = this.state.defaults;
    const projects = Object.fromEntries(Object.entries(this.state.projects).filter(([key]) => {
      try { return JSON.parse(key)[0] !== computerId; } catch { return false; }
    }));
    this.save({ defaults, projects });
  }
  async settle(): Promise<void> { await this.writing; }
  private edit(id: string, action: (profile: KeyboardProfile) => KeyboardProfile) {
    if (!this.state.loaded) return;
    this.save({ profiles: this.state.profiles.map((profile) => profile.id === id ? action(profile) : profile) });
  }
  private save(patch: Partial<KeyboardProfileState>) {
    this.update({ ...this.state, ...patch, error: null });
    const snapshot = this.state;
    this.writing = this.writing.then(async () => {
      if (snapshot.profiles !== this.state.profiles || snapshot.defaults !== this.state.defaults || snapshot.projects !== this.state.projects) return;
      try { await this.storage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, profiles: snapshot.profiles, defaults: snapshot.defaults, projects: snapshot.projects })); }
      catch { this.update({ ...this.state, error: '快捷键配置暂存在内存中，未能保存到本机' }); }
    });
  }
  private update(state: KeyboardProfileState) { this.state = state; for (const listener of this.listeners) listener(); }
}
let singleton: KeyboardProfileStore | undefined;
export function keyboardProfiles(): KeyboardProfileStore {
  if (!singleton) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const storage = require('@react-native-async-storage/async-storage').default as Storage;
    singleton = new KeyboardProfileStore(storage);
  }
  return singleton;
}
export function useKeyboardProfiles(): KeyboardProfileState {
  const store = keyboardProfiles();
  const state = useSyncExternalStore(store.subscribe, store.getState, store.getState);
  useEffect(() => { void store.load(); }, [store]);
  return state;
}
