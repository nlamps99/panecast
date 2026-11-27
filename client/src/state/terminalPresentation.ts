import { useEffect, useSyncExternalStore } from 'react';

import { setPrefs, usePrefs } from './prefs';

export type TerminalPresentation = 'terminal' | 'chat';

type Storage = { getItem(key: string): Promise<string | null>; setItem(key: string, value: string): Promise<void> };

const STORAGE_KEY = 'panecast.terminal-presentation.v1';
/** Terminals whose choice is kept; the least recently chosen is forgotten first. */
export const MAX_REMEMBERED_TERMINALS = 400;

/** One terminal on one computer. Surface ids are unique on a computer. */
export function presentationKey(computerId: string, surfaceId: string): string {
  return JSON.stringify([computerId, surfaceId]);
}

/** Stored choices, oldest first; anything malformed is dropped. */
export function parsePresentations(value: unknown): [string, TerminalPresentation][] {
  if (!value || typeof value !== 'object' || (value as { version?: unknown }).version !== 1) return [];
  const entries = (value as { entries?: unknown }).entries;
  if (!Array.isArray(entries)) return [];
  const valid = entries.filter((entry): entry is [string, TerminalPresentation] => Array.isArray(entry) && entry.length === 2
    && typeof entry[0] === 'string' && entry[0].length <= 600 && (entry[1] === 'chat' || entry[1] === 'terminal'));
  return valid.slice(-MAX_REMEMBERED_TERMINALS);
}

/**
 * 对话/终端 per terminal: switching one terminal leaves the others as they
 * were. A terminal never switched shows the saved default (`Prefs.terminalPresentation`).
 */
export class TerminalPresentationStore {
  private choices = new Map<string, TerminalPresentation>();
  private listeners = new Set<() => void>();
  private loading: Promise<void> | null = null;
  private writing: Promise<void> = Promise.resolve();

  constructor(private storage: Storage) {}

  load(): Promise<void> {
    return this.loading ??= this.storage.getItem(STORAGE_KEY).then((raw) => {
      const stored = parsePresentations(raw ? JSON.parse(raw) : null);
      // A choice made while reading wins over the stored one.
      const merged = new Map(stored);
      for (const [key, mode] of this.choices) { merged.delete(key); merged.set(key, mode); }
      this.choices = merged;
      this.emit();
    }).catch(() => {});
  }

  choice(computerId: string, surfaceId: string): TerminalPresentation | null {
    return this.choices.get(presentationKey(computerId, surfaceId)) ?? null;
  }

  choose(computerId: string, surfaceId: string, mode: TerminalPresentation): void {
    const key = presentationKey(computerId, surfaceId);
    if (this.choices.get(key) === mode) return;
    this.choices.delete(key);
    this.choices.set(key, mode);
    while (this.choices.size > MAX_REMEMBERED_TERMINALS) this.choices.delete(this.choices.keys().next().value!);
    this.emit();
    const entries = [...this.choices];
    // In order, so a quick switch back and forth is stored as its last state.
    this.writing = this.writing.then(() => this.storage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, entries }))).catch(() => {});
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

let singleton: TerminalPresentationStore | null = null;
export function terminalPresentations(): TerminalPresentationStore {
  if (!singleton) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const storage = require('@react-native-async-storage/async-storage').default as Storage;
    singleton = new TerminalPresentationStore(storage);
  }
  return singleton;
}

/**
 * The presentation of one terminal and a setter for it. Without a terminal
 * (none chosen yet) the setter changes the saved default instead.
 */
export function useTerminalPresentation(computerId: string, surfaceId: string | null | undefined): [TerminalPresentation, (mode: TerminalPresentation) => void] {
  const store = terminalPresentations();
  const { terminalPresentation } = usePrefs();
  useEffect(() => { void store.load(); }, [store]);
  const read = () => (surfaceId ? store.choice(computerId, surfaceId) : null);
  const choice = useSyncExternalStore(store.subscribe, read, read);
  const set = (mode: TerminalPresentation) => {
    if (surfaceId) store.choose(computerId, surfaceId, mode);
    else setPrefs({ terminalPresentation: mode });
  };
  return [choice ?? terminalPresentation, set];
}
