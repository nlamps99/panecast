import { RpcCallError } from '../protocol/connection';
import type { RpcChannel, SurfaceTarget } from './terminalSession';
import type { TerminalRepository } from './terminalRepository';

export const activityKey = (target: SurfaceTarget) => JSON.stringify([target.workspaceId, target.surfaceId]);
export type TerminalActivity = { status: 'running' | 'completed' | 'idle' | 'unknown'; at: number; windowId?: string | null };
export type ActivityState = Readonly<Record<string, TerminalActivity>>;
export type ActivityTarget = SurfaceTarget & { title: string; workspaceTitle: string; windowId: string | null };
type Snapshot = { conversation: string; generation: string; revision?: string; branch?: string; user: string; final: string };
type Options = {
  repository?: TerminalRepository;
  targets(): ActivityTarget[];
  onActivity(target: ActivityTarget, at: number): void;
  onComplete(target: ActivityTarget, id: string, body: string): void;
  /** Pause between automatic reads while the app is in front (default 1 s). */
  pollMs?: number;
  /** In the background only running terminals are read, this far apart (default 5 s). */
  backgroundPollMs?: number;
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
  private inBackground = false;
  private unsubscribe: () => void;
  private unwatch: () => void = () => {};
  private observed = new WeakSet<object>();

  constructor(private channel: RpcChannel, private options: Options) {
    if (options.repository) this.unwatch = options.repository.watch((target, head) => {
      const found = options.targets().findLast(item => activityKey(item) === activityKey(target));
      if (found) this.accept(found, head);
    });
    this.unsubscribe = channel.onStatus(status => {
      this.generation++; this.pending = null; this.snapshots.clear(); this.observed = new WeakSet(); this.retryAfter.clear(); this.unsupported = false;
      if (this.timer) clearTimeout(this.timer);
      this.replace(Object.fromEntries(Object.entries(this.state).map(([key, value]) => [key, { ...value, status: 'unknown' }])));
      if (status.state === 'open') void this.refresh();
    });
  }
  getState = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private replace(state: ActivityState) { this.state = state; for (const listener of this.listeners) listener(); }
  private set(key: string, value: TerminalActivity) {
    if (this.state[key]?.status !== value.status || this.state[key]?.at !== value.at || this.state[key]?.windowId !== value.windowId) this.replace({ ...this.state, [key]: value });
  }
  dispose() {
    this.disposed = true; this.generation++; this.unsubscribe(); this.unwatch(); this.listeners.clear();
    if (this.timer) clearTimeout(this.timer);
  }
  /**
   * A phone in the background keeps reading only running terminals, slowly, so
   * a finished turn can still raise a local alert without a steady stream of
   * reads for idle ones. Back in front, everything is checked again.
   */
  setBackground(background: boolean) {
    if (this.inBackground === background) return;
    this.inBackground = background;
    if (!background && !this.disposed) { if (this.timer) clearTimeout(this.timer); void this.refresh(); }
  }
  prioritize(target: SurfaceTarget) { this.retryAfter.set(activityKey(target), -1); this.options.repository?.invalidate(target); }
  refresh(force = false): Promise<void> {
    if (this.pending) return this.pending;
    if (this.disposed || !this.channel.isOpen || this.unsupported) return Promise.resolve();
    if (this.timer) clearTimeout(this.timer);
    const generation = this.generation;
    const targets = [...new Map(this.options.targets().map(target => [activityKey(target), target])).values()];
    const retained = new Set(targets.map(activityKey));
    for (const key of this.snapshots.keys()) if (!retained.has(key)) { this.snapshots.delete(key); this.retryAfter.delete(key); }
    if (Object.keys(this.state).some(key => !retained.has(key))) this.replace(Object.fromEntries(Object.entries(this.state).filter(([key]) => retained.has(key))));
    const due = targets.filter(target => !this.options.repository?.isViewing(target) && (force || (this.retryAfter.get(activityKey(target)) ?? 0) <= Date.now())
      && (!this.inBackground || this.state[activityKey(target)]?.status === 'running'))
      .sort((a, b) => (this.retryAfter.get(activityKey(a)) ?? 0) - (this.retryAfter.get(activityKey(b)) ?? 0) || Number(this.state[activityKey(b)]?.status === 'running') - Number(this.state[activityKey(a)]?.status === 'running'));
    // Automatic polling has a fixed request budget, independent of how many
    // recent conversations exist. Foreground reads supply their own status.
    const queue = force ? due : due.slice(0, 1);
    const worker = async () => {
      while (queue.length && generation === this.generation && !this.disposed && !this.unsupported) {
        await this.read(queue.shift()!, generation);
      }
    };
    const task = worker().finally(() => {
      if (this.pending === task) this.pending = null;
      if (generation === this.generation && !this.disposed && !this.unsupported) this.timer = setTimeout(() => { void this.refresh(); },
        this.inBackground ? this.options.backgroundPollMs ?? 5000 : this.options.pollMs ?? 1000);
    });
    this.pending = task; return task;
  }
  private async read(target: ActivityTarget, generation: number) {
    const key = activityKey(target), previous = this.snapshots.get(key);
    try {
      const raw = record(await (this.options.repository ? this.options.repository.readHead(target) : this.channel.call('terminal.conversation', {
        workspace_id: target.workspaceId, surface_id: target.surfaceId, limit: 20,
        ...(previous?.revision ? { revision: previous.revision } : {}), ...(previous?.branch ? { branch: previous.branch } : {}),
      }, 10_000)));
      if (this.disposed || generation !== this.generation) return;
      this.accept(target, raw);
    } catch (error) {
      if (this.disposed || generation !== this.generation) return;
      this.snapshots.delete(key);
      this.set(key, { status: 'unknown', at: this.state[key]?.at ?? 0, windowId: target.windowId });
      this.retryAfter.set(key, Date.now() + 30_000);
      if (error instanceof RpcCallError && ['method_not_found', 'unknown_method', '-32601'].includes(error.code)) this.unsupported = true;
    }
  }
  private accept(target: ActivityTarget, raw: Record<string, unknown>) {
      const key = activityKey(target), previous = this.snapshots.get(key);
      if (this.observed.has(raw)) return;
      this.observed.add(raw);
      if (raw.available !== true || !text(raw.conversation_id) || typeof raw.active !== 'boolean') {
        this.snapshots.delete(key); this.set(key, { status: 'unknown', at: this.state[key]?.at ?? 0 });
        this.retryAfter.set(key, Date.now() + 60_000); return;
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
      this.set(key, { status: raw.active ? 'running' : completed || (same && this.state[key]?.status === 'completed') ? 'completed' : 'idle', at, windowId: target.windowId });
      this.retryAfter.set(key, Date.now() + (raw.active ? 3000 : 15_000));
      if (started || completed) this.options.onActivity(target, at);
      if (completed) this.options.onComplete(target, `terminal-complete:${snapshot.conversation}:${snapshot.final}`, text(final?.text).slice(0, 500));
  }
}

/** Running first, then most recent activity/visit; ties preserve the input order. */
export function compareActivity(a: TerminalActivity | undefined, b: TerminalActivity | undefined, aVisit = 0, bVisit = 0): number {
  return Number(b?.status === 'running') - Number(a?.status === 'running') || Math.max(b?.at ?? 0, bVisit) - Math.max(a?.at ?? 0, aVisit);
}
