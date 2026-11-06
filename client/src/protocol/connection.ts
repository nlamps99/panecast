import {
  parseInbound,
  PROTOCOL_VERSION,
  WS_SUBPROTOCOL,
  type Hello,
  type PushFrame,
  type RpcResponse,
} from './frames';

/** The subset of the WebSocket API this client uses (RN, browser and `ws` all fit). */
export interface SocketLike {
  readonly readyState: number;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export type SocketFactory = (url: string, protocols: string[], headers: Record<string, string>) => SocketLike;

export type CloseReason =
  /** Upgrade rejected with 401/403/404: the stored token is no longer valid. */
  | 'auth_failed'
  /** Broker answered 503 or closed with 1013: the Mac relay is not connected. */
  | 'relay_offline'
  | 'network'
  /** The relay closed us, usually because the hello did not arrive in time. */
  | 'closed_by_server';

export type ConnectionStatus =
  | { state: 'idle' }
  | { state: 'connecting'; attempt: number }
  | { state: 'open' }
  | { state: 'waiting'; attempt: number; retryAt: number; reason: CloseReason }
  | { state: 'auth_failed' };

export class RpcCallError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = 'RpcCallError';
  }
}

export type RelayConnectionOptions = {
  url: string;
  token: string;
  deviceId: string;
  appVersion: string;
  createSocket: SocketFactory;
  /** Default RPC timeout. */
  rpcTimeoutMs?: number;
  /** Backoff: base * 2^attempt, capped. */
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  /** A connection must stay open this long before the backoff resets. */
  stableAfterMs?: number;
  /**
   * Liveness: if nothing arrives for `idleProbeMs`, send a cheap relay-owned
   * RPC; if that gets no answer within `probeTimeoutMs`, drop the socket. The
   * relay ignores non-RPC frames, so an app-level ping would get no reply.
   */
  idleProbeMs?: number;
  probeTimeoutMs?: number;
  probeMethod?: string;
  log?: (message: string) => void;
};

type Pending = {
  resolve: (result: unknown) => void;
  reject: (error: RpcCallError) => void;
  timer: ReturnType<typeof setTimeout>;
  method: string;
};

/**
 * One RPC channel to the relay, directly or through the broker.
 *
 * On open it sends the hello synchronously (the relay drops connections that
 * do not send one within 100 ms), then multiplexes RPCs by id and hands push
 * frames to listeners. It reconnects with exponential backoff until stopped
 * or until the token is rejected.
 */
export class RelayConnection {
  private readonly opts: Required<Omit<RelayConnectionOptions, 'log'>> & { log?: (m: string) => void };
  private socket: SocketLike | null = null;
  private generation = 0;
  private nextId = 1;
  private pending = new Map<string, Pending>();
  private attempt = 0;
  private running = false;
  private openedAt = 0;
  private lastInboundAt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private probeInFlight = false;
  private currentStatus: ConnectionStatus = { state: 'idle' };
  private statusListeners = new Set<(status: ConnectionStatus) => void>();
  private pushListeners = new Set<(frame: PushFrame) => void>();

  constructor(options: RelayConnectionOptions) {
    this.opts = {
      rpcTimeoutMs: 15_000,
      backoffBaseMs: 1_000,
      backoffMaxMs: 30_000,
      stableAfterMs: 5_000,
      idleProbeMs: 20_000,
      probeTimeoutMs: 8_000,
      probeMethod: 'host.battery',
      ...options,
    };
  }

  get status(): ConnectionStatus {
    return this.currentStatus;
  }

  get isOpen(): boolean {
    return this.currentStatus.state === 'open';
  }

