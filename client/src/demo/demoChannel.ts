import { RpcCallError, type ConnectionStatus } from '../protocol/connection';
import type { DiffOp, PushFrame } from '../protocol/frames';
import { screenHash } from '../protocol/screen';
import type { RpcChannel } from '../session/terminalSession';
import { profileFor, seedNewShell, WINDOW_SEEDS } from './demoContent';
import { batterySnapshot, uploadResult } from './demoHost';
import { CHECK_TOTAL } from './demoPrograms';
import { DemoTerminal, type InputRequest, type ShellProfile } from './demoTerminal';
import { absolutePath } from './demoText';

/**
 * A pretend relay with a pretend Mac behind it, for trying the app without a
 * Mac and for App Review. It answers the same RPCs with the same result
 * shapes as the relay and cmux, and pushes the same frames:
 *
 * - Two cmux windows (`window.list`), workspaces per window
 *   (`workspace.list` with `window_id`), created, renamed, selected and
 *   closed like cmux does, each change followed by an `event` frame.
 * - Terminals that can be created, focused and closed, with shells that
 *   echo input and a few programs whose output keeps changing.
 * - `surface.subscribe` starts with clear + every row, then sends a
 *   `screen.diff` whenever the screen changes and a `screen.checksum` every
 *   5 s, computed with `screenHash` over exactly what was sent.
 * - `surface.history` pages a frozen snapshot of the scrollback with an
 *   anchor, like `SurfaceHistoryService`.
 * - `host.battery` and `file.upload` (measured, never stored).
 *
 * One timer drives everything and runs only while a screen is subscribed and
 * someone listens for frames.
 */

/** Simulated round trip of one RPC. */
const DEMO_LATENCY_MS = 40;
/** Programs advance and subscribed screens are diffed this often. */
const DEMO_TICK_MS = 500;
/** `screen.checksum` every 5 s per subscription, like the relay's DiffEngine. */
const CHECKSUM_EVERY_TICKS = 10;
/** A subscription's first frame comes about one relay polling tick after it. */
const FIRST_FRAME_MS = 60;
/** Input shows on screen at the relay's next poll. */
const ECHO_MS = 20;
/** cmux `event` frames trail the change that caused them. */
const EVENT_MS = 30;
/** The canned notifications arrive this long after the first `workspace.list`. */
const FIRST_NOTIFICATIONS_MS = 800;
/** Limits from `SurfaceHistoryService` and the relay's param handling. */
const MAX_SNAPSHOTS = 8;
const MAX_PAGE_LINES = 500;
const MAX_TAIL_LINES = 2_000;
const DEFAULT_LINES = 200;
/** cmux does not report the cursor; the relay always sends (0, 0). */
const CURSOR = { x: 0, y: 0 } as const;

type DemoWindow = { id: string; ref: string; workspaceIds: string[]; selectedId: string | null };

type DemoWorkspace = {
  id: string;
  ref: string;
  windowId: string;
  title: string;
  /** Where its shells start; decides what a new terminal there shows. */
  cwd: string;
  terminalIds: string[];
  focusedId: string | null;
};

/** What the phone has of one subscribed screen. */
type Subscription = { lines: number; rows: string[]; rev: number; ticks: number; started: boolean };

type Params = Record<string, unknown>;

export class DemoChannel implements RpcChannel {
  readonly isOpen = true;
  readonly status: ConnectionStatus = { state: 'open' };

