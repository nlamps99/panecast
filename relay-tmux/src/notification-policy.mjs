import { notificationSignal } from './notification-signal.mjs';

const integer = (value, fallback, max) => Number.isInteger(value) ? Math.max(0, Math.min(max, value)) : fallback;
export function notificationPreferences(value) {
  const p = value && typeof value === 'object' ? value : {};
  const q = p.quiet_hours && typeof p.quiet_hours === 'object' ? p.quiet_hours : {};
  let zone = typeof q.time_zone === 'string' ? q.time_zone : 'UTC';
  try { new Intl.DateTimeFormat('en-US', { timeZone: zone }).format(); } catch { zone = 'UTC'; }
  return { needs_input_only: p.needs_input_only === true,
    muted_workspaces: Array.isArray(p.muted_workspaces) ? [...new Set(p.muted_workspaces.filter((s) => typeof s === 'string' && s.length <= 300))].slice(0, 200) : [],
    quiet_hours: { enabled: q.enabled === true, start_minutes: integer(q.start_minutes, 22 * 60, 1439), end_minutes: integer(q.end_minutes, 8 * 60, 1439), time_zone: zone },
    dedupe_seconds: integer(p.dedupe_seconds, 60, 3600) };
}
export function notificationAllowed(preferences, notification, now = Date.now()) {
  const signal = notificationSignal({ category: 'notification', name: 'notification.created', payload: notification });
  if (!signal) return false;
  const p = notificationPreferences(preferences);
  if (p.muted_workspaces.includes(notification.workspace_id ?? notification.thread_id ?? '')) return false;
  const needs = signal === 'attention';
  if (p.needs_input_only && !needs) return false;
  const q = p.quiet_hours;
  if (!q.enabled) return true;
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: q.time_zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  const minute = Number(parts.find((x) => x.type === 'hour')?.value) * 60 + Number(parts.find((x) => x.type === 'minute')?.value);
  const quiet = q.start_minutes === q.end_minutes || (q.start_minutes < q.end_minutes ? minute >= q.start_minutes && minute < q.end_minutes : minute >= q.start_minutes || minute < q.end_minutes);
  return !quiet;
}
export function notificationGroup(notification) {
  return JSON.stringify([notification.workspace_id ?? '', notification.surface_id ?? '', notification.source_id ?? '', notification.thread_id ?? '', notification.task_id ?? notification.request_id ?? notification.turn_id ?? '', notificationSignal({ category: 'notification', name: 'notification.created', payload: notification }), notification.title ?? '', notification.body ?? '']);
}
