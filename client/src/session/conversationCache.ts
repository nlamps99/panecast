import { sha256, toHex, utf8Encode } from '../protocol/sha256';
import { agentThread, agentTurns } from './agentData';
import type { AgentThread, AgentTurn, SourceInfo } from './sourceStore';

export type PreparedHistory = { cursor: string; turns: AgentTurn[]; nextCursor: string | null };
export type CachedConversation = { sourceId: string; thread: AgentThread; turns: AgentTurn[]; cursor: string | null; prepared?: PreparedHistory; at: number };
export type ConversationStorage = {
  read(name: string): Promise<string | null>;
  write(name: string, value: string): Promise<void>;
  remove(name: string): Promise<void>;
  clear(): Promise<void>;
};
type Entry = { key: string; sourceId: string; thread: AgentThread; at: number; bytes: number };
const object = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const cursor = (v: unknown): string | null => typeof v === 'string' && v.length <= 4096 ? v : null;
const digest = (value: string) => toHex(sha256(utf8Encode(value)));
const keyFor = (sourceId: string, threadId: string) => digest(JSON.stringify([sourceId, threadId]));

/** Whole conversations are evicted, so a retained cursor never skips discarded turns. */
export class ConversationCache {
  readonly ready: Promise<void>;
  sources: SourceInfo[] = [];
  private entries = new Map<string, Entry>();
  private memory = new Map<string, CachedConversation>();
  private reads = new Map<string, Promise<CachedConversation | null>>();
  private dirty = new Set<string>();
  private blocked = new Map<string, string>();
  private revoked = new Set<string>();
  private stopped = false;
  private sourcesChanged = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private writes = Promise.resolve();
  private readonly maxBytes: number;
  private readonly maxEntries: number;

