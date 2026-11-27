import { RpcCallError, type ConnectionStatus } from '../protocol/connection';
import type { PushFrame } from '../protocol/frames';
import { encodeKey, Keys, type Key, type KeyAction } from '../protocol/keys';
import { applyDiff, applyFull, EMPTY_SCREEN, screenHash, type ScreenState } from '../protocol/screen';
import { ReadingPositionSearch, type ReadingPosition } from './readingPosition';
import { alignHistory, sameVisibleRows } from './historyAlignment';
import { agentItem } from './agentData';
import { itemsOnScreen, recordLayout, RECORD_WRITING_NOTICE, seamOverlap } from './recordHistory';
import type { AgentItem } from './sourceStore';
import { mergeTerminalItems } from './terminalMerge';
import type { SnapshotCache } from './snapshotCache';
import { terminalDecision } from './terminalPrompt';
import { plainTerminalRows } from '../terminal/textTools';

/** Anything with a connection status: `RelayConnection`, or the demo channel. */
export type StatusSource = {
  readonly status: ConnectionStatus;
  onStatus(listener: (status: ConnectionStatus) => void): () => void;
};

/** What the session needs from a connection; `RelayConnection` satisfies it. */
export interface RpcChannel {
  readonly isOpen: boolean;
  call<T = unknown>(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<T>;
  onPush(listener: (frame: PushFrame) => void): () => void;
  onStatus(listener: (status: ConnectionStatus) => void): () => void;
}

export type SurfaceTarget = { workspaceId: string; surfaceId: string };

/**
 * Scrollback the user is reading. While browsing, the live screen keeps
 * updating underneath, but the view shows `frozenRows` (the live rows at the
 * moment browsing began) so output cannot shift the text being read.
 * `olderRows` are pages from `surface.history`, oldest first.
 */
export type Browse = {
  /** A full-screen program's history, read from its session record (see recordHistory.ts). */
  kind?: 'application';
  frozenRows: readonly string[];
  olderRows: readonly string[];
  cursor: string | null;
  started: boolean;
  exhausted: boolean;
  loading: boolean;
  error: string | null;
  liveChanged: boolean;
  /** Expired/stalled cursors must be replaced, not retried verbatim. */
  restartRequired?: boolean;
  /** Record history: `olderRows` indexes that show the rest of an item when tapped. */
  expandable?: ReadonlyMap<number, string>;
};

export type SubscriptionState = 'none' | 'subscribing' | 'live' | 'error';

/**
 * `busy`: a send has waited more than `INPUT_STALL_MS` for its answer (what
 * is typed meanwhile waits behind it). A send answered sooner changes
 * nothing here, so typing does not redraw the terminal. `error`: the last
 * send that failed or could not be confirmed.
 */
export type InputState = { busy: boolean; error: string | null };

export type TerminalState = {
  target: SurfaceTarget | null;
  screen: ScreenState;
  subscription: SubscriptionState;
  subscriptionError: string | null;
  browse: Browse | null;
  input: InputState;
  /** Explicit input should reveal the prompt even while viewing a live TUI. */
  inputRevision?: number;
  restoredReading?: ReadingPosition | null;
  restoringReading?: boolean;
  readingNotice?: string | null;
  /**
   * Alternate-screen programs own their history and consume mouse-wheel input.
   * `record`: whether the program's session record can be read (null until
   * known); without one, the wheel goes straight to the program.
   */
  applicationScroll?: { columns: number; rows: number; busy: boolean; error: string | null; record?: boolean | null } | null;
  /** The terminal's real column count on the computer, when the relay reports its grid. */
  terminalColumns?: number | null;
  fromCache?: boolean;
  /**
   * When the screen shown was last known to be current: its latest frame,
   * the moment the connection dropped, or when a cached copy was saved.
   * Null when unknown.
   */
  screenAt?: number | null;
};

export type SendReceipt = { status: 'sent' | 'not_sent' | 'unknown'; message: string };
type KeystrokeItem = KeyAction;
type InputItem = KeystrokeItem
  | { kind: 'line'; text: string; target: SurfaceTarget; paste?: boolean; resolve: (result: SendReceipt) => void }
  | { kind: 'paste'; text: string; target: SurfaceTarget; fallback: readonly KeystrokeItem[] | null; resolve: (result: SendReceipt) => void }
  | { kind: 'promptKeys'; keys: readonly Key[]; screen: ScreenState; target: SurfaceTarget; resolve: (result: SendReceipt) => void };
/** The shapes of `terminal.paste` a gateway may take or refuse: older hubs require `submit_key` and visible text. */
type PasteShape = 'submit' | 'insert' | 'blank';

export type TerminalSessionOptions = {
  /** Rows kept on the live screen; `surface.subscribe`'s `lines`. */
  liveLines?: number;
  historyPageLines?: number;
  log?: (message: string) => void;
  readingForTarget?: (target: SurfaceTarget) => ReadingPosition | null;
  saveReading?: (target: SurfaceTarget, position: ReadingPosition | null) => void;
  screenCache?: SnapshotCache<ScreenState>;
};

const SUBSCRIBE_ATTEMPTS = 4;
const RESYNC_MIN_COOLDOWN_MS = 3_000;
const RESYNC_MAX_COOLDOWN_MS = 60_000;
/** Re-pin cmux focus before a key unless we did so for this surface very recently. */
const FOCUS_REUSE_MS = 1_500;
const MAX_HISTORY_ALIGNMENT_PAGES = 25;
const HISTORY_ALIGNMENT_TIMEOUT_MS = 10_000;
const SCROLL_INTERVAL_MS = 32;
const SCROLL_BATCH_LINES = 4;
const SCROLL_IN_FLIGHT = 4;
/** Items per session-record page. */
const RECORD_PAGE = 80;
/** Items per page when reading a whole record for search. */
const RECORD_WHOLE_PAGE = 150;
/** Read ahead until the first page holds this many items to show. */
const RECORD_HEAD_ITEMS = 30;
/** A prefetched first page this recent is shown at once, then checked by revision. */
const RECORD_FRESH_MS = 60_000;
/** `terminal.paste` text per request; the hub takes at most 64 000 characters. */
export const PASTE_CHUNK_CHARS = 60_000;
/** `surface.input` per request: the hub takes at most 512 items and 256 KiB of text, a shared window 32 000 characters an item. */
export const INPUT_BATCH_ITEMS = 500;
export const INPUT_BATCH_CHARS = 200_000;
export const INPUT_ITEM_CHARS = 30_000;
/** A send unanswered this long shows "发送中…" (`input.busy`). */
export const INPUT_STALL_MS = 1_000;
/**
 * While typing, `inputRevision` (which brings the prompt back into view and
 * tells the activity poller this terminal is in use) moves at most this
 * often: each move redraws the whole terminal.
 */
const INPUT_REVEAL_MS = 1_000;
/** A failed send's message stays at least this long, even while typing goes on. */
export const INPUT_ERROR_HOLD_MS = 5_000;

type RecordPage = { items: AgentItem[]; cursor: string | null; conversationId: string | null; generation: string; revision: string | null; branch: string | null; active: boolean; at: number };

/**
 * State for one terminal surface on top of a relay connection: keeps the
 * subscription alive across reconnects, applies screen frames, repairs drift
 * reported by `screen.checksum`, pages `surface.history`, and sends input in
 * order.
 */
export class TerminalSession {
  private state: TerminalState = {
    target: null,
    screen: EMPTY_SCREEN,
    subscription: 'none',
    subscriptionError: null,
    browse: null,
    input: { busy: false, error: null },
  };
  private listeners = new Set<() => void>();
  private disposers: (() => void)[] = [];
  /** Bumped whenever an in-flight subscribe should be abandoned. */
  private subscribeToken = 0;
  private historyToken = 0;
  private historyCursors = new Set<string>();
  private preparedHistory: Promise<HistoryPage | null> | null = null;
  private preparedPage: HistoryPage | null = null;
  private preparedPages = new Map<string, Promise<HistoryPage>>();
  /** The newest record page, read ahead so browsing shows history at once. */
  private recordHead: RecordPage | null = null;
  private recordHeadTask: Promise<RecordPage | null> | null = null;
  /** The record being browsed: merged items, the newest ones the live screen already shows, the next older page. */
  private record: { items: AgentItem[]; hidden: Set<string>; cursor: string | null; conversationId: string | null; generation: string; active: boolean; verified: boolean; expanded: Set<string> } | null = null;
  /** An unsubscribe + subscribe is in flight (resync or a live-lines change). Only one at a time. */
  private replacing = false;
  private lastResyncAt = 0;
  private resyncCooldown = RESYNC_MIN_COOLDOWN_MS;
  private queue: InputItem[] = [];
  private pumping = false;
  private lastFocus: { surfaceId: string; at: number } | null = null;
  /** `surface.input` on this connection: unknown until tried, then remembered until it reconnects. */
  private batchInput: 'unknown' | 'yes' | 'no' = 'unknown';
  /**
   * `terminal.paste` per source (the hub prefixes surface ids with it) and
   * shape, remembered like `batchInput`: older hubs refuse a paste without a
   * submit key, non-cmux sources refuse the method.
   */
  private pasteSupport = new Map<string, 'yes' | 'no'>();
  private stallTimer: ReturnType<typeof setTimeout> | null = null;
  private lastReveal = -Infinity;
  private errorAt = 0;
  private disposed = false;
  private pendingReading: ReadingPosition | null = null;
  private restoringPosition = false;
  private readingTask = 0;
  private selectionIntent = 0;
  private scrollGeneration = 0;
  private inspectingScroll = false;
  private scrollModeChecked = false;
  private queuedScroll = 0;
  private scrollBatch = SCROLL_BATCH_LINES;
  private scrollingApplication = false;
  private scrollInFlight = 0;
  private scrollTimer: ReturnType<typeof setTimeout> | null = null;
  private lastScrollSentAt = -Infinity;
  private liveLines: number;
  /** `lines` sent with the latest `surface.subscribe`. */
  private subscribedLines: number | null = null;
  private readonly historyPageLines: number;
  private readonly log: (message: string) => void;
  private screens = new Map<string, ScreenState>();
  private receivedScreen = false;

