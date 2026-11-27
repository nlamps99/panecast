import { sanitizePrefs, setPrefs } from '../../state/prefs';
import { desktopFontSize, desktopZoomPatch, fitFontSize, showDesktopFontSize, zoomDesktopTerminal } from '../terminalZoom';

// jest.mock is hoisted above the imports.
jest.mock('../../state/prefs', () => {
  const actual = jest.requireActual('../../state/prefs');
  return { ...actual, setPrefs: jest.fn(), getPrefs: () => ({ ...actual.DEFAULT_PREFS, fontSize: 13, desktopFontZoom: null }) };
});

describe('desktop terminal zoom', () => {
  it('fits a wide terminal into the window without growing past the chosen size', () => {
    expect(fitFontSize(1000, 80, 13)).toBe(13);
    expect(fitFontSize(1000, 160, 13)).toBe(10);
    expect(fitFontSize(600, 300, 13)).toBe(9);
  });

  it('fits only an unwrapped terminal with known columns, and an explicit size wins', () => {
    const base = { preference: 13, zoom: null, wrap: false, width: 1000, columns: 160 };
    expect(desktopFontSize(base)).toBe(10);
    expect(desktopFontSize({ ...base, wrap: true })).toBe(13);
    expect(desktopFontSize({ ...base, columns: null })).toBe(13);
    expect(desktopFontSize({ ...base, zoom: 15 })).toBe(15);
    expect(desktopFontSize({ ...base, wrap: true, zoom: 11 })).toBe(11);
  });

  it('steps from the size on screen, so the first ⌘= after fitting grows by one step', () => {
    const prefs = { fontSize: 13, desktopFontZoom: null };
    expect(desktopZoomPatch(1, prefs, 10)).toEqual({ desktopFontZoom: 11 });
    expect(desktopZoomPatch(-1, prefs, 10.5)).toEqual({ desktopFontZoom: 9.5 });
    expect(desktopZoomPatch(1, { fontSize: 13, desktopFontZoom: 15 }, null)).toEqual({ desktopFontZoom: 16 });
    // An explicit size wins over a size last shown before it was set.
    expect(desktopZoomPatch(1, { fontSize: 13, desktopFontZoom: 15 }, 10)).toEqual({ desktopFontZoom: 16 });
    expect(desktopZoomPatch(1, prefs, null)).toEqual({ desktopFontZoom: 14 });
    expect(desktopZoomPatch(1, prefs, 20)).toEqual({ desktopFontZoom: 20 });
    expect(desktopZoomPatch(-1, prefs, 9)).toEqual({ desktopFontZoom: 9 });
    // ⌘0 (实际大小) fits again.
    expect(desktopZoomPatch(0, { fontSize: 13, desktopFontZoom: 16 }, 16)).toEqual({ desktopFontZoom: null });
  });

  it('applies the shortcut to the shown size, without touching the phone font size', () => {
    showDesktopFontSize(10);
    zoomDesktopTerminal(1);
    expect(setPrefs).toHaveBeenLastCalledWith({ desktopFontZoom: 11 });
    zoomDesktopTerminal(0);
    expect(setPrefs).toHaveBeenLastCalledWith({ desktopFontZoom: null });
    showDesktopFontSize(null);
  });

  it('keeps a stored zoom only when it is a size', () => {
    expect(sanitizePrefs({ desktopFontZoom: 15 }).desktopFontZoom).toBe(15);
    expect(sanitizePrefs({ desktopFontZoom: 99 }).desktopFontZoom).toBe(20);
    expect(sanitizePrefs({ desktopFontZoom: 'big' }).desktopFontZoom).toBeNull();
    expect(sanitizePrefs({}).desktopFontZoom).toBeNull();
  });
});
