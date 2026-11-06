import { FLAG_HIDDEN, FLAG_INVERSE, parseAnsiRow, type Attr, type Cell } from './ansi';

/** A run of text sharing one attribute. */
export type Span = { text: string; attr: Attr };

/** One line on the phone: a wrapped piece of a terminal row. */
export type VisualLine = { spans: readonly Span[]; plain: string };

export const EMPTY_LINE: VisualLine = { spans: [], plain: '' };

/**
 * Horizontal-rule glyphs. A row made only of these (and spaces) is drawn for
 * the Mac pane's width; trimmed to the phone width it stays one rule instead
 * of wrapping into several lines of dashes.
 */
const RULE_CHARS = new Set(['─', '━', '═', '╌', '╍', '┄', '┅', '┈', '┉', '-', '=']);

/** Splits one terminal row into visual lines at most `columns` cells wide. */
export function layoutRow(row: string, columns: number, wrap = true): VisualLine[] {
  const limit = Math.max(2, Math.floor(columns));
  let cells = trimTrailingBlank(parseAnsiRow(row));
  if (cells.length === 0) return [EMPTY_LINE];
  if (!wrap) return [toVisualLine(cells)];
  if (isRuleRow(cells)) cells = fitWidth(cells, limit);
  return wrapCells(cells, limit).map(toVisualLine);
}

/**
 * cmux pads every row with spaces to the pane width. Trailing blanks with no
 * visible background carry nothing and would otherwise wrap into empty lines.
 */
function trimTrailingBlank(cells: Cell[]): Cell[] {
  let end = cells.length;
  while (end > 0) {
    const cell = cells[end - 1];
    if (cell.text !== ' ' || hasVisibleBackground(cell.attr)) break;
    end--;
  }
  return end === cells.length ? cells : cells.slice(0, end);
}

function hasVisibleBackground(attr: Attr): boolean {
  return attr.bg !== null || (attr.flags & FLAG_INVERSE) !== 0;
}

function isRuleRow(cells: Cell[]): boolean {
  let sawRule = false;
  for (const cell of cells) {
    if (cell.text === ' ') continue;
    if (!RULE_CHARS.has(cell.text)) return false;
    sawRule = true;
  }
  return sawRule;
}

function fitWidth(cells: Cell[], columns: number): Cell[] {
  let width = 0;
  for (let i = 0; i < cells.length; i++) {
    width += cells[i].width;
    if (width > columns) return cells.slice(0, i);
  }
  return cells;
}

type Segment = { cells: Cell[]; width: number; kind: 'space' | 'word' | 'wide' };

/**
 * Greedy wrapping at word boundaries. Breaks after spaces and between wide
 * (CJK) characters; a word longer than the line is split mid-word. A space that
 * would start a continuation line is dropped.
 */
export function wrapCells(cells: Cell[], columns: number): Cell[][] {
  const lines: Cell[][] = [];
  let line: Cell[] = [];
  let width = 0;
  const flush = () => {
    lines.push(line);
    line = [];
    width = 0;
  };

  for (const segment of segments(cells)) {
    if (segment.kind === 'space') {
      if (width + segment.width <= columns) {
        line.push(...segment.cells);
        width += segment.width;
      } else if (width > 0) {
        flush();
      }
      continue;
    }
    if (width + segment.width <= columns) {
      line.push(...segment.cells);
      width += segment.width;
      continue;
    }
    if (segment.width <= columns) {
      if (width > 0) flush();
      line.push(...segment.cells);
      width = segment.width;
      continue;
    }
    // Longer than a whole line: split it, starting on the current line.
    for (const cell of segment.cells) {
      if (width + cell.width > columns && width > 0) flush();
      line.push(cell);
      width += cell.width;
    }
  }
  if (line.length > 0 || lines.length === 0) lines.push(line);
  return lines;
}

function segments(cells: Cell[]): Segment[] {
  const out: Segment[] = [];
  let word: Cell[] = [];
  let wordWidth = 0;
  const endWord = () => {
    if (word.length > 0) out.push({ cells: word, width: wordWidth, kind: 'word' });
    word = [];
    wordWidth = 0;
  };
  for (const cell of cells) {
    if (cell.text === ' ') {
      endWord();
      out.push({ cells: [cell], width: 1, kind: 'space' });
    } else if (cell.width === 2) {
      endWord();
      out.push({ cells: [cell], width: 2, kind: 'wide' });
    } else {
      word.push(cell);
      wordWidth += cell.width;
    }
  }
  endWord();
  return out;
}