  constructor(
    private readonly channel: RpcChannel,
    private readonly options: TerminalSessionOptions = {},
  ) {
    this.liveLines = sanitizeLines(options.liveLines ?? 120, 120);
    this.historyPageLines = options.historyPageLines ?? 500;
    this.log = options.log ?? (() => {});
    this.disposers.push(
      channel.onPush((frame) => this.handlePush(frame)),
      channel.onStatus((status) => this.handleStatus(status)),
    );
  }

  getState = (): TerminalState => this.state;

  get isConnected(): boolean { return this.channel.isOpen; }
  get selectionVersion(): number { return this.selectionIntent; }
  reserveSelection(): number { return ++this.selectionIntent; }

  private discardQueuedInput(): void {
    for (const item of this.queue) {
      if ('resolve' in item) item.resolve({ status: 'not_sent', message: '尚未发送，草稿已保留' });
    }
    this.queue = [];
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  dispose(): void {
    void this.options.screenCache?.flush();
    this.disposed = true;
    this.record = null;
    for (const dispose of this.disposers) dispose();
    this.disposers = [];
    this.subscribeToken++;
    this.historyToken++;
    this.preparedHistory = null;
    this.preparedPage = null; this.preparedPages.clear();
    this.cancelApplicationScroll();
    this.scrollModeChecked = false;
    this.discardQueuedInput();
    if (this.stallTimer) clearTimeout(this.stallTimer);
    this.stallTimer = null;
    this.listeners.clear();
  }

  // MARK: Target and subscription

  setTarget(target: SurfaceTarget | null): void {
    this.selectionIntent++;
    const previous = this.state.target;
    if (sameTarget(previous, target)) return;
    this.record = null; this.recordHead = null; this.recordHeadTask = null;
    // The screen being left was live until now; a later visit dates it from here.
    if (previous && this.state.subscription === 'live') this.options.screenCache?.touch(JSON.stringify([previous.workspaceId, previous.surfaceId]));
    if (previous && this.channel.isOpen) {
      this.channel.call('surface.unsubscribe', { surface_id: previous.surfaceId }).catch(() => {});
    }
    this.historyToken++;
    this.preparedHistory = null;
    this.preparedPage = null; this.preparedPages.clear();
    this.cancelApplicationScroll();
    this.scrollModeChecked = false;
    this.discardQueuedInput();
    this.lastFocus = null;
    this.lastReveal = -Infinity;
    this.readingTask++;
    this.restoringPosition = false;
    this.pendingReading = target ? this.options.readingForTarget?.(target) ?? null : null;
    const key = target ? JSON.stringify([target.workspaceId, target.surfaceId]) : '';
    const cached = this.screens.get(key) ?? this.options.screenCache?.peek(key);
    this.receivedScreen = false;
    this.update({
      target,
      screen: cached ? { ...cached, rev: 0 } : EMPTY_SCREEN,
      fromCache: Boolean(cached),
      screenAt: cached ? this.options.screenCache?.savedAt(key) ?? null : null,
      subscription: 'none',
      subscriptionError: null,
      browse: null,
      input: { busy: this.pumping && this.state.input.busy, error: null },
      restoredReading: null,
      restoringReading: this.pendingReading !== null,
      readingNotice: null,
      applicationScroll: null,
      terminalColumns: null,
    });
    if (target && !cached && this.options.screenCache) {
      const selection = this.selectionIntent;
      void this.options.screenCache.get(key).then(screen => {
        if (screen && !this.disposed && selection === this.selectionIntent && !this.receivedScreen) this.update({ screen: { ...screen, rev: 0 }, fromCache: true, screenAt: this.options.screenCache?.savedAt(key) ?? null });
      });
    }
    if (target) void this.subscribeCurrent();
  }

  /** "重试" after the terminal could not be opened: subscribe to the same target again. */
  retrySubscription(): void {
    if (this.disposed || !this.state.target || this.replacing || this.state.subscription === 'subscribing' || this.state.subscription === 'live') return;
    void this.subscribeCurrent();
  }

  /** Subscribes to the current target, retrying while the relay attaches the session. */
  private async subscribeCurrent(): Promise<void> {
    const target = this.state.target;
    if (!target || !this.channel.isOpen) return;
    const token = ++this.subscribeToken;
    this.update({ subscription: 'subscribing', subscriptionError: null });
    for (let attempt = 0; attempt < SUBSCRIBE_ATTEMPTS; attempt++) {
      try {
        this.subscribedLines = this.liveLines;
        await this.channel.call('surface.subscribe', {
          workspace_id: target.workspaceId,
          surface_id: target.surfaceId,
          lines: this.liveLines,
        });
        if (token !== this.subscribeToken) return;
        this.update({ subscription: 'live' });
        // `setLiveLines` while this subscribe was in flight.
        this.applyLiveLines();
        return;
      } catch (error) {
        if (token !== this.subscribeToken) return;
        // Through the broker, the relay attaches the session asynchronously
        // after the hello; a subscribe that overtakes it is rejected.
        const retryable = error instanceof RpcCallError && error.code === 'session_not_attached';
        if (retryable && attempt + 1 < SUBSCRIBE_ATTEMPTS) {
          await delay(150 * (attempt + 1));
          if (token !== this.subscribeToken) return;
          continue;
        }
        const inaccessible = error instanceof RpcCallError && ['source_revoked', 'read_only', 'invalid_target', 'not_found'].includes(error.code);
        if (inaccessible) {
          const key = JSON.stringify([target.workspaceId, target.surfaceId]);
          this.screens.delete(key); this.options.screenCache?.remove(key);
        }
        this.update({ subscription: 'error', subscriptionError: describeError(error), ...(inaccessible ? { screen: EMPTY_SCREEN, fromCache: false } : {}) });
        return;
      }
    }
  }

  /**
   * Replaces the relay's subscription. `surface.subscribe` is a no-op for a
   * surface that is already subscribed, so unsubscribe first; the new
   * subscription starts with a full snapshot.
   */
  resync(reason: string): void {
    const target = this.state.target;
    if (!target || this.replacing || !this.channel.isOpen) return;
    const now = Date.now();
    const sinceLast = now - this.lastResyncAt;
    if (sinceLast < this.resyncCooldown) return;
    // Back off while mismatches keep coming soon after a resync.
    this.resyncCooldown =
      sinceLast < this.resyncCooldown * 4
        ? Math.min(this.resyncCooldown * 2, RESYNC_MAX_COOLDOWN_MS)
        : RESYNC_MIN_COOLDOWN_MS;
    this.lastResyncAt = now;
    this.log(`resync (${reason})`);
    this.replaceSubscription(target);
  }

  /**
   * Rows the relay keeps live (`surface.subscribe` `lines`). Takes effect at
   * once: a live subscription is replaced and starts again from a full
   * snapshot. Changes made while a replacement is in flight are coalesced.
   */
  setLiveLines(lines: number): void {
    const next = sanitizeLines(lines, this.liveLines);
    if (next === this.liveLines) return;
    this.liveLines = next;
    this.applyLiveLines();
  }

  /** Replaces a live subscription whose `lines` no longer match `liveLines`. */
  private applyLiveLines(): void {
    const target = this.state.target;
    if (this.disposed || this.replacing || !target || !this.channel.isOpen) return;
    if (this.state.subscription !== 'live' || this.subscribedLines === this.liveLines) return;
    this.log(`resubscribe (${this.liveLines} lines)`);
    this.replaceSubscription(target);
  }

  /**
   * Unsubscribes, then subscribes again. The relay may run two requests from
   * one socket out of order, so overlapping replacements of one surface could
   * leave it unsubscribed; `replacing` allows one at a time.
   */
  private replaceSubscription(target: SurfaceTarget): void {
    this.replacing = true;
    const token = ++this.subscribeToken;
    this.channel
      .call('surface.unsubscribe', { surface_id: target.surfaceId })
      .catch(() => {})
      .then(() => {
        if (token === this.subscribeToken && sameTarget(this.state.target, target)) {
          return this.subscribeCurrent();
        }
      })
      .finally(() => {
        this.replacing = false;
        this.applyLiveLines();
      });
  }

  private handleStatus(status: ConnectionStatus): void {
    if (status.state === 'open') {
      if (this.state.target) void this.subscribeCurrent();
      return;
    }
    // The relay drops every subscription with the socket.
    this.subscribeToken++;
    this.lastFocus = null;
    // The next connection may reach a different gateway (local, LAN, server).
    this.batchInput = 'unknown';
    this.pasteSupport.clear();
    if (this.state.subscription !== 'none') {
      // A live screen was current until now; the banner dates it from here.
      const target = this.state.target, live = this.state.subscription === 'live' && this.state.screen.rows.length > 0;
      if (live && target) this.options.screenCache?.touch(JSON.stringify([target.workspaceId, target.surfaceId]));
      this.update({ subscription: 'none', ...(live ? { screenAt: Date.now() } : {}) });
    }
    const browse = this.state.browse;
    if (browse?.loading) this.update({ browse: { ...browse, loading: false } });
    this.historyToken++;
    this.cancelApplicationScroll();
    if (this.state.applicationScroll) this.update({ applicationScroll: { ...this.state.applicationScroll, busy: false } });
  }

  private handlePush(frame: PushFrame): void {
    const target = this.state.target;
    switch (frame.type) {
      case 'screen.full': {
        if (!target || frame.surfaceId !== target.surfaceId) return;
        this.setScreen(applyFull(frame));
        return;
      }
      case 'screen.diff': {
        if (!target || frame.surfaceId !== target.surfaceId) return;
        if (this.state.fromCache && frame.ops[0]?.op !== 'clear') { this.resync('awaiting full screen after cache'); return; }
        if (frame.rev > this.state.screen.rev + 1 && frame.ops[0]?.op !== 'clear') {
          this.resync('missing screen diff');
          return;
        }
        const next = applyDiff(this.state.screen, frame);
        if (next !== this.state.screen) this.setScreen(next);
        return;
      }
      case 'screen.checksum': {
        if (!target || frame.surfaceId !== target.surfaceId) return;
        if (this.state.subscription !== 'live') return;
        // A checksum for another rev describes a screen we are not showing
        // (frames can be reordered through the broker); wait for the next one.
        if (frame.rev !== this.state.screen.rev) return;
        if (screenHash(this.state.screen.rows, this.state.screen.cursor) !== frame.hash) {
          this.resync('checksum mismatch');
        }
        return;
      }
      case 'event':
        if (frame.category === 'system' && frame.name === 'cmux.reset') this.resync('cmux restarted');
        if (frame.category === 'source' && frame.name === 'source.changed' && frame.payload && typeof frame.payload === 'object' && 'source_ids' in frame.payload && Array.isArray(frame.payload.source_ids) && frame.payload.source_ids.some((id) => target?.surfaceId.startsWith(`${id}~`))) {
          this.lastResyncAt = 0;
          this.resync('source authorization changed');
        }
        if (frame.category === 'source' && frame.payload && typeof frame.payload === 'object' && 'source_id' in frame.payload && target?.surfaceId.startsWith(`${frame.payload.source_id}~`)) {
          if (frame.name === 'source.disconnected') this.update({ subscription: 'error', subscriptionError: '终端来源已断开，正在重新连接…' });
          if (frame.name === 'source.reconnected') this.update({ subscription: 'live', subscriptionError: null });
        }
        return;
      default:
        return;
    }
  }

  private setScreen(screen: ScreenState): void {
    this.receivedScreen = true;
    const target = this.state.target;
    if (target) {
      const key = JSON.stringify([target.workspaceId, target.surfaceId]);
      this.screens.delete(key); this.screens.set(key, screen); this.options.screenCache?.set(key, screen);
      while (this.screens.size > 24) this.screens.delete(this.screens.keys().next().value!);
    }
    const browse = this.state.browse;
    const rowsChanged = screen.rows !== this.state.screen.rows;
    const screenAt = Date.now();
    if (browse && browse.kind !== 'application' && rowsChanged && !browse.liveChanged) {
      this.update({ screen, fromCache: false, screenAt, browse: { ...browse, liveChanged: true } });
    } else {
      this.update({ screen, fromCache: false, screenAt });
    }
    if (this.pendingReading && !this.restoringPosition) void this.restoreReadingPosition();
  }

  rememberReading(position: ReadingPosition): void {
    if (this.state.target && !this.state.restoringReading) this.options.saveReading?.(this.state.target, position);
  }

  private async restoreReadingPosition(): Promise<void> {
    const position = this.pendingReading, target = this.state.target;
    if (!position || !target) return;
    this.restoringPosition = true;
    const token = ++this.readingTask;
    // A full-screen program's place is in its session record, not the terminal's scrollback.
    if (!this.scrollModeChecked) await this.inspectScrollMode();
    if (this.disposed || token !== this.readingTask || !sameTarget(target, this.state.target)) return;
    if (this.state.applicationScroll && this.state.applicationScroll.record !== false) this.startApplicationHistory();
    else this.startBrowsing();
    let found: number | null = null;
    // Each page only searches the rows it added, not everything loaded so far.
    const search = new ReadingPositionSearch(position);
    // Bound recovery work. The relay's history may have rotated since the last visit.
    for (let page = 0; page <= 24; page++) {
      if (this.disposed || token !== this.readingTask || !sameTarget(target, this.state.target)) return;
      const browse = this.state.browse;
      if (!browse) break;
      const rows = [...browse.olderRows, ...browse.frozenRows];
      found = search.locate(rows);
      if (found !== null) {
        this.update({ restoredReading: { ...position, rowFromBottom: rows.length - found - 1 }, restoringReading: false });
        break;
      }
      if (page === 24 || browse.exhausted || !this.channel.isOpen) break;
      await this.loadOlder({ retry: true });
      if (this.state.browse?.error) break;
    }
    if (token !== this.readingTask || this.disposed) return;
    this.pendingReading = null;
    this.restoringPosition = false;
    if (found === null) this.update({ restoringReading: false, readingNotice: '上次阅读的位置已不在可恢复的历史中，当前显示最近的历史输出' });
  }

  // MARK: History

  /** Fetch the first immutable page while the current screen is being read. */
  prepareHistory(): void {
    // Full-screen programs: read their session record ahead instead.
    if (this.state.applicationScroll) { if (!this.state.browse && !this.state.fromCache) void this.prepareRecord(); return; }
    const target = this.state.target, rows = this.state.screen.rows;
    if (this.state.fromCache || !this.scrollModeChecked || this.preparedHistory || this.state.browse || this.state.applicationScroll || !rows.length
      || !target || !this.channel.isOpen || this.disposed) return;
    const generation = this.historyToken;
    this.preparedHistory = this.channel.call('surface.history', {
      workspace_id: target.workspaceId, surface_id: target.surfaceId,
      limit: this.historyPageLines, tail_lines: rows.length,
    }, 30_000).then(parseHistoryPage).then((page) => {
      if (generation === this.historyToken && !this.disposed) {
        this.preparedPage = page;
        void this.fillPreparedHistory(target, page, generation);
      }
      return page;
    }).catch(() => null);
  }

  private async fillPreparedHistory(target: SurfaceTarget, first: HistoryPage, generation: number): Promise<void> {
    let page = first, collected = first.rows;
    const seen = new Set<string>();
    try {
      for (let count = 1; page.nextCursor && collected.length < this.historyPageLines && count < 8; count++) {
        if (generation !== this.historyToken || this.state.browse || this.disposed) return;
        const cursor = page.nextCursor;
        if (seen.has(cursor) || !page.rows.length) return;
        seen.add(cursor);
        const pending = this.channel.call('surface.history', {
          workspace_id: target.workspaceId, surface_id: target.surfaceId, cursor, limit: this.historyPageLines,
        }, 30_000).then(parseHistoryPage);
        this.preparedPages.set(cursor, pending);
        page = await pending;
        // If a drag began while this page was in flight, the normal loader
        // takes the same promise. The first page never waits for this runway.
        if (generation !== this.historyToken || this.state.browse || this.disposed) return;
        this.preparedPages.delete(cursor);
        collected = [...page.rows, ...collected];
        this.preparedPage = { ...page, rows: collected, anchorRows: first.anchorRows };
      }
    } catch {
      // The first page stays usable. A later browse can retry this cursor.
    }
  }

  /**
   * Browse a full-screen program's history from its session record, above
   * the frozen screen. Nothing is sent to the program, so its window on the
   * computer and every other viewer stay as they are.
   */
  startApplicationHistory(): void {
    const scroll = this.state.applicationScroll;
    if (!scroll || scroll.record === false || this.state.browse || !this.state.screen.rows.length) return;
    this.stopApplicationScroll(true);
    this.record = null;
    this.update({ browse: { kind: 'application', frozenRows: this.state.screen.rows, olderRows: [],
      cursor: null, started: false, exhausted: false, loading: false, error: null, liveChanged: false } });
    // A page read ahead shows at once; the first load checks that it is still current.
    const head = this.recordHead;
    if (head && Date.now() - head.at < RECORD_FRESH_MS) this.showRecord(head, false);
  }

  /**
   * Reads the newest record page ahead of browsing. With a revision, an
   * unchanged record costs one small answer. Resolves null when there is no
   * record or the read failed.
   */
  prepareRecord(force = false): Promise<RecordPage | null> {
    const target = this.state.target, scroll = this.state.applicationScroll;
    if (!target || !scroll || scroll.record === false || !this.channel.isOpen || this.disposed) return Promise.resolve(null);
    if (this.recordHeadTask) return this.recordHeadTask;
    const previous = this.recordHead;
    if (!force && previous && Date.now() - previous.at < RECORD_FRESH_MS) return Promise.resolve(previous);
    const read = (params: Record<string, unknown>) => this.channel.call('terminal.conversation', { workspace_id: target.workspaceId, surface_id: target.surfaceId, limit: RECORD_PAGE, ...params }, 15_000);
    const task: Promise<RecordPage | null> = read({ ...(previous?.revision ? { revision: previous.revision } : {}), ...(previous?.branch ? { branch: previous.branch } : {}) }).then(async (value) => {
      if (!sameTarget(target, this.state.target) || this.disposed) return null;
      const raw = asObject(value);
      if (raw.available !== true) { this.recordHead = null; this.markRecord(false); return null; }
      let fresh = parseRecordPage(raw);
      const unchanged = previous && fresh.conversationId === previous.conversationId && (raw.unchanged === true || (fresh.revision !== null && fresh.revision === previous.revision));
      // The newest entries can all be internal ones; read on until there is something to show.
      for (let pages = 1; !unchanged && fresh.items.length < RECORD_HEAD_ITEMS && fresh.cursor && pages < 4; pages++) {
        const older = parseRecordPage(asObject(await read({ cursor: fresh.cursor })));
        if (!sameTarget(target, this.state.target) || this.disposed) return null;
        if (older.conversationId !== fresh.conversationId) break;
        fresh = { ...fresh, items: mergeTerminalItems(older.items, fresh.items), cursor: older.cursor };
      }
      const page = unchanged ? { ...previous, active: fresh.active, at: fresh.at } : fresh;
      this.recordHead = page;
      this.markRecord(true);
      return page;
    }, (error: unknown) => {
      if (error instanceof RpcCallError && ['method_not_found', '-32601'].includes(error.code)) this.markRecord(false);
      return null;
    }).finally(() => { if (this.recordHeadTask === task) this.recordHeadTask = null; });
    this.recordHeadTask = task;
    return task;
  }

  /** Without a record, history browsing ends and the wheel goes to the program. */
  private markRecord(available: boolean): void {
    const scroll = this.state.applicationScroll;
    if (scroll && scroll.record !== available) this.update({ applicationScroll: { ...scroll, record: available } });
    if (!available && this.state.browse?.kind === 'application') { this.record = null; this.update({ browse: null }); }
  }

  /**
   * Lays the record out above the frozen screen. The newest items the screen
   * already shows are left out (`itemsOnScreen`), so the two meet without
   * repeating. `verified`: read after browsing began, so nothing newer is missing.
   */
  private showRecord(page: RecordPage, verified: boolean, older = false): void {
    const browse = this.state.browse;
    if (!browse || browse.kind !== 'application') return;
    if (!older || !this.record) {
      const shown = itemsOnScreen(page.items, browse.frozenRows);
      this.record = { items: page.items, hidden: new Set(page.items.slice(page.items.length - shown).map((item) => item.id)), cursor: page.cursor,
        conversationId: page.conversationId, generation: page.generation, active: page.active, verified, expanded: this.record?.expanded ?? new Set() };
    } else {
      this.record = { ...this.record, items: mergeTerminalItems(this.record.items, page.items), cursor: page.cursor };
    }
    this.layoutRecord({ loading: false, error: null });
  }

  /** Draws the record's rows above the frozen screen. */
  private layoutRecord(patch: Partial<Browse> = {}): void {
    const browse = this.state.browse, record = this.record;
    if (!browse || browse.kind !== 'application' || !record) return;
    const columns = this.state.terminalColumns ?? this.state.applicationScroll?.columns ?? 100;
    const layout = recordLayout(record.items.filter((item) => !record.hidden.has(item.id)), columns, record.expanded);
    // Where the screen's top edge cuts an item, both draw its last lines: show them once.
    const rows = layout.rows.slice(0, layout.rows.length - seamOverlap(layout.rows, browse.frozenRows));
    const expandable = new Map([...layout.expandable].filter(([index]) => index < rows.length));
    // The reply being written fills the screen; its start reaches the record when it is done.
    const writing = record.active && record.hidden.size === 0 ? [...(rows.length ? [''] : []), RECORD_WRITING_NOTICE] : [];
    this.update({ browse: { ...browse, ...patch, olderRows: [...rows, ...writing], expandable, cursor: record.cursor, started: true,
      exhausted: record.verified && record.cursor === null } });
  }

  /** Shows a shortened tool output or diff in full. */
  expandRecordItem(id: string): void {
    if (!this.record || this.record.expanded.has(id)) return;
    this.record.expanded.add(id);
    this.layoutRecord();
  }

  /**
   * Reads every remaining page, for searching the whole conversation. Draws
   * once at the end rather than after each page. Returns false if browsing
   * ended or a read failed.
   */
  async loadWholeRecord(maxPages = 200): Promise<boolean> {
    const target = this.state.target;
    if (this.state.browse?.kind !== 'application' || !target) return false;
    if (!this.record?.verified) await this.loadOlder();
    const token = this.historyToken;
    const browse = this.state.browse;
    if (!browse || browse.kind !== 'application' || browse.error || !this.record) return false;
    this.update({ browse: { ...browse, loading: true } });
    try {
      for (let pages = 0; this.record.cursor && pages < maxPages; pages++) {
        // The gateway's largest page: each request parses a window of the file, whatever the page size.
        const raw = asObject(await this.channel.call('terminal.conversation', { workspace_id: target.workspaceId, surface_id: target.surfaceId,
          limit: RECORD_WHOLE_PAGE, cursor: this.record.cursor }, 15_000));
        if (token !== this.historyToken || this.disposed || this.state.browse?.kind !== 'application' || !this.record) return false;
        const page = parseRecordPage(raw);
        if (raw.available !== true || page.conversationId !== this.record.conversationId) break;
        this.record = { ...this.record, items: mergeTerminalItems(this.record.items, page.items), cursor: page.cursor };
      }
      this.layoutRecord({ loading: false });
      return true;
    } catch (error) {
      if (token === this.historyToken && this.state.browse) {
        this.layoutRecord({ loading: false });
        this.update({ browse: { ...this.state.browse!, error: describeError(error) } });
      }
      return false;
    }
  }

  private async loadRecordOlder(): Promise<void> {
    const target = this.state.target, browse = this.state.browse;
    if (!target || !browse || browse.loading || browse.exhausted || browse.error || !this.channel.isOpen) return;
    const token = ++this.historyToken;
    this.update({ browse: { ...browse, loading: true } });
    try {
      const record = this.record;
      if (!record?.verified) {
        // The first page, read (or confirmed by revision) after browsing began.
        const page = await this.prepareRecord(true);
        if (token !== this.historyToken || this.disposed || this.state.browse?.kind !== 'application') return;
        if (!page) {
          if (this.state.applicationScroll?.record === false) return;
          throw new Error('暂时读不到会话记录');
        }
        this.showRecord(page, true);
        return;
      }
      if (!record.cursor) { this.update({ browse: { ...this.state.browse!, loading: false, exhausted: true } }); return; }
      const raw = asObject(await this.channel.call('terminal.conversation', { workspace_id: target.workspaceId, surface_id: target.surfaceId,
        limit: RECORD_PAGE, cursor: record.cursor }, 15_000));
      if (token !== this.historyToken || this.disposed || this.state.browse?.kind !== 'application') return;
      if (raw.available !== true) { this.markRecord(false); return; }
      const page = parseRecordPage(raw);
      if (page.conversationId !== record.conversationId || page.generation !== record.generation) throw new Error('会话记录已更换，请回到底部后重新查看');
      this.showRecord(page, true, true);
    } catch (error) {
      if (token === this.historyToken && this.state.browse) this.update({ browse: { ...this.state.browse, loading: false, error: describeError(error) } });
    }
  }

  /** Freezes the view at the current live rows; call when the user scrolls away from the bottom. */
  startBrowsing(options: { freezeApplication?: boolean } = {}): void {
    if (this.state.applicationScroll && !options.freezeApplication) return;
    if (this.state.browse) return;
    this.historyCursors.clear();
    this.update({
      browse: {
        frozenRows: this.state.screen.rows,
        olderRows: [],
        cursor: null,
        started: false,
        exhausted: false,
        loading: false,
        error: null,
        liveChanged: false,
      },
    });
  }

  private cancelApplicationScroll(): void {
    this.scrollGeneration++;
    this.inspectingScroll = false;
    this.scrollingApplication = false;
    this.scrollInFlight = 0;
    this.lastScrollSentAt = -Infinity;
    this.stopApplicationScroll();
  }

  /** A new touch or explicit input stops unsent momentum immediately. */
  stopApplicationScroll(newGesture = false): void {
    this.queuedScroll = 0;
    if (this.scrollTimer !== null) clearTimeout(this.scrollTimer);
    this.scrollTimer = null;
    if (newGesture && this.state.applicationScroll?.error) {
      this.update({ applicationScroll: { ...this.state.applicationScroll, error: null } });
    }
    if (!this.scrollInFlight && this.scrollingApplication) {
      this.scrollingApplication = false;
      if (this.state.applicationScroll) this.update({ applicationScroll: { ...this.state.applicationScroll, busy: false } });
    }
  }

  /** Older relays and ordinary shells retain cursor-based scrollback. */
  async inspectScrollMode(): Promise<void> {
    const target = this.state.target;
    if (!target || !this.channel.isOpen || this.inspectingScroll || this.disposed) return;
    const generation = this.scrollGeneration;
    this.inspectingScroll = true;
    try {
      const raw = await this.channel.call('terminal.replay', { workspace_id: target.workspaceId, surface_id: target.surfaceId, anchor: 'screen', max_scrollback_rows: 0 }, 5_000);
      if (generation !== this.scrollGeneration || this.disposed) return;
      const columns = gridColumns(raw);
      if (columns !== (this.state.terminalColumns ?? null)) this.update({ terminalColumns: columns });
      const size = applicationScrollSize(raw);
      if (size) {
        const first = !this.state.applicationScroll, reading = this.pendingReading;
        // Screen-based browsing does not apply to a full-screen program.
        if (first) this.resumeLive();
        this.update({ applicationScroll: { ...size, busy: this.scrollingApplication, error: this.state.applicationScroll?.error ?? null, record: this.state.applicationScroll?.record ?? null } });
        // A place saved in its record history is found again there.
        if (first && reading) { this.pendingReading = reading; this.update({ restoringReading: true }); void this.restoreReadingPosition(); }
      } else if (this.state.applicationScroll) {
        this.cancelApplicationScroll();
        this.update({ applicationScroll: null });
      }
    } catch {
      // Capability detection must not break history on tmux or older cmux.
    } finally {
      if (generation === this.scrollGeneration) { this.inspectingScroll = false; this.scrollModeChecked = true; }
    }
  }

  /**
   * Scroll the selected application without injecting text or changing pane focus.
   * A touch drag passes `batch: 1` (one wheel unit per request, so the program
   * follows the finger) and a small `maxQueued`, dropping what the network
   * cannot keep up with instead of scrolling on after the finger lifts.
   */
  scrollApplication(lines: number, options: { maxQueued?: number; batch?: number } = {}): void {
    if (!this.state.applicationScroll || !this.state.target || !this.channel.isOpen || this.disposed || !Number.isFinite(lines)) return;
    if (this.state.applicationScroll.error) return;
    const limit = Math.max(1, Math.trunc(options.maxQueued ?? 120));
    this.scrollBatch = Math.max(1, Math.min(SCROLL_BATCH_LINES, Math.trunc(options.batch ?? SCROLL_BATCH_LINES)));
    if (this.queuedScroll && Math.sign(lines) !== Math.sign(this.queuedScroll)) this.queuedScroll = 0;
    this.queuedScroll = Math.max(-limit, Math.min(limit, this.queuedScroll + Math.trunc(lines)));
    if (this.queuedScroll) this.pumpApplicationScroll();
  }

  private pumpApplicationScroll(): void {
    if (this.scrollTimer !== null || this.scrollInFlight >= SCROLL_IN_FLIGHT || !this.queuedScroll) return;
    const delay = SCROLL_INTERVAL_MS - (Date.now() - this.lastScrollSentAt);
    if (delay > 0) {
      this.scrollTimer = setTimeout(() => { this.scrollTimer = null; this.pumpApplicationScroll(); }, delay);
      return;
    }
    const target = this.state.target, size = this.state.applicationScroll;
    if (!target || !size || !this.channel.isOpen || this.disposed) return;
    const generation = this.scrollGeneration;
    const lines = Math.sign(this.queuedScroll) * Math.min(this.scrollBatch, Math.abs(this.queuedScroll));
    this.queuedScroll -= lines;
    this.scrollInFlight++;
    this.lastScrollSentAt = Date.now();
    if (!this.scrollingApplication) {
      this.scrollingApplication = true;
      this.update({ applicationScroll: { ...size, busy: true, error: null } });
    }
    // WebSocket preserves send order. A small bounded pipeline keeps a slow
    // round trip from turning finger movement into screen-sized wheel jumps.
    void this.channel.call('terminal.scroll', { workspace_id: target.workspaceId, surface_id: target.surfaceId,
      delta_lines: lines, col: Math.floor(size.columns / 2), row: Math.floor(size.rows / 2) }, 5_000)
      .catch((error: unknown) => {
        if (generation !== this.scrollGeneration) return;
        this.cancelApplicationScroll();
        if (this.state.applicationScroll) this.update({ applicationScroll: { ...this.state.applicationScroll, busy: false, error: describeError(error) } });
      }).finally(() => {
        if (generation !== this.scrollGeneration) return;
        this.scrollInFlight--;
        if (!this.scrollInFlight && !this.queuedScroll) {
          this.scrollingApplication = false;
          if (this.state.applicationScroll) this.update({ applicationScroll: { ...this.state.applicationScroll, busy: false } });
        }
        this.pumpApplicationScroll();
      });
    this.pumpApplicationScroll();
  }

  /** Back to the live screen; drops loaded history so the next browse starts from a fresh snapshot. */
  resumeLive(): void {
    if (!this.state.browse && !this.pendingReading && !this.state.restoringReading) return;
    this.record = null;
    this.historyToken++;
    this.readingTask++;
    this.pendingReading = null;
    this.restoringPosition = false;
    if (this.state.target) this.options.saveReading?.(this.state.target, null);
    this.update({ browse: null, restoringReading: false, restoredReading: null, readingNotice: null });
  }

  /** Loads the page above what is shown. No-op while loading, after the start of history, or after an error. */
  async loadOlder(options: { retry?: boolean } = {}): Promise<void> {
    if (this.state.browse?.kind === 'application') {
      if (options.retry && this.state.browse.error) this.update({ browse: { ...this.state.browse, error: null } });
      return this.loadRecordOlder();
    }
    const target = this.state.target;
    let browse = this.state.browse;
    if (!target || !browse || browse.loading || browse.exhausted) return;
    if (browse.error && !options.retry) return;
    if (!this.channel.isOpen) return;
    const restarting = Boolean(options.retry && browse.restartRequired);
    if (restarting) {
      // Restart explicitly from today's live screen. Keeping an expired cursor
      // would fail forever; splicing a new snapshot onto old pages can duplicate
      // or skip output, so discard the old pagination boundary together.
      this.historyCursors.clear();
      browse = { frozenRows: this.state.screen.rows, olderRows: [], cursor: null, started: false, exhausted: false, loading: false, error: null, liveChanged: false };
      this.update({ browse, restoredReading: null, readingNotice: '已重新读取当前终端的历史' });
    }
    const token = ++this.historyToken;
    const first = !browse.started;
    this.update({ browse: { ...browse, loading: true, error: null } });
    try {
      const seen = new Set(this.historyCursors);
      const readPage = async (cursor: string | null, timeoutMs = 30_000): Promise<HistoryPage> => {
        const params = { workspace_id: target.workspaceId, surface_id: target.surfaceId, limit: this.historyPageLines,
          ...(cursor ? { cursor } : { tail_lines: Math.max(1, browse!.frozenRows.length || this.liveLines) }) };
        const pending = cursor ? this.preparedPages.get(cursor) : null;
        if (cursor) this.preparedPages.delete(cursor);
        const page = pending ? await pending : parseHistoryPage(await this.channel.call('surface.history', params, timeoutMs));
        if (token !== this.historyToken || !this.state.browse || this.disposed) throw new RpcCallError('history_cancelled', '已取消历史加载');
        if (page.nextCursor && (page.nextCursor === cursor || seen.has(page.nextCursor))) throw new RpcCallError('history_stalled', '历史分页没有前进，请重新读取历史');
        if (page.nextCursor && page.rows.length === 0) throw new RpcCallError('history_stalled', '历史服务重复返回空页，请重新读取历史');
        if (page.nextCursor) seen.add(page.nextCursor);
        return page;
      };
      const prepared = first ? this.preparedHistory : null;
      const preparedPage = first ? this.preparedPage : null;
      if (first) this.preparedHistory = null;
      let page = preparedPage ?? (prepared ? await prepared : null);
      if (first) this.preparedPage = null;
      if (token !== this.historyToken || !this.state.browse || this.disposed) return;
      // A cached page can precede new output. Reuse it only when its text
      // still joins the frozen screen, keeping the reading boundary exact.
      if (page && (!page.anchorRows || !alignHistory(browse.frozenRows, page.rows, page.anchorRows).matched)) page = null;
      if (!page) page = await readPage(first ? null : browse.cursor);
      else if (page.nextCursor) seen.add(page.nextCursor);
      let olderRows: readonly string[] = page.rows;
      let replacementAnchor: readonly string[] | null = null;
      if (first && page.anchorRows !== null) {
        const anchor = page.anchorRows;
        let collected = page.rows;
        let aligned = alignHistory(browse.frozenRows, collected, anchor);
        const deadline = Date.now() + HISTORY_ALIGNMENT_TIMEOUT_MS;
        // If output advanced by more than one page, these rows are NEWER than
        // the frozen screen. Walk backwards before displaying any of them.
        for (let hop = 1; page.nextCursor && !aligned.ambiguous && !(restarting && !aligned.matched) && hop < MAX_HISTORY_ALIGNMENT_PAGES && Date.now() < deadline && (!aligned.matched || aligned.olderRows.length === 0); hop++) {
          page = await readPage(page.nextCursor, Math.max(100, deadline - Date.now()));
          collected = [...page.rows, ...collected];
          aligned = alignHistory(browse.frozenRows, collected, anchor);
        }
        if (aligned.matched) olderRows = aligned.olderRows;
        else {
          // Never erase a frozen screen just because the computer was cleared
          // or history rotated. Replacing different text needs an explicit
          // reload; equivalent repeated rows can safely use the snapshot split.
          if (!restarting && !sameVisibleRows(browse.frozenRows, anchor)) throw new RpcCallError('history_alignment', '历史与当前画面无法衔接，当前内容已保留；请重新加载历史');
          olderRows = collected; replacementAnchor = anchor;
        }
      }
      const current = this.state.browse;
      if (token !== this.historyToken || !current) return;
      this.historyCursors = seen;
      this.update({
        browse: {
          ...current,
          frozenRows: replacementAnchor ?? current.frozenRows,
          olderRows: first ? olderRows : [...page.rows, ...current.olderRows],
          cursor: page.nextCursor,
          started: true,
          exhausted: page.nextCursor === null,
          loading: false,
          error: null,
          restartRequired: false,
          liveChanged: replacementAnchor !== null || current.liveChanged,
        },
        ...(replacementAnchor !== null ? { restoredReading: null, readingNotice: '历史已按电脑保存的完整快照重新对齐' } : {}),
      });
    } catch (error) {
      const current = this.state.browse;
      if (token !== this.historyToken || !current) return;
      const expired = error instanceof RpcCallError && /expired|过期|invalid.*cursor|cursor.*invalid/i.test(error.message);
      this.update({
        browse: {
          ...current,
          loading: false,
          error: expired ? '历史快照已过期，请重新加载历史' : describeError(error),
          restartRequired: expired || (error instanceof RpcCallError && ['history_stalled', 'history_alignment'].includes(error.code)),
        },
      });
    }
  }

  // MARK: Input

  /**
   * Input brings the prompt back: it ends history browsing and stops program
   * scrolling at once. Otherwise `inputRevision` moves at most every
   * INPUT_REVEAL_MS while typing, since each move redraws the terminal.
   */
  private revealInputResult(): void {
    if (!this.state.target || !this.channel.isOpen || this.disposed) return;
    const reading = Boolean(this.state.browse || this.pendingReading || this.state.restoringReading);
    this.resumeLive();
    this.stopApplicationScroll();
    const now = Date.now();
    if (!reading && now - this.lastReveal < INPUT_REVEAL_MS) return;
    this.lastReveal = now;
    this.update({ inputRevision: (this.state.inputRevision ?? 0) + 1 });
  }

  sendText(text: string): void {
    if (text.length === 0) return;
    this.revealInputResult();
    const last = this.queue[this.queue.length - 1];
    // Coalesce text typed while the previous request is in flight.
    if (last && last.kind === 'text') last.text += text;
    else this.queue.push({ kind: 'text', text });
    void this.pump();
  }

  sendKey(key: Key): void {
    this.revealInputResult();
    this.queue.push({ kind: 'key', key });
    void this.pump();
  }

  /**
   * Explicit prompt controls are pinned to the question the user actually
   * saw. Pressed while earlier input is on its way (↓ ↓ Enter in quick
   * succession), they wait their turn like any other key: moving the
   * highlight leaves the question the same, so a later key still goes.
   */
  sendPromptKeys(keys: readonly Key[], screen: ScreenState): Promise<SendReceipt> {
    const target = this.state.target;
    if (!target || !this.channel.isOpen || this.disposed || !sameQuestion(screen.rows, this.state.screen.rows)
      || !keys.length || keys.length > 12 || keys.some(key => !['up', 'down', 'left', 'right', 'enter', 'escape', 'space', 'tab'].includes(key.name) || key.modifiers?.length)) {
      return Promise.resolve({ status: 'not_sent', message: '终端状态已变化，请查看最新选项后重试' });
    }
    this.revealInputResult();
    return new Promise(resolve => {
      this.queue.push({ kind: 'promptKeys', keys, screen, target, resolve });
      void this.pump();
    });
  }

  /**
   * Command mode: the line, then Enter. An empty line sends just Enter. A
   * line with line breaks goes as one paste plus Enter, so the program gets
   * it once instead of a submission per line; where the computer cannot
   * paste it is typed as before. `paste`: always paste it (a bound
   * conversation), never type it.
   */
  submitLine(line: string, options: { paste?: boolean } = {}): Promise<SendReceipt> {
    const target = this.state.target;
    if (!target || !this.channel.isOpen || this.disposed) {
      return Promise.resolve({ status: 'not_sent', message: '尚未连接，草稿已保留' });
    }
    this.revealInputResult();
    return new Promise((resolve) => {
      this.queue.push({ kind: 'line', text: line, target, paste: options.paste, resolve });
      void this.pump();
    });
  }

  /**
   * Puts `text` at the prompt as a paste (`terminal.paste`: the program gets
   * it bracketed, so a line break edits instead of submitting) without
   * pressing Enter. Text over PASTE_CHUNK_CHARS goes as several pastes, in
   * order. Where the computer cannot paste (an older gateway, a tmux source,
   * a shared window), `fallback` is typed instead; without one the receipt
   * says not_sent.
   */
  pasteText(text: string, fallback: readonly KeyAction[] | null): Promise<SendReceipt> {
    const target = this.state.target;
    if (!text) return Promise.resolve({ status: 'not_sent', message: '没有要粘贴的内容' });
    if (!target || !this.channel.isOpen || this.disposed) return Promise.resolve({ status: 'not_sent', message: '尚未连接，没有发送' });
    this.revealInputResult();
    return new Promise((resolve) => {
      this.queue.push({ kind: 'paste', text, target, fallback, resolve });
      void this.pump();
    });
  }

  clearInputError(): void {
    if (this.state.input.error) this.update({ input: { ...this.state.input, error: null } });
  }

  /** Input not yet acknowledged. The key bar stops auto-repeat while this backs up. */
  get pendingInput(): number {
    return this.queue.length + (this.pumping ? 1 : 0);
  }

  /**
   * Sends queued input one request at a time. Through the broker, concurrent
   * requests are not guaranteed to reach cmux in order. A failed request is
   * reported (never sent again), and what was queued behind it is dropped.
   */
  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    // A new round of input starts without the last round's failure, once that has been seen.
    if (this.state.input.error && Date.now() - this.errorAt >= INPUT_ERROR_HOLD_MS) this.update({ input: { ...this.state.input, error: null } });
    while (this.queue.length > 0) {
      const target = this.state.target;
      const item = this.queue.shift()!;
      if (!target) {
        if ('resolve' in item) item.resolve({ status: 'not_sent', message: '终端已关闭，草稿已保留' });
        this.discardQueuedInput();
        break;
      }
      this.watchStall();
      try {
        let note: string | undefined;
        if (item.kind === 'text' || item.kind === 'key') {
          // Everything typed while the previous request was in flight goes in
          // one request: a burst of keys costs one round trip, not one each.
          const burst: KeystrokeItem[] = [item];
          while (this.queue[0]?.kind === 'text' || this.queue[0]?.kind === 'key') burst.push(this.queue.shift() as KeystrokeItem);
          await this.sendKeystrokes(target, burst);
        } else {
          note = await this.execute(target, item);
        }
        if ('resolve' in item) item.resolve({ status: 'sent', message: note ?? '已送达终端' });
      } catch (failure) {
        // Input queued behind it builds on it: a later Enter could run a line
        // whose earlier part never arrived (half an `rm -rf …`). Drop it.
        const dropped = this.queue.length > 0;
        this.discardQueuedInput();
        const reason = describeError(failure);
        const certain = notSent(failure);
        const after = dropped ? '，之后的输入已取消' : '';
        // Kept at least INPUT_ERROR_HOLD_MS, even while typing goes on.
        this.errorAt = Date.now();
        this.update({ input: { ...this.state.input, error: certain ? `输入没有发送：${reason}${after}` : `输入没有确认送达：${reason}${after}。请先查看终端，需要时再输入一次` } });
        if ('resolve' in item) {
          item.resolve(certain ? { status: 'not_sent', message: `尚未发送：${reason}，草稿已保留` }
            : { status: 'unknown', message: `发送未确认：${reason}。请先检查终端，再决定是否重发` });
        }
      } finally {
        this.settleStall();
      }
    }
    this.pumping = false;
  }

