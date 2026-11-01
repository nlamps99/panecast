import Constants from 'expo-constants';
import * as Device from 'expo-device';
import { Platform } from 'react-native';

import { RelayConnection, type SocketLike } from '../protocol/connection';
import { brokerEndpoint, webSocketUrl } from '../protocol/endpoint';
import { parsePairingUrl } from '../protocol/pairing';
import { registerDevice, RegisterFailure } from '../protocol/register';
import { TerminalSession } from '../session/terminalSession';
import { clearPairing, getClientId, loadPairing, savePairing, storageSupported, type StoredPairing } from './pairingStorage';

export type AppStoreState = {
  /** `loading` until SecureStore has been read. */
  phase: 'loading' | 'unpaired' | 'paired';
  pairing: StoredPairing | null;
  connection: RelayConnection | null;
  session: TerminalSession | null;
};

export class PairingError extends Error {}

const APP_VERSION = Constants.expoConfig?.version ?? '0.1.0';

/**
 * React Native's WebSocket takes a non-standard third argument whose `headers`
 * ride on the upgrade request; that carries the bearer token. Browsers cannot
 * set headers, so on the web the broker rejects the upgrade (undecided, see
 * CLAUDE.md).
 */
function createSocket(url: string, protocols: string[], headers: Record<string, string>): SocketLike {
  const NativeWebSocket = WebSocket as unknown as new (u: string, p: string[], o?: { headers: Record<string, string> }) => SocketLike;
  return Platform.OS === 'web' ? new NativeWebSocket(url, protocols) : new NativeWebSocket(url, protocols, { headers });
}

function log(message: string) {
  if (__DEV__) console.log(`[relay] ${message}`);
}

/** App-wide pairing and connection state. One instance; React reads it with `useSyncExternalStore`. */
class AppStore {
  private state: AppStoreState = { phase: 'loading', pairing: null, connection: null, session: null };
  private listeners = new Set<() => void>();
  private loaded = false;

  getState = (): AppStoreState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    let pairing: StoredPairing | null = null;
    try {
      pairing = await loadPairing();
    } catch (error) {
      log(`could not read pairing: ${error instanceof Error ? error.message : String(error)}`);
    }
    this.activate(pairing);
  }

  /** Pairs with the relay described by a scanned `cmux://pair?...` URL. */
  async pair(rawUrl: string): Promise<void> {
    if (!storageSupported) throw new PairingError('网页版还不能配对，请用手机 App。');
    const parsed = parsePairingUrl(rawUrl);
    if (!parsed.ok) {
      throw new PairingError(
        parsed.error.kind === 'missing_field'
          ? `二维码缺少 ${parsed.error.field} 字段，请在电脑上重新生成。`
          : '这不是 Panecast 的配对二维码。',
      );
    }
    const endpoint = brokerEndpoint(parsed.payload.serverUrl, parsed.payload.relayId);
    if (!endpoint.ok) {
      throw new PairingError(endpoint.error === 'insecure_url' ? '服务器地址必须是 https。' : '二维码里的服务器地址无效。');
    }
    let credentials;
    try {
      credentials = await registerDevice({
        endpoint: endpoint.endpoint,
        pairingCode: parsed.payload.pairingCode,
        clientId: await getClientId(),
        deviceName: Device.deviceName ?? Device.modelName ?? 'Panecast',
      });
    } catch (error) {
      if (error instanceof RegisterFailure) throw new PairingError(error.message);
      throw error;
    }
    const pairing: StoredPairing = {
      version: 1,
      serverUrl: endpoint.endpoint.baseUrl,
      relayId: parsed.payload.relayId,
      deviceId: credentials.deviceId,
      token: credentials.token,
      pairedAt: new Date().toISOString(),
    };
    await savePairing(pairing);
    this.activate(pairing);
  }

  /** Forgets the pairing on this phone. The broker entry stays until revoked there. */
  async unpair(): Promise<void> {
    this.activate(null);
    await clearPairing();
  }

  /** Called when the app returns to the foreground. */
  wake(): void {
    this.state.connection?.wake();
  }

  private activate(pairing: StoredPairing | null): void {
    this.state.session?.dispose();
    this.state.connection?.stop();
    if (!pairing) {
      this.setState({ phase: 'unpaired', pairing: null, connection: null, session: null });
      return;
    }
    const endpoint = brokerEndpoint(pairing.serverUrl, pairing.relayId);
    if (!endpoint.ok) {
      this.setState({ phase: 'unpaired', pairing: null, connection: null, session: null });
      return;
    }
    const connection = new RelayConnection({
      url: webSocketUrl(endpoint.endpoint),
      token: pairing.token,
      deviceId: pairing.deviceId,
      appVersion: APP_VERSION,
      createSocket,
      log,
    });
    const session = new TerminalSession(connection, { liveLines: 120, log });
    this.setState({ phase: 'paired', pairing, connection, session });
    connection.start();
  }

  private setState(state: AppStoreState): void {
    this.state = state;
    for (const listener of this.listeners) listener();
  }
}

export const appStore = new AppStore();
