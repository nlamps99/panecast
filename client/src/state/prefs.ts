import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSyncExternalStore } from 'react';

/** Display preferences. Not secret, so AsyncStorage rather than SecureStore. */
export type Prefs = {
  fontSize: number;
  inputMode: 'line' | 'live';
};

export const FONT_SIZE_MIN = 9;
export const FONT_SIZE_MAX = 20;

const DEFAULTS: Prefs = { fontSize: 13, inputMode: 'line' };
const KEY = 'panecast.prefs.v1';

let prefs: Prefs = DEFAULTS;
const listeners = new Set<() => void>();
let loaded = false;

export function clampFontSize(size: number): number {
  return Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, Math.round(size * 2) / 2));
}

export async function loadPrefs(): Promise<void> {
  if (loaded) return;
  loaded = true;
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (!raw) return;
    const value = JSON.parse(raw) as Partial<Prefs>;
    prefs = {
      fontSize: typeof value.fontSize === 'number' ? clampFontSize(value.fontSize) : DEFAULTS.fontSize,
      inputMode: value.inputMode === 'live' ? 'live' : 'line',
    };
    emit();
  } catch {
    // keep defaults
  }
}

export function setPrefs(patch: Partial<Prefs>): void {
  const next = { ...prefs, ...patch };
  if (patch.fontSize !== undefined) next.fontSize = clampFontSize(patch.fontSize);
  if (next.fontSize === prefs.fontSize && next.inputMode === prefs.inputMode) return;
  prefs = next;
  emit();
  AsyncStorage.setItem(KEY, JSON.stringify(prefs)).catch(() => {});
}

export function usePrefs(): Prefs {
  return useSyncExternalStore(subscribe, getPrefs, getPrefs);
}

function getPrefs(): Prefs {
  return prefs;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function emit(): void {
  for (const listener of listeners) listener();
}
