import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Network from 'expo-network';
import { Platform } from 'react-native';
import { desktopBridge, DesktopSocket, serviceFetch } from '../platform/desktop';

import { RelayConnection, type SocketLike } from '../protocol/connection';
import { brokerEndpoint, healthUrl, lanEndpoint, webSocketUrl } from '../protocol/endpoint';
import type { PairingPayload } from '../protocol/pairing';
import { parseShareKey } from '../protocol/shareKey';
import { registerDevice, RegisterFailure, type DeviceCredentials } from '../protocol/register';
import type { RpcChannel, StatusSource } from '../session/terminalSession';
import { AutoChannel, networkKindOf, withTimeout, type ActiveTransport, type NetworkKind, type NetworkWatcher } from './autoChannel';
import type { StoredComputer, TransportPreference } from './computers';
import { getClientId, newComputerId } from './pairingStorage';

export class PairingError extends Error {}

export const APP_VERSION = Constants.expoConfig?.version ?? '0.1.0';

export type { ActiveTransport } from './autoChannel';

/**
 * A live connection to one computer. `wake` and `stop` are lifecycle hooks
 * for the app; `transport` reports the path in use.
 */
export type ComputerChannel = RpcChannel &
  StatusSource & {
    start(): void;
    stop(): void;
    wake(): void;
    /** The user asked to reconnect: start over now, from any state. */
    reconnect(): void;
    readonly transport: ActiveTransport;
    /** The direct path is this computer's own gateway (desktop app on the paired Mac). */
    readonly directIsLocal: boolean;
    onTransport(listener: (transport: ActiveTransport) => void): () => void;
  };

/**
 * Registers this phone with the computer described by a scanned pairing
 * payload and returns the record to store.
 *
 * The broker registration comes first and must succeed. If the QR also
 * carries a private-LAN relay address, the phone then registers there too
 * (the relay issues a separate token); that part is best effort, because the
 * phone may not be on the Mac's Wi-Fi right now.
 */
/**
 * The entry for a window shared with a key. The key already carries a
 * credential for this one window, so nothing is registered.
 */
export function sharedWindow(raw: string): StoredComputer {
  const key = parseShareKey(raw);
  if (!key) throw new PairingError('分享密钥不完整，请向分享者重新复制一份。');
  const endpoint = brokerEndpoint(key.serverUrl, key.relayId);
  if (!endpoint.ok) throw new PairingError(endpoint.error === 'insecure_url' ? '分享密钥里的服务器地址必须是 https。' : '分享密钥里的服务器地址无效。');
  const name = key.name || '分享窗口';
  return {
    id: newComputerId(),
    name,
    broker: { serverUrl: endpoint.endpoint.baseUrl, relayId: key.relayId, deviceId: key.deviceId, token: key.token },
    pairedAt: new Date().toISOString(),
    share: { name },
  };
}

export async function registerComputer(payload: PairingPayload): Promise<StoredComputer> {
  const endpoint = brokerEndpoint(payload.serverUrl, payload.relayId);
  if (!endpoint.ok) {
    throw new PairingError(endpoint.error === 'insecure_url' ? '服务器地址必须是 https。' : '二维码里的服务器地址无效。');
  }
  const clientId = await getClientId();
  const name = deviceName();
  let credentials: DeviceCredentials;
  try {
    credentials = await registerDevice({
      endpoint: endpoint.endpoint,
      pairingCode: payload.pairingCode,
      clientId,
      deviceName: name,
    });
  } catch (error) {
    if (error instanceof RegisterFailure) throw new PairingError(error.message);
    throw error;
  }
  const lan = await registerLan(payload, clientId, name);
  return {
    id: newComputerId(),
    name: payload.relayId,
    broker: { serverUrl: endpoint.endpoint.baseUrl, relayId: payload.relayId, ...credentials },
    ...(lan ? { lan } : {}),
    pairedAt: new Date().toISOString(),
  };
}

/** Total time LAN registration may add to pairing. */
const LAN_REGISTER_BUDGET_MS = 8_000;
const LAN_REGISTER_ATTEMPT_MS = 3_000;
const LAN_REGISTER_RETRY_DELAY_MS = 1_000;
const LAN_REGISTER_MAX_ATTEMPTS = 5;
/**
 * A network error faster than this is the OS refusing outright, typically
 * iOS while its local-network permission prompt is on screen: worth retrying
 * once the user has answered. A slow failure means nothing answers there.
 */
const LAN_FAST_FAILURE_MS = 1_000;

