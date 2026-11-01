import { Keys, type Key } from '../protocol/keys';

export type InputAction = { kind: 'text'; text: string } | { kind: 'key'; key: Key };

/**
 * Turns text the input method has committed in live mode into terminal input:
 * line breaks become Enter key presses, everything else is sent as text.
 * `\r\n` counts as one break.
 */
export function translateCommitted(text: string): InputAction[] {
  const actions: InputAction[] = [];
  let buffer = '';
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '\r' || char === '\n') {
      if (buffer) actions.push({ kind: 'text', text: buffer });
      buffer = '';
      actions.push({ kind: 'key', key: Keys.enter });
      if (char === '\r' && text[i + 1] === '\n') i++;
    } else {
      buffer += char;
    }
  }
  if (buffer) actions.push({ kind: 'text', text: buffer });
  return actions;
}
