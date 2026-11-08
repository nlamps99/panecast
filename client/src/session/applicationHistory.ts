import { plainTerminalRows } from '../terminal/textTools';

export type ApplicationHistoryPage = { rows: readonly string[]; replacedRows: number };

const meaningful = (row: string) => Boolean(row.trim()) && !/^[\s─━═╌╍┄┅┈┉│┌┐└┘╭╮╰╯=+|\-]+$/u.test(row);

/** A spinner or status update does not mean that the transcript moved. */
export function sameApplicationViewport(previous: readonly string[], next: readonly string[]): boolean {
  const a = plainTerminalRows(previous), b = plainTerminalRows(next);
  let total = 0, matches = 0;
  const distinct = new Set<string>();
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (!meaningful(a[i] ?? '') && !meaningful(b[i] ?? '')) continue;
    total++;
    if (a[i] === b[i]) { matches++; distinct.add(a[i]); }
  }
  return distinct.size >= 3 && matches >= total * 0.8;
}

/** Extract only newly revealed rows, using the overlap between two TUI screens. */
export function olderApplicationRows(previous: readonly string[], next: readonly string[]): ApplicationHistoryPage | null {
  const a = plainTerminalRows(previous), b = plainTerminalRows(next);
  const count = (rows: readonly string[], row: string) => rows.reduce((total, value) => total + Number(value === row), 0);
  const minimum = Math.max(3, Math.ceil(Math.min(a.filter(meaningful).length, b.filter(meaningful).length) / 4));
  let header = 0;
  while (header < Math.min(a.length, b.length) && a[header] === b[header]) header++;
  let best = 0, oldStart = 0, newStart = 0, ambiguous = false;
  for (let delta = 1; delta < b.length; delta++) {
    const matches: number[] = [];
    const distinct = new Set<string>();
    for (let i = 0; i < Math.min(a.length, b.length - delta); i++) {
      if (a[i] === b[i + delta] && meaningful(a[i])) { matches.push(i); distinct.add(a[i]); }
    }
    if (!matches.length || matches.length < best) continue;
    const first = matches[0], last = matches[matches.length - 1];
    const unique = matches.filter(i => a[i].length >= 4 && count(a, a[i]) === 1 && count(b, a[i]) === 1);
    const characters = unique.reduce((total, i) => total + a[i].length, 0);
    const group = unique.length >= 3 && characters >= 18;
    const pair = unique.length >= 2 && characters >= 24;
    const single = matches.length === 1 && header > 0 && first === header && first + delta < b.length - 1
      && a[first].length >= 12 && unique.length === 1;
    if (!(matches.length >= minimum && distinct.size >= 2) && !group && !pair && !single) continue;
    let span = 0;
    for (let i = first; i <= last; i++) if (meaningful(a[i]) || meaningful(b[i + delta])) span++;
    if (matches.length < span * 0.65) continue;
    if (matches.length > best) {
      best = matches.length; oldStart = first; newStart = first + delta; ambiguous = false;
    } else if (newStart - oldStart !== delta) ambiguous = true;
  }
  if (!best || ambiguous || sameApplicationViewport(previous, next)) return null;
  // Replace the old boundary prefix with the actual new prefix. It includes
  // any changing header once, so header height changes cannot drop real rows.
  return { rows: next.slice(0, newStart), replacedRows: oldStart };
}