  /** Marks input busy if the request now leaving goes unanswered for INPUT_STALL_MS. */
  private watchStall(): void {
    if (this.stallTimer) clearTimeout(this.stallTimer);
    this.stallTimer = setTimeout(() => {
      this.stallTimer = null;
      if (this.pumping && !this.disposed && !this.state.input.busy) this.update({ input: { ...this.state.input, busy: true } });
    }, INPUT_STALL_MS);
  }

  private settleStall(): void {
    if (this.stallTimer) clearTimeout(this.stallTimer);
    this.stallTimer = null;
    if (this.state.input.busy && !this.disposed) this.update({ input: { ...this.state.input, busy: false } });
  }

  private async sendKeystrokes(target: SurfaceTarget, items: readonly KeystrokeItem[]): Promise<void> {
    if (await this.sendBatch(target, items.map((item) => item.kind === 'text' ? { text: item.text } : { key: encodeKey(item.key) }))) return;
    for (const item of items) {
      if (this.disposed || !sameTarget(this.state.target, target)) throw new RpcCallError('target_changed', '终端已切换');
      await this.execute(target, item);
    }
  }

  /**
   * Ordered `surface.input` requests, within the hub's limits per request;
   * the gateway sends each item to the named terminal, so no focus change is
   * needed. Returns false when the gateway predates it (nothing was sent),
   * and the caller uses the one-request-per-item path.
   */
  private async sendBatch(target: SurfaceTarget, items: readonly BatchItem[]): Promise<boolean> {
    if (!items.length) return true;
    if (this.batchInput === 'no') return false;
    const batches = inputBatches(items);
    for (let index = 0; index < batches.length; index++) {
      if (this.disposed) throw new RpcCallError('closed', '终端已关闭');
      try {
        await this.channel.call('surface.input', { workspace_id: target.workspaceId, surface_id: target.surfaceId, items: batches[index] });
        this.batchInput = 'yes';
      } catch (error) {
        if (index === 0 && this.batchInput !== 'yes' && batchUnsupported(error)) {
          this.batchInput = 'no';
          return false;
        }
        throw error;
      }
    }
    return true;
  }

