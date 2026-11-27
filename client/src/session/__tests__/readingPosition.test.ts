import { LayoutCache, layoutRow } from '../../terminal/layout';
import { locateReadingPosition, makeReadingPosition, positionedLines, ReadingPositionSearch, readingAnchor, restoredLineIndex } from '../readingPosition';
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

describe('positioned lines', () => {
  it('lays out every row once per frame whatever the wrap setting, so the cache survives the frame', () => {
    const cache = new LayoutCache();
    const rows = ['alpha', 'a much longer row that would wrap', '', ''];
    for (const wrap of [true, false]) {
      const first = positionedLines(rows, 8, cache, wrap);
      const again = positionedLines(rows, 8, cache, wrap);
      // The same laid-out spans: trimming the blank bottom rows did not clear the cache.
      expect(again.map((line) => line.spans)).toEqual(first.map((line) => line.spans));
      again.forEach((line, index) => expect(line.spans).toBe(first[index].spans));
    }
  });

  it('hands unchanged lines back as the same objects, also when a row above rewraps', () => {
    const cache = new LayoutCache();
    const rows = ['top', 'short', 'bottom'];
    const first = positionedLines(rows, 8, cache, true);
    const edited = positionedLines(['top', 'now long enough to wrap', 'bottom'], 8, cache, true, { previous: first });
    expect(edited[0]).toBe(first[0]);
    expect(edited.at(-1)).toBe(first.at(-1));
    expect(edited.at(-1)?.rowFromBottom).toBe(2);
    expect(edited[1]).not.toBe(first[1]);
  });

  it('keeps blank bottom rows up to the cursor row', () => {
    const rows = ['$ cat', '', '', ''];
    expect(positionedLines(rows, 80, new LayoutCache())).toHaveLength(1);
    const kept = positionedLines(rows, 80, new LayoutCache(), true, { keepRows: 2 });
    expect(kept.map((line) => line.rowFromBottom)).toEqual([2, 3]);
  });
});

describe('finding a saved reading position while pages load', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const hashing = require('../../protocol/sha256') as typeof import('../../protocol/sha256');
  it('hashes each loaded row about once, not once per page', () => {
    const page = (n: number) => Array.from({ length: 100 }, (_, i) => `page ${n} row ${i}`);
    const pages = Array.from({ length: 10 }, (_, n) => page(n));
    const all = pages.flat().reverse();
    const target = 30; // in the oldest page
    const position = { anchor: readingAnchor(all, target), rowFromBottom: all.length - target - 1, segmentFromBottom: 0, horizontalColumns: 0 };
    const spy = jest.spyOn(hashing, 'sha256');
    try {
      const search = new ReadingPositionSearch(position);
      let found: number | null = null;
      let rows: string[] = [];
      for (let loaded = 1; loaded <= 10 && found === null; loaded++) {
        rows = all.slice(all.length - loaded * 100);
        found = search.locate(rows);
      }
      expect(found).toBe(target);
      expect(rows[found!]).toBe(all[target]);
      // A full rescan per page would hash 100 + 200 + … + 1000 = 5500 windows.
      expect(spy.mock.calls.length).toBeLessThan(1100);
    } finally {
      spy.mockRestore();
    }
  });

  it('searches again from scratch when the rows below changed', () => {
    const position = makeReadingPosition(['a', 'b', 'c'], positionedLines(['a', 'b', 'c'], 80, new LayoutCache())[1]);
    const search = new ReadingPositionSearch(position);
    expect(search.locate(['x', 'y', 'z'])).toBeNull();
    expect(search.locate(['a', 'b', 'c'])).toBe(1);
  });
});
