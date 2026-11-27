import { useCallback, useEffect, type RefObject } from 'react';
import { Platform } from 'react-native';

import type { TerminalImeAnchor, TerminalInputHandle } from '../../modules/terminal-input';

/** The terminal screen's root view (`nativeID`, an `id` on the web). */
export const TERMINAL_ROOT_ID = 'panecast-terminal';

/** Marks the cell under the live cursor in the terminal view (rendered as `data-terminal-cursor`). */
export const TERMINAL_CURSOR_DATA = { dataSet: { terminalCursor: '1' } } as object;

export type FallbackKey = {
  key: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
  isComposing?: boolean;
  keyCode?: number;
};

/** Where keyboard focus is when a key arrives, as far as the terminal input cares. */
export type FocusContext = {
  /** Nothing is focused, or the page itself. */
  idle: boolean;
  /** A field or editor has focus; it takes its own keys (the terminal input included). */
  editable: boolean;
  /** The focused element is inside the terminal screen. */
  insideTerminal: boolean;
  /** Focus came from the keyboard (`:focus-visible`): Enter, Space and Tab belong to that control. */
  keyboardFocus: boolean;
  /** A dialog or sheet is open. */
  modalOpen: boolean;
  /** Text is selected on the page. */
  selection: boolean;
};

const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'AltGraph', 'Meta', 'OS', 'Super', 'Hyper', 'Fn', 'FnLock', 'CapsLock', 'NumLock', 'ScrollLock', 'ContextMenu']);
const NAMED_KEYS = new Set(['Enter', 'Tab', 'Escape', 'Backspace', 'Delete', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown']);
/** Keys an input method or a dead key turns into text: the browser has to deliver them itself. */
const TEXT_KEYS = new Set(['Dead', 'Process']);

/**
 * What to do with a key pressed while the terminal input does not have
 * focus (after a click on a button, on the terminal's text, or a reconnect):
 * - `type`: focus the input and let the browser type the key there, so text,
 *   dead keys and the input method work as usual;
 * - `press`: focus the input and press the key there (Enter, arrows, Ctrl
 *   combinations: keys whose default would act on the old focus);
 * - null: leave it alone. Fields, dialogs and ⌘ shortcuts (but ⌘V, a paste
 *   into the terminal) keep their keys; a
 *   control reached with the keyboard keeps Enter, Space and Tab; with text
 *   selected, only typing moves on (so copying and extending still work).
 */
export function keyFallback(key: FallbackKey, focus: FocusContext): 'type' | 'press' | null {
  if (key.isComposing || key.keyCode === 229) return null;
  if (focus.modalOpen || focus.editable || MODIFIER_KEYS.has(key.key)) return null;
  // ⌘V: the paste lands in the terminal input, as typing does.
  if (key.metaKey) return !key.ctrlKey && !key.altKey && !key.shiftKey && key.key.toLowerCase() === 'v' && !(!focus.idle && focus.keyboardFocus) ? 'type' : null;
  if (!focus.idle && focus.keyboardFocus && (!focus.insideTerminal || key.key === 'Enter' || key.key === ' ' || key.key === 'Tab')) return null;
  const text = TEXT_KEYS.has(key.key) || [...key.key].length === 1;
  if (focus.selection) return text && !key.ctrlKey && !key.altKey ? 'type' : null;
  if (text) return key.ctrlKey ? 'press' : 'type';
  if (NAMED_KEYS.has(key.key) || /^F(?:[1-9]|1[0-2])$/.test(key.key)) return 'press';
  return null;
}

/**
 * Whether the terminal screen is on view: the tabs keep it mounted, hidden,
 * behind another page (settings, inbox, a source), which then owns the keys.
 */
export function terminalShown(document: Document): boolean {
  const root = document.getElementById(TERMINAL_ROOT_ID) as (HTMLElement & { checkVisibility?: () => boolean }) | null;
  return root !== null && root.checkVisibility?.() !== false;
}

/** The page's focus, read when a key arrives. */
export function focusContext(document: Document): FocusContext {
  const active = document.activeElement;
  const idle = !active || active === document.body || active === document.documentElement;
  const editable = !idle && (/^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName) || (active as HTMLElement).isContentEditable === true);
  let keyboardFocus = false;
  if (!idle) {
    // Engines without :focus-visible throw on it: treat focus as the keyboard's then.
    try { keyboardFocus = active.matches(':focus-visible'); } catch { keyboardFocus = true; }
  }
  const selection = document.defaultView?.getSelection();
  return {
    idle,
    editable,
    insideTerminal: !idle && active.closest(`#${TERMINAL_ROOT_ID}`) !== null,
    keyboardFocus,
    modalOpen: document.querySelector('[aria-modal="true"]') !== null,
    selection: Boolean(selection && !selection.isCollapsed),
  };
}

/**
 * Desktop: typing goes to the terminal even when focus went elsewhere. A key
 * pressed on the page, or on a clicked button in the window, focuses the
 * terminal input and reaches it (see `keyFallback`). Listens after the page's
 * own handlers, so anything that took the key first keeps it.
 */
export function useTerminalKeyFallback(input: RefObject<TerminalInputHandle | null>, enabled: boolean): void {
  useEffect(() => {
    if (!enabled || Platform.OS !== 'web' || typeof window === 'undefined' || typeof document === 'undefined') return;
    const keydown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const handle = input.current;
      if (!handle?.pressKey) return;
      const action = keyFallback(event, focusContext(document));
      if (action === 'type') void handle.focus();
      else if (action === 'press') {
        const used = handle.pressKey({ key: event.key, ctrlKey: event.ctrlKey, altKey: event.altKey, shiftKey: event.shiftKey,
          metaKey: event.metaKey, altGraphKey: event.getModifierState?.('AltGraph') ?? false });
        // Tab the input did not take still ends there, instead of moving on past it.
        if (used || event.key === 'Tab') event.preventDefault();
      }
    };
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  }, [input, enabled]);
}

