import type { EventFrame } from '../protocol/frames';
import { cachedInbox, cachedRecovery, INBOX_LIMIT, readInbox, rememberInbox, saveRecoveredInbox } from './inboxPersistence';
import { RpcCallError } from '../protocol/connection';
import { EMPTY_RECOVERY, eventIdentity, lifecycleFields, parseSyncPage, resolutionMatcher, type InboxSyncState, type RecoveryMetadata } from './inboxRecovery';
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
  /** A question, approval request, failure or blocker needs attention. */
  needsInput: boolean;
  /** Read state and handling state are independent. */
  resolvedAt?: number | null;
  snoozedUntil?: number | null;
  reminderId?: string | null;
  sourceId?: string | null;
  threadId?: string | null;
  taskId?: string | null;
  requestId?: string | null;
  turnId?: string | null;
};

export type InboxState = {
  /** Newest first, at most 200. */
  items: readonly InboxItem[];
  unread: number;
  unreadByWorkspace: Readonly<Record<string, number>>;
  pending: number;
  pendingByWorkspace: Readonly<Record<string, number>>;
  /** False while the stored inbox is being read; always true without a `storageKey`. */
  loaded: boolean;
  sync?: InboxSyncState;
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
  private recovery: RecoveryMetadata = EMPTY_RECOVERY;
  private statusDispose: () => void = () => {};
  private syncing: Promise<void> | null = null;
  private connectionGeneration = 0;
  private syncAgain = false;
  private liveBuffer: EventFrame[] = [];

  constructor(private channel: RpcChannel, options: InboxStoreOptions = {}) {
    this.storageKey = options.storageKey ?? null;
    const cached = this.storageKey === null ? undefined : cachedInbox(this.storageKey);
    if (this.storageKey === null || cached) {
      this.state = summarize(cached ?? [], true);
      if (this.storageKey) this.recovery = cachedRecovery(this.storageKey);
      this.ready = Promise.resolve();
    } else {
      this.state = summarize([], false);
      this.pending = [];
      this.ready = this.load(this.storageKey);
    }
    this.dispose_ = channel.onPush((frame) => {
      if (frame.type === 'event') this.ingest(frame);
    });
    if (this.storageKey) {
      this.statusDispose = channel.onStatus((status) => {
        this.connectionGeneration++;
        if (status.state === 'open') void this.sync();
      });
      if (channel.isOpen) void this.sync();
    }
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
    this.statusDispose();
    this.connectionGeneration++;
    this.listeners.clear();
    this.newListeners.clear();
  }

  ingest(event: EventFrame, replay = false, buffered = false): void {
    if (this.disposed) return;
    const identity = eventIdentity(event);
    if (identity && !replay && !buffered && this.storageKey) {
      // A newer live completion must not overtake an older replayed prompt.
      // Keep live events until the bounded replay snapshot has been applied.
      this.liveBuffer.push(event);
      if (this.liveBuffer.length > 2000) this.liveBuffer.shift();
      this.syncAgain = true; void this.sync(); return;
    }
    if (identity && this.recovery.seen.includes(identity)) return;
    if (identity) this.recovery = { ...this.recovery, seen: [...this.recovery.seen, identity].slice(-2000) };
    const record = parseInboxEvent(event, () => `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${this.counter++}`);
    const resolved = resolutionMatcher(event);
    if (resolved) {
      this.apply((items) => items.map((item) => item.id !== record?.id && resolved(item) && !item.resolvedAt ? { ...item, resolvedAt: Date.now(), snoozedUntil: null } : item));
      this.persist();
    }
    if (!record) return;
    const item = { ...toItem(record), ...Object.fromEntries(Object.entries(lifecycleFields(event)).filter(([, value]) => value !== null)) };
    const resurface = !replay && !identity && record.idSource === 'content';
    const before = this.state.items;
    this.apply((items) => mergeArrival(items, item, resurface));
    const top = this.state.items[0];
    if (!replay && this.state.items !== before && top?.id === item.id && !top.read) {
      for (const listener of [...this.newListeners]) listener(top);
    }
    if (identity && !replay && !buffered) { this.syncAgain = true; void this.sync(); }
  }

  sync(): Promise<void> {
    if (!this.storageKey || this.disposed || !this.channel.isOpen) return Promise.resolve();
    if (this.syncing) { this.syncAgain = true; return this.syncing; }
    const generation = this.connectionGeneration;
    const run = this.recover(generation).finally(() => {
      this.syncing = null;
      if (this.syncAgain && !this.disposed && this.channel.isOpen) { this.syncAgain = false; void this.sync(); }
    });
    this.syncing = run; return run;
  }

  private async recover(generation: number): Promise<void> {
    await this.ready;
    if (this.disposed || generation !== this.connectionGeneration) return;
    this.syncState({ status: 'syncing', gap: this.state.sync?.gap ?? false });
    let head: string | undefined;
    try {
      for (let i = 0; i < 25; i++) {
        const page = parseSyncPage(await this.channel.call('inbox.sync', { ...(this.recovery.cursor ? { cursor: this.recovery.cursor } : {}), ...(head ? { until_cursor: head } : {}), limit: 100 }, 10_000));
        if (this.disposed || generation !== this.connectionGeneration) return;
        if (page.more && page.cursor === this.recovery.cursor) throw new Error('通知同步游标未前进');
        for (const event of page.events) this.ingest(event, !this.liveBuffer.some((live) => eventIdentity(live) === eventIdentity(event)), true);
        this.recovery = { ...this.recovery, cursor: page.cursor };
        this.persist(); head = page.head;
        if (page.gap) this.syncState({ status: 'syncing', gap: true, message: '离线时间超过电脑的保留范围，已补齐仍可获取的通知' });
        if (!page.more) {
          const buffered = this.liveBuffer; this.liveBuffer = [];
          for (const event of buffered) this.ingest(event, false, true);
          this.syncState({ ...this.state.sync!, status: 'ready' }); return;
        }
      }
      throw new Error('通知较多，请再次同步以读取余下记录');
    } catch (error) {
      if (this.disposed || generation !== this.connectionGeneration) return;
      const unsupported = error instanceof RpcCallError && ['method_not_found', 'unknown_method', '-32601'].includes(error.code);
      this.syncAgain = false;
      const buffered = this.liveBuffer; this.liveBuffer = [];
      for (const event of buffered) this.ingest(event, false, true);
      this.syncState({ status: unsupported ? 'unsupported' : 'error', gap: this.state.sync?.gap ?? false,
        message: unsupported ? '电脑尚不支持离线通知补齐，请升级 relay；在线通知仍可接收' : '通知补齐失败，已有记录已保留，点按重试' });
    }
  }

  private syncState(sync: InboxSyncState) { this.state = { ...this.state, sync }; for (const listener of this.listeners) listener(); }
  private persist() { if (this.storageKey && this.pending === null) saveRecoveredInbox(this.storageKey, this.state.items, this.recovery); }

  markRead(id: string): void {
    this.apply((items) => mapItems(items, (item) => item.id === id && !item.read));
  }

  resolve(id: string, done = true): void {
    this.apply((items) => items.map((item) => item.id === id ? { ...item, resolvedAt: done ? Date.now() : null, snoozedUntil: null, reminderId: null } : item));
  }

  snooze(id: string, until: number, reminderId: string): void {
    this.apply((items) => items.map((item) => item.id === id ? { ...item, snoozedUntil: until, reminderId } : item));
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
    const recovery = cachedRecovery(key);
    this.recovery = { cursor: recovery.cursor, seen: [...new Set([...recovery.seen, ...this.recovery.seen])].slice(-2000) };
    const ops = this.pending ?? [];
    this.pending = null;
    let items = stored;
    for (const op of ops) items = op(items);
    if (items === stored) rememberInbox(key, items);
    this.commit(items, true, items !== stored);
  }

  private commit(items: readonly InboxItem[], loaded: boolean, save = true): void {
    this.state = { ...summarize(items, loaded), ...(this.state.sync ? { sync: this.state.sync } : {}) };
    // While loading, the list is partial; the replay in `load` saves the whole one.
    if (save) this.persist();
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
  const previous = items[index];
  const next = previous.reminderId ? { ...item, reminderId: previous.reminderId, snoozedUntil: previous.snoozedUntil } : item;
  return [next, ...items.slice(0, index), ...items.slice(index + 1)];
}

/** Marks the matching items read; returns `items` itself when none match. */
function mapItems(items: readonly InboxItem[], matches: (item: InboxItem) => boolean): readonly InboxItem[] {
  if (!items.some(matches)) return items;
  return items.map((item) => (matches(item) ? { ...item, read: true } : item));
}

function summarize(items: readonly InboxItem[], loaded: boolean): InboxState {
  const unreadByWorkspace: Record<string, number> = {};
  const pendingByWorkspace: Record<string, number> = {};
  let pending = 0;
  let unread = 0;
  for (const item of items) {
    if (isPending(item)) {
      pending++;
      if (item.workspaceId) pendingByWorkspace[item.workspaceId] = (pendingByWorkspace[item.workspaceId] ?? 0) + 1;
    }
    if (item.read) continue;
    unread++;
    if (item.workspaceId) unreadByWorkspace[item.workspaceId] = (unreadByWorkspace[item.workspaceId] ?? 0) + 1;
  }
  return { items, unread, unreadByWorkspace, pending, pendingByWorkspace, loaded };
}

export function isPending(item: InboxItem): boolean { return item.needsInput && !item.resolvedAt; }

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