  /**
   * `terminal.paste`, PASTE_CHUNK_CHARS at a time; only the last piece may
   * submit. Null when the gateway refused the first piece: it checks before
   * pasting anything, so nothing reached the terminal, and the refusal is
   * remembered for the source until the connection changes. `note`: the
   * text arrived but its Enter did not.
   */
  private async paste(target: SurfaceTarget, text: string, submit: boolean): Promise<{ note?: string } | null> {
    const ids = { workspace_id: target.workspaceId, surface_id: target.surfaceId };
    const pieces = pastePieces(text.replace(/\r\n?/g, '\n'), PASTE_CHUNK_CHARS);
    const source = sourceOf(target.surfaceId);
    const support = (shape: PasteShape) => `${source}\n${shape}`;
    const shapeOf = (index: number): PasteShape => submit && index === pieces.length - 1 ? 'submit' : pieces[index].trim() ? 'insert' : 'blank';
    if (this.pasteSupport.get(support(shapeOf(0))) === 'no') return null;
    let note: string | undefined;
    for (let index = 0; index < pieces.length; index++) {
      if (index > 0 && this.disposed) throw new RpcCallError('closed', '终端已关闭');
      const shape = shapeOf(index);
      let result: unknown;
      try {
        result = await this.channel.call('terminal.paste', { ...ids, text: pieces[index], ...(shape === 'submit' ? { submit_key: 'return' } : {}) });
      } catch (error) {
        if (index === 0 && pasteRefused(error)) {
          for (const each of batchUnsupported(error) ? PASTE_SHAPES : [shape]) this.pasteSupport.set(support(each), 'no');
          return null;
        }
        throw error;
      }
      this.pasteSupport.set(support(shape), 'yes');
      const answer = asObject(result);
      if (shape !== 'submit' && answer.submitted === true) {
        // A gateway that passed the missing submit key on to cmux, whose default is Return.
        this.pasteSupport.set(support('insert'), 'no'); this.pasteSupport.set(support('blank'), 'no');
        throw new RpcCallError('paste_submitted', '电脑端在粘贴后按下了回车（电脑端版本不匹配），之后改为逐行输入；请更新电脑端的 Panecast');
      }
      if (shape === 'submit' && answer.submitted === false) note = '已粘贴到终端，但回车没有按下，请在终端里按一次回车';
    }
    return { note };
  }

