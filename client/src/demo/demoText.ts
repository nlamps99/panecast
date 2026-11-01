import { codePointWidth } from '../terminal/cellWidth';

/** Columns of the pretend Mac pane. cmux pads every row with spaces to this width. */
export const PANE_COLS = 120;

/** The pretend Mac user's home directory. */
export const DEMO_HOME = '/Users/demo';

const ESC = '\u001b';

/** SGR helpers. The relay sends rows independently, so every styled run resets at its end. */
export const sgr = (codes: string, text: string) => `${ESC}[${codes}m${text}${ESC}[0m`;
export const bold = (text: string) => sgr('1', text);
export const dim = (text: string) => sgr('2', text);
export const red = (text: string) => sgr('31', text);
export const green = (text: string) => sgr('32', text);
export const yellow = (text: string) => sgr('33', text);
export const blue = (text: string) => sgr('34', text);
export const cyan = (text: string) => sgr('36', text);
/** 256-colour palette entry. */
export const color256 = (index: number, text: string) => sgr(`38;5;${index}`, text);
/** 24-bit colour. */
export const rgb = (r: number, g: number, b: number, text: string) => sgr(`38;2;${r};${g};${b}`, text);

const SGR_PATTERN = /\u001b\[[0-9;]*m/g;

export function stripSgr(text: string): string {
  return text.replace(SGR_PATTERN, '');
}

/** Display width in terminal cells, ignoring SGR sequences; CJK counts as two. */
export function visibleWidth(text: string): number {
  let width = 0;
  for (const char of stripSgr(text)) width += codePointWidth(char.codePointAt(0)!);
  return width;
}

/** Pads a row with spaces to the pane width, like cmux's `surface.read_text`. */
export function padRow(row: string): string {
  const missing = PANE_COLS - visibleWidth(row);
  return missing > 0 ? row + ' '.repeat(missing) : row;
}

/** Pads to `width` cells (for aligned columns that mix CJK and ASCII). */
export function padEnd(text: string, width: number): string {
  const missing = width - visibleWidth(text);
  return missing > 0 ? text + ' '.repeat(missing) : text;
}

/** `~/code/x` → `/Users/demo/code/x`. */
export function absolutePath(cwd: string): string {
  return cwd === '~' ? DEMO_HOME : cwd.startsWith('~/') ? `${DEMO_HOME}${cwd.slice(1)}` : cwd;
}

/** A small seeded PRNG (mulberry32) so demo output is varied but repeatable. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export function pick<T>(random: () => number, items: readonly T[]): T {
  return items[Math.floor(random() * items.length)];
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/** Local wall-clock time, `HH:MM:SS`. */
export function clockTime(at: number): string {
  const date = new Date(at);
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}

/** Local wall-clock time with milliseconds, for log lines. */
export function logTime(at: number): string {
  return `${clockTime(at)}.${String(new Date(at).getMilliseconds()).padStart(3, '0')}`;
}
