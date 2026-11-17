import { DEFAULT_ATTR, intern } from '../../terminal/ansi';
import { fitFontSize, liveCursor, splitAtCursor } from '../TerminalView';
import type { TerminalState } from '../../session/terminalSession';

const bold = intern(null, null, 1);
const state = (x: number, y: number, extra: Partial<TerminalState> = {}) => ({
  target: null, screen: { rev: 1, rows: [], cursor: { x, y } }, subscription: 'live', subscriptionError: null, browse: null,
  input: { busy: false, error: null }, ...extra,
}) as TerminalState;

describe('the terminal cursor', () => {
  const rows = ['$ ls', 'a  b', '$ '];

  it('maps the cursor row to the line counted from the bottom', () => {
    expect(liveCursor(state(2, 2), rows, () => true)).toEqual({ rowFromBottom: 0, column: 2 });
    expect(liveCursor(state(1, 0), rows, () => true)).toEqual({ rowFromBottom: 2, column: 1 });
  });

  it('is not drawn while browsing, past the rows, on wrapped rows or for the placeholder', () => {
    expect(liveCursor(state(2, 2, { browse: {} as TerminalState['browse'] }), rows, () => true)).toBeNull();
    expect(liveCursor(state(0, 3), rows, () => true)).toBeNull();
    expect(liveCursor(state(2, 2), rows, () => false)).toBeNull();
    expect(liveCursor(state(0, 0), rows, () => true)).toBeNull();
    expect(liveCursor(state(2, 2, { subscription: 'subscribing' }), rows, () => true)).toBeNull();
  });

  it('splits styled text at a terminal cell, counting wide characters as two', () => {
    const spans = [{ text: '中a', attr: bold }, { text: 'bc', attr: DEFAULT_ATTR }];
    expect(splitAtCursor(spans, 2)).toEqual({ before: [{ text: '中', attr: bold }], at: { text: 'a', attr: bold }, after: [{ text: 'bc', attr: DEFAULT_ATTR }] });
    expect(splitAtCursor(spans, 4)).toEqual({ before: [{ text: '中a', attr: bold }, { text: 'b', attr: DEFAULT_ATTR }], at: { text: 'c', attr: DEFAULT_ATTR }, after: [] });
  });

  it('pads past the end of the text', () => {
    expect(splitAtCursor([{ text: '$', attr: DEFAULT_ATTR }], 3)).toEqual({
      before: [{ text: '$', attr: DEFAULT_ATTR }, { text: '  ', attr: DEFAULT_ATTR }], at: { text: ' ', attr: DEFAULT_ATTR }, after: [],
    });
  });

  it('fits a wide terminal into the window without growing past the chosen size', () => {
    expect(fitFontSize(1000, 80, 13)).toBe(13);
    expect(fitFontSize(1000, 160, 13)).toBe(10);
    expect(fitFontSize(600, 300, 13)).toBe(9);
  });
});
