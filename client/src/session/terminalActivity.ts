import { RpcCallError } from '../protocol/connection';
import type { RpcChannel, SurfaceTarget } from './terminalSession';

export const activityKey = (target: SurfaceTarget) => JSON.stringify([target.workspaceId, target.surfaceId]);
export type TerminalActivity = { status: 'running' | 'completed' | 'idle' | 'unknown'; at: number };
export type ActivityState = Readonly<Record<string, TerminalActivity>>;
export type ActivityTarget = SurfaceTarget & { title: string; workspaceTitle: string; windowId: string | null };
type Snapshot = { conversation: string; generation: string; revision?: string; branch?: string; user: string; final: string };
type Options = {
  targets(): ActivityTarget[];
  onActivity(target: ActivityTarget, at: number): void;
  onComplete(target: ActivityTarget, id: string, body: string): void;
};
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' ? value as Record<string, unknown> : {};
const text = (value: unknown) => typeof value === 'string' ? value : '';

/** One desktop-wide observer, independent of the currently displayed terminal. */
export class TerminalActivityStore {
  private state: ActivityState = {};
  private snapshots = new Map<string, Snapshot>();
  private retryAfter = new Map<string, number>();
  private listeners = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pending: Promise<void> | null = null;
  private generation = 0;
  private disposed = false;
  private unsupported = false;
  private unsubscribe: () => void;

  constructor(private channel: RpcChannel, private options: Options) {
    this.unsubscribe = channel.onStatus(status => {
      this.generation++; this.pending = null; this.snapshots.clear(); this.retryAfter.clear(); this.unsupported = false;
      if (this.timer) clearTimeout(this.timer);
      this.replace(Object.fromEntries(Object.entries(this.state).map(([key, value]) => [key, { ...value, status: 'unknown' }])));
      if (status.state === 'open') void this.refresh();
    });
  }
  getState = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private replace(state: ActivityState) { this.state = state; for (const listener of this.listeners) listener(); }
  private set(key: string, value: TerminalActivity) {
    if (this.state[key]?.status !== value.status || this.state[key]?.at !== value.at) this.replace({ ...this.state, [key]: value });
  }
  dispose() {
    this.disposed = true; this.generation++; this.unsubscribe(); this.listeners.clear();
    if (this.timer) clearTimeout(this.timer);
  }
  refresh(): Promise<void> {
    if (this.pending) return this.pending;
    if (this.disposed || !this.channel.isOpen || this.unsupported) return Promise.resolve();
    if (this.timer) clearTimeout(this.timer);
    const generation = this.generation;
    const targets = [...new Map(this.options.targets().map(target => [activityKey(target), target])).values()];
    const retained = new Set(targets.map(activityKey));
    for (const key of this.snapshots.keys()) if (!retained.has(key)) { this.snapshots.delete(key); this.retryAfter.delete(key); }
    if (Object.keys(this.state).some(key => !retained.has(key))) this.replace(Object.fromEntries(Object.entries(this.state).filter(([key]) => retained.has(key))));
    const queue = targets.filter(target => (this.retryAfter.get(activityKey(target)) ?? 0) <= Date.now());
    const worker = async () => {
      while (queue.length && generation === this.generation && !this.disposed && !this.unsupported) {
        await this.read(queue.shift()!, generation);
      }
    };
    const task = Promise.all([worker(), worker(), worker()]).then(() => {}).finally(() => {
      if (this.pending === task) this.pending = null;
      if (generation === this.generation && !this.disposed && !this.unsupported) this.timer = setTimeout(() => { void this.refresh(); }, 2500);
    });
    this.pending = task; return task;
  }
  private async read(target: ActivityTarget, generation: number) {
    const key = activityKey(target), previous = this.snapshots.get(key);
    try {
      const raw = record(await this.channel.call('terminal.conversation', {
        workspace_id: target.workspaceId, surface_id: target.surfaceId, limit: 20,
        ...(previous?.revision ? { revision: previous.revision } : {}), ...(previous?.branch ? { branch: previous.branch } : {}),
      }, 10_000));
      if (this.disposed || generation !== this.generation) return;
      if (raw.available !== true || !text(raw.conversation_id) || typeof raw.active !== 'boolean') {
        this.snapshots.delete(key); this.set(key, { status: 'unknown', at: this.state[key]?.at ?? 0 });
        this.retryAfter.set(key, Date.now() + 30_000); return;
      }
      const same = previous?.conversation === raw.conversation_id && previous?.generation === text(raw.generation) && raw.reset !== true;
      const items = Array.isArray(raw.items) ? raw.items.map(record) : [];
      const user = items.findLast(item => item.type === 'userMessage');
      const last = items.at(-1);
      // Only an actual final reply establishes completion. A disconnect, an
      // unavailable binding or a cancelled turn must never look like success.
      const final = items.findLast(item => item.type === 'agentMessage' && item.needsInput !== true &&
        (item.phase === 'final' || (raw.provider === 'claude' && raw.active === false && item === last)));
      const snapshot: Snapshot = { conversation: text(raw.conversation_id), generation: text(raw.generation),
        revision: text(raw.revision) || undefined, branch: text(raw.branch) || undefined,
        user: text(user?.id) || (same ? previous.user : ''), final: text(final?.id) || (same ? previous.final : '') };
      const started = raw.active && (!same || this.state[key]?.status !== 'running' || snapshot.user !== previous.user);
      const completed = same && !raw.active && Boolean(final) && snapshot.final !== previous.final;
      const at = started || completed ? Date.now() : this.state[key]?.at ?? 0;
      this.snapshots.set(key, snapshot);
      this.set(key, { status: raw.active ? 'running' : completed || (same && this.state[key]?.status === 'completed') ? 'completed' : 'idle', at });
      if (started || completed) this.options.onActivity(target, at);
      if (completed) this.options.onComplete(target, `terminal-complete:${snapshot.conversation}:${snapshot.final}`, text(final?.text).slice(0, 500));
    } catch (error) {
      if (this.disposed || generation !== this.generation) return;
      this.snapshots.delete(key);
      this.set(key, { status: 'unknown', at: this.state[key]?.at ?? 0 });
      this.retryAfter.set(key, Date.now() + 15_000);
      if (error instanceof RpcCallError && ['method_not_found', 'unknown_method', '-32601'].includes(error.code)) this.unsupported = true;
    }
  }
}

/** Running first, then most recent activity/visit; ties preserve the input order. */
export function compareActivity(a: TerminalActivity | undefined, b: TerminalActivity | undefined, aVisit = 0, bVisit = 0): number {
  return Number(b?.status === 'running') - Number(a?.status === 'running') || Math.max(b?.at ?? 0, bVisit) - Math.max(a?.at ?? 0, aVisit);
}