/**
 * Desktop: puts focus back in the terminal input after a send, a reconnect,
 * a mode switch or a closed sheet, unless the user is now typing somewhere
 * else, has a dialog open, reached a control with the keyboard, or is
 * reading a selection.
 */
export function refocusTerminalInput(input: TerminalInputHandle | null | undefined): void {
  if (!input || Platform.OS !== 'web' || typeof document === 'undefined') return;
  if (!terminalShown(document)) return;
  const focus = focusContext(document);
  if (focus.editable || focus.modalOpen || focus.selection || (!focus.idle && focus.keyboardFocus)) return;
  void input.focus();
}

/**
 * Desktop: a stable function that puts focus back in the terminal input just
 * after the current update (see `refocusTerminalInput`), so a sheet that
 * opened keeps its focus. For clicks on tabs and buttons: WKWebView starts
 * the input method only in a field that is focused when a key goes down, so
 * focusing from that key would send the first pinyin letter raw.
 */
export function useTerminalRefocus(input: RefObject<TerminalInputHandle | null>, enabled: boolean): () => void {
  return useCallback(() => { if (enabled) setTimeout(() => refocusTerminalInput(input.current), 0); }, [input, enabled]);
}

/** The terminal's live cursor cell on screen, where the input method should compose; null when none is shown. */
export function terminalCursorAnchor(background: string): TerminalImeAnchor | null {
  if (Platform.OS !== 'web' || typeof document === 'undefined') return null;
  const cell = document.querySelector(`#${TERMINAL_ROOT_ID} [data-terminal-cursor]`);
  if (!cell) return null;
  const box = cell.getBoundingClientRect();
  const view = document.defaultView;
  if (box.height <= 0 || box.bottom < 0 || box.left < 0 || (view && (box.top > view.innerHeight || box.left > view.innerWidth))) return null;
  return { left: box.left, top: box.top, height: box.height, background };
}
