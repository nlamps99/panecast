import { codePointWidth } from './cellWidth';

/** A palette index (0–255) or a packed 0xRRGGBB truecolor value. */
export type Color = { kind: 'index'; value: number } | { kind: 'rgb'; value: number };

export const FLAG_BOLD = 1;
export const FLAG_DIM = 2;
export const FLAG_ITALIC = 4;
export const FLAG_UNDERLINE = 8;
export const FLAG_INVERSE = 16;
export const FLAG_STRIKE = 32;
export const FLAG_HIDDEN = 64;

/** Text attributes. Interned: equal attributes are the same object, so runs merge by identity. */
export type Attr = { readonly key: string; readonly fg: Color | null; readonly bg: Color | null; readonly flags: number };

/** One terminal cell: a base code point plus any combining marks, with its width. */
export type Cell = { text: string; width: 0 | 1 | 2; attr: Attr };

const MAX_INTERNED = 4_096;

export const DEFAULT_ATTR: Attr = { key: '-|-|0', fg: null, bg: null, flags: 0 };

const interned = new Map<string, Attr>([[DEFAULT_ATTR.key, DEFAULT_ATTR]]);

export function intern(fg: Color | null, bg: Color | null, flags: number): Attr {
  const key = `${colorKey(fg)}|${colorKey(bg)}|${flags}`;
  const existing = interned.get(key);
  if (existing) return existing;
  // Truecolor gradients could otherwise grow this without bound.
  if (interned.size >= MAX_INTERNED) {
    interned.clear();
    interned.set(DEFAULT_ATTR.key, DEFAULT_ATTR);
  }
  const attr: Attr = { key, fg, bg, flags };
  interned.set(key, attr);
  return attr;
}

function colorKey(color: Color | null): string {
  if (!color) return '-';
  return color.kind === 'index' ? `i${color.value}` : `r${color.value}`;
}

const TAB_WIDTH = 8;

/**
 * Parses one row of terminal text into cells. Handles SGR (16, 256 and
 * truecolor, bold/dim/italic/underline/inverse/strike/hidden), skips other CSI,
 * OSC, DCS and two-byte escape sequences, drops control characters and expands
 * tabs. Attributes reset at the start of every row: the relay sends rows
 * independently.
 */
export function parseAnsiRow(text: string): Cell[] {
  const cells: Cell[] = [];
  let attr = DEFAULT_ATTR;
  let column = 0;
  let afterZwj = false;
  const length = text.length;
  let i = 0;
  while (i < length) {
    const cp = text.codePointAt(i)!;
    const size = cp > 0xffff ? 2 : 1;

    if (cp === 0x1b) {
      i = skipEscape(text, i + 1, (params) => {
        attr = applySgr(attr, params);
      });
      continue;
    }
    if (cp === 0x9b) {
      // 8-bit CSI
      i = skipCsi(text, i + 1, (params) => {
        attr = applySgr(attr, params);
      });
      continue;
    }
    i += size;
    if (cp === 0x09) {
      const spaces = TAB_WIDTH - (column % TAB_WIDTH);
      for (let s = 0; s < spaces; s++) cells.push({ text: ' ', width: 1, attr });
      column += spaces;
      afterZwj = false;
      continue;
    }
    if (cp < 0x20 || cp === 0x7f || (cp >= 0x80 && cp < 0xa0)) continue;

    const char = String.fromCodePoint(cp);
    const width = codePointWidth(cp);
    const previous = cells[cells.length - 1];
    const skinTone = cp >= 0x1f3fb && cp <= 0x1f3ff && previous?.width === 2;
    if ((width === 0 || afterZwj || skinTone) && previous) {
      // Combining mark, variation selector, skin tone, or the far side of a ZWJ sequence.
      previous.text += char;
      afterZwj = cp === 0x200d;
      continue;
    }
    if (width === 0) continue;
    cells.push({ text: char, width, attr });
    column += width;
    afterZwj = false;
  }
  return cells;
}

/** Returns the index after the escape sequence starting at `i` (just past ESC). */
function skipEscape(text: string, i: number, onSgr: (params: string) => void): number {
  if (i >= text.length) return i;
  const next = text.charCodeAt(i);
  if (next === 0x5b) return skipCsi(text, i + 1, onSgr); // [
  if (next === 0x5d || next === 0x50 || next === 0x58 || next === 0x5e || next === 0x5f) {
    // OSC ] , DCS P, SOS X, PM ^, APC _: until BEL or ST (ESC \)
    let j = i + 1;
    while (j < text.length) {
      const c = text.charCodeAt(j);
      if (c === 0x07) return j + 1;
      if (c === 0x1b && text.charCodeAt(j + 1) === 0x5c) return j + 2;
      if (c === 0x9c) return j + 1;
      j++;
    }
    return j;
  }
  // Intermediate bytes (e.g. charset designation `ESC ( B`) then one final byte.
  let j = i;
  while (j < text.length && text.charCodeAt(j) >= 0x20 && text.charCodeAt(j) <= 0x2f) j++;
  return Math.min(j + 1, text.length);
}

