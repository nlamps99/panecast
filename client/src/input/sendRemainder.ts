/**
 * What stays in an input after `sent` went out, now that the input holds
 * `current`: whatever was typed after the send started, or `null` when the
 * input was edited so it no longer starts with what was sent (then nothing
 * is cleared, so no typing is lost).
 */
export function remainderAfterSend(current: string, sent: string): string | null {
  return current.startsWith(sent) ? current.slice(sent.length) : null;
}

type EditableInput = {
  applyEdit(expectedText: string, text: string, selectionStart: number, selectionEnd: number): Promise<boolean>;
};

/**
 * Takes `sent` off the front of the input in one atomic edit, keeping what
 * was typed after it. `'pending'` means try again on the next change: the IME
 * is still composing, or the text changed between reading and editing.
 * `'gone'` means the input no longer starts with `sent`, so nothing is cut.
 */
export async function stripSent(input: EditableInput, sent: string, state: { text: string; composing: boolean }): Promise<'done' | 'pending' | 'gone'> {
  const rest = remainderAfterSend(state.text, sent);
  if (rest === null) return 'gone';
  if (state.composing) return 'pending';
  return (await input.applyEdit(state.text, rest, rest.length, rest.length)) ? 'done' : 'pending';
}
