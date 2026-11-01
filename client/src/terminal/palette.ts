import type { TextStyle } from 'react-native';

import { colors, fonts } from '../ui/theme';
import {
  FLAG_BOLD,
  FLAG_DIM,
  FLAG_INVERSE,
  FLAG_ITALIC,
  FLAG_STRIKE,
  FLAG_UNDERLINE,
  type Attr,
  type Color,
} from './ansi';

/** ANSI 0–15, mapped onto the app palette. */
const BASE16 = [
  colors.mutedDim, // black: visible on the dark background
  colors.red,
  colors.green,
  colors.yellow,
  colors.blue,
  colors.magenta,
  colors.cyan,
  colors.inkDim,
  colors.muted, // bright black
  '#ff899d',
  '#9fe044',
  '#faba4a',
  '#8db0ff',
  '#c7a9ff',
  '#a4daff',
  colors.terminalText,
];

const CUBE_LEVELS = [0, 95, 135, 175, 215, 255];

export function paletteHex(index: number): string {
  const i = Math.max(0, Math.min(255, index));
  if (i < 16) return BASE16[i];
  if (i >= 232) {
    const shade = 8 + (i - 232) * 10;
    return rgbHex(shade, shade, shade);
  }
  const n = i - 16;
  return rgbHex(CUBE_LEVELS[Math.floor(n / 36) % 6], CUBE_LEVELS[Math.floor(n / 6) % 6], CUBE_LEVELS[n % 6]);
}

export function colorHex(color: Color): string {
  if (color.kind === 'index') return paletteHex(color.value);
  return rgbHex((color.value >> 16) & 0xff, (color.value >> 8) & 0xff, color.value & 0xff);
}

function rgbHex(r: number, g: number, b: number): string {
  return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;
}

function blend(fgHex: string, bgHex: string, amount: number): string {
  const f = parseInt(fgHex.slice(1), 16);
  const b = parseInt(bgHex.slice(1), 16);
  const mix = (shift: number) =>
    Math.round(((f >> shift) & 0xff) * (1 - amount) + ((b >> shift) & 0xff) * amount);
  return rgbHex(mix(16), mix(8), mix(0));
}

export const DEFAULT_FG = colors.terminalText;
export const DEFAULT_BG = colors.canvas;

const styleCache = new Map<string, TextStyle | null>();

/**
 * The style for a span with these attributes, or null for the default (the
 * line's base style applies). Cached per interned attribute key.
 */
export function styleForAttr(attr: Attr): TextStyle | null {
  const cached = styleCache.get(attr.key);
  if (cached !== undefined) return cached;
  const style = computeStyle(attr);
  if (styleCache.size > 4_096) styleCache.clear();
  styleCache.set(attr.key, style);
  return style;
}

function computeStyle(attr: Attr): TextStyle | null {
  if (attr.fg === null && attr.bg === null && attr.flags === 0) return null;
  let fg = attr.fg ? colorHex(attr.fg) : DEFAULT_FG;
  let bg: string | undefined = attr.bg ? colorHex(attr.bg) : undefined;
  if (attr.flags & FLAG_INVERSE) {
    const swappedFg = bg ?? DEFAULT_BG;
    bg = fg;
    fg = swappedFg;
  }
  // Nested Text cannot take opacity; blend toward the background instead.
  if (attr.flags & FLAG_DIM) fg = blend(fg, bg ?? DEFAULT_BG, 0.45);

  const style: { -readonly [K in keyof TextStyle]: TextStyle[K] } = {};
  if (fg !== DEFAULT_FG) style.color = fg;
  if (bg) style.backgroundColor = bg;
  if (attr.flags & FLAG_BOLD) style.fontFamily = fonts.monoBold;
  // GeistMono ships no italic face; iOS and Android would substitute another font.
  if (attr.flags & FLAG_ITALIC) style.fontStyle = 'normal';
  const underline = (attr.flags & FLAG_UNDERLINE) !== 0;
  const strike = (attr.flags & FLAG_STRIKE) !== 0;
  if (underline && strike) style.textDecorationLine = 'underline line-through';
  else if (underline) style.textDecorationLine = 'underline';
  else if (strike) style.textDecorationLine = 'line-through';
  return Object.keys(style).length > 0 ? style : null;
}
