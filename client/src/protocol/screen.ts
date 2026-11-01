import type { CursorPos, DiffOp, ScreenDiffFrame, ScreenFullFrame } from './frames';
import { sha256, toHex, utf8Encode } from './sha256';

/**
 * The client's copy of one surface's screen. Immutable: every update returns a
 * new object, so React can compare by identity.
 */
export type ScreenState = {
  rev: number;
  rows: readonly string[];
  cursor: CursorPos;
};

export const EMPTY_SCREEN: ScreenState = { rev: 0, rows: [], cursor: { x: 0, y: 0 } };

export function applyFull(frame: ScreenFullFrame): ScreenState {
  return { rev: frame.rev, rows: frame.rows.slice(), cursor: { ...frame.cursor } };
}

/**
 * Applies one `screen.diff`. Returns the same object when the diff is dropped.
 *
 * Ordering: the relay numbers diffs per subscription and starts every
 * subscription (including a resync) with a `clear` followed by every row. A
 * diff that begins with `clear` is therefore a complete snapshot and always
 * applies. Any other diff applies only if it is newer than what we have; an
 * older one is a leftover from a previous subscription or a reordered frame,
 * and the next checksum repairs whatever it would have changed.
 */
export function applyDiff(state: ScreenState, frame: ScreenDiffFrame): ScreenState {
  const resets = frame.ops.length > 0 && frame.ops[0].op === 'clear';
  if (!resets && frame.rev <= state.rev) return state;
  return { ...applyOps(state, frame.ops), rev: frame.rev };
}

/**
 * `clear` empties the row list rather than blanking each row in place (as
 * `DiffOp.apply` in SharedKit does). The relay always follows `clear` with every
 * row of the new snapshot, so the result is the same when the row count holds,
 * and it stays exact when the terminal shrank, which keeps the checksum honest.
 */
export function applyOps(state: ScreenState, ops: readonly DiffOp[]): ScreenState {
  let rows: string[] | null = null;
  let cursor = state.cursor;
  for (const op of ops) {
    switch (op.op) {
      case 'clear':
        rows = [];
        break;
      case 'row': {
        rows ??= state.rows.slice();
        while (rows.length < op.y) rows.push('');
        rows[op.y] = op.text;
        break;
      }
      case 'cursor':
        cursor = { x: op.x, y: op.y };
        break;
    }
  }
  return { rev: state.rev, rows: rows ?? state.rows, cursor };
}

/**
 * Same digest as `ScreenHasher.hash` in SharedKit: SHA-256 over each row's
 * UTF-8 bytes followed by `\n`, then 0xFF, then cursor x and y as 64-bit
 * little-endian integers; the first 8 bytes as lowercase hex.
 */
export function screenHash(rows: readonly string[], cursor: CursorPos): string {
  const parts: Uint8Array[] = [];
  let length = 0;
  for (const row of rows) {
    const bytes = utf8Encode(row);
    parts.push(bytes);
    length += bytes.length + 1;
  }
  length += 1 + 16;
  const buffer = new Uint8Array(length);
  let offset = 0;
  for (const bytes of parts) {
    buffer.set(bytes, offset);
    offset += bytes.length;
    buffer[offset++] = 0x0a;
  }
  buffer[offset++] = 0xff;
  writeInt64LE(buffer, offset, cursor.x);
  writeInt64LE(buffer, offset + 8, cursor.y);
  return toHex(sha256(buffer).subarray(0, 8));
}

function writeInt64LE(buffer: Uint8Array, offset: number, value: number): void {
  // Two's complement over 64 bits; cursor values are small, possibly -1.
  let low = value >>> 0;
  let high = value < 0 ? 0xffffffff : Math.floor(value / 0x1_0000_0000) >>> 0;
  for (let i = 0; i < 4; i++) {
    buffer[offset + i] = low & 0xff;
    low >>>= 8;
  }
  for (let i = 4; i < 8; i++) {
    buffer[offset + i] = high & 0xff;
    high >>>= 8;
  }
}
