import { useEffect, useSyncExternalStore } from 'react';

export type NotificationPreferences = {
  needs_input_only: boolean;
  muted_workspaces: string[];
  quiet_hours: { enabled: boolean; start_minutes: number; end_minutes: number; time_zone: string };
  dedupe_seconds: number;
};
type Storage = { getItem(key: string): Promise<string | null>; setItem(key: string, value: string): Promise<void> };
const integer = (value: unknown, fallback: number, max: number) => typeof value === 'number' && Number.isInteger(value) ? Math.max(0, Math.min(max, value)) : fallback;
export function localTimeZone(): string { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; } }
export function sanitizeNotificationPreferences(value: unknown): NotificationPreferences {
  const p = value && typeof value === 'object' ? value as Partial<NotificationPreferences> : {};
  const q = p.quiet_hours ?? {} as Partial<NotificationPreferences['quiet_hours']>;
  let zone = typeof q.time_zone === 'string' ? q.time_zone : localTimeZone();
  try { new Intl.DateTimeFormat('en-US', { timeZone: zone }).format(); } catch { zone = 'UTC'; }
  return { needs_input_only: p.needs_input_only === true,
    muted_workspaces: Array.isArray(p.muted_workspaces) ? [...new Set(p.muted_workspaces.filter((s) => typeof s === 'string' && s.length <= 300))].slice(0, 200) : [],
    quiet_hours: { enabled: q.enabled === true, start_minutes: integer(q.start_minutes, 22 * 60, 1439), end_minutes: integer(q.end_minutes, 8 * 60, 1439), time_zone: zone },
    dedupe_seconds: integer(p.dedupe_seconds, 60, 3600) };
}
export function notificationAllowed(preferences: NotificationPreferences, item: { workspaceId?: string | null; threadId?: string | null; needsInput: boolean }, now = Date.now()): boolean {
  const p = preferences;
  if (p.muted_workspaces.includes(item.workspaceId ?? item.threadId ?? '')) return false;
  if (p.needs_input_only && !item.needsInput) return false;
  const q = p.quiet_hours;
  if (!q.enabled) return true;
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: q.time_zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  const minute = Number(parts.find((x) => x.type === 'hour')?.value) * 60 + Number(parts.find((x) => x.type === 'minute')?.value);
  const quiet = q.start_minutes === q.end_minutes || (q.start_minutes < q.end_minutes ? minute >= q.start_minutes && minute < q.end_minutes : minute >= q.start_minutes || minute < q.end_minutes);
  return !quiet;
}
export function notificationGroup(item: { workspaceId?: string | null; surfaceId?: string | null; sourceId?: string | null; threadId?: string | null; taskId?: string | null; requestId?: string | null; turnId?: string | null; needsInput?: boolean; title: string; body: string }) {
  return JSON.stringify([item.workspaceId ?? '', item.surfaceId ?? '', item.sourceId ?? '', item.threadId ?? '', item.taskId ?? item.requestId ?? item.turnId ?? '', item.needsInput === true, item.title, item.body]);
}
export class NotificationRulesStore {
  private state = { loaded: false, preferences: sanitizeNotificationPreferences(null), error: null as string | null };
  private listeners = new Set<() => void>();
  private loading: Promise<void> | null = null;
  private writing = Promise.resolve();
  constructor(private key: string, private storage: Storage) {}
  getState = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  load() { return this.loading ??= this.read(); }
  private async read() {
    try { const raw = await this.storage.getItem(this.key); this.state = { loaded: true, preferences: sanitizeNotificationPreferences(raw ? JSON.parse(raw) : null), error: null }; }
    catch { this.state = { ...this.state, loaded: true, error: '未能读取通知偏好' }; }
    this.emit();
  }
  update(patch: Partial<NotificationPreferences>) {
    if (!this.state.loaded) return;
    this.state = { loaded: true, preferences: sanitizeNotificationPreferences({ ...this.state.preferences, ...patch }), error: null }; this.emit();
    const value = JSON.stringify(this.state.preferences);
    this.writing = this.writing.catch(() => {}).then(() => this.storage.setItem(this.key, value)).catch(() => { this.state = { ...this.state, error: '未能保存通知偏好' }; this.emit(); });
  }
  private emit() { for (const listener of this.listeners) listener(); }
}
export function useNotificationRules(store: NotificationRulesStore) {
  useEffect(() => { void store.load(); }, [store]);
  return useSyncExternalStore(store.subscribe, store.getState, store.getState);
}
