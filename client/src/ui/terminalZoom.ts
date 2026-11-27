import { clampFontSize, getPrefs, setPrefs, type Prefs } from '../state/prefs';

/**
 * Desktop text size. By default an unwrapped terminal fits the computer's
 * columns into the window (at most the font-size preference, at least
 * `MIN_FIT_FONT`). ⌘= / ⌘- fix an explicit size, stepping from the size on
 * screen, which then wins over the fit: a wider terminal scrolls sideways
 * or wraps. ⌘0 (实际大小) goes back to fitting. Phones never use this.
 */

const SIDE_PADDING = 8;
const MONO_ADVANCE_EM = 0.6;
export const MIN_FIT_FONT = 9;

/** The largest size, at most the chosen one, that fits `columns` cells in `width`. */
export function fitFontSize(width: number, columns: number, preferred: number): number {
  const fits = (width - SIDE_PADDING * 2 - 1) / (columns * MONO_ADVANCE_EM);
  return Math.max(MIN_FIT_FONT, Math.min(preferred, Math.floor(fits * 2) / 2));
}

/** The size a desktop terminal draws at, before a pinch. */
export function desktopFontSize(options: { preference: number; zoom: number | null; wrap: boolean; width: number; columns: number | null }): number {
  const { preference, zoom, wrap, width, columns } = options;
  if (zoom !== null) return zoom;
  return !wrap && columns && width > 0 ? fitFontSize(width, columns, preference) : preference;
}

/** The pref change for ⌘= (1), ⌘- (-1) and ⌘0 (0), given the size the terminal shows now. */
export function desktopZoomPatch(step: 1 | -1 | 0, prefs: Pick<Prefs, 'fontSize' | 'desktopFontZoom'>, shown: number | null): Partial<Prefs> {
  if (step === 0) return { desktopFontZoom: null };
  // An explicit size is what the terminal shows; otherwise it shows the fitted size.
  return { desktopFontZoom: clampFontSize(desktopTerminalSize(prefs, shown) + step) };
}

let shownSize: number | null = null;
/**
 * The terminal view reports the size it draws at. The last one is kept when
 * the view closes (settings, chat mode): steps go on from what was last seen.
 */
export function showDesktopFontSize(size: number | null): void {
  shownSize = size;
}

/** The desktop terminal's text size as the user last saw it, for settings. */
export function desktopTerminalSize(prefs: Pick<Prefs, 'fontSize' | 'desktopFontZoom'>, shown = shownSize): number {
  return prefs.desktopFontZoom ?? shown ?? prefs.fontSize;
}

/** ⌘= / ⌘- / ⌘0 from the keyboard or the 显示 menu, and settings' A− / A+ on the desktop. */
export function zoomDesktopTerminal(step: 1 | -1 | 0): void {
  setPrefs(desktopZoomPatch(step, getPrefs(), shownSize));
}
