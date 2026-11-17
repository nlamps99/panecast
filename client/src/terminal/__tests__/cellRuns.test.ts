import { cellRuns } from '../cellRuns';

describe('cellRuns', () => {
  it('keeps text GeistMono draws as one run', () => {
    expect(cellRuns('git status ── │ ┌─┐ é')).toEqual([{ kind: 'text', text: 'git status ── │ ┌─┐ é' }]);
  });

  it('boxes CJK runs at two cells each and symbols at their terminal width', () => {
    expect(cellRuns('ok 中文 ⏺ x😀')).toEqual([
      { kind: 'text', text: 'ok ' },
      { kind: 'wide', text: '中文', cells: 4 },
      { kind: 'text', text: ' ' },
      { kind: 'symbol', text: '⏺', cells: 1 },
      { kind: 'text', text: ' x' },
      { kind: 'symbol', text: '😀', cells: 2 },
    ]);
  });

  it('keeps combining marks and variation selectors with their base', () => {
    expect(cellRuns('✔︎a')).toEqual([{ kind: 'symbol', text: '✔︎', cells: 1 }, { kind: 'text', text: 'a' }]);
  });
});
