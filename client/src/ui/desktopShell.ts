import { useWindowDimensions } from 'react-native';

import { desktopBridge, desktopOnWindows } from '../platform/desktop';

/** The desktop window at its usual size: one window with a fixed sidebar, no phone tab bar. */
export const DESKTOP_SHELL_MIN_WIDTH = 760;

export function useDesktopShell(): boolean {
  const { width } = useWindowDimensions();
  return desktopBridge() !== null && width >= DESKTOP_SHELL_MIN_WIDTH;
}

export type DesktopCommand =
  | { kind: 'terminal'; index: number }
  | { kind: 'cycle'; step: 1 | -1 }
  | { kind: 'workspace'; step: 1 | -1 }
  | { kind: 'new' }
  | { kind: 'find' }
  | { kind: 'font'; step: 1 | -1 | 0 }
  | { kind: 'settings' }
  | { kind: 'focus' };

type KeyLike = { key: string; code?: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean };

/**
 * App shortcuts. On the Mac they use ⌘, which the terminal never receives.
 * On Windows plain Ctrl belongs to the terminal (Ctrl+C, Ctrl+T in shells
 * and editors), so they use Ctrl+Shift, as Windows Terminal does.
 *
 * ⌘1–⌘9 terminal in this workspace (⌘9 the last), ⌘⇧[ / ⌘⇧] previous and
 * next terminal, ⌘⌥↑ / ⌘⌥↓ previous and next workspace, ⌘T new terminal,
 * ⌘F search the output, ⌘= / ⌘- / ⌘0 text size, ⌘, settings, ⌘L focus the
 * terminal input.
 */
export function desktopCommand(event: KeyLike, windows = desktopOnWindows()): DesktopCommand | null {
  const mod = windows ? event.ctrlKey && event.shiftKey && !event.metaKey : event.metaKey && !event.ctrlKey;
  if (!mod) return null;
  const digit = /^Digit([1-9])$/.exec(event.code ?? '')?.[1] ?? (/^[1-9]$/.test(event.key) ? event.key : null);
  if (digit && !event.altKey) return { kind: 'terminal', index: Number(digit) === 9 ? -1 : Number(digit) - 1 };
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
  const shift = windows ? true : event.shiftKey;
  if (event.altKey && (key === 'ArrowUp' || key === 'ArrowDown')) return { kind: 'workspace', step: key === 'ArrowUp' ? -1 : 1 };
  if (shift && (event.code === 'BracketLeft' || key === '[' || key === '{')) return { kind: 'cycle', step: -1 };
  if (shift && (event.code === 'BracketRight' || key === ']' || key === '}')) return { kind: 'cycle', step: 1 };
  if (event.altKey) return null;
  if (key === 't') return { kind: 'new' };
  if (key === 'f') return { kind: 'find' };
  if (key === 'l') return { kind: 'focus' };
  if (key === ',' || key === '<') return { kind: 'settings' };
  if (key === '=' || key === '+') return { kind: 'font', step: 1 };
  if (key === '-' || key === '_') return { kind: 'font', step: -1 };
  if (key === '0' || key === ')') return { kind: 'font', step: 0 };
  return null;
}

const listeners = new Set<(command: DesktopCommand) => void>();
/** The terminal screen takes the commands that need its views (search, focus). */
export function onDesktopCommand(listener: (command: DesktopCommand) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
export function emitDesktopCommand(command: DesktopCommand): void {
  for (const listener of listeners) listener(command);
}
