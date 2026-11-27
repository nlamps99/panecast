/**
 * Whether the live screen was repainted as a whole, rather than edited or
 * scrolled: what a full-screen program does when it starts (switching to
 * the alternate screen) and when it quits (the shell's screen comes back).
 * The scroll method depends on which screen is showing, so a repaint is the
 * cue to ask the computer again (`terminal.replay`).
 *
 * Scrolling output also changes every row, but the rows move up together:
 * most new rows equal an old row a fixed number of places further down.
 */
export function screenRepainted(previous: readonly string[], next: readonly string[]): boolean {
  if (previous === next || !previous.length || !next.length) return false;
  const total = Math.max(previous.length, next.length);
  let changed = Math.abs(previous.length - next.length);
  for (let i = 0; i < Math.min(previous.length, next.length); i++) if (previous[i] !== next[i]) changed++;
  if (changed < total * REPAINTED_SHARE) return false;
  const limit = Math.floor(Math.min(previous.length, next.length) / 2);
  for (let shift = 1; shift <= limit; shift++) {
    let compared = 0, same = 0;
    for (let i = 0; i + shift < previous.length && i < next.length; i++) {
      if (!next[i].trim()) continue;
      compared++;
      if (next[i] === previous[i + shift]) same++;
    }
    if (compared > 0 && same >= compared * SCROLLED_SHARE) return false;
  }
  return true;
}

/** At least this share of the rows changed at once. */
const REPAINTED_SHARE = 0.6;
/** This share of the non-blank rows reappearing higher up means the output scrolled. */
const SCROLLED_SHARE = 0.5;