function skipCsi(text: string, i: number, onSgr: (params: string) => void): number {
  let j = i;
  while (j < text.length) {
    const c = text.charCodeAt(j);
    if (c >= 0x40 && c <= 0x7e) {
      if (c === 0x6d) {
        const params = text.slice(i, j);
        // Private-parameter SGR variants (`ESC [ > 4 m`) are not colors.
        if (!/^[<=>?]/.test(params)) onSgr(params);
      }
      return j + 1;
    }
    j++;
  }
  return j;
}

function applySgr(attr: Attr, params: string): Attr {
  let { fg, bg, flags } = attr;
  const parts = params.length === 0 ? ['0'] : params.split(';');
  for (let p = 0; p < parts.length; p++) {
    const part = parts[p];
    // Colon sub-parameters: 38:5:n or 38:2:[cs:]r:g:b, and 4:x underline styles.
    if (part.includes(':')) {
      const sub = part.split(':').map((s) => (s === '' ? 0 : Number(s)));
      const head = sub[0];
      if (head === 38 || head === 48) {
        const color = colorFromSub(sub);
        if (color) {
          if (head === 38) fg = color;
          else bg = color;
        }
      } else if (head === 4) {
        flags = sub[1] === 0 ? flags & ~FLAG_UNDERLINE : flags | FLAG_UNDERLINE;
      }
      continue;
    }
    const code = part === '' ? 0 : Number(part);
    if (!Number.isFinite(code)) continue;
    if (code === 38 || code === 48) {
      const mode = Number(parts[p + 1]);
      let color: Color | null = null;
      if (mode === 5 && p + 2 < parts.length) {
        color = { kind: 'index', value: clamp(Number(parts[p + 2])) };
        p += 2;
      } else if (mode === 2 && p + 4 < parts.length) {
        color = rgb(Number(parts[p + 2]), Number(parts[p + 3]), Number(parts[p + 4]));
        p += 4;
      } else {
        p = parts.length; // malformed: ignore the rest
      }
      if (color) {
        if (code === 38) fg = color;
        else bg = color;
      }
      continue;
    }
    switch (true) {
      case code === 0:
        fg = null;
        bg = null;
        flags = 0;
        break;
      case code === 1:
        flags |= FLAG_BOLD;
        break;
      case code === 2:
        flags |= FLAG_DIM;
        break;
      case code === 3:
        flags |= FLAG_ITALIC;
        break;
      case code === 4 || code === 21:
        flags |= FLAG_UNDERLINE;
        break;
      case code === 7:
        flags |= FLAG_INVERSE;
        break;
      case code === 8:
        flags |= FLAG_HIDDEN;
        break;
      case code === 9:
        flags |= FLAG_STRIKE;
        break;
      case code === 22:
        flags &= ~(FLAG_BOLD | FLAG_DIM);
        break;
      case code === 23:
        flags &= ~FLAG_ITALIC;
        break;
      case code === 24:
        flags &= ~FLAG_UNDERLINE;
        break;
      case code === 27:
        flags &= ~FLAG_INVERSE;
        break;
      case code === 28:
        flags &= ~FLAG_HIDDEN;
        break;
      case code === 29:
        flags &= ~FLAG_STRIKE;
        break;
      case code >= 30 && code <= 37:
        fg = { kind: 'index', value: code - 30 };
        break;
      case code === 39:
        fg = null;
        break;
      case code >= 40 && code <= 47:
        bg = { kind: 'index', value: code - 40 };
        break;
      case code === 49:
        bg = null;
        break;
      case code >= 90 && code <= 97:
        fg = { kind: 'index', value: code - 90 + 8 };
        break;
      case code >= 100 && code <= 107:
        bg = { kind: 'index', value: code - 100 + 8 };
        break;
      default:
        break;
    }
  }
  return intern(fg, bg, flags);
}

function colorFromSub(sub: number[]): Color | null {
  if (sub[1] === 5 && sub.length >= 3) return { kind: 'index', value: clamp(sub[2]) };
  if (sub[1] === 2) {
    // 38:2:r:g:b or 38:2:colorspace:r:g:b
    const values = sub.length >= 6 ? sub.slice(3, 6) : sub.slice(2, 5);
    if (values.length === 3) return rgb(values[0], values[1], values[2]);
  }
  return null;
}

function rgb(r: number, g: number, b: number): Color | null {
  if (![r, g, b].every(Number.isFinite)) return null;
  return { kind: 'rgb', value: (clamp(r) << 16) | (clamp(g) << 8) | clamp(b) };
}

function clamp(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(255, Math.trunc(value))) : 0;
}
