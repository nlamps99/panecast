/**
 * Image attachments for the terminal input: the phone downscales and
 * re-encodes a picked image as JPEG, sends it with the relay-owned
 * `file.upload` RPC, and the relay saves it under `~/Downloads/cmux-remote/`
 * and returns the Mac path, which goes into the command draft.
 *
 * Size limits on the way (base64 inflates the bytes by 4/3):
 * - relay `RelayFileUploadService.maxBytes`: 12 MiB of decoded data;
 * - relay LAN WebSocket frames: 24 MiB; broker `MAX_WS_PAYLOAD_BYTES`: 32 MiB;
 * - the relay's tunnel to the broker (`BrokerTunnelClient`): relays that
 *   answer `relay.info` raise its `maximumMessageSize` to their frame limit;
 *   older ones keep URLSession's 1 MiB default, where a larger frame fails
 *   `receive()` and drops the whole tunnel, so for them the RPC frame must
 *   stay under 1 MiB.
 *
 * Pure helpers only; the Expo picker and encoder glue is in `attachImage.ts`.
 */

/** `RelayFileUploadService.maxBytes`. */
export const RELAY_UPLOAD_MAX_BYTES = 12 * 1024 * 1024;

/** Base64 characters per upload through the broker: 1 MiB frames minus room for the RPC and envelope JSON. */
export const BROKER_BASE64_BUDGET = 900_000;

/** Over LAN only the relay's limits apply; keep the legacy client's 6 MiB preference. */
export const LAN_BYTES_BUDGET = 6 * 1024 * 1024;

/** `file.upload` sends up to a megabyte over a phone uplink, so allow more than the default RPC timeout. */
export const UPLOAD_TIMEOUT_MS = 60_000;

/** Long side the picked image is decoded to before the encode attempts. */
export const ATTACHMENT_MAX_DIMENSION = 2048;

export type UploadTransport = 'broker' | 'lan';

export type EncodeStep = { maxDimension: number; quality: number };

/**
 * Tried in order until one fits the budget. The first three match the legacy
 * iOS client (2048 px, JPEG 0.78 / 0.68 / 0.56); the smaller sizes keep dense
 * photos under the broker budget.
 */
export const ENCODE_LADDER: readonly EncodeStep[] = [
  { maxDimension: 2048, quality: 0.78 },
  { maxDimension: 2048, quality: 0.68 },
  { maxDimension: 2048, quality: 0.56 },
  { maxDimension: 1600, quality: 0.6 },
  { maxDimension: 1280, quality: 0.6 },
  { maxDimension: 1024, quality: 0.55 },
  { maxDimension: 1024, quality: 0.4 },
];

/** What the relay reports through `relay.info`; null for relays that predate it. */
export type RelayLimits = { maxMessageBytes: number; maxUploadBytes: number };

/** Room left in a frame for the RPC and broker envelope JSON around the base64. */
const FRAME_OVERHEAD = 64 * 1024;

/**
 * Largest base64 payload worth sending, never past the relay's limit. A relay
 * that reports its limits (it accepts large frames through the broker too)
 * gets the legacy client's 6 MiB preference; an older one, through the
 * broker, stays under its 1 MiB tunnel frames.
 */
export function base64Budget(transport: UploadTransport, limits: RelayLimits | null = null, preferredBytes = LAN_BYTES_BUDGET): number {
  const uploadMax = limits ? Math.min(limits.maxUploadBytes, RELAY_UPLOAD_MAX_BYTES) : RELAY_UPLOAD_MAX_BYTES;
  const relayMax = Math.floor(uploadMax / 3) * 4;
  const preferred = Math.ceil(preferredBytes / 3) * 4;
  if (limits) return Math.max(0, Math.min(preferred, relayMax, limits.maxMessageBytes - FRAME_OVERHEAD));
  const wanted = transport === 'lan' ? preferred : BROKER_BASE64_BUDGET;
  return Math.min(wanted, relayMax);
}

/** Reads `relay.info` (`{max_message_bytes, max_upload_bytes}`); null when missing or malformed. */
export function parseRelayLimits(value: unknown): RelayLimits | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  const message = record.max_message_bytes;
  const upload = record.max_upload_bytes;
  if (typeof message !== 'number' || typeof upload !== 'number' || message <= 0 || upload <= 0) return null;
  return { maxMessageBytes: message, maxUploadBytes: upload };
}

/** The transport a channel reports (`ComputerChannel.transport`); anything else counts as the broker, the tighter one. */
export function uploadTransportOf(channel: unknown): UploadTransport {
  if (typeof channel === 'object' && channel !== null && (channel as { transport?: unknown }).transport === 'lan') {
    return 'lan';
  }
  return 'broker';
}