  private readonly startedAt = Date.now();
  private readonly windows = new Map<string, DemoWindow>();
  private readonly workspaces = new Map<string, DemoWorkspace>();
  private readonly terminals = new Map<string, DemoTerminal>();
  /** Terminal id → workspace id. */
  private readonly owner = new Map<string, string>();
  private keyWindowId: string = WINDOW_SEEDS[0].id;
  private readonly subscriptions = new Map<string, Subscription>();
  private readonly snapshots = new Map<string, { terminalId: string; rows: string[] }>();
  private readonly pushListeners = new Set<(frame: PushFrame) => void>();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private ticker: ReturnType<typeof setInterval> | null = null;
  private echoPending = false;
  private firstBatchScheduled = false;
  private firstBatchSent = false;
  /** Questions asked before the first notifications went out; sent with them. */
  private waitingForInput: { terminalId: string; request: InputRequest }[] = [];
  private readonly counters = { window: 0, workspace: 0, terminal: 0, snapshot: 0, notification: 2, input: 0 };
  private readonly hooks = {
    needsInput: (terminalId: string, request: InputRequest) => this.needsInput(terminalId, request),
  };

  constructor() {
    for (const windowSeed of WINDOW_SEEDS) {
      const window = this.addWindow(windowSeed.id);
      for (const seed of windowSeed.workspaces) {
        const workspace = this.addWorkspace(window, seed.title, seed.terminals[0]?.profile.cwd ?? '~', seed.id);
        for (const terminalSeed of seed.terminals) {
          terminalSeed.seed(this.addTerminal(workspace, terminalSeed.title, terminalSeed.profile, terminalSeed.id));
        }
        workspace.focusedId = seed.focusedId;
      }
      window.selectedId = windowSeed.selectedId;
    }
  }

  onPush(listener: (frame: PushFrame) => void): () => void {
    this.pushListeners.add(listener);
    this.updateTicker();
    return () => {
      if (this.pushListeners.delete(listener) && this.pushListeners.size === 0) this.shutdown();
    };
  }

  onStatus(_listener: (status: ConnectionStatus) => void): () => void {
    return () => {};
  }

