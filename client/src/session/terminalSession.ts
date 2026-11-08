import { RpcCallError, type ConnectionStatus } from '../protocol/connection';
import type { PushFrame } from '../protocol/frames';
import { encodeKey, type Key } from '../protocol/keys';
import { applyDiff, applyFull, EMPTY_SCREEN, screenHash, type ScreenState } from '../protocol/screen';
import { locateReadingPosition, type ReadingPosition } from './readingPosition';
import { alignHistory, sameVisibleRows } from './historyAlignment';
import { applicationPageHasPayload, olderApplicationRows, sameApplicationViewport, type ApplicationHistoryPage } from './applicationHistory';

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
};

export type SubscriptionState = 'none' | 'subscribing' | 'live' | 'error';

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
  /** Alternate-screen programs own their history and consume mouse-wheel input. */
  applicationScroll?: { columns: number; rows: number; busy: boolean; error: string | null } | null;
};

export type SendReceipt = { status: 'sent' | 'not_sent' | 'unknown'; message: string };
type InputItem = { kind: 'text'; text: string } | { kind: 'key'; key: Key }
  | { kind: 'line'; text: string; target: SurfaceTarget; resolve: (result: SendReceipt) => void };

export type TerminalSessionOptions = {
  /** Rows kept on the live screen; `surface.subscribe`'s `lines`. */
  liveLines?: number;
  historyPageLines?: number;
  log?: (message: string) => void;
  readingForTarget?: (target: SurfaceTarget) => ReadingPosition | null;
  saveReading?: (target: SurfaceTarget, position: ReadingPosition | null) => void;
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
  private applicationAnchor: readonly string[] | null = null;
  private applicationTravel = 0;
  private applicationPage: { accept: (rows: readonly string[]) => void; cancel: () => void } | null = null;
  /** An unsubscribe + subscribe is in flight (resync or a live-lines change). Only one at a time. */
  private replacing = false;
  private lastResyncAt = 0;
  private resyncCooldown = RESYNC_MIN_COOLDOWN_MS;
  private queue: InputItem[] = [];
  private pumping = false;
  private lastFocus: { surfaceId: string; at: number } | null = null;
  private disposed = false;
  private pendingReading: ReadingPosition | null = null;
  private restoringPosition = false;
  private readingTask = 0;
  private selectionIntent = 0;
  private scrollGeneration = 0;
  private inspectingScroll = false;
  private scrollModeChecked = false;
  private queuedScroll = 0;
  private scrollingApplication = false;
  private scrollInFlight = 0;
  private scrollTimer: ReturnType<typeof setTimeout> | null = null;
  private lastScrollSentAt = -Infinity;
  private liveLines: number;
  /** `lines` sent with the latest `surface.subscribe`. */
  private subscribedLines: number | null = null;
  private readonly historyPageLines: number;
  private readonly log: (message: string) => void;

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
      if (item.kind === 'line') item.resolve({ status: 'not_sent', message: '尚未发送，草稿已保留' });
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
    this.disposed = true;
    this.restoreApplicationViewport();
    for (const dispose of this.disposers) dispose();
    this.disposers = [];
    this.subscribeToken++;
    this.historyToken++;
    this.preparedHistory = null;
    this.preparedPage = null; this.preparedPages.clear();
    this.cancelApplicationScroll();
    this.scrollModeChecked = false;
    this.discardQueuedInput();
    this.listeners.clear();
  }

  // MARK: Target and subscription

  setTarget(target: SurfaceTarget | null): void {
    this.selectionIntent++;
    const previous = this.state.target;
    if (sameTarget(previous, target)) return;
    this.restoreApplicationViewport();
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
    this.readingTask++;
    this.restoringPosition = false;
    this.pendingReading = target ? this.options.readingForTarget?.(target) ?? null : null;
    this.update({
      target,
      screen: EMPTY_SCREEN,
      subscription: 'none',
      subscriptionError: null,
      browse: null,
      input: { busy: this.pumping, error: null },
      restoredReading: null,
      restoringReading: this.pendingReading !== null,
      readingNotice: null,
      applicationScroll: null,
    });
    if (target) void this.subscribeCurrent();
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
        this.update({ subscription: 'error', subscriptionError: describeError(error) });
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
    if (this.state.subscription !== 'none') this.update({ subscription: 'none' });
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
    this.applicationPage?.accept(screen.rows);
    const browse = this.state.browse;
    const rowsChanged = screen.rows !== this.state.screen.rows;
    if (browse && browse.kind !== 'application' && rowsChanged && !browse.liveChanged) {
      this.update({ screen, browse: { ...browse, liveChanged: true } });
    } else {
      this.update({ screen });
    }
    if (this.pendingReading && !this.restoringPosition) void this.restoreReadingPosition();
  }

  rememberReading(position: ReadingPosition): void {
    if (this.state.browse?.kind === 'application') return;
    if (this.state.target && !this.state.restoringReading) this.options.saveReading?.(this.state.target, position);
  }

  private async restoreReadingPosition(): Promise<void> {
    const position = this.pendingReading, target = this.state.target;
    if (!position || !target) return;
    this.restoringPosition = true;
    const token = ++this.readingTask;
    this.startBrowsing();
    let found: number | null = null;
    // Bound recovery work. The relay's history may have rotated since the last visit.
    for (let page = 0; page <= 24; page++) {
      if (this.disposed || token !== this.readingTask || !sameTarget(target, this.state.target)) return;
      const browse = this.state.browse;
      if (!browse) break;
      const rows = [...browse.olderRows, ...browse.frozenRows];
      found = locateReadingPosition(rows, position);
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
    const target = this.state.target, rows = this.state.screen.rows;
    if (!this.scrollModeChecked || this.preparedHistory || this.state.browse || this.state.applicationScroll || !rows.length
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

  /** Keep captured application history in the same native list as the first screen. */
  startApplicationHistory(): void {
    if (!this.state.applicationScroll || this.state.browse || !this.state.screen.rows.length) return;
    this.stopApplicationScroll(true);
    this.applicationAnchor = this.state.screen.rows;
    this.update({ browse: { kind: 'application', frozenRows: this.state.screen.rows, olderRows: [],
      cursor: null, started: false, exhausted: false, loading: false, error: null, liveChanged: false } });
  }

  private restoreApplicationViewport(): void {
    this.applicationPage?.cancel();
    this.applicationPage = null;
    const travel = this.applicationTravel;
    this.applicationTravel = 0;
    this.applicationAnchor = null;
    const target = this.state.target, size = this.state.applicationScroll;
    if (travel && target && size && this.channel.isOpen) {
      void this.channel.call('terminal.scroll', { workspace_id: target.workspaceId, surface_id: target.surfaceId,
        delta_lines: -travel, col: Math.floor(size.columns / 2), row: Math.floor(size.rows / 2) }, 5000).catch(() => {});
    }
  }

  private async loadApplicationOlder(): Promise<void> {
    const target = this.state.target, browse = this.state.browse, size = this.state.applicationScroll;
    const anchor = this.applicationAnchor;
    if (!target || !size || !browse || browse.loading || browse.exhausted || browse.error || !anchor || !this.channel.isOpen) return;
    const token = ++this.historyToken;
    this.update({ browse: { ...browse, loading: true } });
    let finish!: (page: ApplicationHistoryPage | null) => void;
    let accepted = false;
    const result = new Promise<ApplicationHistoryPage | null>((resolve) => { finish = resolve; });
    const pending = this.applicationPage = {
      accept: (rows) => {
        if (accepted) return;
        const page = olderApplicationRows(anchor, rows);
        if (page && applicationPageHasPayload(anchor, page)) { accepted = true; this.applicationAnchor = rows; finish(page); }
      },
      cancel: () => finish(null),
    };
    let timer: ReturnType<typeof setTimeout> | null = null;
    const currentTarget = () => {
      if (token !== this.historyToken || this.disposed) throw new RpcCallError('history_cancelled', '已取消历史加载');
    };
    const scroll = async (delta: number) => {
      currentTarget();
      this.applicationTravel += delta;
      await this.channel.call('terminal.scroll', { workspace_id: target.workspaceId, surface_id: target.surfaceId,
        delta_lines: delta, col: Math.floor(size.columns / 2), row: Math.floor(size.rows / 2) }, 5000);
      currentTarget();
    };
    const read = async () => {
      currentTarget();
      const fresh = await this.channel.call<{ text?: string }>('surface.read_text', {
        workspace_id: target.workspaceId, surface_id: target.surfaceId, lines: size.rows,
      }, 5000);
      currentTarget();
      if (typeof fresh.text !== 'string') throw new Error('无法读取程序的历史画面');
      return fresh.text.split('\n');
    };
    try {
      // cmux and the program can each multiply wheel input. One request can
      // already reveal many rows; scaling by grid height can skip a full screen.
      const lines = 1;
      await scroll(lines);
      timer = setTimeout(() => finish(null), 1500);
      let page = await result;
      if (!page && token === this.historyToken) {
        const rows = await read();
        page = olderApplicationRows(anchor, rows);
        if (page) this.applicationAnchor = rows;
        else if (!sameVisibleRows(anchor, rows) && !sameApplicationViewport(anchor, rows)) throw new Error('程序画面变化，历史暂时无法衔接；已保留当前阅读内容');
      }
      const current = this.state.browse;
      if (token !== this.historyToken || !current || this.disposed) return;
      this.update({ browse: { ...current,
        frozenRows: page ? current.frozenRows.slice(Math.max(0, page.replacedRows - current.olderRows.length)) : current.frozenRows,
        olderRows: page ? [...page.rows, ...current.olderRows.slice(page.replacedRows)] : current.olderRows,
        started: true, loading: false, exhausted: page === null } });
    } catch (error) {
      if (token === this.historyToken && this.state.browse) this.update({ browse: { ...this.state.browse, loading: false, error: describeError(error) } });
    } finally {
      if (timer !== null) clearTimeout(timer);
      if (this.applicationPage === pending) this.applicationPage = null;
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
      const size = applicationScrollSize(raw);
      if (size) {
        if (!this.state.applicationScroll) this.resumeLive();
        this.update({ applicationScroll: { ...size, busy: this.scrollingApplication, error: this.state.applicationScroll?.error ?? null } });
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

  /** Scroll the selected application without injecting text or changing pane focus. */
  scrollApplication(lines: number): void {
    if (!this.state.applicationScroll || !this.state.target || !this.channel.isOpen || this.disposed || !Number.isFinite(lines)) return;
    if (this.state.applicationScroll.error) return;
    if (this.queuedScroll && Math.sign(lines) !== Math.sign(this.queuedScroll)) this.queuedScroll = 0;
    this.queuedScroll = Math.max(-120, Math.min(120, this.queuedScroll + Math.trunc(lines)));
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
    const lines = Math.sign(this.queuedScroll) * Math.min(SCROLL_BATCH_LINES, Math.abs(this.queuedScroll));
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
    this.restoreApplicationViewport();
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
      return this.loadApplicationOlder();
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

  private revealInputResult(): void {
    if (!this.state.target || !this.channel.isOpen || this.disposed) return;
    this.resumeLive();
    this.stopApplicationScroll();
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

  /** Command mode: the line, then Enter. An empty line sends just Enter. */
  submitLine(line: string): Promise<SendReceipt> {
    const target = this.state.target;
    if (!target || !this.channel.isOpen || this.disposed) {
      return Promise.resolve({ status: 'not_sent', message: '尚未连接，草稿已保留' });
    }
    this.revealInputResult();
    return new Promise((resolve) => {
      this.queue.push({ kind: 'line', text: line, target, resolve });
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
   * requests are not guaranteed to reach cmux in order.
   */
  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    this.update({ input: { busy: true, error: null } });
    let error: string | null = null;
    while (this.queue.length > 0) {
      const target = this.state.target;
      const item = this.queue.shift()!;
      if (!target) {
        if (item.kind === 'line') item.resolve({ status: 'not_sent', message: '终端已关闭，草稿已保留' });
        this.discardQueuedInput();
        break;
      }
      try {
        await this.execute(target, item);
        if (item.kind === 'line') item.resolve({ status: 'sent', message: '已送达终端' });
      } catch (failure) {
        this.discardQueuedInput();
        error = describeError(failure);
        if (item.kind === 'line') item.resolve({ status: 'unknown', message: `发送未确认：${error}。请先检查终端，再决定是否重发` });
      }
    }
    this.pumping = false;
    this.update({ input: { busy: false, error } });
  }

  private async execute(target: SurfaceTarget, item: InputItem): Promise<void> {
    const ids = { workspace_id: target.workspaceId, surface_id: target.surfaceId };
    if (item.kind === 'line') {
      if (!sameTarget(target, item.target)) throw new RpcCallError('target_changed', '终端已切换');
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
    await this.channel.call('surface.send_key', { ...ids, key: encodeKey(item.key) });
    this.lastFocus = { surfaceId: target.surfaceId, at: Date.now() };
  }

  private update(patch: Partial<TerminalState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
}

export type HistoryPage = { rows: string[]; anchorRows: string[] | null; nextCursor: string | null };

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
