import { codePointWidth } from '../terminal/cellWidth';
import { plainTerminalRows } from '../terminal/textTools';
import { itemText, type AgentItem } from './sourceStore';

/**
 * History of a full-screen agent (Claude Code, Codex) read from its session
 * record instead of its screen. The program draws only what fits on screen
 * and keeps the rest to itself, so the terminal has no scrollback to page
 * through; the record has every message and tool call, needs nothing from
 * the program's window, and reads the same for any number of viewers.
 *
 * Rows are drawn in the program's own terminal style (❯ prompt, ⏺ reply or
 * tool call, ⎿ result, colored diff lines) and wrapped to the terminal's
 * columns so they line up with the live screen below them.
 */

const RESET = '\u001b[0m', BOLD = '\u001b[1m', DIM = '\u001b[2m', GREEN = '\u001b[32m', RED = '\u001b[31m', GRAY = '\u001b[90m';
const OUTPUT_ROWS = 12;
const DIFF_ROWS = 40;

/** Shown above the live screen while the newest reply is still being written to the record. */
export const RECORD_WRITING_NOTICE = `${GRAY}  …这条回复还在输出，写完后可往上翻到完整内容${RESET}`;

/** One logical line as rows of at most `columns` cells; continuation rows start with `indent`. */
export function wrapCells(text: string, columns: number, indent = ''): string[] {
  const width = Math.max(8, columns);
  const indentWidth = cellWidth(indent);
  const rows: string[] = [];
  let row = '', used = 0;
  for (const char of text.replace(/\t/g, '  ')) {
    const w = codePointWidth(char.codePointAt(0) ?? 0);
    if (used + w > width && row.trim()) {
      rows.push(row.trimEnd());
      row = indent; used = indentWidth;
    }
    row += char; used += w;
  }
  rows.push(row.trimEnd());
  return rows;
}

function cellWidth(text: string): number {
  let total = 0;
  for (const char of text) total += codePointWidth(char.codePointAt(0) ?? 0);
  return total;
}

