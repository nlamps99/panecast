import { plainTerminalRows } from '../terminal/textTools';

export type ApplicationHistoryPage = { rows: readonly string[]; headerRows: number };

/** Extract only newly revealed rows, using the overlap between two TUI screens. */
export function olderApplicationRows(previous: readonly string[], next: readonly string[]): ApplicationHistoryPage | null {
  const a = plainTerminalRows(previous), b = plainTerminalRows(next);
  let header = 0, footer = 0;
  while (header < Math.min(a.length, b.length) && a[header] === b[header]) header++;
  while (footer < Math.min(a.length, b.length) - header && a[a.length - footer - 1] === b[b.length - footer - 1]) footer++;
  const oldBody = a.slice(header, a.length - footer), newBody = b.slice(header, b.length - footer);
  const minimum = Math.max(3, Math.floor(Math.min(oldBody.length, newBody.length) / 3));
  let prior = new Uint32Array(newBody.length + 1);
  let best = 0, shift = 0, ambiguous = false;
  for (let i = 0; i < oldBody.length; i++) {
    const lengths = new Uint32Array(newBody.length + 1);
    for (let j = 0; j < newBody.length; j++) {
      if (oldBody[i] !== newBody[j]) continue;
      const length = lengths[j + 1] = prior[j] + 1;
      const delta = j - i;
      if (delta <= 0 || length < minimum || length < best) continue;
      const meaningful = new Set(oldBody.slice(i - length + 1, i + 1).filter((row) => row.trim()));
      if (meaningful.size < 2) continue;
      if (length > best) { best = length; shift = delta; ambiguous = false; }
      else if (shift !== delta) ambiguous = true;
    }
    prior = lengths;
  }
  return best && !ambiguous ? { rows: next.slice(header, header + shift), headerRows: header } : null;
}
