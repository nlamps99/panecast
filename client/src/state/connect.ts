import Constants from 'expo-constants';
import * as Device from 'expo-device';
import { Platform } from 'react-native';

import { RelayConnection, type SocketLike } from '../protocol/connection';
import { brokerEndpoint, webSocketUrl } from '../protocol/endpoint';
import type { PairingPayload } from '../protocol/pairing';
import { registerDevice, RegisterFailure } from '../protocol/register';
import type { RpcChannel, StatusSource } from '../session/terminalSession';
import type { StoredComputer, TransportPreference } from './computers';
import { getClientId, newComputerId } from './pairingStorage';

export class PairingError extends Error {}

export const APP_VERSION = Constants.expoConfig?.version ?? '0.1.0';

/** Which path a connection is using right now; shown in the UI. */
export type ActiveTransport = 'broker' | 'lan';

/**
 * A live connection to one computer. `wake` and `stop` are lifecycle hooks
 * for the app; `transport` reports the path in use.
 */
export type ComputerChannel = RpcChannel &
  StatusSource & {
    start(): void;
    stop(): void;
    wake(): void;
    readonly transport: ActiveTransport;
    onTransport(listener: (transport: ActiveTransport) => void): () => void;
  };

/**
 * Registers this phone with the computer described by a scanned pairing
 * payload and returns the record to store.
 */
export async function registerComputer(payload: PairingPayload): Promise<StoredComputer> {
  const endpoint = brokerEndpoint(payload.serverUrl, payload.relayId);
  if (!endpoint.ok) {
    throw new PairingError(endpoint.error === 'insecure_url' ? '服务器地址必须是 https。' : '二维码里的服务器地址无效。');
  }
  let credentials;
  try {
    credentials = await registerDevice({
      endpoint: endpoint.endpoint,
      pairingCode: payload.pairingCode,
      clientId: await getClientId(),
      deviceName: deviceName(),
    });
  } catch (error) {
    if (error instanceof RegisterFailure) throw new PairingError(error.message);
    throw error;
  }
  return {
    id: newComputerId(),
    name: payload.relayId,
    broker: { serverUrl: endpoint.endpoint.baseUrl, relayId: payload.relayId, ...credentials },
    pairedAt: new Date().toISOString(),
  };
}

/** Opens a connection to a stored computer. Broker only for now. */
export function createComputerChannel(
  computer: StoredComputer,
  _preference: TransportPreference,
  log: (message: string) => void,
): ComputerChannel | null {
  const endpoint = brokerEndpoint(computer.broker.serverUrl, computer.broker.relayId);
  if (!endpoint.ok) return null;
  const connection = new RelayConnection({
    url: webSocketUrl(endpoint.endpoint),
    token: computer.broker.token,
    deviceId: computer.broker.deviceId,
    appVersion: APP_VERSION,
    createSocket,
    log,
  });
  return Object.assign(connection, {
    transport: 'broker' as const,
    onTransport: () => () => {},
  });
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
  const NativeWebSocket = WebSocket as unknown as new (u: string, p: string[], o?: { headers: Record<string, string> }) => SocketLike;
  return Platform.OS === 'web' ? new NativeWebSocket(url, protocols) : new NativeWebSocket(url, protocols, { headers });
}
