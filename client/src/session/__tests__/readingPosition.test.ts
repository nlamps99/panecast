import { LayoutCache, layoutRow } from '../../terminal/layout';
import { locateReadingPosition, makeReadingPosition, positionedLines, readingAnchor, restoredLineIndex } from '../readingPosition';
it('recovers a logical row after new output arrives and the font/wrapping changes', () => {
  const rows = ['alpha', '这个较长的输出需要换行', 'omega'];
  const lines = positionedLines(rows, 8, new LayoutCache());
  const position = makeReadingPosition(rows, lines.find((line) => line.rowFromBottom === 1)!, 20);
  const updated = ['older', ...rows, 'new output'];
  expect(locateReadingPosition(updated, position)).toBe(2);
  expect(position.horizontalColumns).toBe(20);
  expect(position.anchor).not.toContain('输出');
});
it('does not restore to an unrelated row when history has rotated', () => {
  const position = makeReadingPosition(['a', 'b', 'c'], positionedLines(['a', 'b', 'c'], 80, new LayoutCache())[1]);
  expect(locateReadingPosition(['x', 'y', 'z'], position)).toBeNull();
});
it('normalizes ANSI/padding for anchors and keeps raw columns as one line', () => {
  expect(readingAnchor(['before', '\x1b[31merror\x1b[0m   ', 'after'], 1)).toBe(readingAnchor(['before', 'error', 'after'], 1));
  expect(layoutRow('a'.repeat(100), 20, false)).toHaveLength(1);
  expect(layoutRow('─'.repeat(100), 20, false)[0].plain).toHaveLength(100);
  expect(layoutRow('a'.repeat(100), 20)).toHaveLength(5);
});
it('restores the exact segment of a wrapped line and clamps when wider layout has fewer segments', () => {
  const rows = ['abcdefghijklmnopqrstuvwxyzabcdef'];
  const lines = positionedLines(rows, 8, new LayoutCache());
  const position = makeReadingPosition(rows, lines[2]);
  expect(restoredLineIndex(lines, position)).toBe(2);
  expect(lines[restoredLineIndex(lines, position)].plain).toBe('ijklmnop');
  const wider = positionedLines(rows, 16, new LayoutCache());
  expect(restoredLineIndex(wider, position)).toBe(1);
});