/** Best-effort LAN registration. Never throws; returns null when LAN is not usable now. */
async function registerLan(
  payload: PairingPayload,
  clientId: string,
  name: string,
): Promise<StoredComputer['lan'] | null> {
  if (!payload.lanUrl || !payload.lanPairingCode) return null;
  const endpoint = lanEndpoint(payload.lanUrl);
  if (!endpoint.ok) {
    devLog(`LAN pairing skipped: lan URL ${endpoint.error}`);
    return null;
  }
  if ((await currentNetworkKind()) === 'cellular') {
    devLog('LAN pairing skipped: not on Wi-Fi');
    return null;
  }
  const deadline = Date.now() + LAN_REGISTER_BUDGET_MS;
  for (let attempt = 1; attempt <= LAN_REGISTER_MAX_ATTEMPTS; attempt++) {
    const startedAt = Date.now();
    try {
      const credentials = await registerDevice({
        endpoint: endpoint.endpoint,
        pairingCode: payload.lanPairingCode,
        clientId,
        deviceName: name,
        timeoutMs: Math.max(500, Math.min(LAN_REGISTER_ATTEMPT_MS, deadline - startedAt)),
      });
      return { url: endpoint.endpoint.baseUrl, ...credentials };
    } catch (error) {
      const kind = error instanceof RegisterFailure ? error.error.kind : 'unexpected';
      const fast = kind === 'network' && Date.now() - startedAt < LAN_FAST_FAILURE_MS;
      const retry = fast && Date.now() + LAN_REGISTER_RETRY_DELAY_MS + 500 < deadline;
      devLog(`LAN pairing attempt ${attempt} failed: ${kind}${retry ? '; retrying' : ''}`);
      if (!retry) return null;
      await sleep(LAN_REGISTER_RETRY_DELAY_MS);
    }
  }
  return null;
}

/**
 * Opens a connection to a stored computer, honoring the transport
 * preference (`auto` / `broker` / `lan`); see `AutoChannel`.
 */
export function createComputerChannel(
  computer: StoredComputer,
  preference: TransportPreference,
  log: (message: string) => void,
): ComputerChannel | null {
  const broker = brokerEndpoint(computer.broker.serverUrl, computer.broker.relayId);
  if (!broker.ok) return null;
  const brokerUrl = webSocketUrl(broker.endpoint);
  const stored = storedLan(computer);
  // The desktop app on the computer it controls talks to that computer's
  // gateway over loopback instead of a round trip through the server.
  const desktop = desktopBridge()?.localGateway !== undefined && !computer.share;
  // This computer's own gateway stays the direct path for a while after its
  // credential file disappears (the gateway restarting rewrites it), so a
  // refused old token is not taken for a stale LAN pairing and the status
  // still blames the local gateway. Not for good: after the grace period, or
  // once the server path connects meanwhile, it is an ordinary computer.
  let localSeenAt: number | null = null;
  const local = () => {
    const gateway = desktop ? localGatewayFor(computer) : null;
    if (gateway) localSeenAt = Date.now();
    return gateway;
  };
  const restarting = () => localSeenAt !== null && Date.now() - localSeenAt < LOCAL_GATEWAY_GRACE_MS;
  const direct = () => local() ?? stored;
  const channel = new AutoChannel({
    preference,
    hasLan: stored !== null || desktop,
    lanLocal: () => desktop && (local() !== null || restarting()),
    ...(desktop ? { lanRetryMinMs: 3_000, lanRetryMaxMs: 30_000, probeTimeoutMs: 800 } : {}),
    connect: (transport) => {
      const path = transport === 'lan' ? direct() : null;
      const target = path
        ? { url: path.webSocketUrl, token: path.token, deviceId: path.deviceId }
        : { url: brokerUrl, token: computer.broker.token, deviceId: computer.broker.deviceId };
      return new RelayConnection({
        ...target,
        appVersion: APP_VERSION,
        createSocket,
        log: (message) => log(`[${path === null ? 'broker' : local() ? 'local' : transport}] ${message}`),
      });
    },
    probeLan: async (timeoutMs) => {
      if (desktop) await refreshLocalGateway();
      const path = direct();
      return path ? probeHealth(path.healthUrl, timeoutMs) : false;
    },
    network: expoNetworkWatcher,
    log,
  });
  // The server reached the computer while its file is gone: its gateway is not restarting here.
  if (desktop) channel.onStatus((status) => { if (status.state === 'open' && channel.transport === 'broker') localSeenAt = null; });
  return channel;
}

/** How long this computer's gateway still counts as the direct path after its credential file disappeared. */
export const LOCAL_GATEWAY_GRACE_MS = 3 * 60_000;

/** The credential file the gateway on this computer leaves for the desktop app. */
export type LocalGateway = { webSocketUrl: string; healthUrl: string; token: string; deviceId: string; relayId: string | null; brokerUrl: string | null };
let localGateway: LocalGateway | null = null;

