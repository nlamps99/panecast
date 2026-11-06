import { sha256, toHex, utf8Encode } from '../protocol/sha256';
import { plainTerminalRows } from '../terminal/textTools';
import { buildInvertedLines, LayoutCache, type VisualLine } from '../terminal/layout';

export type ReadingPosition = { anchor: string; rowFromBottom: number; segmentFromBottom: number; horizontalColumns: number };
export type PositionedLine = VisualLine & { rowFromBottom: number; segmentFromBottom: number };
export function positionedLines(rows: readonly string[], columns: number, cache: LayoutCache, wrap = true): PositionedLine[] {
  let end = rows.length;
  while (end > 0 && buildInvertedLines([rows[end - 1]], columns, cache, { trimBottom: true }).length === 0) end--;
  const result: PositionedLine[] = [];
  for (let index = end - 1; index >= 0; index--) {
    const lines = cache.get(rows[index], columns, wrap);
    for (let j = lines.length - 1; j >= 0; j--) result.push({ ...lines[j], rowFromBottom: rows.length - index - 1, segmentFromBottom: lines.length - j - 1 });
  }
  return result;
}
/** Three logical rows make a stable anchor across wrapping, ANSI/color and width changes. */
export function readingAnchor(rows: readonly string[], index: number): string {
  return toHex(sha256(utf8Encode(JSON.stringify(plainTerminalRows(rows.slice(Math.max(0, index - 1), index + 2))))));
}
export function makeReadingPosition(rows: readonly string[], line: PositionedLine, horizontalColumns = 0): ReadingPosition {
  return { anchor: readingAnchor(rows, rows.length - line.rowFromBottom - 1), rowFromBottom: line.rowFromBottom, segmentFromBottom: line.segmentFromBottom, horizontalColumns };
}
export function locateReadingPosition(rows: readonly string[], position: ReadingPosition): number | null {
  // Search nearest the original location first; repeated identical log blocks are indistinguishable.
  const preferred = Math.max(0, Math.min(rows.length - 1, rows.length - position.rowFromBottom - 1));
  for (let delta = 0; delta < rows.length; delta++) {
    const candidates = delta === 0 ? [preferred] : [preferred - delta, preferred + delta];
    for (const index of candidates) if (index >= 0 && index < rows.length && readingAnchor(rows, index) === position.anchor) return index;
  }
  return null;
}

export function restoredLineIndex(lines: readonly PositionedLine[], position: ReadingPosition): number {
  let best = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.rowFromBottom !== position.rowFromBottom) continue;
    if (line.segmentFromBottom === position.segmentFromBottom) return i;
    if (best === -1 || (line.segmentFromBottom <= position.segmentFromBottom && line.segmentFromBottom > lines[best].segmentFromBottom)) best = i;
  }
  return best;
}
