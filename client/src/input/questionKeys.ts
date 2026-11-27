import type { Key } from '../protocol/keys';
import type { TerminalDecision } from '../session/terminalPrompt';
import { focusContext, terminalShown, type FallbackKey } from './terminalFocus';

/** Moves the program's highlight from one option to another, as tapping an option does. */
export function selectionKeys(from: number, to: number): Key[] {
  const delta = to - from;
  return Array.from({ length: Math.abs(delta) }, () => ({ name: delta > 0 ? 'down' : 'up' }));
}

/**
 * The keys a keyboard press sends to a question the terminal is asking, the
 * card's buttons in key form: a number moves the highlight to that option
 * (like tapping it; Enter confirms), ↑ and ↓ move it, Enter confirms, Esc
 * cancels, Space ticks a multiple choice, Tab goes to the next question.
 * An empty list: the key belongs to the card but there is nothing to send.
 * Null: not a key for the card.
 */
export function decisionKeys(decision: Pick<TerminalDecision, 'options' | 'selectedIndex' | 'multiSelect' | 'multipleQuestions'>, key: FallbackKey): Key[] | null {
  if (key.isComposing || key.keyCode === 229 || key.ctrlKey || key.metaKey || key.altKey || key.shiftKey) return null;
  switch (key.key) {
    case 'ArrowUp': return [{ name: 'up' }];
    case 'ArrowDown': return [{ name: 'down' }];
    case 'Enter': return [{ name: 'enter' }];
    case 'Escape': return [{ name: 'escape' }];
    case ' ': return decision.multiSelect ? [{ name: 'space' }] : null;
    case 'Tab': return decision.multipleQuestions ? [{ name: 'tab' }] : null;
  }
  if (!/^[1-9]$/.test(key.key) || decision.selectedIndex === null) return null;
  const index = decision.options.findIndex((option) => option.number === Number(key.key));
  return index < 0 ? null : selectionKeys(decision.selectedIndex, index);
}

/**
 * Whether a key may answer the card: the terminal screen is on view and
 * focus is on the page, in the empty terminal input, or on something clicked
 * in the terminal screen. Not while another page shows, a message is being
 * written, a dialog is open, text is selected, or a control was reached with
 * the keyboard (its Enter is its own).
 */
export function questionKeyFocus(document: Document): boolean {
  if (!terminalShown(document)) return false;
  const focus = focusContext(document);
  if (focus.modalOpen || focus.selection) return false;
  if (focus.idle) return true;
  if (!focus.insideTerminal) return false;
  const active = document.activeElement;
  if (focus.editable) return active?.tagName === 'TEXTAREA' && (active as HTMLTextAreaElement).value === '';
  return !focus.keyboardFocus;
}
