import type { TerminalInputSnapshot } from '../../modules/terminal-input';

export type ComposerEdit = { text: string; selectionStart: number; selectionEnd: number };

/** Adds/removes two spaces from each selected line without splitting UTF-16 selections. */
export function indentSelection(snapshot: TerminalInputSnapshot, outdent: boolean): ComposerEdit | null {
  if (snapshot.composing) return null;
  const { text } = snapshot;
  const start = Math.max(0, Math.min(snapshot.selectionStart, snapshot.selectionEnd, text.length));
  const end = Math.max(start, Math.min(Math.max(snapshot.selectionStart, snapshot.selectionEnd), text.length));
  const first = start === 0 ? 0 : text.lastIndexOf('\n', start - 1) + 1;
  const last = end > start && text[end - 1] === '\n' ? end - 1 : end;
  const changes: { at: number; remove: number; insert: string }[] = [];
  let at = first;
  while (at <= last) {
    const following = text.indexOf('\n', at);
    const line = text.slice(at, following === -1 ? text.length : following);
    const remove = outdent ? (line.match(/^(?:\t| {1,2})/)?.[0].length ?? 0) : 0;
    changes.push({ at, remove, insert: outdent ? '' : '  ' });
    if (following === -1 || following >= last) break;
    at = following + 1;
  }
  let updated = text;
  for (const change of [...changes].reverse()) updated = updated.slice(0, change.at) + change.insert + updated.slice(change.at + change.remove);
  const translate = (position: number) => position + changes.reduce((delta, change) => {
    if (position < change.at) return delta;
    return delta + change.insert.length - Math.min(change.remove, position - change.at);
  }, 0);
  return { text: updated, selectionStart: translate(start), selectionEnd: translate(end) };
}
