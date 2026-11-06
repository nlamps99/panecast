import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { writeJSON } from './push.mjs';
import { lifecycleNotificationId, notificationSignal } from './notification-signal.mjs';

const COMPLETE = new Set(['completed', 'complete', 'resolved', 'failed', 'cancelled', 'canceled', 'interrupted', 'done', 'succeeded', 'success']);
const APPROVALS = new Set(['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'tool/requestUserInput', 'item/tool/requestUserInput']);
const string = (value, max = 2000) => typeof value === 'string' && value ? value.slice(0, max) : undefined;
const FIELDS = ['id', 'notification_id', 'workspace_id', 'surface_id', 'title', 'subtitle', 'body', 'message', 'source', 'source_id', 'thread_id', 'threadId', 'task_id', 'taskId', 'request_id', 'requestId', 'turn_id', 'turnId', 'status', 'state', 'needs_input', 'resolved', 'resolves_notification_id', 'panecast_origin_event_id', 'ts'];

/** Only explicit notification / task lifecycle data is retained, never conversation token streams. */
export function inboxEvent(frame) {
  const p = frame?.payload;
  if (!p || typeof p !== 'object' || Array.isArray(p)) return null;
  if (frame.category === 'agent' && APPROVALS.has(frame.name) && p.request_id && p.threadId) {
    return { type: 'event', category: 'notification', name: 'notification.created', payload: {
      id: `request:${p.source_id ?? ''}:${p.request_id}`, source_id: p.source_id, thread_id: p.threadId,
      request_id: p.request_id, turn_id: p.turnId, task_id: p.task_id,
      needs_input: true, status: 'needs input', title: 'Codex 等待回应', body: string(p.reason) ?? '打开会话查看请求', ts: p.ts ?? Date.now() / 1000,
    } };
  }
  const status = String(p.status?.type ?? p.status ?? p.state ?? p.turn?.status ?? '').toLowerCase();
  const signal = notificationSignal(frame);
  if (!signal && /^(item[./]|tool[./]|message[./])|[./](delta|progress|started|updated)$|^notification\.(?!created$|resolved$)/.test(frame.name)) return null;
  const resolution = frame.name === 'serverRequest/resolved' || frame.name === 'notification.resolved'
    || ((COMPLETE.has(status) || ['turn/completed', 'task.completed', 'task.failed', 'task.cancelled', 'agent.completed'].includes(frame.name)) && (p.notification_id || p.resolves_notification_id || p.task_id || p.taskId || p.request_id || p.requestId || p.turn?.id || p.turn_id || p.turnId));
  if (!signal && !resolution) return null;
  const payload = {};
  for (const key of FIELDS) {
    const value = p[key];
    if (typeof value === 'string') payload[key] = value.slice(0, ['body', 'message'].includes(key) ? 2000 : 300);
    else if (typeof value === 'number' && Number.isFinite(value) || typeof value === 'boolean') payload[key] = value;
  }
  if (resolution) {
    payload.resolved = true; payload.status = COMPLETE.has(status) ? status : signal === 'completed' ? 'completed' : 'resolved';
    if (p.turn?.id) payload.turn_id = String(p.turn.id);
  }
  if (signal) {
    payload.needs_input = signal === 'attention';
    payload.status = signal === 'completed' ? 'completed' : ['failed', 'error', 'blocked', 'needs attention'].includes(status) ? status : 'needs input';
    if (!payload.id) payload.id = lifecycleNotificationId(frame) ?? undefined;
    payload.thread_id ??= payload.threadId;
    payload.task_id ??= payload.taskId;
    payload.request_id ??= payload.requestId;
    payload.turn_id ??= payload.turnId;
    payload.title ??= signal === 'completed' ? '任务已完成' : status === 'failed' ? '任务失败' : '需要你处理';
    const error = string(p.turn?.error?.message ?? p.error?.message);
    if (error && !payload.body) payload.body = error;
  }
  return { type: 'event', category: frame.category, name: frame.name, payload };
}

export class InboxJournal {
  constructor(path, { limit = 2000 } = {}) {
    this.path = path; this.limit = limit; this.epoch = randomUUID(); this.sequence = 0; this.events = []; this.writes = Promise.resolve();
  }
  async load() {
    try {
      const data = JSON.parse(await readFile(this.path, 'utf8'));
      if (typeof data.epoch === 'string' && Number.isSafeInteger(data.sequence) && Array.isArray(data.events)) {
        this.epoch = data.epoch; this.sequence = data.sequence;
        this.events = data.events.filter((e) => Number.isSafeInteger(e.seq) && e.seq > 0 && e.seq <= data.sequence && e.event?.type === 'event').slice(-this.limit);
      }
    } catch { /* First boot or corrupt journal starts a new epoch; clients are told to reset. */ }
  }
  append(frame) {
    const event = inboxEvent(frame);
    if (!event) return Promise.resolve(null);
    const operation = this.writes.catch(() => {}).then(async () => {
      if (event.payload.panecast_origin_event_id) {
        const existing = this.events.find((e) => e.event.payload.panecast_origin_event_id === event.payload.panecast_origin_event_id);
        if (existing) return existing.event;
      }
      const seq = this.sequence + 1, cursor = `${this.epoch}:${seq}`;
      const payload = { ...event.payload, panecast_event_id: cursor, panecast_cursor: cursor };
      if (!payload.id && !payload.notification_id && !payload.resolved) payload.notification_id = `event:${cursor}`;
      const stamped = { ...event, payload };
      const events = [...this.events, { seq, event: stamped }].slice(-this.limit);
      await writeJSON(this.path, { version: 1, epoch: this.epoch, sequence: seq, events });
      this.sequence = seq; this.events = events;
      return stamped;
    });
    this.writes = operation;
    return operation;
  }
  async page({ cursor, limit = 100, until_cursor: until } = {}, allowed = () => true) {
    await this.writes.catch(() => {});
    const parse = (value) => {
      if (typeof value !== 'string') return null;
      const split = value.lastIndexOf(':'), epoch = value.slice(0, split), seq = Number(value.slice(split + 1));
      return epoch === this.epoch && Number.isSafeInteger(seq) && seq >= 0 && seq <= this.sequence ? seq : null;
    };
    const parsed = parse(cursor), oldest = this.events[0]?.seq ?? this.sequence + 1;
    const reset = Boolean(cursor) && (parsed === null || parsed < oldest - 1);
    const start = parsed === null || reset ? oldest - 1 : parsed;
    const head = parse(until) ?? this.sequence;
    const page = this.events.filter((e) => e.seq > start && e.seq <= head).slice(0, Math.min(200, Math.max(1, Number.isInteger(limit) ? limit : 100)));
    const end = page.at(-1)?.seq ?? Math.max(start, head);
    return { events: page.filter((e) => allowed(e.event)).map((e) => e.event), next_cursor: `${this.epoch}:${end}`, head_cursor: `${this.epoch}:${head}`, has_more: end < head, reset, retained_events: this.limit };
  }
}
