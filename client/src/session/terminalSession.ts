import { RpcCallError, type ConnectionStatus } from '../protocol/connection';
import type { PushFrame } from '../protocol/frames';
import { encodeKey, type Key } from '../protocol/keys';
import { applyDiff, applyFull, EMPTY_SCREEN, screenHash, type ScreenState } from '../protocol/screen';

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
  frozenRows: readonly string[];
  olderRows: readonly string[];
  cursor: string | null;
  started: boolean;
  exhausted: boolean;
  loading: boolean;
  error: string | null;
  liveChanged: boolean;
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
};

type InputItem = { kind: 'text'; text: string } | { kind: 'key'; key: Key };

export type TerminalSessionOptions = {
  /** Rows kept on the live screen; `surface.subscribe`'s `lines`. */
  liveLines?: number;
  historyPageLines?: number;
  log?: (message: string) => void;
};

const SUBSCRIBE_ATTEMPTS = 4;
const RESYNC_MIN_COOLDOWN_MS = 3_000;
const RESYNC_MAX_COOLDOWN_MS = 60_000;
/** Re-pin cmux focus before a key unless we did so for this surface very recently. */
const FOCUS_REUSE_MS = 1_500;

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
  private resyncing = false;
  private lastResyncAt = 0;
  private resyncCooldown = RESYNC_MIN_COOLDOWN_MS;
  private queue: InputItem[] = [];
  private pumping = false;
  private lastFocus: { surfaceId: string; at: number } | null = null;
  private readonly liveLines: number;
  private readonly historyPageLines: number;
  private readonly log: (message: string) => void;

  constructor(
    private readonly channel: RpcChannel,
    options: TerminalSessionOptions = {},
  ) {
    this.liveLines = options.liveLines ?? 120;
    this.historyPageLines = options.historyPageLines ?? 200;
    this.log = options.log ?? (() => {});
    this.disposers.push(
      channel.onPush((frame) => this.handlePush(frame)),
      channel.onStatus((status) => this.handleStatus(status)),
    );
  }

  getState = (): TerminalState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  dispose(): void {
    for (const dispose of this.disposers) dispose();
    this.disposers = [];
    this.subscribeToken++;
    this.historyToken++;
    this.queue = [];
    this.listeners.clear();
  }

  // MARK: Target and subscription

  setTarget(target: SurfaceTarget | null): void {
    const previous = this.state.target;
    if (sameTarget(previous, target)) return;
    if (previous && this.channel.isOpen) {
      this.channel.call('surface.unsubscribe', { surface_id: previous.surfaceId }).catch(() => {});
    }
    this.historyToken++;
    this.queue = [];
    this.lastFocus = null;
    this.update({
      target,
      screen: EMPTY_SCREEN,
      subscription: 'none',
      subscriptionError: null,
      browse: null,
      input: { busy: this.pumping, error: null },
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
        await this.channel.call('surface.subscribe', {
          workspace_id: target.workspaceId,
          surface_id: target.surfaceId,
          lines: this.liveLines,
        });
        if (token !== this.subscribeToken) return;
        this.update({ subscription: 'live' });
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
    if (!target || this.resyncing || !this.channel.isOpen) return;
    const now = Date.now();
    const sinceLast = now - this.lastResyncAt;
    if (sinceLast < this.resyncCooldown) return;
    // Back off while mismatches keep coming soon after a resync.
    this.resyncCooldown =
      sinceLast < this.resyncCooldown * 4
        ? Math.min(this.resyncCooldown * 2, RESYNC_MAX_COOLDOWN_MS)
        : RESYNC_MIN_COOLDOWN_MS;
    this.lastResyncAt = now;
    this.resyncing = true;
    this.log(`resync (${reason})`);
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
        this.resyncing = false;
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
        return;
      default:
        return;
    }
  }

  private setScreen(screen: ScreenState): void {
    const browse = this.state.browse;
    const rowsChanged = screen.rows !== this.state.screen.rows;
    if (browse && rowsChanged && !browse.liveChanged) {
      this.update({ screen, browse: { ...browse, liveChanged: true } });
    } else {
      this.update({ screen });
    }
  }

  // MARK: History

  /** Freezes the view at the current live rows; call when the user scrolls away from the bottom. */
  startBrowsing(): void {
    if (this.state.browse) return;
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

  /** Back to the live screen; drops loaded history so the next browse starts from a fresh snapshot. */
  resumeLive(): void {
    if (!this.state.browse) return;
    this.historyToken++;
    this.update({ browse: null });
  }

  /** Loads the page above what is shown. No-op while loading, after the start of history, or after an error. */
  async loadOlder(options: { retry?: boolean } = {}): Promise<void> {
    const target = this.state.target;
    const browse = this.state.browse;
    if (!target || !browse || browse.loading || browse.exhausted) return;
    if (browse.error && !options.retry) return;
    if (!this.channel.isOpen) return;
    const token = ++this.historyToken;
    const first = !browse.started;
    this.update({ browse: { ...browse, loading: true, error: null } });
    try {
      const params: Record<string, unknown> = {
        workspace_id: target.workspaceId,
        surface_id: target.surfaceId,
        limit: this.historyPageLines,
      };
      if (first) params.tail_lines = Math.max(1, browse.frozenRows.length || this.liveLines);
      else if (browse.cursor) params.cursor = browse.cursor;
      const page = parseHistoryPage(await this.channel.call('surface.history', params, 30_000));
      const current = this.state.browse;
      if (token !== this.historyToken || !current) return;
      const olderRows = first
        ? stitchFirstPage(current.frozenRows, page.rows, page.anchorRows ?? [])
        : [...page.rows, ...current.olderRows];
      this.update({
        browse: {
          ...current,
          olderRows,
          cursor: page.nextCursor,
          started: true,
          exhausted: page.nextCursor === null,
          loading: false,
          error: null,
        },
      });
    } catch (error) {
      const current = this.state.browse;
      if (token !== this.historyToken || !current) return;
      const expired = error instanceof RpcCallError && /expired/i.test(error.message);
      this.update({
        browse: {
          ...current,
          loading: false,
          error: expired ? '历史记录已过期，回到底部后再往上滑可以重新加载' : describeError(error),
        },
      });
    }
  }

  // MARK: Input

  sendText(text: string): void {
    if (text.length === 0) return;
    const last = this.queue[this.queue.length - 1];
    // Coalesce text typed while the previous request is in flight.
    if (last && last.kind === 'text') last.text += text;
    else this.queue.push({ kind: 'text', text });
    void this.pump();
  }

  sendKey(key: Key): void {
    this.queue.push({ kind: 'key', key });
    void this.pump();
  }

  /** Command mode: the line, then Enter. An empty line sends just Enter. */
  submitLine(line: string): void {
    if (line.length > 0) this.sendText(line);
    this.sendKey({ name: 'enter' });
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
        this.queue = [];
        break;
      }
      try {
        await this.execute(target, item);
      } catch (failure) {
        this.queue = [];
        error = describeError(failure);
      }
    }
    this.pumping = false;
    this.update({ input: { busy: false, error } });
  }

  private async execute(target: SurfaceTarget, item: InputItem): Promise<void> {
    const ids = { workspace_id: target.workspaceId, surface_id: target.surfaceId };
    if (item.kind === 'text') {
      await this.channel.call('surface.send_text', { ...ids, text: item.text });
      return;
    }
    // `surface.send_key` synthesizes a key event that lands on whichever pane
    // cmux has focused, so pin focus to the surface we show first.
    const now = Date.now();
    const focus = this.lastFocus;
    if (!focus || focus.surfaceId !== target.surfaceId || now - focus.at > FOCUS_REUSE_MS) {
      await this.channel.call('surface.focus', ids).catch(() => {});
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

export function parseHistoryPage(value: unknown): HistoryPage {
  if (typeof value !== 'object' || value === null) throw new RpcCallError('bad_response', '历史记录格式不对');
  const record = value as Record<string, unknown>;
  const rows = stringArray(record.rows);
  if (!rows) throw new RpcCallError('bad_response', '历史记录格式不对');
  const anchorRows = stringArray(record.anchor_rows);
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
  if (frozenRows.length === 0) return [...historyRows, ...anchorRows];
  const combined = [...historyRows, ...anchorRows];
  const m = frozenRows.length;
  for (let extra = 0; extra + m <= combined.length; extra++) {
    const start = combined.length - extra - m;
    let matches = true;
    for (let i = 0; i < m; i++) {
      if (combined[start + i] !== frozenRows[i]) {
        matches = false;
        break;
      }
    }
    if (matches) return combined.slice(0, start);
  }
  return [...historyRows];
}

function stringArray(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((v) => typeof v === 'string') ? (value as string[]) : null;
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
