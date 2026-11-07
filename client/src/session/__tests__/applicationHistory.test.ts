import { olderApplicationRows } from '../applicationHistory';

const body = (start: number, count = 40) => Array.from({ length: count }, (_, i) => `历史 ${start + i}`);

it('extracts an older prefix while leaving the screen being read intact', () => {
  const previous = body(100), next = body(90);
  expect(olderApplicationRows(previous, next)).toEqual({ rows: body(90, 10), headerRows: 0 });
  expect(previous).toEqual(body(100));
});

it('excludes sticky TUI headers and footers from every captured page', () => {
  const previous = ['Codex', '────', ...body(100), '────', '› input'];
  const next = ['Codex', '────', ...body(90), '────', '› input'];
  expect(olderApplicationRows(previous, next)).toEqual({ rows: body(90, 10), headerRows: 2 });
});

it('matches visible text across ANSI changes without erasing its styling', () => {
  const previous = body(100).map(row => `\x1b[31m${row}\x1b[0m`);
  const next = body(90).map(row => `\x1b[32m${row}\x1b[0m`);
  expect(olderApplicationRows(previous, next)?.rows).toEqual(next.slice(0, 10));
});

it('does not invent history when the program redraws, repeats blank rows, or moves forward', () => {
  expect(olderApplicationRows(body(100), body(110))).toBeNull();
  expect(olderApplicationRows(body(100), ['unrelated program', ...body(500)])).toBeNull();
  expect(olderApplicationRows(['header', ...Array(40).fill(''), 'footer'], ['different', ...Array(40).fill(''), 'footer'])).toBeNull();
  expect(olderApplicationRows(body(100), body(100))).toBeNull();
});