  onStatus(listener: (status: ConnectionStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  onPush(listener: (frame: PushFrame) => void): () => void {
    this.pushListeners.add(listener);
    return () => this.pushListeners.delete(listener);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.attempt = 0;
    this.openSocket();
  }

  stop(): void {
    this.running = false;
    this.clearRetry();
    this.stopWatchdog();
    this.dropSocket(1000, 'client stopped');
    this.failAllPending('closed', 'connection stopped');
    this.setStatus({ state: 'idle' });
  }

  /**
   * Call when the app returns to the foreground or the network changes: skips
   * a pending backoff, or checks that an "open" socket still works.
   */
  wake(): void {
    if (!this.running) return;
    if (this.currentStatus.state === 'waiting') {
      this.clearRetry();
      this.openSocket();
    } else if (this.currentStatus.state === 'open') {
      this.probe();
    }
  }

  call<T = unknown>(method: string, params: Record<string, unknown> = {}, timeoutMs?: number): Promise<T> {
    const socket = this.socket;
    if (!socket || !this.isOpen) {
      return Promise.reject(new RpcCallError('not_connected', '还没有连上电脑'));
    }
    const id = String(this.nextId++);
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new RpcCallError('timeout', `${method} 超时`));
      }, timeoutMs ?? this.opts.rpcTimeoutMs);
      this.pending.set(id, { resolve: resolve as (r: unknown) => void, reject, timer, method });
      try {
        socket.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new RpcCallError('send_failed', error instanceof Error ? error.message : String(error)));
      }
    });
  }

  private openSocket(): void {
    this.dropSocket(1000, 'reconnecting');
    const generation = ++this.generation;
    this.setStatus({ state: 'connecting', attempt: this.attempt });
    let socket: SocketLike;
    try {
      socket = this.opts.createSocket(this.opts.url, [WS_SUBPROTOCOL], {
        Authorization: `Bearer ${this.opts.token}`,
      });
    } catch (error) {
      this.log(`socket creation failed: ${error instanceof Error ? error.message : String(error)}`);
      this.scheduleRetry('network');
      return;
    }
    this.socket = socket;
    let opened = false;

    socket.onopen = () => {
      if (generation !== this.generation) return;
      opened = true;
      // Must be the first frame and must go out now: the relay closes
      // connections whose hello does not arrive within 100 ms.
      const hello: Hello = {
        deviceId: this.opts.deviceId,
        appVersion: this.opts.appVersion,
        protocolVersion: PROTOCOL_VERSION,
      };
      try {
        socket.send(JSON.stringify(hello));
      } catch {
        return; // onclose follows
      }
      this.openedAt = Date.now();
      this.lastInboundAt = this.openedAt;
      this.startWatchdog();
      this.setStatus({ state: 'open' });
    };

    socket.onmessage = (event) => {
      if (generation !== this.generation) return;
      this.lastInboundAt = Date.now();
      if (typeof event.data !== 'string') return;
      this.handleText(socket, event.data);
    };

    socket.onerror = () => {
      // Details arrive with onclose (RN puts the failure message in `reason`).
    };

    socket.onclose = (event) => {
      if (generation !== this.generation) return;
      this.socket = null;
      this.stopWatchdog();
      this.failAllPending('closed', '连接已断开');
      const reason = classifyClose(opened, event.code, event.reason);
      this.log(`socket closed code=${event.code ?? '-'} opened=${opened} reason=${reason}`);
      if (opened && Date.now() - this.openedAt >= this.opts.stableAfterMs) this.attempt = 0;
      if (reason === 'auth_failed') {
        this.running = false;
        this.setStatus({ state: 'auth_failed' });
        return;
      }
      if (this.running) this.scheduleRetry(reason);
      else this.setStatus({ state: 'idle' });
    };
  }

  private handleText(socket: SocketLike, text: string): void {
    const inbound = parseInbound(text);
    if (!inbound) return;
    if (inbound.kind === 'response') {
      this.settle(inbound.response);
      return;
    }
    const frame = inbound.frame;
    if (frame.type === 'ping') {
      try {
        socket.send(JSON.stringify({ type: 'pong', ts: frame.ts }));
      } catch {
        // onclose follows
      }
      return;
    }
    if (frame.type === 'pong') return;
    for (const listener of this.pushListeners) {
      try {
        listener(frame);
      } catch (error) {
        this.log(`push listener threw: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  private settle(response: RpcResponse): void {
    const pending = this.pending.get(response.id);
    if (!pending) return;
    this.pending.delete(response.id);
    clearTimeout(pending.timer);
    if (response.ok) {
      pending.resolve(response.result);
    } else {
      const error = response.error ?? { code: 'error', message: '' };
      pending.reject(new RpcCallError(error.code, error.message || `${pending.method} 失败`, error.data));
    }
  }

  private scheduleRetry(reason: CloseReason): void {
    const delay = Math.min(this.opts.backoffBaseMs * 2 ** Math.min(this.attempt, 10), this.opts.backoffMaxMs);
    this.attempt++;
    this.setStatus({ state: 'waiting', attempt: this.attempt, retryAt: Date.now() + delay, reason });
    this.clearRetry();
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.running) this.openSocket();
    }, delay);
  }

  private startWatchdog(): void {
    this.stopWatchdog();
    const interval = Math.max(1_000, Math.floor(this.opts.idleProbeMs / 4));
    this.watchdog = setInterval(() => {
      if (Date.now() - this.lastInboundAt >= this.opts.idleProbeMs) this.probe();
    }, interval);
  }

  private stopWatchdog(): void {
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;
  }

  private probe(): void {
    if (this.probeInFlight || !this.isOpen) return;
    this.probeInFlight = true;
    const generation = this.generation;
    this.call(this.opts.probeMethod, {}, this.opts.probeTimeoutMs)
      .catch((error: unknown) => {
        // Any RPC error reply still proves the link is alive.
        if (error instanceof RpcCallError && error.code === 'timeout' && generation === this.generation) {
          this.log('liveness probe timed out; reconnecting');
          this.forceReconnect();
        }
      })
      .finally(() => {
        this.probeInFlight = false;
      });
  }

  private forceReconnect(): void {
    if (!this.running) return;
    this.dropSocket(4000, 'liveness probe timed out');
    this.stopWatchdog();
    this.failAllPending('closed', '连接已断开');
    this.scheduleRetry('network');
  }

  /** Detaches and closes the current socket without running its onclose path. */
  private dropSocket(code: number, reason: string): void {
    const socket = this.socket;
    this.socket = null;
    this.generation++;
    if (!socket) return;
    socket.onopen = null;
    socket.onmessage = null;
    socket.onerror = null;
    socket.onclose = null;
    try {
      socket.close(code, reason);
    } catch {
      // already closed
    }
  }

  private clearRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private failAllPending(code: string, message: string): void {
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const entry of pending) {
      clearTimeout(entry.timer);
      entry.reject(new RpcCallError(code, message));
    }
  }

  private setStatus(status: ConnectionStatus): void {
    this.currentStatus = status;
    for (const listener of this.statusListeners) listener(status);
  }

  private log(message: string): void {
    this.opts.log?.(message);
  }
}

const AUTH_STATUSES = new Set([401, 403, 404]);

/**
 * Maps a close event to a reason. Before the upgrade completes, RN reports
 * the HTTP status only inside the failure text, e.g. iOS (SocketRocket)
 * "Received bad response code from server: 401." and Android (OkHttp)
 * "Expected HTTP 101 response but was '401 Unauthorized'".
 */
export function classifyClose(opened: boolean, code?: number, reason?: string): CloseReason {
  // The broker can revoke an already connected phone without waiting for its
  // next HTTP upgrade. Stop immediately even when the platform omits reason.
  if (code === 4003) return 'auth_failed';
  if (code === 1013) return 'relay_offline';
  if (!opened) {
    const status = httpStatusIn(reason ?? '');
    if (status !== null && AUTH_STATUSES.has(status)) return 'auth_failed';
    if (status === 503) return 'relay_offline';
    return 'network';
  }
  if (code === 1000 || code === 1008) return 'closed_by_server';
  return 'network';
}

function httpStatusIn(text: string): number | null {
  // A 4xx/5xx token not embedded in a longer number, address or port.
  const match = /(?:^|[^\d.:])([45]\d\d)(?![\d:]|\.\d)/.exec(text);
  return match ? Number(match[1]) : null;
}
