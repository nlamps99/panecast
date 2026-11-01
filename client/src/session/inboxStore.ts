import type { EventFrame } from '../protocol/frames';
import type { RpcChannel } from './terminalSession';

export type InboxItem = {
  id: string;
  workspaceId: string | null;
  surfaceId: string | null;
  title: string;
  subtitle: string | null;
  body: string;
  /** Milliseconds since the epoch. */
  at: number;
  read: boolean;
};

export type InboxState = {
  items: readonly InboxItem[];
  unread: number;
  unreadByWorkspace: Readonly<Record<string, number>>;
};

const MAX_ITEMS = 200;

/**
 * Notifications cmux raises (`notification.created`), collected while the app
 * is connected. Kept in memory only; push notifications come later.
 * Field names follow `NotificationRecord` in SharedKit.
 */
export class InboxStore {
  private state: InboxState = { items: [], unread: 0, unreadByWorkspace: {} };
  private listeners = new Set<() => void>();
  private dispose_: () => void;
  private counter = 0;

  constructor(channel: RpcChannel) {
    this.dispose_ = channel.onPush((frame) => {
      if (frame.type === 'event') this.ingest(frame);
    });
  }

  getState = (): InboxState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  dispose(): void {
    this.dispose_();
    this.listeners.clear();
  }

  ingest(event: EventFrame): void {
    const item = toItem(event, () => `local-${Date.now()}-${this.counter++}`);
    if (!item || this.state.items.some((existing) => existing.id === item.id)) return;
    this.setItems([item, ...this.state.items].slice(0, MAX_ITEMS));
  }

  markRead(id: string): void {
    this.setItems(this.state.items.map((item) => (item.id === id && !item.read ? { ...item, read: true } : item)));
  }

  markWorkspaceRead(workspaceId: string): void {
    this.setItems(
      this.state.items.map((item) => (item.workspaceId === workspaceId && !item.read ? { ...item, read: true } : item)),
    );
  }

  markAllRead(): void {
    this.setItems(this.state.items.map((item) => (item.read ? item : { ...item, read: true })));
  }

  private setItems(items: InboxItem[]): void {
    const unreadByWorkspace: Record<string, number> = {};
    let unread = 0;
    for (const item of items) {
      if (item.read) continue;
      unread++;
      if (item.workspaceId) unreadByWorkspace[item.workspaceId] = (unreadByWorkspace[item.workspaceId] ?? 0) + 1;
    }
    this.state = { items, unread, unreadByWorkspace };
    for (const listener of this.listeners) listener();
  }
}

function toItem(event: EventFrame, fallbackId: () => string): InboxItem | null {
  if (event.category !== 'notification' && event.name !== 'notification.created') return null;
  const payload = isObject(event.payload) ? event.payload : {};
  const title = text(payload, 'title', 'headline') ?? '通知';
  const body = text(payload, 'body', 'message', 'text', 'summary') ?? '';
  const ts = typeof payload.ts === 'number' && Number.isFinite(payload.ts) ? payload.ts : null;
  return {
    id: text(payload, 'id', 'notification_id', 'event_id') ?? fallbackId(),
    workspaceId: text(payload, 'workspace_id', 'workspaceId'),
    surfaceId: text(payload, 'surface_id', 'surfaceId'),
    title,
    subtitle: text(payload, 'subtitle', 'workspace_title', 'surface_title'),
    body,
    // cmux sends seconds; tolerate milliseconds.
    at: ts === null ? Date.now() : ts < 1e12 ? ts * 1000 : ts,
    read: false,
  };
}

function text(payload: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
