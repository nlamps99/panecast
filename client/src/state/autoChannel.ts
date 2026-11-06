import type { NetworkState } from 'expo-network';

import { RpcCallError, type ConnectionStatus } from '../protocol/connection';
import type { PushFrame } from '../protocol/frames';
import type { TransportPreference } from './computers';

/** Which path a connection is using right now; shown in the UI. */
export type ActiveTransport = 'broker' | 'lan';

/**
 * What the phone's current network says about reaching the Mac directly:
 * - `lan`: Wi-Fi or Ethernet, so the Mac may be on the same network.
 * - `cellular`: mobile data (or Bluetooth / WiMAX); a private LAN address cannot answer.
 * - `none`: offline.
 * - `unknown`: connected, type not known. iOS reports this whenever a VPN is up,
 *   even on Wi-Fi, so it is treated like `lan` (worth a probe).
 */
export type NetworkKind = 'lan' | 'cellular' | 'none' | 'unknown';

/** Maps an expo-network state to a `NetworkKind`. */
export function networkKindOf(state: NetworkState): NetworkKind {
  switch (state.type) {
    case 'WIFI':
    case 'ETHERNET':
      return 'lan';
    case 'CELLULAR':
    case 'BLUETOOTH':
    case 'WIMAX':
      return 'cellular';
    case 'NONE':
      return 'none';
    default:
      // UNKNOWN, VPN, OTHER, or a type this SDK does not know yet. Android
      // reports isConnected=false for every UNKNOWN, so it cannot mean offline.
      return 'unknown';
  }
}

/** The network signal the channel listens to; `connect.ts` backs it with expo-network. */
export type NetworkWatcher = {
  /** The current network; may be slow on iOS, so the channel bounds the wait. */
  current(): Promise<NetworkKind>;
  /** Fires on every reported change (possibly repeated or bursty); returns an unsubscribe function. */
  watch(listener: (kind: NetworkKind) => void): () => void;
};

/** The part of `RelayConnection` this channel drives. Tests pass fakes. */
export interface PathConnection {
  readonly status: ConnectionStatus;
  readonly isOpen: boolean;
  onStatus(listener: (status: ConnectionStatus) => void): () => void;
  onPush(listener: (frame: PushFrame) => void): () => void;
  call<T = unknown>(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<T>;
  start(): void;
  stop(): void;
  wake(): void;
}

export type AutoChannelOptions = {
  preference: TransportPreference;
  /** Builds a fresh, unstarted connection for a path. Called again on every switch. */
  connect(transport: ActiveTransport): PathConnection;
  /** Whether the computer has LAN credentials; without them only the broker is used. */
  hasLan: boolean;
  /** GET `<lan>/v1/health`; resolves true only if the LAN relay answered. Must not throw. */
  probeLan(timeoutMs: number): Promise<boolean>;
  network: NetworkWatcher;
  log?: (message: string) => void;
  /** LAN health probe budget. */
  probeTimeoutMs?: number;
  /** Under `auto`, a LAN socket that has not opened by then is given up for the broker. */
  lanConnectTimeoutMs?: number;
  /** While on the broker, retry LAN after this, doubling up to `lanRetryMaxMs`. */
  lanRetryMinMs?: number;
  lanRetryMaxMs?: number;
  /** Network reports arrive in bursts while an interface comes up. */
  networkDebounceMs?: number;
  /** Bound on `network.current()`, which can block for seconds on iOS. */
  networkReadTimeoutMs?: number;
};

type Settings = Required<Omit<AutoChannelOptions, 'log'>> & { log: (message: string) => void };

/** One live `PathConnection` and the bookkeeping for it. */
type Path = {
  transport: ActiveTransport;
  connection: PathConnection;
  dispose: () => void;
  /** Opened since its last failure. A second failure without reopening skips the LAN health check. */
  healthy: boolean;
};

/**
 * A connection to one computer that may change path underneath: the Mac's
 * LAN relay (`ws://<lan>/v1/ws`, faster, unencrypted) or the broker.
 *
 * - `broker` / `lan`: one fixed path. A `lan` preference without LAN
 *   credentials uses the broker.
 * - `auto`: on Wi-Fi/Ethernet (or an unknown network type) it probes
 *   `GET <lan>/v1/health` and uses LAN if the relay answers, else the broker.
 *   It re-decides when the network changes, on `wake`, and when the active
 *   path fails: a LAN failure is checked once with the health probe and then
 *   falls back to the broker; while on the broker it retries LAN with
 *   backoff, connecting the LAN socket in the background and switching only
 *   once it is open. A rejected LAN token disables LAN for this channel.
 *
 * Consumers (`TerminalSession`, `WorkspaceStore`) see a switch as a
 * reconnect: status goes non-open then `open`, pending RPCs on the old path
 * fail with `closed`, and push listeners keep receiving frames from whichever
 * path is active.
 */
export class AutoChannel {
  private readonly opts: Settings;
  private active: Path | null = null;
  /** A LAN connection opening in the background while the broker is active. */
  private candidate: Path | null = null;
  private running = false;
  /** Bumped on start and stop so async work from an earlier run is dropped. */
  private epoch = 0;
  private choosing = false;
  private upgrading = false;
  private lanBlocked = false;
  private kind: NetworkKind = 'unknown';
  private reportedKind: NetworkKind | null = null;
  /** OS reports invalidate older asynchronous foreground network reads. */
  private networkRevision = 0;
  private lanRetryDelay: number;
  private lanRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private lanDeadline: ReturnType<typeof setTimeout> | null = null;
  private candidateDeadline: ReturnType<typeof setTimeout> | null = null;
  private networkDebounce: ReturnType<typeof setTimeout> | null = null;
  private unwatchNetwork: (() => void) | null = null;
  private currentStatus: ConnectionStatus = { state: 'idle' };
  private currentTransport: ActiveTransport;
  private statusListeners = new Set<(status: ConnectionStatus) => void>();
  private pushListeners = new Set<(frame: PushFrame) => void>();
  private transportListeners = new Set<(transport: ActiveTransport) => void>();

