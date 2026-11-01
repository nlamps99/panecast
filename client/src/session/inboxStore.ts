import type { EventFrame } from '../protocol/frames';
import { cachedInbox, INBOX_LIMIT, readInbox, rememberInbox, saveInbox } from './inboxPersistence';
import { parseInboxEvent, type InboxRecord } from './inboxRecord';
import type { RpcChannel } from './terminalSession';

export type InboxItem = {
  id: string;
  workspaceId: string | null;
  surfaceId: string | null;
  title: string;
  subtitle: string | null;
  /** Empty when the notification has nothing to say beyond its title. */
  body: string;
  /** Milliseconds since the epoch. */
  at: number;
  read: boolean;
  /** An agent (Claude Code, Codex, ...) is waiting for approval or an answer. */
  needsInput: boolean;
};

export type InboxState = {
  /** Newest first, at most 200. */
  items: readonly InboxItem[];
  unread: number;
  unreadByWorkspace: Readonly<Record<string, number>>;
  /** False while the stored inbox is being read; always true without a `storageKey`. */
  loaded: boolean;
};

export type InboxStoreOptions = {
  /**
   * Keep the inbox across launches under this AsyncStorage key (see
   * `inboxStorageKey`). One live store per key. Without it the inbox is kept
   * in memory only.
   */
  storageKey?: string;
};

/** Long texts are cut so 200 stored items stay small. */
const MAX_TITLE = 300;
const MAX_BODY = 2_000;

type Op = (items: readonly InboxItem[]) => readonly InboxItem[];

/**
 * The inbox for one computer: cmux notifications and agents waiting for the
 * user (see `inboxRecord.ts` for which events count), newest first, with read
 * state.
 *
 * With a `storageKey` the inbox is read from storage when the store is
 * created and saved after every change. Changes made before the read
 * finishes (events arrive as soon as the socket opens) apply at once and are
 * applied again on top of the stored list when it arrives, so none is lost.
 */
export class InboxStore {
  /** Resolves once the stored inbox has been read (at once without a `storageKey`). */
  readonly ready: Promise<void>;
  private state: InboxState;
  private listeners = new Set<() => void>();
  private newListeners = new Set<(item: InboxItem) => void>();
  private dispose_: () => void;
  private disposed = false;
  private counter = 0;
  private readonly storageKey: string | null;
  /** Changes since creation, while the stored inbox is still being read. */
  private pending: Op[] | null = null;

  constructor(channel: RpcChannel, options: InboxStoreOptions = {}) {
    this.storageKey = options.storageKey ?? null;
    const cached = this.storageKey === null ? undefined : cachedInbox(this.storageKey);
    if (this.storageKey === null || cached) {
      this.state = summarize(cached ?? [], true);
      this.ready = Promise.resolve();
    } else {
      this.state = summarize([], false);
      this.pending = [];
      this.ready = this.load(this.storageKey);
    }
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

  /**
   * Called after an item arrives, or a needs-input prompt the user had already
   * read comes again. Not called for items read from storage or repeats of an
   * unread item. Subscribers have seen the new state by then.
   */
  onNew(listener: (item: InboxItem) => void): () => void {
    this.newListeners.add(listener);
    return () => {
      this.newListeners.delete(listener);
    };
  }

  /** Stops listening and saving. Later calls are ignored. */
  dispose(): void {
    this.disposed = true;
    this.dispose_();
    this.listeners.clear();
    this.newListeners.clear();
  }

  ingest(event: EventFrame): void {
    if (this.disposed) return;
    const record = parseInboxEvent(event, () => `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${this.counter++}`);
    if (!record) return;
    const item = toItem(record);
    const resurface = record.idSource === 'content';
    const before = this.state.items;
    this.apply((items) => mergeArrival(items, item, resurface));
    const top = this.state.items[0];
    if (this.state.items !== before && top?.id === item.id && !top.read) {
      for (const listener of [...this.newListeners]) listener(top);
    }
  }

  markRead(id: string): void {
    this.apply((items) => mapItems(items, (item) => item.id === id && !item.read));
  }

  markWorkspaceRead(workspaceId: string): void {
    this.apply((items) => mapItems(items, (item) => item.workspaceId === workspaceId && !item.read));
  }

  markAllRead(): void {
    this.apply((items) => mapItems(items, (item) => !item.read));
  }

  /** Deletes one item. */
  remove(id: string): void {
    this.apply((items) => (items.some((item) => item.id === id) ? items.filter((item) => item.id !== id) : items));
  }

  /** Deletes every item. */
  clear(): void {
    this.apply((items) => (items.length === 0 ? items : []));
  }

  private apply(op: Op): void {
    if (this.disposed) return;
    this.pending?.push(op);
    const items = op(this.state.items);
    if (items !== this.state.items) this.commit(items, this.state.loaded);
  }

  private async load(key: string): Promise<void> {
    const stored = await readInbox(key);
    if (this.disposed) return;
    const ops = this.pending ?? [];
    this.pending = null;
    let items = stored;
    for (const op of ops) items = op(items);
    if (items === stored) rememberInbox(key, items);
    this.commit(items, true, items !== stored);
  }

  private commit(items: readonly InboxItem[], loaded: boolean, save = true): void {
    this.state = summarize(items, loaded);
    // While loading, the list is partial; the replay in `load` saves the whole one.
    if (this.storageKey !== null && this.pending === null && save) saveInbox(this.storageKey, items);
    for (const listener of [...this.listeners]) listener();
  }
}

/**
 * A new item goes on top. A repeat of a known id changes nothing, except that
 * a needs-input prompt (`resurface`) the user has read comes back on top,
 * unread: the agent is waiting again.
 */
function mergeArrival(items: readonly InboxItem[], item: InboxItem, resurface: boolean): readonly InboxItem[] {
  const index = items.findIndex((existing) => existing.id === item.id);
  if (index === -1) return [item, ...items].slice(0, INBOX_LIMIT);
  if (!resurface || !items[index].read) return items;
  return [item, ...items.slice(0, index), ...items.slice(index + 1)];
}

/** Marks the matching items read; returns `items` itself when none match. */
function mapItems(items: readonly InboxItem[], matches: (item: InboxItem) => boolean): readonly InboxItem[] {
  if (!items.some(matches)) return items;
  return items.map((item) => (matches(item) ? { ...item, read: true } : item));
}

function summarize(items: readonly InboxItem[], loaded: boolean): InboxState {
  const unreadByWorkspace: Record<string, number> = {};
  let unread = 0;
  for (const item of items) {
    if (item.read) continue;
    unread++;
    if (item.workspaceId) unreadByWorkspace[item.workspaceId] = (unreadByWorkspace[item.workspaceId] ?? 0) + 1;
  }
  return { items, unread, unreadByWorkspace, loaded };
}

function toItem(record: InboxRecord): InboxItem {
  return {
    id: record.id,
    workspaceId: record.workspaceId,
    surfaceId: record.surfaceId,
    title: clip(record.title, MAX_TITLE),
    subtitle: record.subtitle === null ? null : clip(record.subtitle, MAX_TITLE),
    body: clip(record.body, MAX_BODY),
    at: toMillis(record.ts),
    read: false,
    needsInput: record.needsInput,
  };
}

/** cmux sends seconds; tolerate milliseconds. A missing or nonsensical `ts` means now. */
function toMillis(ts: number | null): number {
  if (ts === null || ts <= 0) return Date.now();
  return ts < 1e12 ? ts * 1000 : ts;
}

/** Cuts at a code point boundary so a surrogate pair is never split. */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = max - 1;
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end--;
  return `${text.slice(0, end)}…`;
}
