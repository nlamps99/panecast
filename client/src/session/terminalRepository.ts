import { RpcCallError } from '../protocol/connection';
import type { RpcChannel, SurfaceTarget } from './terminalSession';
import { agentItem } from './agentData';
import { cacheStorage } from './cacheStorage';
import { SnapshotCache } from './snapshotCache';
import type { ScreenState } from '../protocol/screen';

export type TerminalHead = Record<string, unknown>;
export const terminalKey = (target: SurfaceTarget) => JSON.stringify([target.workspaceId, target.surfaceId]);
export function parseTerminalHead(value: unknown): TerminalHead | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as TerminalHead;
  if (raw.available !== true || typeof raw.conversation_id !== 'string' || !Array.isArray(raw.items) || raw.items.length > 2000) return null;
  return { ...raw, reset: false, unchanged: false, items: raw.items.map(agentItem).filter(Boolean) };
}
export function parseTerminalScreen(value: unknown): ScreenState | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as ScreenState;
  if (!Array.isArray(raw.rows) || raw.rows.length > 500 || !raw.rows.every(row => typeof row === 'string' && row.length < 100_000) || !raw.cursor) return null;
  return { rows: raw.rows, rev: 0, cursor: { x: Number(raw.cursor.x) || 0, y: Number(raw.cursor.y) || 0 } };
}
type LocalCaches = { heads: SnapshotCache<TerminalHead>; screens: SnapshotCache<ScreenState> };
const caches = new Map<string, LocalCaches>();
export type CacheLimits = { entries: number; bytes: number };
/** The first call for a computer sets its limits (the defaults suit the desktop app). */
export function terminalCaches(computerId: string, limits?: CacheLimits): LocalCaches {
  let result = caches.get(computerId);
  if (!result) {
    result = { heads: new SnapshotCache(cacheStorage(`terminal-heads:${computerId}`), parseTerminalHead, limits),
      screens: new SnapshotCache(cacheStorage(`terminal-screens:${computerId}`), parseTerminalScreen, limits) };
    caches.set(computerId, result);
  }
  return result;
}
export async function forgetTerminalCaches(computerId: string) {
  const cache = terminalCaches(computerId); caches.delete(computerId);
  await Promise.all([cache.heads.clear(), cache.screens.clear()]);
}
type Job = { foreground: boolean; key?: string; run(): Promise<unknown>; resolve(value: unknown): void; reject(error: unknown): void };

/** Share one head read across the visible conversation and sidebar; never queue a background burst on the relay. */
export class TerminalRepository {
  private listeners = new Set<(target: SurfaceTarget, head: TerminalHead) => void>();
  private pending = new Map<string, Promise<TerminalHead>>();
  private checked = new Map<string, number>();
  private jobs: Job[] = [];
  private running = false;
  private nextBackgroundAt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private viewing: string | null = null;
  private generation = 0;
  private stopped = false;
  private unsubscribe: () => void;
  constructor(private channel: RpcChannel, readonly cache: SnapshotCache<TerminalHead>) {
    this.unsubscribe = channel.onStatus(() => {
      this.generation++; this.checked.clear(); this.pending.clear();
      for (const job of this.jobs.splice(0)) job.reject(new RpcCallError('closed', '连接已断开'));
    });
  }
  peek(target: SurfaceTarget) { return this.cache.peek(terminalKey(target)); }
  restore(target: SurfaceTarget) { return this.cache.get(terminalKey(target)); }
  watch(listener: (target: SurfaceTarget, head: TerminalHead) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  setViewing(target: SurfaceTarget | null) { this.viewing = target ? terminalKey(target) : null; this.pump(); }
  isViewing(target: SurfaceTarget) { return this.viewing === terminalKey(target); }
  invalidate(target: SurfaceTarget) { this.checked.delete(terminalKey(target)); }
  private enqueue<T>(run: () => Promise<T>, foreground: boolean, key?: string): Promise<T> {
    if (this.stopped) return Promise.reject(new RpcCallError('closed', '连接已关闭'));
    return new Promise<T>((resolve, reject) => { this.jobs.push({ run, foreground, key, resolve: value => resolve(value as T), reject }); this.pump(); });
  }
  background<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    return this.enqueue(() => this.channel.call<T>(method, params, 10_000), false);
  }
  private pump() {
    if (this.running || this.stopped || !this.jobs.length) return;
    if (this.timer) clearTimeout(this.timer); this.timer = null;
    let index = this.jobs.findIndex(job => job.foreground); if (index < 0) index = 0;
    const job = this.jobs[index];
    if (job.foreground && job.key && job.key !== this.viewing) {
      this.jobs.splice(index, 1); job.reject(new RpcCallError('cancelled', '会话已切换')); this.pump(); return;
    }
    const wait = this.nextBackgroundAt - Date.now();
    if (!job.foreground && wait > 0) { this.timer = setTimeout(() => { this.timer = null; this.pump(); }, wait); return; }
    this.jobs.splice(index, 1); this.running = true;
    if (!job.foreground) this.nextBackgroundAt = Date.now() + 1000;
    void job.run().then(job.resolve, job.reject).finally(() => { this.running = false; this.pump(); });
  }
  readHead(target: SurfaceTarget, foreground = false): Promise<TerminalHead> {
    const key = terminalKey(target), pending = this.pending.get(key);
    if (pending) {
      if (foreground) { const job = this.jobs.find(job => job.key === key); if (job) job.foreground = true; this.pump(); }
      return pending;
    }
    const previous = this.peek(target);
    if (previous && Date.now() - (this.checked.get(key) ?? -Infinity) < 1000) return Promise.resolve(previous);
    const generation = this.generation;
    const task = this.enqueue(async () => {
      const raw = await this.channel.call<TerminalHead>('terminal.conversation', { workspace_id: target.workspaceId, surface_id: target.surfaceId, limit: 80,
        ...(previous?.revision ? { revision: previous.revision } : {}), ...(previous?.branch ? { branch: previous.branch } : {}) }, 15_000);
      if (this.stopped || generation !== this.generation) throw new RpcCallError('closed', '连接已变化');
      const head = raw.unchanged && previous ? { ...previous, ...raw, reset: raw.reset === true, items: previous.items } : raw;
      this.checked.set(key, Date.now());
      if (head.available === true) {
        if (!previous || previous.revision !== head.revision || previous.conversation_id !== head.conversation_id || previous.generation !== head.generation) this.cache.set(key, { ...head, reset: false, unchanged: false });
      } else this.cache.remove(key);
      for (const listener of this.listeners) listener(target, head);
      return head;
    }, foreground, key).catch(error => {
      if (error instanceof RpcCallError && (['source_revoked', 'invalid_target', 'read_only', 'not_found'].includes(error.code) || /^conversation_/.test(error.code))) this.cache.remove(key);
      throw error;
    }).finally(() => { if (this.pending.get(key) === task) this.pending.delete(key); });
    this.pending.set(key, task); return task;
  }
  dispose() {
    this.stopped = true; this.generation++; this.unsubscribe(); this.listeners.clear();
    if (this.timer) clearTimeout(this.timer);
    for (const job of this.jobs.splice(0)) job.reject(new RpcCallError('closed', '连接已关闭'));
    void this.cache.flush();
  }
}