export function parseLocalGateway(value: unknown): LocalGateway | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const text = (key: string) => (typeof raw[key] === 'string' && (raw[key] as string).length > 0 ? (raw[key] as string) : null);
  const url = text('url'), health = text('health_url') ?? text('healthUrl'), token = text('token'), deviceId = text('device_id') ?? text('deviceId');
  if (!url || !health || !token || !deviceId) return null;
  try {
    const socket = new URL(url), probe = new URL(health);
    if (socket.protocol !== 'ws:' || probe.protocol !== 'http:' || socket.host !== probe.host || socket.pathname !== '/v1/ws' || probe.pathname !== '/v1/health') return null;
  } catch { return null; }
  return { webSocketUrl: url, healthUrl: health, token, deviceId, relayId: text('relay_id') ?? text('relayId'), brokerUrl: text('broker_url') ?? text('brokerUrl') };
}

/** Re-reads the local credential; the gateway rotates it on every start. */
export async function refreshLocalGateway(): Promise<LocalGateway | null> {
  const bridge = desktopBridge();
  if (!bridge?.localGateway) return (localGateway = null);
  try { localGateway = parseLocalGateway(await bridge.localGateway()); } catch { localGateway = null; }
  return localGateway;
}

/**
 * The local gateway, if it is the one this stored computer was paired with.
 * Never for a shared window: its key must stay a guest even on the computer
 * that shares it, where the local credential has full access.
 */
export function localGatewayFor(computer: Pick<StoredComputer, 'broker' | 'share'>, gateway: LocalGateway | null = localGateway): LocalGateway | null {
  if (computer.share) return null;
  if (!gateway?.relayId || !gateway.brokerUrl || gateway.relayId !== computer.broker.relayId) return null;
  const same = (a: string, b: string) => a.replace(/\/+$/, '').toLowerCase() === b.replace(/\/+$/, '').toLowerCase();
  return same(gateway.brokerUrl, computer.broker.serverUrl) ? gateway : null;
}

/** The stored LAN half, if it is complete and still names a private-LAN relay. */
function storedLan(
  computer: StoredComputer,
): { webSocketUrl: string; healthUrl: string; token: string; deviceId: string } | null {
  const lan = computer.lan;
  if (!lan || typeof lan.url !== 'string' || typeof lan.token !== 'string' || typeof lan.deviceId !== 'string') return null;
  if (lan.token.length === 0 || lan.deviceId.length === 0) return null;
  const endpoint = lanEndpoint(lan.url);
  if (!endpoint.ok) return null;
  return { webSocketUrl: webSocketUrl(endpoint.endpoint), healthUrl: healthUrl(endpoint.endpoint), token: lan.token, deviceId: lan.deviceId };
}

/**
 * GET `/v1/health` on the LAN relay. Only the relay's exact `{"ok":true}`
 * counts, so some other device at that address is not mistaken for the Mac.
 * No query string: the relay routes the raw request path.
 */
export async function probeHealth(url: string, timeoutMs: number, fetchImpl: typeof fetch = serviceFetch): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: { 'Cache-Control': 'no-cache' },
      signal: controller.signal,
    });
    if (response.status !== 200) return false;
    const body: unknown = await response.json();
    return typeof body === 'object' && body !== null && (body as { ok?: unknown }).ok === true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** expo-network, reduced to what `AutoChannel` needs. */
export const expoNetworkWatcher: NetworkWatcher = {
  current: currentNetworkKind,
  watch(listener) {
    try {
      const subscription = Network.addNetworkStateListener((state) => listener(networkKindOf(state)));
      return () => subscription.remove();
    } catch {
      return () => {};
    }
  },
};

function currentNetworkKind(): Promise<NetworkKind> {
  return withTimeout(
    Network.getNetworkStateAsync().then(networkKindOf),
    1_000,
    'unknown' as NetworkKind,
  );
}

export function deviceName(): string {
  return Device.deviceName ?? Device.modelName ?? 'Panecast';
}

/**
 * React Native's WebSocket takes a non-standard third argument whose `headers`
 * ride on the upgrade request; that carries the bearer token. Browsers cannot
 * set headers, so on the web the broker rejects the upgrade (undecided, see
 * CLAUDE.md).
 */
export function createSocket(url: string, protocols: string[], headers: Record<string, string>): SocketLike {
  const desktop = desktopBridge();
  if (desktop) return new DesktopSocket(desktop, url, protocols, headers);
  const NativeWebSocket = WebSocket as unknown as new (u: string, p: string[], o?: { headers: Record<string, string> }) => SocketLike;
  return Platform.OS === 'web' ? new NativeWebSocket(url, protocols) : new NativeWebSocket(url, protocols, { headers });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Never logs URLs, codes or tokens: the LAN address and pairing codes are private. */
function devLog(message: string): void {
  if (__DEV__) console.log(`[pair] ${message}`);
}
