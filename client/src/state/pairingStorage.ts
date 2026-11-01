import { randomUUID } from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

/** What the phone keeps after pairing. The token is a secret; never log this. */
export type StoredPairing = {
  version: 1;
  serverUrl: string;
  relayId: string;
  deviceId: string;
  token: string;
  pairedAt: string;
};

const PAIRING_KEY = 'panecast.pairing.v1';
const CLIENT_ID_KEY = 'panecast.clientId';

/** The token stays on this device: not in backups, not migrated to a new phone. */
const OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

/** SecureStore has no web implementation; the web client cannot pair yet. */
export const storageSupported = Platform.OS === 'ios' || Platform.OS === 'android';

export async function loadPairing(): Promise<StoredPairing | null> {
  if (!storageSupported) return null;
  const raw = await SecureStore.getItemAsync(PAIRING_KEY, OPTIONS);
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<StoredPairing>;
    if (
      value.version === 1 &&
      typeof value.serverUrl === 'string' &&
      typeof value.relayId === 'string' &&
      typeof value.deviceId === 'string' &&
      typeof value.token === 'string' &&
      value.token.length > 0
    ) {
      return value as StoredPairing;
    }
  } catch {
    // fall through: unreadable entries are dropped
  }
  await SecureStore.deleteItemAsync(PAIRING_KEY, OPTIONS);
  return null;
}

export async function savePairing(pairing: StoredPairing): Promise<void> {
  if (!storageSupported) throw new Error('这个平台不支持安全存储');
  await SecureStore.setItemAsync(PAIRING_KEY, JSON.stringify(pairing), OPTIONS);
}

export async function clearPairing(): Promise<void> {
  if (!storageSupported) return;
  await SecureStore.deleteItemAsync(PAIRING_KEY, OPTIONS);
}

/**
 * Stable per install. The broker replaces an earlier registration with the
 * same client id, so re-pairing does not pile up device entries.
 */
export async function getClientId(): Promise<string> {
  if (!storageSupported) return randomUUID();
  const existing = await SecureStore.getItemAsync(CLIENT_ID_KEY, OPTIONS);
  if (existing) return existing;
  const id = randomUUID();
  await SecureStore.setItemAsync(CLIENT_ID_KEY, id, OPTIONS);
  return id;
}