  constructor(private storage: ConversationStorage, limits: { maxBytes?: number; maxEntries?: number } = {}) {
    this.maxBytes = limits.maxBytes ?? 64 * 1024 * 1024;
    this.maxEntries = limits.maxEntries ?? 12;
    this.ready = this.loadIndex();
  }
  private async loadIndex() {
    try {
      const raw = object(JSON.parse(await this.storage.read('index.json') ?? '{}'));
      if (raw.version !== 1 || this.stopped) return;
      if (!this.sourcesChanged && Array.isArray(raw.sources)) this.sources = raw.sources.flatMap((value) => {
        const s = object(value), caps = object(s.capabilities);
        if (typeof s.id !== 'string' || typeof s.name !== 'string' || s.type !== 'codex') return [];
        return [{ id: s.id, name: s.name.slice(0, 300), type: 'codex' as const, access: s.access === 'control' ? 'control' as const : 'read' as const, enabled: s.enabled === true,
          status: 'offline' as const, mode: ['history', 'attach', 'managed'].includes(String(s.mode)) ? s.mode as SourceInfo['mode'] : 'history',
          capabilities: { read: caps.read === true, control: caps.control === true, realtime: caps.realtime === true, create: caps.create === true } }];
      });
      if (Array.isArray(raw.entries)) for (const value of raw.entries) {
        const e = object(value), thread = agentThread(e.thread);
        if (!thread || typeof e.sourceId !== 'string' || typeof e.bytes !== 'number' || !Number.isFinite(e.bytes) || e.bytes < 0 || this.revoked.has(e.sourceId)) continue;
        const key = keyFor(e.sourceId, thread.id);
        if (!this.blocked.has(key) && !this.entries.has(key)) this.entries.set(key, { key, sourceId: e.sourceId, thread, bytes: e.bytes, at: typeof e.at === 'number' ? e.at : 0 });
      }
    } catch { /* A missing or damaged cache falls back to the computer. */ }
  }
  threads(sourceId: string): AgentThread[] {
    return [...this.entries.values()].filter((e) => e.sourceId === sourceId).sort((a, b) => b.at - a.at).map((e) => ({ ...e.thread, live: false, status: { type: 'history' } }));
  }
  peek(sourceId: string, threadId: string): CachedConversation | null {
    const key = keyFor(sourceId, threadId);
    if (this.stopped || this.revoked.has(sourceId) || this.blocked.has(key)) return null;
    const value = this.memory.get(key);
    if (value) { this.memory.delete(key); this.memory.set(key, value); }
    const entry = this.entries.get(key);
    if (entry) { this.entries.set(key, { ...entry, at: Date.now() }); this.schedule(); }
    return value ?? null;
  }
  async get(sourceId: string, threadId: string): Promise<CachedConversation | null> {
    const key = keyFor(sourceId, threadId);
    if (this.stopped || this.revoked.has(sourceId) || this.blocked.has(key)) return null;
    const cached = this.memory.get(key);
    if (cached) return cached;
    if (this.reads.has(key)) return this.reads.get(key)!;
    const loading = (async () => {
      await this.ready;
      if (!this.entries.has(key) || this.stopped || this.revoked.has(sourceId)) return null;
      try {
        const raw = object(JSON.parse(await this.storage.read(`${key}.json`) ?? '{}'));
        const thread = agentThread(raw.thread);
        if (raw.version !== 1 || raw.sourceId !== sourceId || thread?.id !== threadId || !Array.isArray(raw.turns)) return null;
        const prepared = object(raw.prepared);
        const value: CachedConversation = { sourceId, thread, turns: agentTurns(raw.turns), cursor: cursor(raw.cursor), at: typeof raw.at === 'number' ? raw.at : 0,
          ...(typeof prepared.cursor === 'string' && Array.isArray(prepared.turns) ? { prepared: { cursor: prepared.cursor, turns: agentTurns(prepared.turns), nextCursor: cursor(prepared.nextCursor) } } : {}) };
        if (this.stopped || this.revoked.has(sourceId) || this.blocked.has(key)) return null;
        // A live save while the file was being read takes precedence.
        if (this.memory.has(key)) return this.memory.get(key)!;
        this.memory.set(key, value); this.trimMemory(); return value;
      } catch { return null; }
    })().finally(() => { this.reads.delete(key); });
    this.reads.set(key, loading); return loading;
  }
  save(value: Omit<CachedConversation, 'at'>) {
    const key = keyFor(value.sourceId, value.thread.id);
    if (this.stopped || this.revoked.has(value.sourceId) || this.blocked.has(key)) return;
    const snapshot = { sourceId: value.sourceId, thread: value.thread, turns: value.turns, cursor: value.cursor, ...(value.prepared ? { prepared: value.prepared } : {}), at: Date.now() };
    this.memory.delete(key); this.memory.set(key, snapshot);
    this.entries.set(key, { key, sourceId: value.sourceId, thread: value.thread, at: snapshot.at, bytes: this.entries.get(key)?.bytes ?? 0 });
    this.dirty.add(key); this.schedule();
  }
  rememberSources(sources: SourceInfo[]) {
    if (this.stopped) return;
    this.sourcesChanged = true;
    this.sources = sources.filter((s) => s.type === 'codex');
    for (const source of this.sources) if (source.enabled && this.revoked.delete(source.id)) {
      for (const [key, sourceId] of this.blocked) if (sourceId === source.id) this.blocked.delete(key);
    }
    this.schedule();
  }
  private schedule() {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = null; void this.flush(); }, 1200);
  }
  private trimMemory() {
    for (const key of this.memory.keys()) {
      if (this.memory.size <= 3) break;
      if (!this.dirty.has(key)) this.memory.delete(key);
    }
  }
  flush(): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.writes = this.writes.catch(() => {}).then(async () => {
      await this.ready;
      if (this.stopped) return;
      for (const key of [...this.dirty]) {
        this.dirty.delete(key);
        const value = this.memory.get(key);
        if (!value || this.revoked.has(value.sourceId) || this.blocked.has(key)) continue;
        const raw = JSON.stringify({ version: 1, ...value });
        // Three bytes per UTF-16 unit bounds the UTF-8 file without allocating
        // another copy of a large transcript on the JS thread.
        const bytes = raw.length * 3;
        if (bytes > Math.min(this.maxBytes, 24 * 1024 * 1024)) { this.entries.delete(key); await this.storage.remove(`${key}.json`); continue; }
        await this.storage.write(`${key}.json`, raw);
        this.entries.set(key, { key, sourceId: value.sourceId, thread: value.thread, bytes, at: value.at });
      }
      let bytes = [...this.entries.values()].reduce((sum, e) => sum + e.bytes, 0);
      for (const e of [...this.entries.values()].sort((a, b) => a.at - b.at)) {
        if (this.entries.size <= this.maxEntries && bytes <= this.maxBytes) break;
        this.entries.delete(e.key); this.memory.delete(e.key); bytes -= e.bytes;
        await this.storage.remove(`${e.key}.json`);
      }
      await this.storage.write('index.json', JSON.stringify({ version: 1, sources: this.sources, entries: [...this.entries.values()] }));
      this.trimMemory();
    }).catch(() => { /* Reads remain usable when the disk is full or unavailable. */ });
    return this.writes;
  }
  async forgetThread(sourceId: string, threadId: string) {
    const key = keyFor(sourceId, threadId); this.blocked.set(key, sourceId); this.memory.delete(key); this.dirty.delete(key);
    await this.ready; await this.writes;
    this.entries.delete(key); await this.storage.remove(`${key}.json`).catch(() => {}); await this.flush();
  }
  async forgetSource(sourceId: string) {
    this.revoked.add(sourceId); await this.ready;
    for (const e of [...this.entries.values()]) if (e.sourceId === sourceId) await this.forgetThread(sourceId, e.thread.id);
  }
  async clear() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.memory.clear(); this.entries.clear(); this.dirty.clear();
    await this.writes; await this.storage.clear().catch(() => {});
  }
}

const computers = new Map<string, ConversationCache>();
function fileStorage(computerId: string): ConversationStorage {
  const fs = () => import('expo-file-system/legacy');
  const directory = async () => {
    const api = await fs();
    if (!api.cacheDirectory) throw new Error('File cache unavailable');
    return `${api.cacheDirectory}panecast-conversations-v1/${digest(computerId)}/`;
  };
  return {
    async read(name) { try { return await (await fs()).readAsStringAsync((await directory()) + name); } catch { return null; } },
    async write(name, value) { const api = await fs(), dir = await directory(); await api.makeDirectoryAsync(dir, { intermediates: true }); await api.writeAsStringAsync(dir + name, value); },
    async remove(name) { await (await fs()).deleteAsync((await directory()) + name, { idempotent: true }); },
    async clear() { await (await fs()).deleteAsync(await directory(), { idempotent: true }); },
  };
}
export function conversationCache(computerId: string): ConversationCache {
  let cache = computers.get(computerId);
  if (!cache) { cache = new ConversationCache(fileStorage(computerId)); computers.set(computerId, cache); }
  return cache;
}
export async function forgetConversations(computerId: string) {
  const cache = computers.get(computerId) ?? new ConversationCache(fileStorage(computerId));
  computers.delete(computerId); await cache.clear();
}