/** Bytes encoded by a base64 string, from its length. */
export function decodedByteLength(base64: string): number {
  const length = base64.length;
  if (length === 0) return 0;
  let padding = 0;
  if (base64.endsWith('==')) padding = 2;
  else if (base64.endsWith('=')) padding = 1;
  return Math.floor((length * 3) / 4) - padding;
}

/** `width` x `height` scaled down so the long side is at most `maxDimension`. Never scales up. */
export function fitWithin(width: number, height: number, maxDimension: number): { width: number; height: number } {
  const longSide = Math.max(width, height);
  if (longSide <= maxDimension) return { width, height };
  const scale = maxDimension / longSide;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

export type EncodeAttempt = { width: number; height: number; quality: number };

/**
 * The encode attempts for an image of this size: the ladder with each step's
 * size fitted to the image. A step that would not come out smaller than an
 * earlier one (same size, same or higher quality) is dropped, so a small
 * image skips the sizes it already fits.
 */
export function planEncodeAttempts(
  width: number,
  height: number,
  ladder: readonly EncodeStep[] = ENCODE_LADDER,
): EncodeAttempt[] {
  if (!(width > 0) || !(height > 0)) return [];
  const lowestQuality = new Map<string, number>();
  const attempts: EncodeAttempt[] = [];
  for (const step of ladder) {
    const size = fitWithin(width, height, step.maxDimension);
    const key = `${size.width}x${size.height}`;
    const lowest = lowestQuality.get(key);
    if (lowest !== undefined && step.quality >= lowest) continue;
    lowestQuality.set(key, step.quality);
    attempts.push({ ...size, quality: step.quality });
  }
  return attempts;
}

export type EncodedImage = { base64: string; width: number; height: number; quality: number };

/**
 * Runs the attempts in order and returns the first encoding within
 * `budget` base64 characters, or null if none fits. Unlike the legacy
 * client, an image that does not fit is not sent anyway: through the broker
 * that would drop the relay's tunnel.
 */
export async function encodeWithinBudget(
  attempts: readonly EncodeAttempt[],
  budget: number,
  encode: (attempt: EncodeAttempt) => Promise<string>,
): Promise<EncodedImage | null> {
  for (const attempt of attempts) {
    const base64 = await encode(attempt);
    if (base64.length > 0 && base64.length <= budget) return { base64, ...attempt };
  }
  return null;
}

/** `iphone-image-20260102-030405.jpg`, local time, like the legacy client. The relay adds its own UTC prefix. */
export function attachmentFilename(date: Date, platform: string): string {
  const prefix = platform === 'ios' ? 'iphone-image' : platform === 'android' ? 'android-image' : 'image';
  return `${prefix}-${attachmentTimestamp(date)}.jpg`;
}

/** `yyyyMMdd-HHmmss` in local time. */
export function attachmentTimestamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

/** `file.upload` params, as `RelayFileUploadService.save` reads them. */
export function uploadParams(filename: string, base64: string, mimeType = 'image/jpeg'): Record<string, unknown> {
  return { filename, mime_type: mimeType, data_base64: base64 };
}

export type UploadedFile = { filename: string; path: string; bytes: number; mimeType: string };

/** A failure whose message is already a sentence for the user. */
export class AttachmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AttachmentError';
  }
}

/** Reads `UploadedFileResult.json`: `{filename, path, bytes, mime_type}`. */
export function parseUploadResult(value: unknown): UploadedFile {
  const record = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
  const path = record && typeof record.path === 'string' ? record.path : '';
  if (!record || path.length === 0) throw new AttachmentError('电脑没有返回文件保存的位置');
  const filename =
    typeof record.filename === 'string' && record.filename.length > 0
      ? record.filename
      : (path.split('/').pop() ?? path);
  const bytes = typeof record.bytes === 'number' && Number.isFinite(record.bytes) ? record.bytes : 0;
  const mimeType = typeof record.mime_type === 'string' ? record.mime_type : 'image/jpeg';
  return { filename, path, bytes, mimeType };
}

/** Characters a shell would split on or interpret. The relay's own paths never contain them. */
const SHELL_SPECIAL = /[\s'"\\$`!&|;<>()*?[\]{}#]/;

/** The path as one shell word: unchanged when safe, otherwise single-quoted. */
export function shellQuotePath(path: string): string {
  if (path.length > 0 && !SHELL_SPECIAL.test(path)) return path;
  return `'${path.replace(/'/g, `'\\''`)}'`;
}

/**
 * Text to insert for an uploaded path, like legacy `appendPathToDraft`: a
 * space before it unless the draft is empty or already ends in whitespace,
 * and a space after it so typing can carry on.
 */
export function pathInsertion(draft: string, path: string): string {
  const separator = draft.length === 0 || /\s$/.test(draft) ? '' : ' ';
  return `${separator}${shellQuotePath(path)} `;
}

/** `850 KB`, `1.2 MB`, for the busy message. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${Math.max(0, Math.round(bytes))} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
