import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import { desktopBridge } from './desktop';

const OPTIONS: SecureStore.SecureStoreOptions = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };
export const secureStorageSupported = Platform.OS === 'ios' || Platform.OS === 'android' || desktopBridge() !== null;
export const secureStorage = {
  async get(key: string): Promise<string | null> {
    const desktop = desktopBridge();
    if (desktop) return desktop.getSecret(key);
    return secureStorageSupported ? SecureStore.getItemAsync(key, OPTIONS) : null;
  },
  async set(key: string, value: string): Promise<void> {
    const desktop = desktopBridge();
    if (desktop) return desktop.setSecret(key, value);
    if (!secureStorageSupported) throw new Error('请使用 Panecast 手机或桌面 App。');
    await SecureStore.setItemAsync(key, value, OPTIONS);
  },
  async remove(key: string): Promise<void> {
    const desktop = desktopBridge();
    if (desktop) return desktop.deleteSecret(key);
    if (secureStorageSupported) await SecureStore.deleteItemAsync(key, OPTIONS);
  },
};
