import type { ConversationStorage } from './conversationCache';

let opening: Promise<IDBDatabase> | null = null;
function database(): Promise<IDBDatabase> {
  return opening ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('panecast-local-cache-v1', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('entries');
    request.onsuccess = () => { request.result.onversionchange = () => { request.result.close(); opening = null; }; resolve(request.result); };
    request.onerror = () => reject(request.error);
  }).catch(error => { opening = null; throw error; });
}

/** WKWebView has IndexedDB, but Expo's native filesystem is unavailable on web. */
export function cacheStorage(namespace: string): ConversationStorage {
  const prefix = `${JSON.stringify(namespace)}/`;
  async function transaction<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const db = await database();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('entries', mode), request = run(tx.objectStore('entries'));
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = tx.onabort = () => reject(tx.error ?? new Error('Cache transaction failed'));
    });
  }
  return {
    async read(name) { const value = await transaction('readonly', store => store.get(prefix + name)); return typeof value === 'string' ? value : null; },
    async write(name, value) { await transaction('readwrite', store => store.put(value, prefix + name)); },
    async remove(name) { await transaction('readwrite', store => store.delete(prefix + name)); },
    async clear() { await transaction('readwrite', store => store.delete(IDBKeyRange.bound(prefix, prefix + '\uffff'))); },
  };
}
