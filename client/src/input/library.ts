import { useSyncExternalStore } from 'react';

type Storage = { getItem(key: string): Promise<string | null>; setItem(key: string, value: string): Promise<void>; removeItem(key: string): Promise<void> };
export type InputEntry = { id: string; title: string; text: string; workspaceId: string | null; favorite: boolean; at: number };
export type LibraryState = { loaded: boolean; drafts: Readonly<Record<string, string>>; entries: readonly InputEntry[]; error: string | null };
export const MAX_INPUT_TEXT = 64_000;
const MAX_TEXT = MAX_INPUT_TEXT;
const libraries = new Map<string, InputLibrary>();

export function draftKey(workspaceId: string, surfaceId: string): string { return JSON.stringify([workspaceId, surfaceId]); }

/** One local library per computer. Writes are ordered, so an older draft cannot replace a newer one. */
export class InputLibrary {
  private state: LibraryState = { loaded: false, drafts: {}, entries: [], error: null };
  private listeners = new Set<() => void>();
  private loading: Promise<void> | null = null;
  private writing = Promise.resolve();
  private removed = false;
  constructor(private key: string, private storage: Storage) {}
  getState = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };

  load(): Promise<void> {
    return this.loading ??= this.read();
  }
  private async read(): Promise<void> {
    try {
      const raw = await this.storage.getItem(this.key);
      const value: unknown = raw ? JSON.parse(raw) : {};
      if (this.removed) return;
      const data = parseLibrary(value);
      this.set({ ...data, loaded: true, error: null });
    } catch {
      if (!this.removed) this.set({ ...this.state, loaded: true, error: '没能读取本机的输入记录' });
    }
  }
  setDraft(key: string, text: string): void {
    if (!this.state.loaded || this.removed || this.state.drafts[key] === text) return;
    if (text.length > MAX_TEXT) {
      this.set({ ...this.state, error: `草稿最多 ${MAX_TEXT.toLocaleString()} 个字符，请缩短后保存；之前保存的草稿仍在` });
      return;
    }
    const drafts = { ...this.state.drafts };
    if (text) drafts[key] = text.slice(0, MAX_TEXT); else delete drafts[key];
    this.save({ drafts });
  }
  remember(text: string, workspaceId: string): void {
    if (!text.trim()) return;
    const old = this.state.entries.find((e) => e.text === text && e.workspaceId === workspaceId);
    this.put({ id: old?.id ?? makeId(), title: old?.title ?? '', text, workspaceId, favorite: old?.favorite ?? false, at: Date.now() });
  }
  put(entry: InputEntry): boolean {
    if (!this.state.loaded || !entry.text.trim() || this.removed) return false;
    if (entry.favorite && !this.state.entries.some((e) => e.id === entry.id && e.favorite) && this.state.entries.filter((e) => e.favorite).length >= 100) {
      this.set({ ...this.state, error: '最多保存 100 条收藏，请先删除或取消收藏一条' });
      return false;
    }
    const entries = [ { ...entry, title: entry.title.slice(0, 80), text: entry.text.slice(0, MAX_TEXT) }, ...this.state.entries.filter((e) => e.id !== entry.id) ];
    let recent = 0;
    this.save({ entries: entries.filter((e) => e.favorite || recent++ < 60) });
    return true;
  }
  favorite(id: string): void {
    if (this.state.entries.some((e) => e.id === id && !e.favorite) && this.state.entries.filter((e) => e.favorite).length >= 100) {
      this.set({ ...this.state, error: '最多保存 100 条收藏，请先取消收藏一条' });
      return;
    }
    this.save({ entries: this.state.entries.map((e) => e.id === id ? { ...e, favorite: !e.favorite } : e) });
  }
  remove(id: string): void { this.save({ entries: this.state.entries.filter((e) => e.id !== id) }); }
  clearRecent(): void { this.save({ entries: this.state.entries.filter((e) => e.favorite) }); }
  async forget(): Promise<void> {
    this.removed = true;
    await this.writing;
    await this.storage.removeItem(this.key);
  }
  async settle(): Promise<void> { await this.writing; }
  private save(patch: Partial<LibraryState>): void {
    if (!this.state.loaded || this.removed) return;
    this.set({ ...this.state, ...patch, error: null });
    const snapshot = this.state;
    this.writing = this.writing.then(async () => {
      if (this.removed || snapshot.drafts !== this.state.drafts || snapshot.entries !== this.state.entries) return;
      try { await this.storage.setItem(this.key, JSON.stringify({ version: 1, drafts: snapshot.drafts, entries: snapshot.entries })); }
      catch { this.set({ ...this.state, error: '输入暂存在内存中，未能保存到本机' }); }
    });
  }
  private set(state: LibraryState) { this.state = state; for (const listener of this.listeners) listener(); }
}

export function parseLibrary(value: unknown): Pick<LibraryState, 'drafts' | 'entries'> {
  const drafts: Record<string, string> = {};
  const entries: InputEntry[] = [];
  if (!value || typeof value !== 'object') return { drafts, entries };
  const v = value as Record<string, unknown>;
  if (v.version !== 1) return { drafts, entries };
  if (v.drafts && typeof v.drafts === 'object') {
    for (const [key, text] of Object.entries(v.drafts)) if (typeof text === 'string' && key.startsWith('[')) drafts[key] = text.slice(0, MAX_TEXT);
  }
  if (Array.isArray(v.entries)) {
    const ids = new Set<string>();
    for (const e of v.entries.slice(0, 160)) {
      if (!e || typeof e !== 'object' || typeof e.id !== 'string' || ids.has(e.id) || typeof e.text !== 'string' || !e.text.trim()) continue;
      ids.add(e.id);
      entries.push({ id: e.id, title: typeof e.title === 'string' ? e.title.slice(0, 80) : '', text: e.text.slice(0, MAX_TEXT),
        workspaceId: typeof e.workspaceId === 'string' ? e.workspaceId : null, favorite: e.favorite === true,
        at: typeof e.at === 'number' && Number.isFinite(e.at) ? e.at : 0 });
    }
  }
  return { drafts, entries };
}

export function makeId(): string { return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`; }
export function inputLibrary(computerId: string): InputLibrary {
  let library = libraries.get(computerId);
  if (!library) {
    // Lazy import keeps pure session and storage tests independent of native modules.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const storage = require('@react-native-async-storage/async-storage').default as Storage;
    library = new InputLibrary(`panecast.inputs.v1.${computerId}`, storage);
    libraries.set(computerId, library);
  }
  return library;
}
export async function forgetInputs(computerId: string): Promise<void> {
  await inputLibrary(computerId).forget();
  libraries.delete(computerId);
}
export function useInputLibrary(library: InputLibrary): LibraryState {
  return useSyncExternalStore(library.subscribe, library.getState, library.getState);
}
