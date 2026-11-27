import { DEFAULT_ATTR, intern } from '../ansi';
import { findNeedle, findRanges, firstLineOfRow, markSpans } from '../find';

const bold = intern(null, null, 1);

describe('find', () => {
  it('finds every occurrence, ignoring case and surrounding spaces in the query', () => {
    expect(findNeedle('  Error ')).toBe('error');
    expect(findRanges('ERROR: error again', 'error')).toEqual([[0, 5], [7, 12]]);
    expect(findRanges('aaaa', 'aa')).toEqual([[0, 2], [2, 4]]);
    expect(findRanges('anything', '')).toEqual([]);
  });

  it('marks matches across span boundaries and keeps each span\'s attribute', () => {
    const spans = [{ text: 'npm ER', attr: DEFAULT_ATTR }, { text: 'R! code', attr: bold }];
    expect(markSpans(spans, 'err')).toEqual([
      { text: 'npm ', attr: DEFAULT_ATTR, hit: false },
      { text: 'ER', attr: DEFAULT_ATTR, hit: true },
      { text: 'R', attr: bold, hit: true },
      { text: '! code', attr: bold, hit: false },
    ]);
    expect(markSpans(spans, 'zzz').every((span) => !span.hit)).toBe(true);
  });

  it('finds the first line of a row in bottom-up lines', () => {
    const lines = [0, 1, 1, 1, 3, 4].map((rowFromBottom) => ({ rowFromBottom }));
    expect(firstLineOfRow(lines, 1)).toBe(1);
    expect(firstLineOfRow(lines, 4)).toBe(5);
    expect(firstLineOfRow(lines, 2)).toBe(-1);
    expect(firstLineOfRow([], 0)).toBe(-1);
  });
});