  private async execute(target: SurfaceTarget, item: InputItem, expectedScreen?: ScreenState): Promise<string | undefined> {
    const ids = { workspace_id: target.workspaceId, surface_id: target.surfaceId };
    if (item.kind === 'promptKeys') {
      if (!sameQuestion(this.state.screen.rows, item.screen.rows) || !sameTarget(target, item.target)) throw unsent('target_changed', '提问已变化，请查看最新内容');
      if (await this.sendBatch(target, item.keys.map((key) => ({ key: encodeKey(key) })))) return;
      for (let index = 0; index < item.keys.length; index++) {
        if (this.disposed || !sameTarget(this.state.target, target)) throw new RpcCallError('target_changed', '终端已切换');
        await this.execute(target, { kind: 'key', key: item.keys[index] }, index === 0 ? item.screen : undefined);
      }
      return;
    }
    if (item.kind === 'paste') {
      if (!sameTarget(target, item.target)) throw unsent('target_changed', '终端已切换');
      const pasted = await this.paste(target, item.text, false);
      if (pasted) return pasted.note;
      if (!item.fallback) throw unsent('paste_unsupported', '电脑端的 Panecast 版本较旧，还不能直接粘贴多行内容');
      await this.sendKeystrokes(target, item.fallback);
      return;
    }
    if (item.kind === 'line') {
      if (!sameTarget(target, item.target)) throw unsent('target_changed', '终端已切换');
      if (item.text && (item.paste || /[\r\n]/.test(item.text))) {
        const pasted = await this.paste(target, item.text, true);
        if (pasted) return pasted.note;
        if (item.paste) throw unsent('paste_unsupported', '电脑端的 Panecast 版本较旧，还不能发多行内容');
      }
      if (await this.sendBatch(target, [...(item.text ? [{ text: item.text }] : []), { key: encodeKey(Keys.enter) }])) return;
      if (item.text) await this.channel.call('surface.send_text', { ...ids, text: item.text });
      if (this.disposed || !sameTarget(this.state.target, target)) throw new RpcCallError('target_changed', '终端已切换');
      await this.execute(target, { kind: 'key', key: { name: 'enter' } });
      return;
    }
    if (item.kind === 'text') {
      await this.channel.call('surface.send_text', { ...ids, text: item.text });
      return;
    }
    // `surface.send_key` synthesizes a key event that lands on whichever pane
    // cmux has focused, so pin focus to the surface we show first.
    const now = Date.now();
    const focus = this.lastFocus;
    if (!focus || focus.surfaceId !== target.surfaceId || now - focus.at > FOCUS_REUSE_MS) {
      await this.channel.call('surface.focus', ids);
    }
    if (this.disposed || !sameTarget(this.state.target, target)) throw new RpcCallError('target_changed', '终端已切换');
    if (expectedScreen && !sameQuestion(expectedScreen.rows, this.state.screen.rows)) throw unsent('prompt_changed', '提问已变化，请查看最新内容');
    await this.channel.call('surface.send_key', { ...ids, key: encodeKey(item.key) });
    this.lastFocus = { surfaceId: target.surfaceId, at: Date.now() };
  }

