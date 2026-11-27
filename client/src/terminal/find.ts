import type { Span } from './layout';

/** What the find bar searches for: trimmed, case-insensitive, as `matchingRows` does. */
export function findNeedle(query: string): string {
  return query.trim().toLocaleLowerCase();
}

/**
 * Where `needle` (from `findNeedle`) occurs in `text`, as [start, end) code
 * unit ranges. Empty when lower-casing changes the text's length, which
 * would misplace the marks.
 */
export function findRanges(text: string, needle: string): [number, number][] {
  if (!needle) return [];
  const haystack = text.toLocaleLowerCase();
  if (haystack.length !== text.length) return [];
  const ranges: [number, number][] = [];
  for (let at = haystack.indexOf(needle); at >= 0; at = haystack.indexOf(needle, at + needle.length)) ranges.push([at, at + needle.length]);
  return ranges;
}

export type MarkedSpan = Span & { hit: boolean };

/** Splits a line's spans where matches start and end, keeping each span's attribute. */
export function markSpans(spans: readonly Span[], needle: string): MarkedSpan[] {
  const ranges = findRanges(spans.map((span) => span.text).join(''), needle);
  if (!ranges.length) return spans.map((span) => ({ ...span, hit: false }));
  const out: MarkedSpan[] = [];
  let offset = 0, next = 0;
  for (const span of spans) {
    const end = offset + span.text.length;
    let at = offset;
    while (at < end) {
      while (next < ranges.length && ranges[next][1] <= at) next++;
      const range = ranges[next];
      const inside = range !== undefined && range[0] <= at;
      const stop = inside ? Math.min(end, range[1]) : Math.min(end, range?.[0] ?? end);
      out.push({ text: span.text.slice(at - offset, stop - offset), attr: span.attr, hit: inside });
      at = stop;
    }
    offset = end;
  }
  return out;
}

/** Index of the first line on row `rowFromBottom`; lines are ordered bottom-up, so their rows never decrease. */
export function firstLineOfRow(lines: readonly { rowFromBottom: number }[], rowFromBottom: number): number {
  let low = 0, high = lines.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (lines[mid].rowFromBottom < rowFromBottom) low = mid + 1;
    else high = mid;
  }
  return low < lines.length && lines[low].rowFromBottom === rowFromBottom ? low : -1;
}
