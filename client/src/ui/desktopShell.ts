import { useSyncExternalStore } from 'react';
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
  | { kind: 'newWorkspace' }
  | { kind: 'close' }
  | { kind: 'find' }
  | { kind: 'font'; step: 1 | -1 | 0 }
  | { kind: 'settings' }
  | { kind: 'sidebar' }
  | { kind: 'focus' };

type KeyLike = { key: string; code?: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean };

/**
 * App shortcuts. On the Mac they use ⌘, which the terminal never receives.
 * On Windows plain Ctrl belongs to the terminal (Ctrl+C, Ctrl+T in shells
 * and editors), so they use Ctrl+Shift, as Windows Terminal does.
 *
 * ⌘1–⌘9 terminal in this workspace (⌘9 the last), ⌘⇧[ / ⌘⇧] previous and
 * next terminal, ⌘⌥↑ / ⌘⌥↓ previous and next workspace, ⌘N new workspace,
 * ⌘T new terminal, ⌘W close the terminal, ⌘F search the output, ⌘= / ⌘- /
 * ⌘0 text size, ⌘, settings, ⌘L focus the terminal input.
 *
 * On the Mac the menu bar carries some of these (`menuShortcut`); the menu,
 * not this mapping, handles those keys there.
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
  // ⇧⌘W is the menu's 关闭窗口, ⇧⌘Z its 重做: shifted letters are not these shortcuts.
  if (!windows && event.shiftKey && /^[a-z]$/.test(key)) return null;
  if (key === 'n') return { kind: 'newWorkspace' };
  if (key === 't') return { kind: 'new' };
  if (key === 'w') return { kind: 'close' };
  if (key === 'f') return { kind: 'find' };
  if (key === 'l') return { kind: 'focus' };
  if (key === ',' || key === '<') return { kind: 'settings' };
  if (key === '=' || key === '+') return { kind: 'font', step: 1 };
  if (key === '-' || key === '_') return { kind: 'font', step: -1 };
  if (key === '0' || key === ')') return { kind: 'font', step: 0 };
  return null;
}

/** The keys the Mac menu bar shows beside its items (desktop/src-tauri/src/main.rs `mac_menu`). */
const MENU_KEYS = new Set(['n', 't', 'w', 'f', ',', '=', '-', '0']);
/** …and with ⇧: 关闭窗口. */
const MENU_SHIFTED_KEYS = new Set(['w']);

/**
 * Whether the Mac menu bar owns this key. The web view sees a ⌘ key first and
 * hands it to the menu unless the page prevents it, so the page leaves these
 * alone and each shortcut runs once, through the menu (`menuCommand`).
 */
export function menuShortcut(event: KeyLike): boolean {
  if (!event.metaKey || event.ctrlKey || event.altKey) return false;
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
  return (event.shiftKey ? MENU_SHIFTED_KEYS : MENU_KEYS).has(key);
}

/** The Mac menu bar's custom items, by the id main.rs emits as the `panecast-menu` event. */
const MENU_COMMANDS: Readonly<Record<string, DesktopCommand>> = {
  'new-workspace': { kind: 'newWorkspace' },
  'new-terminal': { kind: 'new' },
  'close-terminal': { kind: 'close' },
  settings: { kind: 'settings' },
  'zoom-in': { kind: 'font', step: 1 },
  'zoom-out': { kind: 'font', step: -1 },
  'zoom-reset': { kind: 'font', step: 0 },
  find: { kind: 'find' },
  'toggle-sidebar': { kind: 'sidebar' },
};
export function menuCommand(id: unknown): DesktopCommand | null {
  return typeof id === 'string' && Object.hasOwn(MENU_COMMANDS, id) ? MENU_COMMANDS[id] : null;
}

/** A shortcut as this computer writes it, for tooltips: ⌘T on the Mac, Ctrl+Shift+T on Windows. */
export function shortcutLabel(key: string, windows = desktopOnWindows()): string {
  return windows ? `Ctrl+Shift+${key}` : `⌘${key}`;
}

/** ⌘W with nothing to close hides the window, as the menu's close used to. Windows has no Dock to bring it back. */
export function hideDesktopWindow(): void {
  if (desktopOnWindows()) return;
  desktopBridge()?.closeWindow?.();
}

const listeners = new Set<(command: DesktopCommand) => void>();
/** Screens take the commands that need their views (search, focus, close, the new-workspace dialog). */
export function onDesktopCommand(listener: (command: DesktopCommand) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
export function emitDesktopCommand(command: DesktopCommand): void {
  for (const listener of listeners) listener(command);
}

/**
 * The sidebar's filter and whether it is hidden (显示 › 显示/隐藏侧栏). Shared
 * so the shortcuts walk exactly what the sidebar shows.
 */
type SidebarState = { query: string; hidden: boolean };
const SIDEBAR_KEY = 'panecast.sidebarHidden';
let sidebar: SidebarState = { query: '', hidden: readHidden() };
const sidebarListeners = new Set<() => void>();
function readHidden(): boolean {
  try { return typeof localStorage !== 'undefined' && localStorage.getItem(SIDEBAR_KEY) === '1'; } catch { return false; }
}
function setSidebar(patch: Partial<SidebarState>): void {
  sidebar = { ...sidebar, ...patch };
  for (const listener of sidebarListeners) listener();
}
const subscribeSidebar = (listener: () => void) => { sidebarListeners.add(listener); return () => { sidebarListeners.delete(listener); }; };
const getSidebar = () => sidebar;
export function sidebarState(): SidebarState { return sidebar; }
export function useSidebarState(): SidebarState {
  return useSyncExternalStore(subscribeSidebar, getSidebar, getSidebar);
}
export function setSidebarQuery(query: string): void {
  if (query !== sidebar.query) setSidebar({ query });
}
export function setSidebarHidden(hidden: boolean): void {
  if (hidden === sidebar.hidden) return;
  setSidebar({ hidden });
  try { if (typeof localStorage !== 'undefined') localStorage.setItem(SIDEBAR_KEY, hidden ? '1' : '0'); } catch { /* the choice lasts until restart */ }
}
