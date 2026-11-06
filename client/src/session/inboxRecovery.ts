import type { EventFrame } from '../protocol/frames';
import type { InboxItem } from './inboxStore';

export type RecoveryMetadata = { cursor: string | null; seen: readonly string[] };
export type InboxSyncState = { status: 'idle' | 'syncing' | 'ready' | 'unsupported' | 'error'; gap: boolean; message?: string };
export const EMPTY_RECOVERY: RecoveryMetadata = { cursor: null, seen: [] };
const COMPLETE = new Set(['completed', 'complete', 'resolved', 'failed', 'cancelled', 'canceled', 'interrupted', 'done', 'succeeded', 'success']);
const names = new Set(['notification.resolved', 'task.completed', 'task.failed', 'task.cancelled', 'agent.completed', 'turn/completed', 'serverRequest/resolved']);
export function payloadObject(event: EventFrame): Record<string, unknown> {
  return event.payload && typeof event.payload === 'object' && !Array.isArray(event.payload) ? event.payload as Record<string, unknown> : {};
}
export function eventIdentity(event: EventFrame): string | null {
  const id = payloadObject(event).panecast_event_id;
  return typeof id === 'string' && id.length <= 200 ? id : null;
}
const string = (value: unknown): string | null => typeof value === 'string' && value ? value : null;
export function lifecycleFields(event: EventFrame) {
  const p = payloadObject(event);
  return {
    sourceId: string(p.source_id), threadId: string(p.thread_id ?? p.threadId),
    taskId: string(p.task_id ?? p.taskId), requestId: string(p.request_id ?? p.requestId), turnId: string(p.turn_id ?? p.turnId ?? (p.turn as Record<string, unknown> | undefined)?.id),
  };
}
/** A completion must identify the notification/request/task/turn. Plain text never resolves a prompt. */
export function resolutionMatcher(event: EventFrame): ((item: InboxItem) => boolean) | null {
  if (/^(item[./]|tool[./]|message[./])|[./](delta|progress|started|updated)$|^notification\.(?!created$|resolved$)/.test(event.name)) return null;
  const p = payloadObject(event);
  const status = string((p.status as Record<string, unknown> | null)?.type ?? p.status ?? p.state ?? (p.turn as Record<string, unknown> | null)?.status)?.toLowerCase();
  if (p.resolved !== true && !names.has(event.name) && !COMPLETE.has(status ?? '')) return null;
  const id = string(p.resolves_notification_id ?? p.notification_id ?? (event.name === 'notification.resolved' ? p.id : null));
  const fields = lifecycleFields(event);
  if (!id && !fields.requestId && !fields.taskId && !fields.turnId) return null;
  return (item) => {
    if (fields.sourceId && item.sourceId !== fields.sourceId) return false;
    if (fields.threadId && item.threadId !== fields.threadId) return false;
    const workspace = string(p.workspace_id), surface = string(p.surface_id);
    if (workspace && item.workspaceId !== workspace || surface && item.surfaceId !== surface) return false;
    return Boolean(id && item.id === id || fields.requestId && item.requestId === fields.requestId || fields.taskId && item.taskId === fields.taskId || fields.turnId && item.turnId === fields.turnId);
  };
}
export function parseSyncPage(value: unknown) {
  if (!value || typeof value !== 'object') throw new Error('通知同步响应无效');
  const p = value as Record<string, unknown>;
  if (!Array.isArray(p.events) || typeof p.next_cursor !== 'string' || p.next_cursor.length > 200 || typeof p.has_more !== 'boolean') throw new Error('通知同步响应无效');
  const events = p.events.map((raw) => {
    if (!raw || typeof raw !== 'object' || raw.type !== 'event' || typeof raw.category !== 'string' || typeof raw.name !== 'string' || !raw.payload || typeof raw.payload !== 'object') throw new Error('通知事件格式无效');
    return raw as EventFrame;
  });
  return { events, cursor: p.next_cursor, head: typeof p.head_cursor === 'string' ? p.head_cursor : undefined, more: p.has_more, gap: p.reset === true };
}
