/**
 * Wire frames on `/v1/ws`. Mirrors `relay/Sources/SharedKit/WireProtocol.swift`,
 * `DiffOp.swift` and `JSONRPC.swift`.
 *
 * - Client → relay: one hello (camelCase keys), then RPC requests.
 * - Relay → client: RPC responses (carry `id`) and push frames (carry `type`,
 *   snake_case keys).
 */

export const PROTOCOL_VERSION = 1;
export const WS_SUBPROTOCOL = 'cmuxremote.v1';

export type Hello = { deviceId: string; appVersion: string; protocolVersion: number };

export type CursorPos = { x: number; y: number };

export type DiffOp =
  | { op: 'row'; y: number; text: string }
  | { op: 'cursor'; x: number; y: number }
  | { op: 'clear' };

export type ScreenFullFrame = {
  type: 'screen.full';
  surfaceId: string;
  rev: number;
  rows: string[];
  cols: number;
  rowsCount: number;
  cursor: CursorPos;
};

export type ScreenDiffFrame = { type: 'screen.diff'; surfaceId: string; rev: number; ops: DiffOp[] };

export type ScreenChecksumFrame = { type: 'screen.checksum'; surfaceId: string; rev: number; hash: string };

export type EventFrame = { type: 'event'; category: string; name: string; payload: unknown };

export type PingFrame = { type: 'ping' | 'pong'; ts: number };

export type PushFrame = ScreenFullFrame | ScreenDiffFrame | ScreenChecksumFrame | EventFrame | PingFrame;

export type RpcError = { code: string; message: string; data?: unknown };

export type RpcResponse = { id: string; ok: boolean; result?: unknown; error?: RpcError };

export type InboundFrame = { kind: 'response'; response: RpcResponse } | { kind: 'push'; frame: PushFrame };

/**
 * Classifies one inbound text frame. Returns null for anything that is not
 * valid JSON or not a frame this client understands; callers drop those.
 */
export function parseInbound(text: string): InboundFrame | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObject(value)) return null;
  if (typeof value.id === 'string') {
    const response = parseResponse(value);
    return response ? { kind: 'response', response } : null;
  }
  const frame = parsePush(value);
  return frame ? { kind: 'push', frame } : null;
}

/** cmux omits `ok` on success and sends `ok: false` on failure. */
function parseResponse(value: Record<string, unknown>): RpcResponse | null {
  const id = value.id as string;
  const error = parseError(value.error);
  const ok = value.ok !== false && error === undefined;
  if (!ok) {
    return { id, ok, error: error ?? { code: 'error', message: 'request failed' } };
  }
  return { id, ok, result: value.result };
}

function parseError(value: unknown): RpcError | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isObject(value)) return { code: 'error', message: String(value) };
  return {
    code: typeof value.code === 'string' ? value.code : 'error',
    message: typeof value.message === 'string' ? value.message : '',
    data: value.data,
  };
}

function parsePush(value: Record<string, unknown>): PushFrame | null {
  switch (value.type) {
    case 'screen.full': {
      if (!isString(value.surface_id) || !isInt(value.rev) || !isStringArray(value.rows)) return null;
      const cursor = parseCursor(value.cursor) ?? { x: 0, y: 0 };
      return {
        type: 'screen.full',
        surfaceId: value.surface_id,
        rev: value.rev,
        rows: value.rows,
        cols: isInt(value.cols) ? value.cols : 0,
        rowsCount: isInt(value.rowsCount) ? value.rowsCount : value.rows.length,
        cursor,
      };
    }
    case 'screen.diff': {
      if (!isString(value.surface_id) || !isInt(value.rev) || !Array.isArray(value.ops)) return null;
      const ops: DiffOp[] = [];
      for (const raw of value.ops) {
        const op = parseOp(raw);
        // The relay rejects unknown ops; dropping one here leaves the screen
        // stale until the next checksum resyncs it, which is the safer failure.
        if (op) ops.push(op);
      }
      return { type: 'screen.diff', surfaceId: value.surface_id, rev: value.rev, ops };
    }
    case 'screen.checksum':
      if (!isString(value.surface_id) || !isInt(value.rev) || !isString(value.hash)) return null;
      return { type: 'screen.checksum', surfaceId: value.surface_id, rev: value.rev, hash: value.hash };
    case 'event':
      if (!isString(value.category) || !isString(value.name)) return null;
      return { type: 'event', category: value.category, name: value.name, payload: value.payload ?? null };
    case 'ping':
    case 'pong':
      return { type: value.type, ts: isFiniteNumber(value.ts) ? value.ts : 0 };
    default:
      return null;
  }
}

function parseOp(value: unknown): DiffOp | null {
  if (!isObject(value)) return null;
  switch (value.op) {
    case 'row':
      return isInt(value.y) && value.y >= 0 && isString(value.text) ? { op: 'row', y: value.y, text: value.text } : null;
    case 'cursor':
      return isInt(value.x) && isInt(value.y) ? { op: 'cursor', x: value.x, y: value.y } : null;
    case 'clear':
      return { op: 'clear' };
    default:
      return null;
  }
}

function parseCursor(value: unknown): CursorPos | null {
  if (!isObject(value) || !isInt(value.x) || !isInt(value.y)) return null;
  return { x: value.x, y: value.y };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isString);
}
