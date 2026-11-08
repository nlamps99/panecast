import { olderApplicationRows, sameApplicationViewport } from '../applicationHistory';

const body = (start: number, count = 40) => Array.from({ length: count }, (_, i) => `历史 ${start + i}`);

it('extracts an older prefix while leaving the screen being read intact', () => {
  const previous = body(100), next = body(90);
  expect(olderApplicationRows(previous, next)).toEqual({ rows: body(90, 10), replacedRows: 0 });
  expect(previous).toEqual(body(100));
});

it('replaces the boundary header once while retaining the original transcript and footer', () => {
  const previous = ['Codex', '────', ...body(100), '────', '› input'];
  const next = ['Codex', '────', ...body(90), '────', '› input'];
  const page = olderApplicationRows(previous, next)!;
  expect(page).toEqual({ rows: ['Codex', '────', ...body(90, 10)], replacedRows: 2 });
  expect([...page.rows, ...previous.slice(page.replacedRows)]).toEqual(['Codex', '────', ...body(90, 50), '────', '› input']);
});

it.each([true, false])('keeps every transcript row when a changing header grows or shrinks (grows=%s)', grows => {
  const previous = [...(grows ? ['status old'] : ['status old', 'old detail']), ...body(100), 'input'];
  const next = [...(grows ? ['status new', 'new detail'] : ['status new']), ...body(90), 'input'];
  const page = olderApplicationRows(previous, next)!;
  const combined = [...page.rows, ...previous.slice(page.replacedRows)];
  expect(combined.filter(row => row.startsWith('历史 '))).toEqual(body(90, 50));
  expect(combined.filter(row => row.startsWith('status'))).toEqual(['status new']);
});

it('matches separated transcript rows when progress output is redrawn inside the overlap', () => {
  const rows = (start: number, revision: number) => body(start).map((row, i) => (start + i) % 6 === 0 ? `progress ${start + i}: ${revision}` : row);
  const previous = rows(100, 1), next = rows(90, 2);
  const page = olderApplicationRows(previous, next)!;
  expect(page).toEqual({ rows: next.slice(0, 10), replacedRows: 0 });
  expect([...page.rows, ...previous.slice(page.replacedRows)]).toEqual([...next.slice(0, 10), ...previous]);
});

it('recognizes an unchanged transcript when only a status line changes', () => {
  const previous = ['header', ...body(100), 'working 1'];
  const next = ['header', ...body(100), 'working 2'];
  expect(olderApplicationRows(previous, next)).toBeNull();
  expect(sameApplicationViewport(previous, next)).toBe(true);
  expect(sameApplicationViewport(previous, ['header', ...body(500), 'working 2'])).toBe(false);
});

it('joins a small overlap using two unique, informative transcript rows', () => {
  const rows = (start: number, length: number) => Array.from({ length }, (_, i) => `transcript payload #${start + i}`);
  const previous = rows(100, 40), next = rows(62, 40), page = olderApplicationRows(previous, next)!;
  expect([...page.rows, ...previous.slice(page.replacedRows)]).toEqual(rows(62, 78));
});

it('uses a unique first transcript row when a fast scroll leaves only one row below a stable header', () => {
  const rows = (start: number, length: number) => Array.from({ length }, (_, i) => `transcript payload #${start + i}`);
  const previous = ['header', 'transcript', ...rows(100, 31), 'input', 'status old'];
  const next = ['header', 'transcript', ...rows(70, 31), 'input', 'status new'];
  const page = olderApplicationRows(previous, next)!;
  expect([...page.rows, ...previous.slice(page.replacedRows)]).toEqual(['header', 'transcript', ...rows(70, 61), 'input', 'status old']);
});

it('rejects a short generic line as the sole overlap', () => {
  const previous = ['header', 'ready', ...body(100), 'input'];
  const next = ['header', ...body(500), 'ready', 'input'];
  expect(olderApplicationRows(previous, next)).toBeNull();
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
