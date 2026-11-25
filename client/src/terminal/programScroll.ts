/**
 * Scrolling a full-screen program (htop, vim, lazygit) that has no session
 * record: travel is turned into whole wheel units for `terminal.scroll`.
 * cmux treats any request as at least one full wheel step, so fractions are
 * carried locally instead of being sent.
 */

/** Rows of wheel or finger travel per wheel unit. */
export const PROGRAM_ROWS_PER_UNIT = 3;

/** At most this many units wait to be sent from a touch drag, so lifting the finger stops the program soon. */
export const PROGRAM_TOUCH_MAX_QUEUED = 6;

/**
 * Adds `pixels` of travel (positive toward older output) to the carried
 * fraction and returns the whole units to send. Reversing direction drops the
 * fraction carried the other way.
 */
export function programScrollUnits(carry: number, pixels: number, unitPixels: number): { units: number; carry: number } {
  if (!Number.isFinite(pixels) || !(unitPixels > 0) || pixels === 0) return { units: 0, carry };
  const start = carry !== 0 && Math.sign(carry) !== Math.sign(pixels) ? 0 : carry;
  const next = start + pixels / unitPixels;
  const units = Math.trunc(next) || 0;
  return { units, carry: next - units };
}

/**
 * The part of a drag that the local list cannot absorb, which goes to the
 * program instead. A wrapped screen taller than the viewport scrolls locally
 * first; past its top (older) or bottom (newer) edge the program scrolls.
 * `fromBottom` and `range` are the inverted list's offset and scroll range.
 */
export function programDragTravel(pixels: number, fromBottom: number, range: number, slack = 2): number {
  if (pixels > 0) return fromBottom >= Math.max(0, range) - slack ? pixels : 0;
  if (pixels < 0) return fromBottom <= slack ? pixels : 0;
  return 0;
}

/** Extra travel for a flick, about a quarter second of its speed, at most `limit` either way. */
export function programFlingTravel(velocity: number, limit: number): number {
  if (!Number.isFinite(velocity) || Math.abs(velocity) < 300) return 0;
  return Math.max(-limit, Math.min(limit, velocity * 0.25));
}
