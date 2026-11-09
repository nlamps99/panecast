import { randomUUID } from 'expo-crypto';
import { secureStorage, secureStorageSupported } from '../platform/secureStorage';

import { EMPTY_COMPUTER_LIST, type ComputerList, type StoredComputer } from './computers';

const COMPUTERS_KEY = 'panecast.computers.v2';
/** The single-computer record written by builds before multi-computer support. */
const LEGACY_PAIRING_KEY = 'panecast.pairing.v1';
const CLIENT_ID_KEY = 'panecast.clientId';

export const storageSupported = secureStorageSupported;

export async function loadComputers(): Promise<ComputerList> {
  if (!storageSupported) return EMPTY_COMPUTER_LIST;
  const raw = await secureStorage.get(COMPUTERS_KEY);
  if (raw) {
    const parsed = parseList(raw);
    if (parsed) return parsed;
    await secureStorage.remove(COMPUTERS_KEY);
  }
  const migrated = await migrateLegacy();
  if (migrated.computers.length > 0) await saveComputers(migrated);
  return migrated;
}

export async function saveComputers(list: ComputerList): Promise<void> {
  if (!storageSupported) throw new Error('这个平台不支持安全存储');
  await secureStorage.set(COMPUTERS_KEY, JSON.stringify(list));
}

/**
 * Stable per install. The broker replaces an earlier registration with the
 * same client id, so re-pairing does not pile up device entries.
 */
export async function getClientId(): Promise<string> {
  if (!storageSupported) return randomUUID();
  const existing = await secureStorage.get(CLIENT_ID_KEY);
  if (existing) return existing;
  const id = randomUUID();
  await secureStorage.set(CLIENT_ID_KEY, id);
  return id;
}

export function newComputerId(): string {
  return randomUUID();
}

function parseList(raw: string): ComputerList | null {
  try {
    const value = JSON.parse(raw) as Partial<ComputerList>;
    if (value.version !== 2 || !Array.isArray(value.computers)) return null;
    const computers = value.computers.filter(isComputer);
    return {
      version: 2,
      selectedId: typeof value.selectedId === 'string' ? value.selectedId : null,
      computers,
      transport: typeof value.transport === 'object' && value.transport !== null ? value.transport : undefined,
    };
  } catch {
    return null;
  }
}

function isComputer(value: unknown): value is StoredComputer {
  if (typeof value !== 'object' || value === null) return false;
  const c = value as Partial<StoredComputer>;
  return (
    typeof c.id === 'string' &&
    typeof c.name === 'string' &&
    typeof c.broker?.serverUrl === 'string' &&
    typeof c.broker.relayId === 'string' &&
    typeof c.broker.token === 'string' &&
    c.broker.token.length > 0 &&
    typeof c.broker.deviceId === 'string'
  );
}

/** Reads the v1 single-pairing record, if any, and removes it. */
async function migrateLegacy(): Promise<ComputerList> {
  const raw = await secureStorage.get(LEGACY_PAIRING_KEY);
  if (!raw) return EMPTY_COMPUTER_LIST;
  let computer: StoredComputer | null = null;
  try {
    const v1 = JSON.parse(raw) as Record<string, unknown>;
    if (
      v1.version === 1 &&
      typeof v1.serverUrl === 'string' &&
      typeof v1.relayId === 'string' &&
      typeof v1.deviceId === 'string' &&
      typeof v1.token === 'string' &&
      v1.token.length > 0
    ) {
      computer = {
        id: newComputerId(),
        name: v1.relayId,
        broker: { serverUrl: v1.serverUrl, relayId: v1.relayId, deviceId: v1.deviceId, token: v1.token },
        pairedAt: typeof v1.pairedAt === 'string' ? v1.pairedAt : new Date().toISOString(),
      };
    }
  } catch {
    computer = null;
  }
  await secureStorage.remove(LEGACY_PAIRING_KEY);
  return computer ? { version: 2, selectedId: computer.id, computers: [computer] } : EMPTY_COMPUTER_LIST;
}
