import { sha256, toHex, utf8Encode } from '../protocol/sha256';
import type { ConversationStorage } from './conversationCache';

export function cacheStorage(namespace: string): ConversationStorage {
  const fs = () => import('expo-file-system/legacy');
  const directory = async () => {
    const api = await fs();
    if (!api.cacheDirectory) throw new Error('File cache unavailable');
    return `${api.cacheDirectory}panecast-cache-v2/${toHex(sha256(utf8Encode(namespace)))}/`;
  };
  return {
    async read(name) { try { return await (await fs()).readAsStringAsync((await directory()) + name); } catch { return null; } },
    async write(name, value) { const api = await fs(), dir = await directory(); await api.makeDirectoryAsync(dir, { intermediates: true }); await api.writeAsStringAsync(dir + name, value); },
    async remove(name) { await (await fs()).deleteAsync((await directory()) + name, { idempotent: true }); },
    async clear() { await (await fs()).deleteAsync(await directory(), { idempotent: true }); },
  };
}
