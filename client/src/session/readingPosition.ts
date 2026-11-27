import { sha256, toHex, utf8Encode } from '../protocol/sha256';
import { plainTerminalRows } from '../terminal/textTools';
import { isBlankLayout, type LayoutCache, type VisualLine } from '../terminal/layout';

export type ReadingPosition = { anchor: string; rowFromBottom: number; segmentFromBottom: number; horizontalColumns: number };
export type PositionedLine = VisualLine & { rowFromBottom: number; segmentFromBottom: number };

export type PositionedLineOptions = {
  /** Rows from the top that are never trimmed as bottom padding: a cursor on a blank row keeps its line. */
  keepRows?: number;
  /**
   * The previous result. A line whose row and layout did not change comes
   * back as the same object, so a memoized line skips its render.
   */
  previous?: readonly PositionedLine[];
};

/** A line's list key: its place counted from the bottom, which older pages loading above do not move. */
export function positionedLineKey(line: { rowFromBottom: number; segmentFromBottom: number }): string {
  return `${line.rowFromBottom}:${line.segmentFromBottom}`;
}

export function positionedLines(rows: readonly string[], columns: number, cache: LayoutCache, wrap = true, options: PositionedLineOptions = {}): PositionedLine[] {
  const { keepRows = 0, previous = [] } = options;
  // Every lookup uses the same wrap setting: a mismatch clears the cache and lays out every row again.
  let end = rows.length;
  while (end > keepRows && isBlankLayout(cache.get(rows[end - 1], columns, wrap))) end--;
  const result: PositionedLine[] = [];
  let byKey: Map<string, PositionedLine> | null = null;
  const reuse = (line: VisualLine, rowFromBottom: number, segmentFromBottom: number): PositionedLine => {
    // Usually at the same index; after a row rewraps, found by its key.
    let prior: PositionedLine | undefined = previous[result.length];
    if (previous.length && (!prior || prior.rowFromBottom !== rowFromBottom || prior.segmentFromBottom !== segmentFromBottom)) {
      byKey ??= new Map(previous.map((item) => [positionedLineKey(item), item]));
      prior = byKey.get(positionedLineKey({ rowFromBottom, segmentFromBottom }));
    }
    return prior && prior.spans === line.spans && prior.plain === line.plain ? prior : { ...line, rowFromBottom, segmentFromBottom };
  };
  for (let index = end - 1; index >= 0; index--) {
    const lines = cache.get(rows[index], columns, wrap);
    for (let j = lines.length - 1; j >= 0; j--) result.push(reuse(lines[j], rows.length - index - 1, lines.length - j - 1));
  }
  return result;
}

/** `positionedLines` for one view: lines that did not change come back as the same objects frame after frame. */
export class PositionedLineCache {
  private last: readonly PositionedLine[] = [];

  lines(rows: readonly string[], columns: number, cache: LayoutCache, wrap: boolean, keepRows = 0): PositionedLine[] {
    const lines = positionedLines(rows, columns, cache, wrap, { keepRows, previous: this.last });
    this.last = lines;
    return lines;
  }
}

/** Three logical rows make a stable anchor across wrapping, ANSI/color and width changes. */
export function readingAnchor(rows: readonly string[], index: number): string {
  return anchorOf(plainTerminalRows(rows.slice(Math.max(0, index - 1), index + 2)));
}
function anchorOf(plainRows: readonly string[]): string {
  return toHex(sha256(utf8Encode(JSON.stringify(plainRows))));
}
export function makeReadingPosition(rows: readonly string[], line: PositionedLine, horizontalColumns = 0): ReadingPosition {
  return { anchor: readingAnchor(rows, rows.length - line.rowFromBottom - 1), rowFromBottom: line.rowFromBottom, segmentFromBottom: line.segmentFromBottom, horizontalColumns };
}

/**
 * Looks for a saved position again as history pages load above the screen.
 * Rows at the bottom that an earlier search already ruled out (unchanged, as
 * are their neighbours) are skipped, so loading many pages hashes each row
 * about once instead of once per page.
 */
export class ReadingPositionSearch {
  private searched: readonly string[] = [];

  constructor(private readonly position: ReadingPosition) {}

  locate(rows: readonly string[]): number | null {
    const previous = this.searched;
    let shared = 0;
    while (shared < previous.length && shared < rows.length && rows[rows.length - 1 - shared] === previous[previous.length - 1 - shared]) shared++;
    // An anchor also reads the row above: the top shared row has a new neighbour, so it is checked again.
    const last = shared > 0 ? rows.length - shared : rows.length - 1;
    const plain: (string | undefined)[] = [];
    const plainAt = (index: number) => (plain[index] ??= plainTerminalRows([rows[index]])[0]);
    const matches = (index: number) => {
      const window: string[] = [];
      for (let i = Math.max(0, index - 1); i <= Math.min(rows.length - 1, index + 1); i++) window.push(plainAt(i));
      return anchorOf(window) === this.position.anchor;
    };
    // Nearest the original location first; repeated identical log blocks are indistinguishable.
    const preferred = Math.max(0, Math.min(rows.length - 1, rows.length - this.position.rowFromBottom - 1));
    for (let delta = 0; preferred - delta >= 0 || preferred + delta <= last; delta++) {
      const low = preferred - delta, high = preferred + delta;
      if (low >= 0 && low <= last && matches(low)) return low;
      if (delta > 0 && high <= last && matches(high)) return high;
    }
    this.searched = rows;
    return null;
  }
}

export function locateReadingPosition(rows: readonly string[], position: ReadingPosition): number | null {
  return new ReadingPositionSearch(position).locate(rows);
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