  private update(patch: Partial<TerminalState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
}

export type HistoryPage = { rows: string[]; anchorRows: string[] | null; nextCursor: string | null };

function gridColumns(value: unknown): number | null {
  if (!value || typeof value !== 'object' || !('render_grid' in value)) return null;
  const grid = value.render_grid;
  if (!grid || typeof grid !== 'object' || !('columns' in grid) || !Number.isSafeInteger(grid.columns)) return null;
  const columns = Number(grid.columns);
  return columns >= 1 && columns <= 2000 ? columns : null;
}

function applicationScrollSize(value: unknown): { columns: number; rows: number } | null {
  if (!value || typeof value !== 'object' || !('render_grid' in value)) return null;
  const grid = value.render_grid;
  if (!grid || typeof grid !== 'object' || !('active_screen' in grid) || grid.active_screen !== 'alternate'
    || !('modes' in grid) || !Array.isArray(grid.modes)
    || !grid.modes.some((mode) => mode && mode.ansi === false && [1000, 1002, 1003].includes(mode.code) && mode.on === true)
    || !('columns' in grid) || !Number.isSafeInteger(grid.columns) || Number(grid.columns) < 1
    || !('rows' in grid) || !Number.isSafeInteger(grid.rows) || Number(grid.rows) < 1) return null;
  return { columns: Number(grid.columns), rows: Number(grid.rows) };
}

export function parseHistoryPage(value: unknown): HistoryPage {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new RpcCallError('bad_response', '历史记录格式不对');
  const record = value as Record<string, unknown>;
  const rows = stringArray(record.rows);
  if (!rows) throw new RpcCallError('bad_response', '历史记录格式不对');
  const anchorRows = stringArray(record.anchor_rows);
  if (record.anchor_rows !== undefined && record.anchor_rows !== null && !anchorRows) throw new RpcCallError('bad_response', '历史记录位置格式不对');
  if (record.next_cursor !== null && typeof record.next_cursor !== 'string') throw new RpcCallError('bad_response', '历史分页信息不完整，请重试');
  const nextCursor = typeof record.next_cursor === 'string' && record.next_cursor.length > 0 ? record.next_cursor : null;
  return { rows, anchorRows, nextCursor };
}

/**
 * Joins the first history page onto the frozen live rows.
 *
 * The relay snapshots scrollback when the page is requested, which can be a
 * little after browsing froze the view; output in between makes the
 * snapshot's tail (`anchorRows`) run past `frozenRows`. Find where the frozen
 * rows sit in `history + anchor` and keep only what lies above them, so the
 * rows being read do not move. Without a match, fall back to the snapshot's
 * own split.
 */
export function stitchFirstPage(
  frozenRows: readonly string[],
  historyRows: readonly string[],
  anchorRows: readonly string[],
): string[] {
  return alignHistory(frozenRows, historyRows, anchorRows).olderRows;
}

function stringArray(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((v) => typeof v === 'string') ? (value as string[]) : null;
}

/** A positive whole number of rows, or `fallback`. */
function sanitizeLines(lines: number, fallback: number): number {
  return Number.isFinite(lines) && lines >= 1 ? Math.round(lines) : fallback;
}

function sameTarget(a: SurfaceTarget | null, b: SurfaceTarget | null): boolean {
  return a?.workspaceId === b?.workspaceId && a?.surfaceId === b?.surfaceId;
}

/**
 * The next program-history request size: one unit larger while the current
 * size moved at most half the target (and the larger size is not known to
 * overshoot), one smaller once it moved more than the target.
 */
const asObject = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const optionalString = (value: unknown): string | null => typeof value === 'string' && value ? value : null;

function parseRecordPage(raw: Record<string, unknown>): RecordPage {
  const items = Array.isArray(raw.items) ? raw.items.map(agentItem).filter((item): item is AgentItem => item !== null) : [];
  return { items: mergeTerminalItems([], items), cursor: optionalString(raw.next_cursor), conversationId: optionalString(raw.conversation_id),
    generation: optionalString(raw.generation) ?? '', revision: optionalString(raw.revision), branch: optionalString(raw.branch), active: raw.active === true, at: Date.now() };
}

export function describeError(error: unknown): string {
  if (error instanceof RpcCallError) {
    if (error.code === 'not_connected' || error.code === 'closed') return '没有连上电脑';
    if (error.code === 'timeout') return '电脑没有响应，请稍后再试';
    return error.message || error.code;
  }
  return error instanceof Error ? error.message : String(error);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A gateway from before `surface.input`: the method is unknown, so nothing was sent. */
export function batchUnsupported(error: unknown): boolean {
  if (!(error instanceof RpcCallError)) return false;
  if (error.code === 'method_not_found' || error.code === '-32601') return true;
  return /method[_ ]not[_ ]found|unknown method|统一网关不支持这个操作/i.test(error.message);
}

/**
 * Whether two screens ask the same question (terminalPrompt's decision: its
 * heading and choices, not which one is highlighted). Screens without one
 * must show the same rows.
 */
export function sameQuestion(a: readonly string[], b: readonly string[]): boolean {
  const first = terminalDecision(plainTerminalRows(a))?.id ?? null, second = terminalDecision(plainTerminalRows(b))?.id ?? null;
  return first !== null || second !== null ? first === second : sameVisibleRows(a, b);
}

const PASTE_SHAPES: readonly PasteShape[] = ['submit', 'insert', 'blank'];

/** A gateway checks a paste before pasting anything: these answers mean nothing reached the terminal. */
function pasteRefused(error: unknown): boolean {
  return error instanceof RpcCallError && (error.code === 'invalid_params' || error.code === '-32602' || batchUnsupported(error));
}

/** The hub's source of a terminal (`<source>~<surface>`); a computer without the hub has one. */
export function sourceOf(surfaceId: string): string {
  const mark = surfaceId.indexOf('~');
  return mark < 0 ? '' : surfaceId.slice(0, mark);
}

const NOT_SENT = { notSent: true } as const;
/** A failure found before anything was sent. */
function unsent(code: string, message: string): RpcCallError {
  return new RpcCallError(code, message, NOT_SENT);
}
function notSent(error: unknown): boolean {
  if (!(error instanceof RpcCallError)) return false;
  return error.code === 'not_connected' || error.data === NOT_SENT;
}

type BatchItem = { text: string } | { key: string };

/**
 * `surface.input` items as requests within the hub's limits (items and text
 * per request, text per item), in order. Longer text is cut, never inside a
 * surrogate pair.
 */
export function inputBatches(items: readonly BatchItem[], maxItems = INPUT_BATCH_ITEMS, maxChars = INPUT_BATCH_CHARS, itemChars = INPUT_ITEM_CHARS): BatchItem[][] {
  const batches: BatchItem[][] = [];
  let current: BatchItem[] = [], chars = 0;
  const flush = () => { if (current.length) batches.push(current); current = []; chars = 0; };
  for (const item of items) {
    if (!('text' in item)) {
      if (current.length >= maxItems) flush();
      current.push(item);
      continue;
    }
    let text = item.text;
    while (text) {
      if (current.length >= maxItems || chars >= maxChars) flush();
      let take = Math.min(text.length, maxChars - chars, itemChars);
      if (take < text.length && isHighSurrogate(text.charCodeAt(take - 1))) take--;
      if (take <= 0) {
        if (chars > 0) { flush(); continue; }
        take = Math.min(2, text.length);
      }
      current.push({ text: text.slice(0, take) });
      chars += take;
      text = text.slice(take);
    }
  }
  flush();
  return batches;
}

/**
 * `text` in pieces of at most `size` UTF-16 units, each cut just after a
 * line break when one falls in its second half, never inside a surrogate
 * pair. An empty text is one empty piece.
 */
export function pastePieces(text: string, size: number): string[] {
  const pieces: string[] = [];
  let rest = text;
  while (rest.length > size) {
    let cut = rest.lastIndexOf('\n', size - 1) + 1;
    if (cut < size / 2) cut = size;
    if (isHighSurrogate(rest.charCodeAt(cut - 1))) cut--;
    pieces.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  pieces.push(rest);
  return pieces;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}
