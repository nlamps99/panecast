import type { TerminalHardwareKey } from '../../modules/terminal-input';
import type { Key, KeyModifier } from '../protocol/keys';

const namedKeys: Record<string, string> = {
  Enter: 'enter', Tab: 'tab', Escape: 'escape', Backspace: 'backspace', Delete: 'delete',
  ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
  Home: 'home', End: 'end', PageUp: 'pgup', PageDown: 'pgdn',
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

/** Text and Option/dead-key input use the textarea's committed input events. */
export function terminalHardwareKey(event: TerminalHardwareKey, context: HardwareKeyContext = {}): Key | null {
  // Command shortcuts belong to macOS, including copy/paste and switching apps.
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