  constructor(options: AutoChannelOptions) {
    this.opts = {
      probeTimeoutMs: 1_500,
      lanConnectTimeoutMs: 5_000,
      lanRetryMinMs: 15_000,
      lanRetryMaxMs: 5 * 60_000,
      networkDebounceMs: 750,
      networkReadTimeoutMs: 1_000,
      ...options,
      log: options.log ?? (() => {}),
    };
    this.lanRetryDelay = this.opts.lanRetryMinMs;
    this.currentTransport = this.opts.preference === 'lan' && this.opts.hasLan ? 'lan' : 'broker';
  }

  // MARK: Public surface (ComputerChannel)

  get status(): ConnectionStatus {
    return this.currentStatus;
  }

  get isOpen(): boolean {
    return this.currentStatus.state === 'open' && this.active !== null && this.active.connection.isOpen;
  }

  get transport(): ActiveTransport {
    return this.currentTransport;
  }

  onStatus(listener: (status: ConnectionStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  onPush(listener: (frame: PushFrame) => void): () => void {
    this.pushListeners.add(listener);
    return () => this.pushListeners.delete(listener);
  }

  onTransport(listener: (transport: ActiveTransport) => void): () => void {
    this.transportListeners.add(listener);
    return () => this.transportListeners.delete(listener);
  }

  call<T = unknown>(method: string, params: Record<string, unknown> = {}, timeoutMs?: number): Promise<T> {
    const active = this.active;
    if (!active || !this.isOpen) return Promise.reject(new RpcCallError('not_connected', '还没有连上电脑'));
    return active.connection.call<T>(method, params, timeoutMs);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const epoch = ++this.epoch;
    this.lanRetryDelay = this.opts.lanRetryMinMs;
    this.unwatchNetwork = this.opts.network.watch((kind) => this.networkReported(epoch, kind));
    if (this.autoLan) {
      void this.chooseInitial(epoch);
      return;
    }
    if (this.opts.preference === 'lan' && !this.opts.hasLan) {
      this.log('LAN preferred but this computer has no LAN pairing; using the broker');
    }
    this.activate(this.opts.preference === 'lan' && this.opts.hasLan ? 'lan' : 'broker');
    void this.readNetwork().then((kind) => {
      if (epoch !== this.epoch) return;
      this.kind = kind;
      this.reportedKind ??= kind;
    });
  }

  stop(): void {
    this.running = false;
    this.epoch++;
    this.choosing = false;
    this.upgrading = false;
    this.unwatchNetwork?.();
    this.unwatchNetwork = null;
    this.clearTimer('lanRetryTimer');
    this.clearTimer('lanDeadline');
    this.clearTimer('networkDebounce');
    this.discardCandidate();
    const active = this.active;
    this.active = null;
    if (active) {
      active.dispose();
      active.connection.stop();
    }
    this.reportedKind = null;
    this.setStatus({ state: 'idle' });
  }

  /** The app came to the foreground: reconnect now, and re-decide the path under `auto`. */
  wake(): void {
    if (!this.running || !this.active) return;
    this.active.connection.wake();
    if (!this.autoLan) return;
    const epoch = this.epoch;
    const networkRevision = this.networkRevision;
    this.lanRetryDelay = this.opts.lanRetryMinMs;
    void this.readNetwork().then((kind) => {
      if (epoch !== this.epoch || !this.running || networkRevision !== this.networkRevision) return;
      // This read is the newest observation. It also replaces a pending older
      // debounce and the deduplication baseline for the next OS event.
      this.clearTimer('networkDebounce');
      this.kind = kind;
      this.reportedKind = kind;
      this.reevaluate();
    });
  }

  // MARK: Choosing a path

  /** `auto` with LAN credentials that the relay has not rejected. */
  private get autoLan(): boolean {
    return this.opts.preference === 'auto' && this.opts.hasLan && !this.lanBlocked;
  }

  private lanCapable(kind: NetworkKind = this.kind): boolean {
    return kind === 'lan' || kind === 'unknown';
  }

  /** First decision under `auto`: LAN if the phone could be on the Mac's network and the relay answers. */
  private async chooseInitial(epoch: number): Promise<void> {
    this.choosing = true;
    this.setStatus({ state: 'connecting', attempt: 0 });
    const kind = await this.readNetwork();
    if (epoch !== this.epoch) return;
    this.kind = kind;
    this.reportedKind ??= kind;
    const useLan = this.lanCapable(kind) && (await this.probe());
    if (epoch !== this.epoch) return;
    this.choosing = false;
    this.log(`auto: network=${kind}, ${useLan ? 'LAN relay answered' : 'using the broker'}`);
    this.activate(useLan ? 'lan' : 'broker');
    if (!useLan) this.scheduleLanRetry();
  }

  /** Re-decides under `auto` after a network change or wake. */
  private reevaluate(): void {
    if (!this.running || !this.active || !this.autoLan || this.choosing) return;
    if (this.active.transport === 'lan') {
      if (this.kind === 'cellular') this.fallBackToBroker('the phone left Wi-Fi');
      else if (this.kind !== 'none') void this.recheckLan(this.active);
      return;
    }
    if (this.lanCapable()) {
      this.clearTimer('lanRetryTimer');
      void this.tryUpgrade();
    }
  }

  /**
   * The LAN path is in doubt (it failed, or the network changed): keep it if
   * the relay still answers its health check, otherwise use the broker now
   * rather than waiting out socket timeouts on an address that is gone.
   */
  private async recheckLan(path: Path): Promise<void> {
    const epoch = this.epoch;
    const answered = await this.probe();
    if (epoch !== this.epoch || this.active !== path) return;
    if (answered) {
      path.connection.wake();
    } else if (this.autoLan) {
      this.fallBackToBroker('the LAN relay stopped answering');
    }
  }

  private fallBackToBroker(why: string): void {
    this.log(`auto: ${why}; switching to the broker`);
    this.activate('broker');
    this.scheduleLanRetry();
  }

  /** While on the broker under `auto`: probe LAN and, if it answers, open it in the background. */
  private async tryUpgrade(): Promise<void> {
    if (!this.running || !this.autoLan || this.upgrading || this.candidate) return;
    if (this.active?.transport !== 'broker' || !this.lanCapable()) return;
    const epoch = this.epoch;
    this.upgrading = true;
    const answered = await this.probe();
    if (epoch !== this.epoch) return;
    this.upgrading = false;
    if (!this.running || !this.autoLan || this.active?.transport !== 'broker' || this.candidate) return;
    if (!answered) {
      this.scheduleLanRetry();
      return;
    }
    this.log('auto: LAN relay answered; connecting to it in the background');
    this.openCandidate();
  }

  private scheduleLanRetry(): void {
    if (!this.running || !this.autoLan) return;
    this.clearTimer('lanRetryTimer');
    const delay = this.lanRetryDelay;
    this.lanRetryDelay = Math.min(this.lanRetryDelay * 2, this.opts.lanRetryMaxMs);
    this.lanRetryTimer = setTimeout(() => {
      this.lanRetryTimer = null;
      void this.tryUpgrade();
    }, delay);
  }

  // MARK: Paths

  /**
   * Break-before-make switch: stops the current path (its pending RPCs fail
   * with `closed`) and starts a fresh one. Its `connecting` status reaches
   * consumers before anything else, so the switch reads as a reconnect.
   */
  private activate(transport: ActiveTransport): void {
    this.discardCandidate();
    this.clearTimer('lanDeadline');
    const previous = this.active;
    this.active = null;
    if (previous) {
      previous.dispose();
      previous.connection.stop();
    }
    const path = this.createPath(transport);
    this.active = path;
    this.setTransport(transport);
    let reported = false;
    const untilFirst = path.connection.onStatus(() => {
      reported = true;
    });
    path.connection.start();
    untilFirst();
    if (!reported && this.active === path) this.onActiveStatus(path, { state: 'connecting', attempt: 0 });
  }

  private createPath(transport: ActiveTransport): Path {
    const connection = this.opts.connect(transport);
    const path: Path = { transport, connection, dispose: () => {}, healthy: false };
    const offStatus = connection.onStatus((status) => {
      if (this.active === path) this.onActiveStatus(path, status);
      else if (this.candidate === path) this.onCandidateStatus(path, status);
    });
    const offPush = connection.onPush((frame) => {
      if (this.active !== path) return;
      for (const listener of this.pushListeners) {
        try {
          listener(frame);
        } catch (error) {
          this.log(`push listener threw: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    });
    path.dispose = () => {
      offStatus();
      offPush();
    };
    return path;
  }

  private onActiveStatus(path: Path, status: ConnectionStatus): void {
    const lanAuto = path.transport === 'lan' && this.autoLan;
    switch (status.state) {
      case 'open':
        this.clearTimer('lanDeadline');
        path.healthy = true;
        if (path.transport === 'lan') this.lanRetryDelay = this.opts.lanRetryMinMs;
        this.setStatus(status);
        return;
      case 'connecting':
        if (lanAuto && !this.lanDeadline) {
          this.lanDeadline = setTimeout(() => {
            this.lanDeadline = null;
            if (this.active === path && !path.connection.isOpen && this.autoLan) {
              this.fallBackToBroker('the LAN socket did not open in time');
            }
          }, this.opts.lanConnectTimeoutMs);
        }
        this.setStatus(status);
        return;
      case 'waiting':
      case 'auth_failed':
        this.clearTimer('lanDeadline');
        if (lanAuto) {
          this.onLanFailed(path, status);
          return;
        }
        this.setStatus(status);
        // The broker is down or the Mac's tunnel dropped: LAN may still work.
        if (path.transport === 'broker' && status.state === 'waiting' && this.autoLan && this.lanCapable()) {
          this.clearTimer('lanRetryTimer');
          void this.tryUpgrade();
        }
        return;
      case 'idle':
        this.setStatus(status);
        return;
    }
  }

  /** The active LAN path failed under `auto`. */
  private onLanFailed(path: Path, status: ConnectionStatus): void {
    if (status.state === 'auth_failed') {
      // The relay no longer knows this phone's LAN token; retrying cannot fix
      // that, so stay on the broker until the computer is paired again.
      this.lanBlocked = true;
      this.log('auto: the LAN relay rejected this phone; using the broker only');
      this.activate('broker');
      return;
    }
    const wasHealthy = path.healthy;
    path.healthy = false;
    if (wasHealthy && this.lanCapable()) {
      // One drop on a working LAN (relay restart, iOS suspending the socket):
      // if the relay still answers, reconnect there instead of bouncing to
      // the broker and back.
      this.setStatus(status);
      void this.recheckLan(path);
      return;
    }
    this.fallBackToBroker('the LAN connection failed');
  }

  /** Make-before-break: connect LAN while the broker keeps serving, and switch only once LAN is open. */
  private openCandidate(): void {
    const path = this.createPath('lan');
    this.candidate = path;
    this.candidateDeadline = setTimeout(() => {
      this.candidateDeadline = null;
      if (this.candidate !== path) return;
      this.log('auto: the LAN socket did not open in time; staying on the broker');
      this.discardCandidate();
      this.scheduleLanRetry();
    }, this.opts.lanConnectTimeoutMs);
    path.connection.start();
  }

  private onCandidateStatus(path: Path, status: ConnectionStatus): void {
    if (status.state === 'open') {
      this.promote(path, status);
      return;
    }
    if (status.state === 'connecting') return;
    if (status.state === 'auth_failed') {
      this.lanBlocked = true;
      this.log('auto: the LAN relay rejected this phone; using the broker only');
    } else {
      this.log('auto: the LAN socket failed; staying on the broker');
    }
    this.discardCandidate();
    this.scheduleLanRetry();
  }

  private promote(path: Path, status: ConnectionStatus): void {
    this.clearTimer('candidateDeadline');
    this.clearTimer('lanRetryTimer');
    this.candidate = null;
    const previous = this.active;
    this.active = path;
    path.healthy = true;
    this.lanRetryDelay = this.opts.lanRetryMinMs;
    if (previous) {
      previous.dispose();
      previous.connection.stop();
    }
    this.log('auto: switched to the LAN relay');
    this.setTransport('lan');
    // Consumers resubscribe on a non-open -> open edge.
    this.setStatus({ state: 'connecting', attempt: 0 });
    this.setStatus(status);
  }

  private discardCandidate(): void {
    this.clearTimer('candidateDeadline');
    const candidate = this.candidate;
    this.candidate = null;
    if (!candidate) return;
    candidate.dispose();
    candidate.connection.stop();
  }

  // MARK: Network changes

  /** Raw reports: exact repeats are dropped, real changes are acted on once the burst settles. */
  private networkReported(epoch: number, kind: NetworkKind): void {
    if (epoch !== this.epoch || !this.running) return;
    this.networkRevision++;
    if (kind === this.reportedKind) return;
    this.reportedKind = kind;
    this.clearTimer('networkDebounce');
    this.networkDebounce = setTimeout(() => {
      this.networkDebounce = null;
      this.kind = kind;
      this.networkChanged();
    }, this.opts.networkDebounceMs);
  }

  private networkChanged(): void {
    if (!this.running || !this.active || this.choosing) return;
    this.log(`network changed: ${this.kind}`);
    // Skip any reconnect backoff, or check that an open socket survived the change.
    if (this.kind !== 'none') this.active.connection.wake();
    if (!this.autoLan) return;
    if (this.lanCapable()) this.lanRetryDelay = this.opts.lanRetryMinMs;
    this.reevaluate();
  }

  // MARK: Helpers

  private probe(): Promise<boolean> {
    return withTimeout(this.opts.probeLan(this.opts.probeTimeoutMs), this.opts.probeTimeoutMs + 500, false);
  }

  private readNetwork(): Promise<NetworkKind> {
    return withTimeout(this.opts.network.current(), this.opts.networkReadTimeoutMs, 'unknown');
  }

  private clearTimer(name: 'lanRetryTimer' | 'lanDeadline' | 'candidateDeadline' | 'networkDebounce'): void {
    const timer = this[name];
    if (timer) clearTimeout(timer);
    this[name] = null;
  }

  private setTransport(transport: ActiveTransport): void {
    if (transport === this.currentTransport) return;
    this.currentTransport = transport;
    for (const listener of this.transportListeners) listener(transport);
  }

  private setStatus(status: ConnectionStatus): void {
    this.currentStatus = status;
    for (const listener of this.statusListeners) listener(status);
  }

  private log(message: string): void {
    this.opts.log(message);
  }
}

/** Resolves to `fallback` if `promise` rejects or takes longer than `ms`. */
export function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}
