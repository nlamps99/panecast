import { DEFAULT_ATTR, FLAG_HIDDEN, FLAG_INVERSE, parseAnsiRow, type Attr, type Cell } from './ansi';

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

/**
 * Splits one terminal row into visual lines at most `columns` cells wide.
 * Continuation lines are indented to where the row's text starts (after its
 * indentation and a list, tool-output or diff marker), so a wrapped line still
 * reads as part of its row.
 */
export function layoutRow(row: string, columns: number, wrap = true): VisualLine[] {
  const limit = Math.max(2, Math.floor(columns));
  let cells = trimTrailingBlank(parseAnsiRow(row));
  if (cells.length === 0) return [EMPTY_LINE];
  if (!wrap) return [toVisualLine(cells)];
  if (isRuleRow(cells)) return [toVisualLine(fitRule(cells, limit))];
  cells = dropRightBorder(cells, limit);
  const indent = hangingIndent(cells, limit);
  return wrapCells(cells, limit, limit - indent).map((line, index) => toVisualLine(line, index === 0 ? 0 : indent));
}

/**
 * Cells that a GeistMono glyph covers in U+2000–U+2BFF (punctuation, arrows,
 * math, box drawing, blocks, a few shapes), as inclusive ranges. Generated
 * from both bundled weights, which cover the same code points.
 */
const MONO_SYMBOLS = [
  0x2013, 0x2014, 0x2018, 0x201a, 0x201c, 0x201e, 0x2020, 0x2022, 0x2026, 0x2026, 0x2028, 0x2029, 0x2030, 0x2030,
  0x2032, 0x2033, 0x2039, 0x203a, 0x2044, 0x2044, 0x2070, 0x2070, 0x2074, 0x2079, 0x2080, 0x2089, 0x20aa, 0x20aa,
  0x20ac, 0x20ac, 0x20b1, 0x20b1, 0x20b4, 0x20b4, 0x20b9, 0x20b9, 0x20bd, 0x20bd, 0x2107, 0x2107, 0x2116, 0x2117,
  0x2122, 0x2122, 0x2153, 0x2155, 0x215b, 0x215e, 0x2190, 0x2199, 0x219d, 0x219d, 0x21a9, 0x21aa, 0x21b0, 0x21b1,
  0x21b3, 0x21b5, 0x21e4, 0x21e5, 0x21e7, 0x21e7, 0x2202, 0x2202, 0x2206, 0x2206, 0x220f, 0x220f, 0x2211, 0x2212,
  0x221a, 0x221a, 0x221e, 0x221e, 0x222b, 0x222b, 0x2236, 0x2236, 0x2248, 0x2248, 0x2260, 0x2260, 0x2264, 0x2265,
  0x2326, 0x2327, 0x232b, 0x232b, 0x23ce, 0x23ce, 0x240b, 0x240c, 0x2423, 0x2423, 0x2460, 0x2468, 0x24ea, 0x24ea,
  0x24ff, 0x259f, 0x25b2, 0x25b3, 0x25b6, 0x25b7, 0x25bc, 0x25bd, 0x25c0, 0x25c1, 0x25ca, 0x25cc, 0x25cf, 0x25cf,
  0x2776, 0x277e,
];

function monoCovers(cp: number): boolean {
  for (let i = 0; i < MONO_SYMBOLS.length; i += 2) {
    if (cp < MONO_SYMBOLS[i]) return false;
    if (cp <= MONO_SYMBOLS[i + 1]) return true;
  }
  return false;
}

/**
 * The cells a character takes on the phone. A narrow symbol the monospace font
 * lacks (◯ ✔ ⎿ ✻ …) is drawn from a fallback font at about a full em, nearly
 * two cells; counting it as one pushed the end of its line out of view.
 */
export function layoutWidth(cell: Cell): number {
  if (cell.width !== 1) return cell.width;
  const cp = (SUBSTITUTIONS[cell.text] ?? cell.text).codePointAt(0)!;
  if (cp < 0x2000 || cp > 0x2bff) return 1;
  return monoCovers(cp) ? 1 : 2;
}

/**
 * Markers whose text continues after them: Claude Code's ⏺ and ⎿, Codex's •
 * and └, list bullets and numbers, quote and prompt marks, and the line number
 * and sign of a diff line. Each must be followed by a space.
 */
const MARKER = /^(?:[⏺●•◦▪‣⎿└├│›>*+\-✻✳✶✢✽✓✔✗✘☐☒◯○◉■□▶►→]|\d+[.)]|\d+ [-+ ]?)(?= )/u;

/** Continuation lines never get less than 60% of the width. */
const MAX_INDENT_SHARE = 0.4;