  call<T = unknown>(method: string, params: Params = {}): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      setTimeout(() => {
        try {
          resolve(this.handle(method, params) as T);
        } catch (error) {
          reject(error);
        }
      }, DEMO_LATENCY_MS);
    });
  }

  private handle(method: string, params: Params): unknown {
    switch (method) {
      case 'window.list':
        return this.listWindows();
      case 'workspace.list':
        return this.listWorkspaces(params);
      case 'workspace.create':
        return this.createWorkspace(params);
      case 'workspace.rename':
        return this.renameWorkspace(params);
      case 'workspace.select': {
        const workspace = this.workspaceById(params.workspace_id);
        this.select(workspace);
        return { workspace_id: workspace.id };
      }
      case 'workspace.close': {
        const workspace = this.workspaceById(params.workspace_id);
        this.removeWorkspace(workspace);
        return { workspace_id: workspace.id };
      }
      case 'surface.list':
        return this.listSurfaces(params);
      case 'surface.create':
        return this.createSurface(params);
      case 'surface.close':
        return this.closeSurface(params);
      case 'surface.focus':
        return this.focusSurface(params);
      case 'surface.subscribe':
        return this.subscribe(params);
      case 'surface.unsubscribe':
        if (typeof params.surface_id !== 'string') throw new RpcCallError('invalid_params', '缺少 surface_id');
        this.subscriptions.delete(params.surface_id);
        this.updateTicker();
        return {};
      case 'surface.history':
        return this.history(params);
      case 'surface.send_text': {
        const terminal = this.terminalById(params.surface_id);
        if (typeof params.text !== 'string') throw new RpcCallError('invalid_params', '缺少 text');
        terminal.sendText(params.text);
        this.scheduleEcho();
        return {};
      }
      case 'surface.send_key': {
        const terminal = this.terminalById(params.surface_id);
        if (typeof params.key !== 'string') throw new RpcCallError('invalid_params', '缺少 key');
        terminal.sendKey(params.key);
        this.scheduleEcho();
        return {};
      }
      case 'surface.read_text': {
        const terminal = this.terminalById(params.surface_id);
        const lines = isInt(params.lines) && params.lines > 0 ? params.lines : DEFAULT_LINES;
        return { ...this.surfaceRefs(terminal), text: terminal.screen(lines).join('\n') };
      }
      case 'notification.create':
        return this.createNotification(params);
      case 'host.battery':
        return batterySnapshot(this.startedAt, Date.now());
      case 'file.upload':
        return uploadResult(params, Date.now());
      default:
        throw new RpcCallError('method_not_found', `演示模式不支持 ${method}`);
    }
  }

  // MARK: World

  private addWindow(id: string): DemoWindow {
    const n = ++this.counters.window;
    const window: DemoWindow = { id, ref: `window:${n}`, workspaceIds: [], selectedId: null };
    this.windows.set(id, window);
    return window;
  }

  private addWorkspace(window: DemoWindow, title: string, cwd: string, id?: string): DemoWorkspace {
    const n = ++this.counters.workspace;
    const workspace: DemoWorkspace = {
      id: id ?? `demo-ws-${n}`,
      ref: `workspace:${n}`,
      windowId: window.id,
      title,
      cwd,
      terminalIds: [],
      focusedId: null,
    };
    window.workspaceIds.push(workspace.id);
    this.workspaces.set(workspace.id, workspace);
    return workspace;
  }

  private addTerminal(workspace: DemoWorkspace, title: string, profile: ShellProfile, id?: string): DemoTerminal {
    const n = ++this.counters.terminal;
    const terminal = new DemoTerminal(id ?? `demo-sf-${n}`, `demo-pane-${n}`, `surface:${n}`, `pane:${n}`, title, profile, this.hooks);
    workspace.terminalIds.push(terminal.id);
    this.terminals.set(terminal.id, terminal);
    this.owner.set(terminal.id, workspace.id);
    return terminal;
  }

  private windowById(value: unknown): DemoWindow {
    if (typeof value !== 'string') throw new RpcCallError('invalid_params', 'window_id 应该是字符串');
    const window = this.windows.get(value);
    if (!window) throw new RpcCallError('not_found', '找不到这个窗口');
    return window;
  }

  private workspaceById(value: unknown): DemoWorkspace {
    if (typeof value !== 'string') throw new RpcCallError('invalid_params', '缺少 workspace_id');
    const workspace = this.workspaces.get(value);
    if (!workspace) throw new RpcCallError('not_found', '找不到这个工作区，可能已经关闭');
    return workspace;
  }

  private terminalById(value: unknown): DemoTerminal {
    if (typeof value !== 'string') throw new RpcCallError('invalid_params', '缺少 surface_id');
    const terminal = this.terminals.get(value);
    if (!terminal) throw new RpcCallError('not_found', '这个终端已经关闭');
    return terminal;
  }

  private ownerOf(terminal: DemoTerminal): DemoWorkspace {
    return this.workspaces.get(this.owner.get(terminal.id)!)!;
  }

  private keyWindow(): DemoWindow {
    return this.windows.get(this.keyWindowId)!;
  }

  /** What cmux acts on when a method is called without `workspace_id`: the key window's selected workspace. */
  private defaultWorkspace(params: Params): DemoWorkspace {
    if (params.workspace_id !== undefined && params.workspace_id !== null) return this.workspaceById(params.workspace_id);
    const selected = this.keyWindow().selectedId;
    if (!selected) throw new RpcCallError('not_found', '电脑上没有打开的工作区');
    return this.workspaceById(selected);
  }

  // MARK: Windows and workspaces

  private listWindows() {
    return {
      windows: [...this.windows.values()].map((window, index) => ({
        id: window.id,
        ref: window.ref,
        index,
        key: window.id === this.keyWindowId,
        workspace_count: window.workspaceIds.length,
      })),
    };
  }

  /** Without `window_id` cmux lists only its key window. */
  private listWorkspaces(params: Params) {
    const windowId = optionalString(params, 'window_id');
    const window = windowId === undefined ? this.keyWindow() : this.windowById(windowId);
    this.scheduleFirstBatch();
    return {
      window_id: window.id,
      window_ref: window.ref,
      workspaces: window.workspaceIds.map((id) => this.workspaceRecord(this.workspaces.get(id)!)),
    };
  }

  private workspaceRecord(workspace: DemoWorkspace) {
    const window = this.windows.get(workspace.windowId)!;
    return {
      id: workspace.id,
      ref: workspace.ref,
      index: window.workspaceIds.indexOf(workspace.id),
      title: workspace.title,
      selected: window.selectedId === workspace.id,
      pinned: false,
      current_directory: absolutePath(workspace.cwd),
      description: null,
      custom_color: null,
      listening_ports: [],
    };
  }

  /** Like cmux: the new workspace opens with one shell and becomes the window's selected one. */
  private createWorkspace(params: Params) {
    const windowId = optionalString(params, 'window_id');
    const window = windowId === undefined ? this.keyWindow() : this.windowById(windowId);
    const title =
      optionalString(params, 'title')?.trim() || optionalString(params, 'name')?.trim() || `工作区 ${this.workspaces.size + 1}`;
    const workspace = this.addWorkspace(window, title, '~');
    const terminal = this.addTerminal(workspace, 'zsh', profileFor(undefined));
    seedNewShell(terminal);
    workspace.focusedId = terminal.id;
    window.selectedId = workspace.id;
    this.announce('workspace', 'workspace.created', { workspace_id: workspace.id, window_id: window.id, title });
    return { workspace_id: workspace.id, window_id: window.id, workspace: this.workspaceRecord(workspace) };
  }

  private renameWorkspace(params: Params) {
    const workspace = this.workspaceById(params.workspace_id);
    const title = typeof params.title === 'string' ? params.title.trim() : '';
    if (!title) throw new RpcCallError('invalid_params', '名字不能为空');
    if (title !== workspace.title) {
      workspace.title = title;
      this.announce('workspace', 'workspace.renamed', { workspace_id: workspace.id, window_id: workspace.windowId, title });
    }
    return { workspace_id: workspace.id, title };
  }

  private select(workspace: DemoWorkspace): void {
    const window = this.windows.get(workspace.windowId)!;
    if (window.selectedId === workspace.id) return;
    window.selectedId = workspace.id;
    this.announce('workspace', 'workspace.selected', { workspace_id: workspace.id, window_id: window.id });
  }

  /** Closes its terminals too; the window selects the neighbour, or nothing when it was the last. */
  private removeWorkspace(workspace: DemoWorkspace): void {
    const window = this.windows.get(workspace.windowId)!;
    for (const id of workspace.terminalIds) this.dropTerminal(id);
    const index = window.workspaceIds.indexOf(workspace.id);
    window.workspaceIds.splice(index, 1);
    this.workspaces.delete(workspace.id);
    if (window.selectedId === workspace.id) {
      window.selectedId = window.workspaceIds[Math.min(index, window.workspaceIds.length - 1)] ?? null;
    }
    this.announce('workspace', 'workspace.closed', { workspace_id: workspace.id, window_id: window.id });
  }

  // MARK: Terminals

  private surfaceRefs(terminal: DemoTerminal) {
    const workspace = this.ownerOf(terminal);
    const window = this.windows.get(workspace.windowId)!;
    return {
      surface_id: terminal.id,
      surface_ref: terminal.ref,
      pane_id: terminal.paneId,
      pane_ref: terminal.paneRef,
      workspace_id: workspace.id,
      workspace_ref: workspace.ref,
      window_id: window.id,
      window_ref: window.ref,
    };
  }

  private listSurfaces(params: Params) {
    const workspace = this.defaultWorkspace(params);
    const window = this.windows.get(workspace.windowId)!;
    return {
      workspace_id: workspace.id,
      workspace_ref: workspace.ref,
      window_id: window.id,
      window_ref: window.ref,
      surfaces: workspace.terminalIds.map((id, index) => {
        const terminal = this.terminals.get(id)!;
        return {
          id: terminal.id,
          ref: terminal.ref,
          index,
          title: terminal.title,
          type: 'terminal',
          focused: workspace.focusedId === terminal.id,
          pane_id: terminal.paneId,
          pane_ref: terminal.paneRef,
          index_in_pane: 0,
          selected_in_pane: true,
        };
      }),
    };
  }

  /** The result carries `surface_id`, which the legacy clients' `SurfaceMutationPayload` decodes. */
  private createSurface(params: Params) {
    const workspace = this.defaultWorkspace(params);
    if ((optionalString(params, 'type') ?? 'terminal') !== 'terminal') {
      throw new RpcCallError('invalid_params', '演示模式只能新建终端');
    }
    const terminal = this.addTerminal(workspace, 'zsh', profileFor(workspace.cwd));
    seedNewShell(terminal);
    if (params.focus !== false) {
      workspace.focusedId = terminal.id;
      this.select(workspace);
    }
    this.announce('surface', 'surface.created', { workspace_id: workspace.id, surface_id: terminal.id });
    return { ...this.surfaceRefs(terminal), type: 'terminal' };
  }

  /** Closing a workspace's last terminal closes the workspace, as in cmux. */
  private closeSurface(params: Params) {
    const terminal = this.terminalById(params.surface_id);
    const workspace = this.ownerOf(terminal);
    const index = workspace.terminalIds.indexOf(terminal.id);
    workspace.terminalIds.splice(index, 1);
    this.dropTerminal(terminal.id);
    this.announce('surface', 'surface.closed', { workspace_id: workspace.id, surface_id: terminal.id });
    if (workspace.terminalIds.length === 0) {
      this.removeWorkspace(workspace);
    } else if (workspace.focusedId === terminal.id) {
      workspace.focusedId = workspace.terminalIds[Math.min(index, workspace.terminalIds.length - 1)];
    }
    return { surface_id: terminal.id, workspace_id: workspace.id };
  }

  /** Sent before every key; only a real change raises an event, so typing does not make the lists refetch. */
  private focusSurface(params: Params) {
    const terminal = this.terminalById(params.surface_id);
    const workspace = this.ownerOf(terminal);
    this.select(workspace);
    if (workspace.focusedId !== terminal.id) {
      workspace.focusedId = terminal.id;
      this.announce('surface', 'surface.focused', { workspace_id: workspace.id, surface_id: terminal.id });
    }
    return {};
  }

  private dropTerminal(id: string): void {
    this.terminals.delete(id);
    this.owner.delete(id);
    this.subscriptions.delete(id);
    this.waitingForInput = this.waitingForInput.filter((waiting) => waiting.terminalId !== id);
    this.updateTicker();
  }

  // MARK: Screens

  private subscribe(params: Params) {
    if (typeof params.workspace_id !== 'string' || typeof params.surface_id !== 'string') {
      throw new RpcCallError('invalid_params', '缺少 workspace_id 或 surface_id');
    }
    const surfaceId = params.surface_id;
    this.terminalById(surfaceId);
    // Like the relay: subscribing again to a subscribed surface changes nothing.
    if (this.subscriptions.has(surfaceId)) return {};
    const lines = isInt(params.lines) ? Math.max(1, params.lines) : DEFAULT_LINES;
    const subscription: Subscription = { lines, rows: [], rev: 0, ticks: 0, started: false };
    this.subscriptions.set(surfaceId, subscription);
    this.updateTicker();
    this.later(FIRST_FRAME_MS, () => {
      if (this.subscriptions.get(surfaceId) === subscription) this.flush(surfaceId, subscription);
    });
    return {};
  }

  /** Sends what changed since the last frame, like the relay's RowState: the first frame and any row-count change resend everything. */
  private flush(surfaceId: string, subscription: Subscription): void {
    const terminal = this.terminals.get(surfaceId);
    if (!terminal) return;
    const next = terminal.screen(subscription.lines);
    const ops: DiffOp[] = [];
    if (!subscription.started) {
      ops.push({ op: 'clear' }, ...rowOps(next), { op: 'cursor', x: CURSOR.x, y: CURSOR.y });
      subscription.started = true;
    } else if (next.length !== subscription.rows.length) {
      ops.push({ op: 'clear' }, ...rowOps(next));
    } else {
      next.forEach((text, y) => {
        if (text !== subscription.rows[y]) ops.push({ op: 'row', y, text });
      });
    }
    if (ops.length === 0) return;
    subscription.rows = next;
    subscription.rev += 1;
    this.emit({ type: 'screen.diff', surfaceId, rev: subscription.rev, ops });
  }

  private tick(): void {
    for (const terminal of this.terminals.values()) terminal.tick();
    for (const [surfaceId, subscription] of this.subscriptions) {
      if (!subscription.started) continue;
      this.flush(surfaceId, subscription);
      subscription.ticks += 1;
      if (subscription.ticks % CHECKSUM_EVERY_TICKS === 0) {
        const hash = screenHash(subscription.rows, CURSOR);
        this.emit({ type: 'screen.checksum', surfaceId, rev: subscription.rev, hash });
      }
    }
  }

  private scheduleEcho(): void {
    if (this.echoPending) return;
    this.echoPending = true;
    this.later(ECHO_MS, () => {
      this.echoPending = false;
      for (const [surfaceId, subscription] of this.subscriptions) {
        if (subscription.started) this.flush(surfaceId, subscription);
      }
    });
  }

  /** `surface.history`: the first page freezes a snapshot; cursors page it until it is evicted. */
  private history(params: Params) {
    if (typeof params.workspace_id !== 'string' || typeof params.surface_id !== 'string') {
      throw new RpcCallError('invalid_params', '缺少 workspace_id 或 surface_id');
    }
    const limit = clampInt(params.limit, 1, MAX_PAGE_LINES, 200);
    const cursor = typeof params.cursor === 'string' && params.cursor.length > 0 ? params.cursor : null;
    if (cursor) {
      const dot = cursor.lastIndexOf('.');
      const snapshotId = cursor.slice(0, Math.max(0, dot));
      const snapshot = this.snapshots.get(snapshotId);
      const before = Number(cursor.slice(dot + 1));
      if (!snapshot || snapshot.terminalId !== params.surface_id || !Number.isInteger(before) || before < 0) {
        throw new RpcCallError('history_unavailable', 'terminal history cursor expired');
      }
      return historyPage(snapshotId, snapshot.rows, before, limit, false);
    }
    const terminal = this.terminals.get(params.surface_id);
    if (!terminal) throw new RpcCallError('history_unavailable', '这个终端已经关闭');
    const snapshotId = `demo-snap-${++this.counters.snapshot}`;
    const rows = terminal.snapshot();
    this.snapshots.set(snapshotId, { terminalId: terminal.id, rows });
    while (this.snapshots.size > MAX_SNAPSHOTS) this.snapshots.delete(this.snapshots.keys().next().value!);
    const anchor = Math.min(clampInt(params.tail_lines, 1, MAX_TAIL_LINES, 120), rows.length);
    return historyPage(snapshotId, rows, rows.length - anchor, limit, true);
  }

  // MARK: Notifications

  private createNotification(params: Params) {
    const workspace = this.defaultWorkspace(params);
    const title = typeof params.title === 'string' ? params.title.trim() : '';
    if (!title) throw new RpcCallError('invalid_params', '通知需要标题');
    const payload: Params = {
      id: `demo-n-${++this.counters.notification}`,
      workspace_id: workspace.id,
      title,
      subtitle: optionalString(params, 'subtitle') ?? workspace.title,
      body: optionalString(params, 'body') ?? '',
      ts: nowSeconds(),
    };
    const surfaceId = optionalString(params, 'surface_id');
    if (surfaceId) payload.surface_id = surfaceId;
    this.announce('notification', 'notification.created', payload);
    return {};
  }

  private scheduleFirstBatch(): void {
    if (this.firstBatchScheduled) return;
    this.firstBatchScheduled = true;
    this.later(FIRST_NOTIFICATIONS_MS, () => this.sendFirstBatch());
  }

  /** What cmux raised before the app connected: a finished run, a confirmation, and an agent waiting for a choice. */
  private sendFirstBatch(): void {
    this.firstBatchSent = true;
    const now = nowSeconds();
    const payloads: Params[] = [
      {
        id: 'demo-n-1',
        workspace_id: 'demo-ws-1',
        surface_id: 'demo-sf-1',
        title: '测试全部通过',
        subtitle: 'panecast',
        body: `./scripts/check：${CHECK_TOTAL} 项全部通过`,
        ts: now - 120,
      },
      {
        id: 'demo-n-2',
        workspace_id: 'demo-ws-2',
        surface_id: 'demo-sf-3',
        title: '需要你确认',
        subtitle: 'notes',
        body: '是否继续？回到终端里按 ↵ 确认。',
        ts: now - 30,
      },
    ];
    for (const { terminalId, request } of this.waitingForInput) {
      const payload = this.inputPayload(terminalId, request);
      if (payload) payloads.push({ ...payload, ts: now - 5 });
    }
    this.waitingForInput = [];
    for (const payload of payloads) this.emit({ type: 'event', category: 'notification', name: 'notification.created', payload });
  }

  private needsInput(terminalId: string, request: InputRequest): void {
    if (!this.firstBatchSent) {
      this.waitingForInput.push({ terminalId, request });
      return;
    }
    const payload = this.inputPayload(terminalId, request);
    if (payload) this.emit({ type: 'event', category: 'notification', name: 'notification.created', payload });
  }

  /**
   * A notification saying an agent waits for input. `status: "needs input"`
   * is what SharedKit's `isNeedsInputEvent` keys on; the source is neutral.
   */
  private inputPayload(terminalId: string, request: InputRequest): Params | null {
    const terminal = this.terminals.get(terminalId);
    if (!terminal) return null;
    const workspace = this.ownerOf(terminal);
    return {
      id: `demo-input-${++this.counters.input}`,
      workspace_id: workspace.id,
      surface_id: terminal.id,
      title: request.title,
      subtitle: `${workspace.title} · ${terminal.title}`,
      body: request.body,
      source: request.source,
      status: 'needs input',
      ts: nowSeconds(),
    };
  }

  // MARK: Frames and timers

  private announce(category: string, name: string, payload: Params): void {
    this.later(EVENT_MS, () => this.emit({ type: 'event', category, name, payload }));
  }

  private emit(frame: PushFrame): void {
    for (const listener of this.pushListeners) listener(frame);
  }

  private later(ms: number, run: () => void): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      run();
    }, ms);
    this.timers.add(timer);
  }

  private updateTicker(): void {
    const wanted = this.subscriptions.size > 0 && this.pushListeners.size > 0;
    if (wanted && !this.ticker) {
      this.ticker = setInterval(() => this.tick(), DEMO_TICK_MS);
    } else if (!wanted && this.ticker) {
      clearInterval(this.ticker);
      this.ticker = null;
    }
  }

  /** The last listener left (the app left the demo): drop subscriptions and timers, like a closed socket. */
  private shutdown(): void {
    this.subscriptions.clear();
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this.echoPending = false;
    this.firstBatchScheduled = this.firstBatchSent;
    this.updateTicker();
  }
}

function rowOps(rows: readonly string[]): DiffOp[] {
  return rows.map((text, y) => ({ op: 'row', y, text }));
}

function historyPage(snapshotId: string, rows: readonly string[], before: number, limit: number, withAnchor: boolean) {
  const end = Math.min(Math.max(before, 0), rows.length);
  const start = Math.max(0, end - limit);
  return {
    rows: rows.slice(start, end),
    next_cursor: start > 0 ? `${snapshotId}.${start}` : null,
    ...(withAnchor ? { anchor_rows: rows.slice(end) } : {}),
  };
}

function isInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  return isInt(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

function optionalString(params: Params, key: string): string | undefined {
  const value = params[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new RpcCallError('invalid_params', `${key} 应该是字符串`);
  return value;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}
