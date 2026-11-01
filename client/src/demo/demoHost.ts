import { RpcCallError } from '../protocol/connection';
import { DEMO_HOME } from './demoText';

/**
 * The relay-owned methods (`host.battery`, `file.upload`) for the demo, with
 * the result shapes of `relay/Sources/RelayServer/HostServices.swift`.
 */

/** Where demo uploads pretend to land. The relay itself writes to `~/Downloads/cmux-remote/`. */
export const DEMO_UPLOAD_DIR = `${DEMO_HOME}/Downloads/panecast`;

/** Same cap as `RelayFileUploadService.maxBytes`. */
export const MAX_UPLOAD_BYTES = 12 * 1024 * 1024;

/** A MacBook on battery that drains one percent every three minutes, never below 20 %. */
export function batterySnapshot(startedAt: number, now: number) {
  const minutes = Math.max(0, (now - startedAt) / 60_000);
  return {
    available: true,
    percent: Math.max(20, 76 - Math.floor(minutes / 3)),
    state: 'discharging',
    is_charging: false,
    power_source: 'Battery Power',
  };
}

/**
 * Validates `file.upload` params like the relay and returns its result shape.
 * The data is measured, never kept.
 */
export function uploadResult(params: Record<string, unknown>, now: number) {
  const filename = params.filename;
  const mimeType = params.mime_type ?? params.mimeType;
  const data = params.data_base64 ?? params.dataBase64;
  if (typeof filename !== 'string' || typeof mimeType !== 'string' || typeof data !== 'string') {
    throw new RpcCallError('upload_failed', '上传失败：缺少 filename、mime_type 或 data_base64');
  }
  const bytes = base64ByteLength(data);
  if (bytes === null) throw new RpcCallError('upload_failed', '上传失败：data_base64 不是有效的 base64');
  if (bytes > MAX_UPLOAD_BYTES) throw new RpcCallError('upload_failed', '上传失败：文件超过 12 MB');
  const name = uploadFilename(filename, mimeType, now);
  return { filename: name, path: `${DEMO_UPLOAD_DIR}/${name}`, bytes, mime_type: mimeType };
}

/** Decoded size of strict base64 (what Foundation's `Data(base64Encoded:)` accepts), or null. */
export function base64ByteLength(data: string): number | null {
  if (data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) return null;
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  return (data.length / 4) * 3 - padding;
}

/** `RelayFileUploadService.uniqueFilename`: UTC timestamp, sanitized base name, extension from the MIME type. */
export function uploadFilename(requested: string, mimeType: string, now: number): string {
  const last = requested.split('/').filter(Boolean).pop() ?? '';
  // Like CharacterSet.alphanumerics plus "-_.": letters and digits of any script stay.
  const safe = Array.from(last)
    .map((char) => (/[A-Za-z0-9._-]/.test(char) || char.charCodeAt(0) > 0x7f ? char : '-'))
    .join('');
  const ext = extensionFor(mimeType);
  const base = safe === '' ? `iphone-image.${ext}` : /\.[^.]+$/.test(safe) ? safe : `${safe}.${ext}`;
  return `${utcStamp(now)}-${base}`;
}

function extensionFor(mimeType: string): string {
  switch (mimeType.toLowerCase()) {
    case 'image/png':
      return 'png';
    case 'image/heic':
    case 'image/heif':
      return 'heic';
    default:
      return 'jpg';
  }
}

function utcStamp(at: number): string {
  const d = new Date(at);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}
