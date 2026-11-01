import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSyncExternalStore } from 'react';

/** Display and input preferences. Not secret, so AsyncStorage rather than SecureStore. */
export type Prefs = {
  fontSize: number;
  inputMode: 'line' | 'live';
  /** Rows the relay keeps live for the terminal (`surface.subscribe` `lines`). */
  historyLines: number;
  /** A light tap on each key-row press. */
  keyHaptics: boolean;
  /** The second key row: Ctrl, symbols, PgUp/PgDn, Home/End. */
  extraKeyRow: boolean;
};

export const FONT_SIZE_MIN = 9;
export const FONT_SIZE_MAX = 20;
/** The native client's range and step for "Terminal history". */
export const HISTORY_LINES_MIN = 60;
export const HISTORY_LINES_MAX = 400;
export const HISTORY_LINES_STEP = 20;

export const DEFAULT_PREFS: Prefs = {
  fontSize: 13,
  inputMode: 'line',
  historyLines: 120,
  keyHaptics: true,
  extraKeyRow: false,
};
const KEY = 'panecast.prefs.v1';

let prefs: Prefs = DEFAULT_PREFS;
const listeners = new Set<() => void>();
let loaded = false;

export function clampFontSize(size: number): number {
  return Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, Math.round(size * 2) / 2));
}

/** Snaps to the settings stepper's 20-line grid within 60–400. */
export function clampHistoryLines(lines: number): number {
  if (!Number.isFinite(lines)) return DEFAULT_PREFS.historyLines;
  const snapped = HISTORY_LINES_MIN + Math.round((lines - HISTORY_LINES_MIN) / HISTORY_LINES_STEP) * HISTORY_LINES_STEP;
  return Math.min(HISTORY_LINES_MAX, Math.max(HISTORY_LINES_MIN, snapped));
}

/**
 * Prefs from untrusted input (storage written by any app version): every
 * field is checked, and anything missing or malformed takes its default.
 */
export function sanitizePrefs(value: unknown): Prefs {
  const v = (typeof value === 'object' && value !== null ? value : {}) as Partial<Record<keyof Prefs, unknown>>;
  return {
    fontSize: typeof v.fontSize === 'number' ? clampFontSize(v.fontSize) : DEFAULT_PREFS.fontSize,
    inputMode: v.inputMode === 'live' ? 'live' : 'line',
    historyLines: typeof v.historyLines === 'number' ? clampHistoryLines(v.historyLines) : DEFAULT_PREFS.historyLines,
    keyHaptics: typeof v.keyHaptics === 'boolean' ? v.keyHaptics : DEFAULT_PREFS.keyHaptics,
    extraKeyRow: typeof v.extraKeyRow === 'boolean' ? v.extraKeyRow : DEFAULT_PREFS.extraKeyRow,
  };
}

export async function loadPrefs(): Promise<void> {
  if (loaded) return;
  loaded = true;
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (!raw) return;
    prefs = sanitizePrefs(JSON.parse(raw));
    emit();
  } catch {
    // keep defaults
  }
}

export function setPrefs(patch: Partial<Prefs>): void {
  const next = sanitizePrefs({ ...prefs, ...patch });
  if ((Object.keys(next) as (keyof Prefs)[]).every((key) => next[key] === prefs[key])) return;
  prefs = next;
  emit();
  AsyncStorage.setItem(KEY, JSON.stringify(prefs)).catch(() => {});
}

export function usePrefs(): Prefs {
  return useSyncExternalStore(subscribe, getPrefs, getPrefs);
}

/** The current prefs, for code outside React (e.g. creating a session with the saved history lines). */
export function getPrefs(): Prefs {
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
