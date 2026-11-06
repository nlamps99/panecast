import { FLAG_HIDDEN, parseAnsiRow } from './ansi';

/** Logical lines, without display wrapping or terminal escape sequences. */
export function plainTerminalRows(rows: readonly string[]): string[] {
  return rows.map((row) => parseAnsiRow(row).map((cell) => cell.attr.flags & FLAG_HIDDEN ? ' ' : cell.text).join('').trimEnd());
}
export function matchingRows(rows: readonly string[], query: string): number[] {
  const needle = query.trim().toLocaleLowerCase();
  return needle ? rows.flatMap((row, index) => row.toLocaleLowerCase().includes(needle) ? [index] : []) : [];
}
export function terminalLinks(text: string): string[] {
  return [...new Set((text.match(/https?:\/\/[^\s<>"'\x1b]+/g) ?? []).map((s) => s.replace(/[),.;!?\]}]+$/, '')))]
    .filter((s) => { try { return ['http:', 'https:'].includes(new URL(s).protocol); } catch { return false; } });
}
