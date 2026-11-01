import Constants from 'expo-constants';
import * as Device from 'expo-device';
import { Platform } from 'react-native';

import { DemoChannel } from '../demo/demoChannel';
import { RelayConnection, type SocketLike } from '../protocol/connection';
import { brokerEndpoint, webSocketUrl } from '../protocol/endpoint';
import { parsePairingUrl } from '../protocol/pairing';
import { registerDevice, RegisterFailure } from '../protocol/register';
import { InboxStore } from '../session/inboxStore';
import { TerminalSession, type RpcChannel, type StatusSource } from '../session/terminalSession';
import { WorkspaceStore } from '../session/workspaceStore';
import { clearPairing, getClientId, loadPairing, savePairing, storageSupported, type StoredPairing } from './pairingStorage';

/** Everything that exists while connected to one Mac (or the demo). */
export type Machine = {
  mode: 'relay' | 'demo';
  /** Set in relay mode. */
  pairing: StoredPairing | null;
  channel: RpcChannel & StatusSource;
  session: TerminalSession;
  workspaces: WorkspaceStore;
  inbox: InboxStore;
};

export type AppStoreState = {
  /** `loading` until SecureStore has been read. */
  phase: 'loading' | 'unpaired' | 'ready';
  machine: Machine | null;
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
  private state: AppStoreState = { phase: 'loading', machine: null };
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
    this.activate(pairing ? this.relayMachine(pairing) : null);
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
    this.activate(this.relayMachine(pairing));
  }

  /** Forgets the pairing on this phone. The broker entry stays until revoked there. */
  async unpair(): Promise<void> {
    this.activate(null);
    await clearPairing();
  }

  /** A pretend Mac, for trying the app without pairing (and for App Review). */
  enterDemo(): void {
    if (this.state.machine?.mode === 'demo') return;
    const channel = new DemoChannel();
    this.activate({ mode: 'demo', pairing: null, channel, ...this.stores(channel) });
  }

  /** Leaves the demo for the real Mac if one is paired, otherwise for the pairing screen. */
  async exitDemo(): Promise<void> {
    if (this.state.machine?.mode !== 'demo') return;
    let pairing: StoredPairing | null = null;
    try {
      pairing = await loadPairing();
    } catch {
      pairing = null;
    }
    this.activate(pairing ? this.relayMachine(pairing) : null);
  }

  /** Called when the app returns to the foreground. */
  wake(): void {
    const channel = this.state.machine?.channel;
    if (channel instanceof RelayConnection) channel.wake();
  }

  private relayMachine(pairing: StoredPairing): Machine | null {
    const endpoint = brokerEndpoint(pairing.serverUrl, pairing.relayId);
    if (!endpoint.ok) return null;
    const channel = new RelayConnection({
      url: webSocketUrl(endpoint.endpoint),
      token: pairing.token,
      deviceId: pairing.deviceId,
      appVersion: APP_VERSION,
      createSocket,
      log,
    });
    return { mode: 'relay', pairing, channel, ...this.stores(channel) };
  }

  private stores(channel: RpcChannel) {
    return {
      session: new TerminalSession(channel, { liveLines: 120, log }),
      workspaces: new WorkspaceStore(channel),
      inbox: new InboxStore(channel),
    };
  }

  private activate(machine: Machine | null): void {
    const previous = this.state.machine;
    if (previous) {
      previous.session.setTarget(null);
      previous.session.dispose();
      previous.workspaces.dispose();
      previous.inbox.dispose();
      if (previous.channel instanceof RelayConnection) previous.channel.stop();
    }
    this.setState({ phase: machine ? 'ready' : 'unpaired', machine });
    if (machine?.channel instanceof RelayConnection) machine.channel.start();
    else if (machine) void machine.workspaces.refresh();
  }

  private setState(state: AppStoreState): void {
    this.state = state;
    for (const listener of this.listeners) listener();
  }
}

export const appStore = new AppStore();
