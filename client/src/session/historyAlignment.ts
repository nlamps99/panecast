import { plainTerminalRows } from '../terminal/textTools';

export type HistoryAlignment = { matched: boolean; olderRows: string[]; ambiguous?: boolean };

/** Re-anchoring identical visible text cannot discard what the user is reading. */
export function sameVisibleRows(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const a = plainTerminalRows(left), b = plainTerminalRows(right);
  return a.every((row, index) => row === b[index]);
}

/** Find a stable prefix of the frozen screen inside a chronological snapshot. */
export function alignHistory(frozenRows: readonly string[], historyRows: readonly string[], anchorRows: readonly string[]): HistoryAlignment {
  const combined = [...historyRows, ...anchorRows];
  if (!frozenRows.length) return { matched: true, olderRows: combined };
  const frozen = plainTerminalRows(frozenRows);
  const snapshot = plainTerminalRows(combined);
  const minimum = Math.min(frozen.length, Math.max(2, Math.ceil(frozen.length / 2)));
  // Z matching is linear in the snapshot size, including repetitive logs. The
  // old nested prefix search became expensive when a spinner rewrote its tail.
  const sequence: (string | symbol)[] = [...frozen, Symbol('boundary'), ...snapshot];
  const z = new Array<number>(sequence.length).fill(0);
  let left = 0, right = 0;
  for (let i = 1; i < sequence.length; i++) {
    if (i < right) z[i] = Math.min(right - i, z[i - left]);
    while (i + z[i] < sequence.length && sequence[z[i]] === sequence[i + z[i]]) z[i]++;
    if (i + z[i] > right) { left = i; right = i + z[i]; }
  }
  const meaningful = [0];
  for (const row of frozen) meaningful.push(meaningful[meaningful.length - 1] + Number(Boolean(row.trim())));
  let bestStart = -1, bestLength = 0, bestCount = 0;
  for (let start = 0; start < snapshot.length; start++) {
    const length = Math.min(frozen.length, z[frozen.length + 1 + start]);
    if (length >= minimum && meaningful[length] > 0 && length >= bestLength) {
      bestCount = length > bestLength ? 1 : bestCount + 1;
      bestStart = start; bestLength = length;
    }
  }
  if (bestCount > 1) return { matched: false, olderRows: [...historyRows], ambiguous: true };
  return bestStart < 0 ? { matched: false, olderRows: [...historyRows] } : { matched: true, olderRows: combined.slice(0, bestStart) };
}