/** Markdown the program would have rendered: emphasis and code markers dropped, headings bold. */
function prose(text: string): { text: string; style: string }[] {
  let fence = false;
  return text.replace(/\r\n/g, '\n').split('\n').map((line) => {
    if (/^\s*```/.test(line)) { fence = !fence; return { text: '', style: '' }; }
    if (fence) return { text: line, style: DIM };
    const heading = /^\s{0,3}#{1,6}\s+(.*)$/.exec(line);
    const plain = (heading ? heading[1] : line).replace(/\*\*(.+?)\*\*/g, '$1').replace(/__(.+?)__/g, '$1').replace(/`([^`]+)`/g, '$1');
    return { text: plain, style: heading ? BOLD : '' };
  }).filter((line, index, all) => line.text !== '' || (index > 0 && all[index - 1].text !== ''));
}

/** Rows for a block whose first row starts with `marker` and later rows are indented under it. */
function block(lines: { text: string; style: string }[], columns: number, marker: string, markerStyle: string): string[] {
  const rows: string[] = [];
  lines.forEach((line, index) => {
    const prefix = index === 0 ? `${marker} ` : '  ';
    wrapCells(prefix + line.text, columns, '  ').forEach((row, part) => {
      const first = index === 0 && part === 0;
      const rest = first ? row.slice(marker.length) : row;
      const body = line.style ? `${line.style}${rest}${RESET}` : rest;
      rows.push(first ? `${markerStyle}${marker}${RESET}${body}` : body);
    });
  });
  return rows;
}

/** Ends a shortened block; tapping it shows the rest (`RecordRows.expandable`). */
const more = (hidden: number) => `${DIM}     … 还有 ${hidden} 行，点按展开${RESET}`;

/** Tool output under its call, first rows only unless expanded, as the program shows it. */
function output(text: string, columns: number, limit = OUTPUT_ROWS): string[] {
  const lines = text.replace(/\r\n/g, '\n').replace(/\n+$/, '').split('\n');
  if (!text.trim()) return [];
  const rows: string[] = [];
  lines.slice(0, limit).forEach((line, index) => {
    for (const row of wrapCells((index === 0 ? '  ⎿  ' : '     ') + line, columns, '     ')) rows.push(`${DIM}${row}${RESET}`);
  });
  if (lines.length > limit) rows.push(more(lines.length - limit));
  return rows;
}

function diff(text: string, columns: number, limit = DIFF_ROWS): string[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n').filter((line) => !/^(\+\+\+|---|diff |index )/.test(line));
  const rows: string[] = [];
  for (const line of lines.slice(0, limit)) {
    const color = line.startsWith('+') ? GREEN : line.startsWith('-') ? RED : DIM;
    for (const row of wrapCells(`     ${line}`, columns, '       ')) rows.push(`${color}${row}${RESET}`);
  }
  if (lines.length > limit) rows.push(more(lines.length - limit));
  return rows;
}

function toolTitle(item: AgentItem): string {
  const command = (item.command ?? '').replace(/\s+/g, ' ').trim();
  const name = item.tool || (item.type === 'commandExecution' ? 'Bash' : '工具');
  if (item.type === 'mcpToolCall') return `${item.server ?? ''} - ${item.tool ?? ''}${item.status ? ` (${item.status})` : ''}`;
  return command ? `${name}(${command.length > 200 ? `${command.slice(0, 200)}…` : command})` : name;
}

/** The rows one record item draws as; `expanded` shows tool output and diffs in full. */
export function itemRows(item: AgentItem, columns: number, expanded = false): string[] {
  const all = expanded ? Number.MAX_SAFE_INTEGER : undefined;
  switch (item.type) {
    case 'userMessage': {
      const text = itemText(item).trim();
      return text ? block(text.split('\n').map((line) => ({ text: line, style: '' })), columns, '❯', GRAY) : [];
    }
    case 'agentMessage': case 'plan': {
      const lines = prose(itemText(item).trim());
      return lines.length ? block(lines, columns, '⏺', '') : [];
    }
    case 'commandExecution': case 'toolExecution': case 'mcpToolCall': {
      const failed = /fail|error/i.test(item.status ?? '');
      return [...block([{ text: toolTitle(item), style: BOLD }], columns, '⏺', failed ? RED : GREEN),
        ...output(item.aggregatedOutput || (item.type === 'toolExecution' ? item.text ?? '' : ''), columns, all)];
    }
    case 'fileChange':
      return (item.changes ?? []).flatMap((change) => [...block([{ text: `Update(${change.path})`, style: BOLD }], columns, '⏺', GREEN), ...diff(change.diff ?? '', columns, all)]);
    default:
      return [];
  }
}

const drawn = new WeakMap<AgentItem, { columns: number; expanded: boolean; rows: string[] }>();
const MORE = /… 还有 \d+ 行，点按展开/;

/** Rows for a record, and which rows expand which item when tapped. */
export type RecordRows = { rows: string[]; expandable: Map<number, string> };

/** Record items as terminal rows, oldest first, a blank row between items. */
export function recordRows(items: readonly AgentItem[], columns: number, expanded: ReadonlySet<string> = new Set()): string[] {
  return recordLayout(items, columns, expanded).rows;
}

export function recordLayout(items: readonly AgentItem[], columns: number, expanded: ReadonlySet<string> = new Set()): RecordRows {
  const rows: string[] = [];
  const expandable = new Map<number, string>();
  for (const item of items) {
    const open = expanded.has(item.id);
    let cached = drawn.get(item);
    if (!cached || cached.columns !== columns || cached.expanded !== open) { cached = { columns, expanded: open, rows: itemRows(item, columns, open) }; drawn.set(item, cached); }
    if (!cached.rows.length) continue;
    if (rows.length) rows.push('');
    for (const row of cached.rows) {
      if (!open && MORE.test(row)) expandable.set(rows.length, item.id);
      rows.push(row);
    }
  }
  return { rows, expandable };
}

/**
 * How many rows at the end of the history the screen repeats at its top:
 * the item cut off by the screen's top edge, where both draw the same lines.
 * Only an exact run (blank rows aside) counts, so nothing else is trimmed.
 */
export function seamOverlap(rows: readonly string[], screenRows: readonly string[]): number {
  const text = (row: string) => plainTerminalRows([row])[0].trim();
  const screen = screenRows.slice(0, 40).map(text).filter(Boolean);
  let best = 0;
  for (let length = 1; length <= Math.min(screen.length, 40); length++) {
    // The history's last `length` non-blank rows must equal the screen's first `length`.
    let index = rows.length - 1, matched = 0, start = rows.length;
    for (let i = length - 1; i >= 0 && index >= 0; index--) {
      const row = text(rows[index]);
      if (!row) continue;
      if (row !== screen[i]) break;
      matched++; i--; start = index;
    }
    if (matched === length) best = rows.length - start;
  }
  return best;
}

const letters = (text: string) => text.normalize('NFKC').replace(/[^\p{L}\p{N}]/gu, '');

/** Text the program shows at the start of an item, letters and digits only. */
function probe(item: AgentItem): string {
  const source = item.type === 'commandExecution' || item.type === 'toolExecution' ? item.command || item.tool || ''
    : item.type === 'fileChange' ? item.changes?.[0]?.path ?? ''
      : item.type === 'mcpToolCall' ? `${item.server ?? ''}${item.tool ?? ''}` : itemText(item);
  const line = source.split('\n').find((candidate) => letters(candidate).length >= 4) ?? '';
  return letters(line).slice(0, 16);
}

/**
 * How many of the newest items the live screen already shows. Walking up
 * from the newest, each item's opening text must appear above the previous
 * one's, so repeated phrases elsewhere on screen cannot hide older items.
 * The item cut off at the top of the screen is not counted: its rest stays
 * in the history, a little overlap rather than a gap.
 */
export function itemsOnScreen(items: readonly AgentItem[], screenRows: readonly string[]): number {
  const screen = letters(plainTerminalRows(screenRows).join(''));
  let end = screen.length, counted = 0, pending = 0;
  for (let index = items.length - 1; index >= 0; index--) {
    const text = probe(items[index]);
    if (text.length < 4) { pending++; continue; }
    const at = end > 0 ? screen.lastIndexOf(text, end - 1) : -1;
    if (at < 0) break;
    end = at; counted += pending + 1; pending = 0;
  }
  return counted;
}
