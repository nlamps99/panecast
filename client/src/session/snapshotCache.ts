import { sha256, toHex, utf8Encode } from '../protocol/sha256';
import type { ConversationStorage } from './conversationCache';

type Entry<T> = { value?: T; at: number; bytes: number };
const file = (key: string) => `${toHex(sha256(utf8Encode(key)))}.json`;

/** Bounded local snapshots. Memory serves repeat clicks synchronously; disk survives relaunch. */
export class SnapshotCache<T> {
  readonly ready: Promise<void>;
  private entries = new Map<string, Entry<T>>();
  private dirty = new Set<string>();
  private deleted = new Set<string>();
  private reads = new Map<string, Promise<T | null>>();
  private writes = Promise.resolve();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  constructor(private storage: ConversationStorage, private parse: (value: unknown) => T | null,
    private limits = { entries: 48, bytes: 24 * 1024 * 1024 }) {
    this.ready = this.loadIndex();
  }
  private async loadIndex() {
    try {
      const data = JSON.parse(await this.storage.read('index.json') ?? '{}');
      if (this.stopped || data.version !== 1 || !Array.isArray(data.entries)) return;
      for (const item of data.entries.slice(0, this.limits.entries)) {
        if (typeof item.key === 'string' && typeof item.at === 'number' && typeof item.bytes === 'number' &&
          item.bytes >= 0 && item.bytes <= this.limits.bytes && !this.entries.has(item.key) && !this.deleted.has(item.key)) {
          this.entries.set(item.key, { at: item.at, bytes: item.bytes });
        }
      }
    } catch { /* An unavailable cache must not prevent a live connection. */ }
  }
  peek(key: string): T | null {
    const entry = this.entries.get(key);
    if (!entry?.value || this.stopped) return null;
    entry.at = Date.now(); return entry.value;
  }
  get(key: string): Promise<T | null> {
    const memory = this.peek(key);
    if (memory) return Promise.resolve(memory);
    const pending = this.reads.get(key); if (pending) return pending;
    const task = (async () => {
      await this.ready;
      if (this.stopped || this.deleted.has(key) || !this.entries.has(key)) return null;
      try {
        const raw = await this.storage.read(file(key));
        if (this.stopped || this.deleted.has(key)) return null;
        const current = this.peek(key); if (current) return current;
        const value = raw ? this.parse(JSON.parse(raw)) : null;
        if (value) this.entries.set(key, { value, at: Date.now(), bytes: raw!.length * 2 });
        return value;
      } catch { return null; }
    })().finally(() => this.reads.delete(key));
    this.reads.set(key, task); return task;
  }
  set(key: string, value: T) {
    if (this.stopped || this.entries.get(key)?.value === value) return;
    this.entries.set(key, { value, at: Date.now(), bytes: this.entries.get(key)?.bytes ?? 0 });
    this.deleted.delete(key); this.dirty.add(key);
    // Bound memory before serialization, and coalesce rapid screen updates.
    while (this.entries.size > this.limits.entries) this.remove([...this.entries].sort((a, b) => a[1].at - b[1].at)[0][0]);
    this.schedule();
  }
  remove(key: string) { this.entries.delete(key); this.dirty.delete(key); this.deleted.add(key); this.schedule(); }
  private schedule() { if (!this.timer && !this.stopped) this.timer = setTimeout(() => { this.timer = null; void this.flush(); }, 1500); }
  flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer); this.timer = null;
    this.writes = this.writes.catch(() => {}).then(async () => {
      await this.ready; if (this.stopped) return;
      for (const key of [...this.dirty]) {
        this.dirty.delete(key);
        const entry = this.entries.get(key); if (!entry?.value) continue;
        const raw = JSON.stringify(entry.value);
        entry.bytes = raw.length * 2;
        if (entry.bytes > this.limits.bytes / 2) { this.remove(key); continue; }
        await this.storage.write(file(key), raw);
      }
      let bytes = [...this.entries.values()].reduce((sum, item) => sum + item.bytes, 0);
      for (const [key, entry] of [...this.entries].sort((a, b) => a[1].at - b[1].at)) {
        if (bytes <= this.limits.bytes && this.entries.size <= this.limits.entries) break;
        bytes -= entry.bytes; this.remove(key);
      }
      for (const key of [...this.deleted]) { await this.storage.remove(file(key)); this.deleted.delete(key); }
      await this.storage.write('index.json', JSON.stringify({ version: 1, entries: [...this.entries].map(([key, entry]) => ({ key, at: entry.at, bytes: entry.bytes })) }));
    }).catch(() => { /* Keep memory usable when persistence is unavailable. */ });
    return this.writes;
  }
  async clear() {
    this.stopped = true; if (this.timer) clearTimeout(this.timer); this.entries.clear(); this.dirty.clear(); this.deleted.clear();
    await this.writes; await this.storage.clear().catch(() => {});
  }
}
