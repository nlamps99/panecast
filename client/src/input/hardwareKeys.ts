import type { TerminalHardwareKey } from '../../modules/terminal-input';
import { ctrl, type Key, type KeyModifier } from '../protocol/keys';

/** cmux's `surface.send_key` names (see protocol/keys.ts). */
const namedKeys: Record<string, string> = {
  Enter: 'enter', Tab: 'tab', Escape: 'escape', Backspace: 'backspace', Delete: 'delete',
  ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
  Home: 'home', End: 'end', PageUp: 'pageup', PageDown: 'pagedown',
};

export type HardwareKeyContext = {
  /** Windows desktop: Ctrl doubles as the copy/paste modifier. */
  windows?: boolean;
  /** Terminal text is selected, so Ctrl+C copies it on Windows. */
  selection?: boolean;
};

/**
 * Windows shortcuts the system handles, following Windows Terminal: Ctrl+V and
 * Ctrl+Shift+V paste, Ctrl+Shift+C copies, Ctrl+C copies only while text is
 * selected (otherwise it interrupts), and Alt+F4 closes the window.
 */
function windowsSystemKey(event: TerminalHardwareKey, selection: boolean): boolean {
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
  if (event.altKey) return !event.ctrlKey && key === 'F4';
  if (!event.ctrlKey) return false;
  return key === 'v' || (key === 'c' && (event.shiftKey || selection));
}

/**
 * The Mac line-editing shortcuts, as Terminal.app and iTerm2 send them by
 * default: ⌘← and ⌘→ go to the start and end of the line (Ctrl-A, Ctrl-E),
 * ⌘⌫ deletes to its start (Ctrl-U) and ⌘K clears the screen (Ctrl-L); ⌥← and
 * ⌥→ move by word (Esc-b, Esc-f) and ⌥⌫ deletes the word before the cursor
 * (Ctrl-W). Option can report as AltGraph on a Mac; on these keys it never
 * types text, so either counts.
 */
function macEditingKey(event: TerminalHardwareKey): Key | null {
  if (event.ctrlKey || event.shiftKey) return null;
  const option = event.altKey || event.altGraphKey;
  if (event.metaKey && !option) {
    if (event.key === 'ArrowLeft') return ctrl('a');
    if (event.key === 'ArrowRight') return ctrl('e');
    if (event.key === 'Backspace') return ctrl('u');
    if (event.key === 'k') return ctrl('l');
    return null;
  }
  if (option && !event.metaKey) {
    if (event.key === 'ArrowLeft') return { name: 'b', modifiers: ['alt'] };
    if (event.key === 'ArrowRight') return { name: 'f', modifiers: ['alt'] };
    if (event.key === 'Backspace') return ctrl('w');
  }
  return null;
}

/**
 * The remote key for a key pressed in the live terminal input, or null when
 * the key stays local. Text and Option/dead-key input use the textarea's
 * committed input events instead.
 */
export function terminalHardwareKey(event: TerminalHardwareKey, context: HardwareKeyContext = {}): Key | null {
  if (!context.windows) {
    const editing = macEditingKey(event);
    if (editing) return editing;
  }
  // Other Command shortcuts belong to macOS, including copy/paste and switching apps.
  if (event.metaKey || event.altGraphKey) return null;
  if (context.windows && windowsSystemKey(event, context.selection === true)) return null;
  const name = namedKeys[event.key] ?? (/^F(?:[1-9]|1[0-2])$/.test(event.key) ? event.key.toLowerCase() : null);
  const controlCharacter = event.ctrlKey && /^[\x20-\x7e]$/.test(event.key);
  if (!name && !controlCharacter) return null;
  const modifiers: KeyModifier[] = [];
  if (event.ctrlKey) modifiers.push('ctrl');
  if (event.altKey) modifiers.push('alt');
  if (event.shiftKey) modifiers.push('shift');
  return { name: name ?? event.key.toLowerCase(), ...(modifiers.length ? { modifiers } : {}) };
}