function toVisualLine(cells: Cell[]): VisualLine {
  if (cells.length === 0) return EMPTY_LINE;
  const spans: Span[] = [];
  let plain = '';
  for (const cell of cells) {
    const text = (cell.attr.flags & FLAG_HIDDEN) !== 0 ? ' '.repeat(cell.width) : displayText(cell.text);
    plain += cell.text;
    const last = spans[spans.length - 1];
    if (last && last.attr === cell.attr) last.text += text;
    else spans.push({ text, attr: cell.attr });
  }
  return { spans, plain };
}

/**
 * iOS draws characters with a default emoji presentation (⏺, ✔, ●, …) as color
 * emoji when the monospace font lacks them. Map the media-control symbols that
 * have no text-style glyph, and ask for text presentation (VS15) on the rest.
 * Mirrors `TerminalGlyph` in the legacy iOS client.
 */
const SUBSTITUTIONS: Record<string, string> = {
  '⏺': '●︎', // ⏺ → ●
  '⏸': '‖', // ⏸ → ‖
  '⏹': '■︎', // ⏹ → ■
  '⏫': '↑', // ⏫ → ↑
  '⏬': '↓', // ⏬ → ↓
  '⏭': '≫', // ⏭ → ≫
  '⏮': '≪', // ⏮ → ≪
  '⏯': '▶︎', // ⏯ → ▶
};

function displayText(text: string): string {
  const substitute = SUBSTITUTIONS[text];
  if (substitute) return substitute;
  const cp = text.codePointAt(0)!;
  if (cp < 0x2190 || text.length > 1) return text; // fast path; sequences keep their own selectors
  if (mayPromoteToEmoji(cp)) return `${text}︎`;
  return text;
}

function mayPromoteToEmoji(cp: number): boolean {
  return (
    (cp >= 0x2190 && cp <= 0x21ff) ||
    (cp >= 0x2300 && cp <= 0x23ff) ||
    (cp >= 0x2460 && cp <= 0x24ff) ||
    (cp >= 0x25a0 && cp <= 0x25ff) ||
    (cp >= 0x2600 && cp <= 0x26ff) ||
    (cp >= 0x2700 && cp <= 0x27bf) ||
    (cp >= 0x2b00 && cp <= 0x2bff)
  );
}

/**
 * Caches `layoutRow` by row text for one column count. Most rows do not change
 * between frames, so a frame only lays out the rows that did.
 */
export class LayoutCache {
  private cache = new Map<string, VisualLine[]>();
  private columns = 0;
  private wrap = true;

  constructor(private readonly maxEntries = 4_000) {}

  get(row: string, columns: number, wrap = true): VisualLine[] {
    if (columns !== this.columns || wrap !== this.wrap) {
      this.cache.clear();
      this.columns = columns;
      this.wrap = wrap;
    }
    let lines = this.cache.get(row);
    if (!lines) {
      lines = layoutRow(row, columns, wrap);
      if (this.cache.size >= this.maxEntries) this.cache.clear();
      this.cache.set(row, lines);
    }
    return lines;
  }
}

export function terminalRowColumns(row: string): number {
  return trimTrailingBlank(parseAnsiRow(row)).reduce((columns, cell) => columns + cell.width, 0);
}

/**
 * Visual lines for an inverted list: index 0 is the bottom line. Trailing
 * blank rows at the bottom of the live screen are dropped so the prompt sits
 * at the bottom of the phone instead of above a screenful of padding.
 */
export function buildInvertedLines(
  rows: readonly string[],
  columns: number,
  cache: LayoutCache,
  { trimBottom }: { trimBottom: boolean },
): VisualLine[] {
  let end = rows.length;
  if (trimBottom) {
    while (end > 0 && isBlank(cache.get(rows[end - 1], columns))) end--;
  }
  const out: VisualLine[] = [];
  for (let r = end - 1; r >= 0; r--) {
    const lines = cache.get(rows[r], columns);
    for (let l = lines.length - 1; l >= 0; l--) out.push(lines[l]);
  }
  return out;
}

function isBlank(lines: VisualLine[]): boolean {
  return lines.length === 1 && lines[0] === EMPTY_LINE;
}