function hangingIndent(cells: Cell[], columns: number): number {
  let index = 0;
  let width = 0;
  const skipSpaces = () => {
    while (index < cells.length && cells[index].text === ' ' && !hasVisibleBackground(cells[index].attr)) {
      index++;
      width++;
    }
  };
  skipSpaces();
  let head = '';
  const ends: number[] = [];
  for (let i = index; i < cells.length && ends.length < 12; i++) {
    head += cells[i].text;
    ends.push(head.length);
  }
  const marker = MARKER.exec(head);
  if (marker) {
    const count = ends.findIndex(end => end >= marker[0].length) + 1;
    // A fallback marker (⎿ ✓) is drawn about one cell wide; two would push the continuation past the text.
    for (let i = 0; i < count; i++) width += cells[index + i].width;
    index += count;
    skipSpaces();
  }
  // Nothing after the indentation: there is no text to line up with.
  if (index >= cells.length) return 0;
  return Math.min(width, Math.floor(columns * MAX_INDENT_SHARE));
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

function isBoxDrawing(text: string): boolean {
  const cp = text.codePointAt(0)!;
  return text.length === 1 && cp >= 0x2500 && cp <= 0x257f;
}

/** Rules and box borders (╭───╮, ╰───╯): only rule or box-drawing characters and spaces. */
function isRuleRow(cells: Cell[]): boolean {
  let sawRule = false;
  for (const cell of cells) {
    if (cell.text === ' ') continue;
    if (!RULE_CHARS.has(cell.text) && !isBoxDrawing(cell.text)) return false;
    sawRule = true;
  }
  return sawRule;
}

/** Cuts a rule to the screen. A border keeps its closing corner, so a box drawn for the Mac still closes on the phone. */
function fitRule(cells: Cell[], columns: number): Cell[] {
  const fitted = fitWidth(cells, columns);
  if (fitted.length === cells.length) return cells;
  const last = cells[cells.length - 1];
  if (fitted.length === 0 || fitted[fitted.length - 1].text === last.text) return fitted;
  return [...fitWidth(cells, columns - layoutWidth(last)), last];
}

const VERTICAL_BORDERS = new Set(['│', '┃', '║']);

/**
 * A row framed by a box (`│ text … │`) that is wider than the screen loses its
 * right border and the padding before it. Wrapped, that border would land
 * alone on a line of its own; the left border still marks the box.
 */
function dropRightBorder(cells: Cell[], columns: number): Cell[] {
  const last = cells[cells.length - 1];
  if (!VERTICAL_BORDERS.has(last.text)) return cells;
  const first = cells.findIndex(cell => cell.text !== ' ');
  if (first === cells.length - 1 || cells[first].text !== last.text) return cells;
  if (cells.reduce((sum, cell) => sum + layoutWidth(cell), 0) <= columns) return cells;
  let end = cells.length - 1;
  while (end > 0 && cells[end - 1].text === ' ' && !hasVisibleBackground(cells[end - 1].attr)) end--;
  return cells.slice(0, end);
}

function fitWidth(cells: Cell[], columns: number): Cell[] {
  let width = 0;
  for (let i = 0; i < cells.length; i++) {
    width += layoutWidth(cells[i]);
    if (width > columns) return cells.slice(0, i);
  }
  return cells;
}

type Segment = { cells: Cell[]; width: number; kind: 'space' | 'word' | 'wide' };

/** Punctuation that must not start a line (kinsoku): it moves down with the character before it. */
const NO_LINE_START = new Set([...'，。、；：！？）」』》〉】〕｝〗’”…％,.;:!?)]}']);

function closesText(segment: Segment): boolean {
  return segment.cells.every(cell => NO_LINE_START.has(cell.text));
}

/**
 * Greedy wrapping at word boundaries. Breaks after spaces and between wide
 * (CJK) characters; a word longer than the line is split mid-word. Spaces that
 * would start a continuation line are dropped, so the padding between a
 * status line's left and right parts never wraps into a blank line. Closing
 * punctuation that does not fit takes the character before it along.
 *
 * The first line holds `columns` cells, the rest `nextColumns` (narrower when
 * continuation lines are indented).
 */
export function wrapCells(cells: Cell[], columns: number, nextColumns = columns): Cell[][] {
  const lines: Cell[][] = [];
  let line: Cell[] = [];
  let width = 0;
  let limit = columns;
  // Where the word or wide character that ends the line starts; -1 when the line ends otherwise.
  let lastStart = -1;
  const flush = () => {
    lines.push(line);
    line = [];
    width = 0;
    limit = nextColumns;
    lastStart = -1;
  };
  const put = (segment: Segment) => {
    lastStart = line.length;
    line.push(...segment.cells);
    width += segment.width;
  };

  for (const segment of segments(cells)) {
    if (segment.kind === 'space') {
      if (width === 0 && lines.length > 0 && !hasVisibleBackground(segment.cells[0].attr)) continue;
      if (width + segment.width <= limit) {
        line.push(...segment.cells);
        width += segment.width;
        lastStart = -1;
      } else if (width > 0) {
        flush();
      }
      continue;
    }
    if (width + segment.width <= limit) {
      put(segment);
      continue;
    }
    if (lastStart > 0 && closesText(segment)) {
      const carried = line.slice(lastStart);
      const carriedWidth = carried.reduce((sum, cell) => sum + layoutWidth(cell), 0);
      if (carriedWidth + segment.width <= nextColumns) {
        line = line.slice(0, lastStart);
        flush();
        line = carried;
        width = carriedWidth;
        put(segment);
        lastStart = -1;
        continue;
      }
    }
    if (width > 0 && segment.width <= nextColumns) {
      flush();
      put(segment);
      continue;
    }
    // Longer than a whole line: split it, starting on the current line.
    for (const cell of segment.cells) {
      const cellWidth = layoutWidth(cell);
      if (width + cellWidth > limit && width > 0) flush();
      line.push(cell);
      width += cellWidth;
    }
    lastStart = -1;
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
      wordWidth += layoutWidth(cell);
    }
  }
  endWord();
  return out;
}

/** `indent` blank cells go in front: a continuation line lines up with its row's text. */
function toVisualLine(cells: Cell[], indent = 0): VisualLine {
  if (cells.length === 0) return EMPTY_LINE;
  const spans: Span[] = indent > 0 ? [{ text: ' '.repeat(indent), attr: DEFAULT_ATTR }] : [];
  let plain = ' '.repeat(indent);
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
  return trimTrailingBlank(parseAnsiRow(row)).reduce((columns, cell) => columns + layoutWidth(cell), 0);
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
