import { useSyncExternalStore } from 'react';
import type { SurfaceTarget } from '../session/terminalSession';
import type { ReadingPosition } from '../session/readingPosition';

type Storage = { getItem(key: string): Promise<string | null>; setItem(key: string, value: string): Promise<void> };
export type RecentTerminal = SurfaceTarget & { title: string; workspaceTitle: string; windowId: string | null; at: number };
export type ComputerMemory = {
  lastTarget: SurfaceTarget | null;
  windowId: string | null;
  recent: readonly RecentTerminal[];
  pinned: readonly string[];
  reading: Readonly<Record<string, ReadingPosition>>;
  source: { sourceId: string; threadId: string | null } | null;
  lastView?: 'terminal' | 'source';
};
export type SessionMemoryState = { loaded: boolean; computers: Readonly<Record<string, ComputerMemory>>; error: string | null };
const EMPTY: ComputerMemory = { lastTarget: null, windowId: null, recent: [], pinned: [], reading: {}, source: null };
const KEY = 'panecast.session-memory.v1';
export const surfaceMemoryKey = (target: SurfaceTarget): string => JSON.stringify([target.workspaceId, target.surfaceId]);

/** Local navigation metadata. Reading anchors contain hashes, never terminal output. */
export class SessionMemory {
  private state: SessionMemoryState = { loaded: false, computers: {}, error: null };
  private listeners = new Set<() => void>();
  private loading: Promise<void> | null = null;
  private writes = Promise.resolve();
  constructor(private storage: Storage) {}
  getState = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  computer(id: string): ComputerMemory { return this.state.computers[id] ?? EMPTY; }
  load(): Promise<void> {
    return this.loading ??= (async () => {
      try { this.set({ loaded: true, computers: parseSessionMemory(await this.storage.getItem(KEY)), error: null }); }
      catch { this.set({ ...this.state, loaded: true, error: '无法读取上次使用记录' }); }
    })();
  }
  visit(id: string, entry: Omit<RecentTerminal, 'at'>, refreshTime = true): void {
    if (!this.state.loaded) return;
    const previous = this.computer(id);
    const key = surfaceMemoryKey(entry);
    const old = previous.recent.find((e) => surfaceMemoryKey(e) === key);
    if (!refreshTime && old && previous.lastTarget && surfaceMemoryKey(previous.lastTarget) === key && old.title === entry.title && old.workspaceTitle === entry.workspaceTitle && old.windowId === entry.windowId) return;
    const recent = [{ ...entry, at: refreshTime ? Date.now() : old?.at ?? Date.now() }, ...previous.recent.filter((e) => surfaceMemoryKey(e) !== key)].slice(0, 30);
    const retained = new Set(recent.map(surfaceMemoryKey));
    this.update(id, { ...previous, ...(refreshTime ? { lastView: 'terminal' as const } : {}), lastTarget: { workspaceId: entry.workspaceId, surfaceId: entry.surfaceId }, recent, reading: Object.fromEntries(Object.entries(previous.reading).filter(([k]) => retained.has(k))) });
  }
  rememberWindow(id: string, windowId: string): void {
    const previous = this.computer(id);
    if (previous.windowId !== windowId) this.update(id, { ...previous, windowId });
  }
  pin(id: string, workspaceId: string): void {
    const previous = this.computer(id);
    this.update(id, { ...previous, pinned: previous.pinned.includes(workspaceId) ? previous.pinned.filter((w) => w !== workspaceId) : [...previous.pinned, workspaceId] });
  }
  rememberReading(id: string, target: SurfaceTarget, position: ReadingPosition | null): void {
    const previous = this.computer(id), key = surfaceMemoryKey(target), reading = { ...previous.reading };
    if (!position && !reading[key]) return;
    if (position) reading[key] = position; else delete reading[key];
    this.update(id, { ...previous, reading });
  }
  rememberSource(id: string, source: ComputerMemory['source']): void {
    const previous = this.computer(id);
    if (previous.source?.sourceId === source?.sourceId && previous.source?.threadId === source?.threadId && (!source || previous.lastView === 'source')) return;
    this.update(id, { ...previous, source, ...(source ? { lastView: 'source' as const } : {}) });
  }
  forgetTarget(id: string, target: SurfaceTarget): void {
    const previous = this.computer(id), key = surfaceMemoryKey(target), reading = { ...previous.reading };
    delete reading[key];
    this.update(id, { ...previous, lastTarget: previous.lastTarget && surfaceMemoryKey(previous.lastTarget) === key ? null : previous.lastTarget, recent: previous.recent.filter((e) => surfaceMemoryKey(e) !== key), reading });
  }
  forgetComputer(id: string): void {
    const computers = { ...this.state.computers }; delete computers[id]; this.persist(computers);
  }
  settle(): Promise<void> { return this.writes; }
  private update(id: string, value: ComputerMemory) { this.persist({ ...this.state.computers, [id]: value }); }
  private persist(computers: SessionMemoryState['computers']) {
    if (!this.state.loaded) return;
    this.set({ ...this.state, computers, error: null });
    this.writes = this.writes.then(async () => {
      if (this.state.computers !== computers) return;
      try { await this.storage.setItem(KEY, JSON.stringify({ version: 1, computers })); }
      catch { this.set({ ...this.state, error: '使用记录暂存在内存中，未能保存到本机' }); }
    });
  }
  private set(state: SessionMemoryState) { this.state = state; for (const listener of this.listeners) listener(); }
}

