import { matchingRows, plainTerminalRows, terminalLinks } from '../textTools';
it('copies logical lines without ANSI, hidden text or padded spaces', () => {
  const rows = plainTerminalRows(['\x1b[31mError\x1b[0m  ', '中文输出', '\x1b[8msecret\x1b[0m']);
  expect(rows).toEqual(['Error', '中文输出', '']);
  expect(matchingRows(rows, 'ERROR')).toEqual([0]);
  expect(matchingRows(rows, '中文')).toEqual([1]);
});
it('opens only explicit web links and deduplicates them', () => {
  expect(terminalLinks('javascript:alert(1) https://example.com/a). https://example.com/a')).toEqual(['https://example.com/a']);
});
