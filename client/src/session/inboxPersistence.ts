import type { AsyncStorageStatic } from '@react-native-async-storage/async-storage';

import type { InboxItem } from './inboxStore';

/**
 * Keeps each computer's inbox (items and read state) across launches, in
 * AsyncStorage: notifications are not secret enough for SecureStore, and
 * SecureStore caps values at about 2 KB.
 *
 * Writes for one key run one at a time, in order, and coalesce: a burst of
 * changes ends in one write of the newest list. The newest list per key is
 * also kept in memory, so an `InboxStore` created again for the same computer
 * (on reconnect, or switching back) starts from it instead of re-reading
 * storage, which could still hold an older list while a write is pending.
 */

export const INBOX_LIMIT = 200;

const VERSION = 1;

type Storage = Pick<AsyncStorageStatic, 'getItem' | 'setItem' | 'removeItem'>;

/** The newest list per key, once a store has loaded it. */
const snapshots = new Map<string, readonly InboxItem[]>();
/** Keys with a write queued but not yet started. */
const queued = new Set<string>();
/** The tail of each key's chain of storage operations. */
const chains = new Map<string, Promise<void>>();

let storage: Storage | null | undefined;

/**
 * AsyncStorage is required on first use: its module throws at import time
 * when the native side is missing (Jest without a mock), and every module
 * that imports `InboxStore` would inherit that.
 */
function getStorage(): Storage | null {
  if (storage === undefined) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const loaded = require('@react-native-async-storage/async-storage') as { default?: Storage } & Storage;
      storage = loaded.default ?? loaded;
    } catch (error) {
      warn('AsyncStorage unavailable; the inbox is kept in memory only', error);
      storage = null;
    }
  }
  return storage;
}

/** The AsyncStorage key for one paired computer's inbox. */
export function inboxStorageKey(computerId: string): string {
  return `panecast.inbox.v${VERSION}.${computerId}`;
}

/** The list a store loaded earlier in this process, if any. */
export function cachedInbox(key: string): readonly InboxItem[] | undefined {
  return snapshots.get(key);
}

/**
 * Reads a stored inbox, after any write queued for the key. Never throws:
 * unreadable or malformed data reads as empty.
 */
export async function readInbox(key: string): Promise<readonly InboxItem[]> {
  await chains.get(key);
  const cached = snapshots.get(key);
  if (cached) return cached;
  const store = getStorage();
  if (!store) return [];
  try {
    return parseStoredInbox(await store.getItem(key));
  } catch (error) {
    warn('could not read the inbox', error);
    return [];
  }
}

/** Makes `items` the newest list for `key`, without writing it. */
export function rememberInbox(key: string, items: readonly InboxItem[]): void {
  snapshots.set(key, items);
}

/** Makes `items` the newest list for `key` and schedules a write. */
export function saveInbox(key: string, items: readonly InboxItem[]): void {
  snapshots.set(key, items);
  if (queued.has(key)) return;
  queued.add(key);
  enqueue(key, async (store) => {
    queued.delete(key);
    const latest = snapshots.get(key);
    if (latest) await store.setItem(key, serializeInbox(latest));
  });
}

/**
 * Deletes a computer's stored inbox, e.g. after unpairing it. Dispose its
 * `InboxStore` first; a live store would write the list back.
 */
export function forgetInbox(key: string): Promise<void> {
  snapshots.delete(key);
  queued.delete(key);
  return enqueue(key, (store) => store.removeItem(key));
}

/** Resolves once every storage operation queued so far has finished. */
export async function settleInboxWrites(): Promise<void> {
  await Promise.all([...chains.values()]);
}

function enqueue(key: string, task: (store: Storage) => Promise<void>): Promise<void> {
  const run = async () => {
    const store = getStorage();
    if (!store) return;
    try {
      await task(store);
    } catch (error) {
      warn('could not save the inbox', error);
    }
  };
  const next = (chains.get(key) ?? Promise.resolve()).then(run);
  chains.set(key, next);
  void next.then(() => {
    if (chains.get(key) === next) chains.delete(key);
  });
  return next;
}

export function serializeInbox(items: readonly InboxItem[]): string {
  return JSON.stringify({ version: VERSION, items: items.slice(0, INBOX_LIMIT) });
}

/** Accepts only what `serializeInbox` writes; drops malformed and repeated items. */
export function parseStoredInbox(raw: string | null): readonly InboxItem[] {
  if (!raw) return [];
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!isObject(value) || value.version !== VERSION || !Array.isArray(value.items)) return [];
  const items: InboxItem[] = [];
  const seen = new Set<string>();
  for (const entry of value.items) {
    const item = parseItem(entry);
    if (!item || seen.has(item.id)) continue;
    seen.add(item.id);
    items.push(item);
    if (items.length === INBOX_LIMIT) break;
  }
  return items;
}

function parseItem(value: unknown): InboxItem | null {
  if (!isObject(value)) return null;
  const { id, workspaceId, surfaceId, title, subtitle, body, at, read, needsInput } = value;
  if (typeof id !== 'string' || id.length === 0) return null;
  if (typeof title !== 'string' || typeof body !== 'string') return null;
  if (typeof at !== 'number' || !Number.isFinite(at) || typeof read !== 'boolean') return null;
  if (!isNullableString(workspaceId) || !isNullableString(surfaceId) || !isNullableString(subtitle)) return null;
  return {
    id,
    workspaceId: workspaceId ?? null,
    surfaceId: surfaceId ?? null,
    title,
    subtitle: subtitle ?? null,
    body,
    at,
    read,
    needsInput: needsInput === true,
  };
}

function isNullableString(value: unknown): value is string | null | undefined {
  return value === undefined || value === null || typeof value === 'string';
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function warn(message: string, error: unknown): void {
  if (__DEV__) console.warn(`[inbox] ${message}: ${error instanceof Error ? error.message : String(error)}`);
}
