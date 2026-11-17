import { codePointWidth } from './cellWidth';
import { monoCovers } from './layout';

/**
 * How the browser and desktop renderer keeps the grid: text GeistMono draws
 * runs as is (every glyph advances exactly one cell), and everything else
 * gets a box of its terminal width. CJK runs keep their 1 em glyphs and gain
 * letter spacing up to two cells; other symbols (emoji, ⏺, ✻ …) sit centered
 * in their own box. Columns then line up with the computer's terminal.
 */
export type CellRun =
  | { kind: 'text'; text: string }
  | { kind: 'wide'; text: string; cells: number }
  | { kind: 'symbol'; text: string; cells: number };

const cjk = (cp: number) =>
  (cp >= 0x2e80 && cp <= 0x303e) || (cp >= 0x3041 && cp <= 0x33ff) || (cp >= 0x3400 && cp <= 0x4dbf) || (cp >= 0x4e00 && cp <= 0x9fff) ||
  (cp >= 0xa000 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe4f) ||
  (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x20000 && cp <= 0x3fffd);

/** Code points GeistMono itself draws at one cell. */
function monoNative(cp: number): boolean {
  return cp < 0x0300 || (cp >= 0x0370 && cp < 0x0530) || (cp >= 0x2000 && cp <= 0x2bff && monoCovers(cp));
}

export function cellRuns(text: string): CellRun[] {
  const runs: CellRun[] = [];
  let plain = '';
  const flush = () => { if (plain) { runs.push({ kind: 'text', text: plain }); plain = ''; } };
  // Graphemes: a base character keeps its combining marks and variation selectors.
  const chars = Array.from(text);
  for (let index = 0; index < chars.length; index++) {
    let char = chars[index];
    const cp = char.codePointAt(0)!;
    while (index + 1 < chars.length && codePointWidth(chars[index + 1].codePointAt(0)!) === 0) char += chars[++index];
    const width = codePointWidth(cp);
    if (width === 0) { plain += char; continue; }
    if (width === 1 && monoNative(cp)) { plain += char; continue; }
    flush();
    const last = runs.at(-1);
    if (width === 2 && cjk(cp) && char.length <= 2) {
      if (last?.kind === 'wide') { last.text += char; last.cells += 2; }
      else runs.push({ kind: 'wide', text: char, cells: 2 });
      continue;
    }
    runs.push({ kind: 'symbol', text: char, cells: width });
  }
  flush();
  return runs;
}