export function parseSessionMemory(raw: string | null): Record<string, ComputerMemory> {
  if (!raw) return {};
  let value: unknown; try { value = JSON.parse(raw); } catch { return {}; }
  if (!object(value) || value.version !== 1 || !object(value.computers)) return {};
  const result: Record<string, ComputerMemory> = {};
  for (const [id, data] of Object.entries(value.computers)) {
    if (!object(data)) continue;
    const recent: RecentTerminal[] = [];
    const seen = new Set<string>();
    if (Array.isArray(data.recent)) for (const item of data.recent) {
      if (!target(item) || !object(item) || seen.has(surfaceMemoryKey(item))) continue;
      const fields = item as unknown as Record<string, unknown>;
      seen.add(surfaceMemoryKey(item));
      recent.push({ workspaceId: item.workspaceId, surfaceId: item.surfaceId, title: typeof fields.title === 'string' ? fields.title.slice(0, 200) : '终端', workspaceTitle: typeof fields.workspaceTitle === 'string' ? fields.workspaceTitle.slice(0, 200) : '工作区', windowId: typeof fields.windowId === 'string' ? fields.windowId : null, at: typeof fields.at === 'number' && Number.isFinite(fields.at) ? fields.at : 0 });
      if (recent.length >= 30) break;
    }
    const reading: Record<string, ReadingPosition> = {};
    if (object(data.reading)) for (const [key, p] of Object.entries(data.reading)) {
      if (!seen.has(key) || !object(p) || typeof p.anchor !== 'string' || !/^[a-f0-9]{64}$/.test(p.anchor)) continue;
      if (typeof p.rowFromBottom !== 'number' || !Number.isInteger(p.rowFromBottom) || p.rowFromBottom < 0 || p.rowFromBottom > 50_000) continue;
      reading[key] = { anchor: p.anchor, rowFromBottom: p.rowFromBottom, segmentFromBottom: typeof p.segmentFromBottom === 'number' ? Math.max(0, Math.min(10_000, Math.floor(p.segmentFromBottom))) : 0, horizontalColumns: typeof p.horizontalColumns === 'number' ? Math.max(0, Math.min(10_000, p.horizontalColumns)) : 0 };
    }
    result[id] = { lastTarget: target(data.lastTarget) ? { workspaceId: data.lastTarget.workspaceId, surfaceId: data.lastTarget.surfaceId } : null,
      ...(data.lastView === 'source' || data.lastView === 'terminal' ? { lastView: data.lastView } : {}),
      windowId: typeof data.windowId === 'string' ? data.windowId : null, recent,
      pinned: Array.isArray(data.pinned) ? [...new Set(data.pinned.filter((x): x is string => typeof x === 'string'))].slice(0, 100) : [], reading,
      source: object(data.source) && typeof data.source.sourceId === 'string' ? { sourceId: data.source.sourceId, threadId: typeof data.source.threadId === 'string' ? data.source.threadId : null } : null };
  }
  return result;
}
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function target(value: unknown): value is SurfaceTarget { return object(value) && typeof value.workspaceId === 'string' && Boolean(value.workspaceId) && typeof value.surfaceId === 'string' && Boolean(value.surfaceId); }
function storage(): Storage {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('@react-native-async-storage/async-storage').default as Storage;
}
export const sessionMemory = new SessionMemory({ getItem: (key) => storage().getItem(key), setItem: (key, value) => storage().setItem(key, value) });
export function useSessionMemory(id: string): ComputerMemory {
  useSyncExternalStore(sessionMemory.subscribe, sessionMemory.getState, sessionMemory.getState);
  return sessionMemory.computer(id);
}
