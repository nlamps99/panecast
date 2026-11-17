import type { RpcChannel, SurfaceTarget } from '../session/terminalSession';
import { RpcCallError } from '../protocol/connection';
import { AttachmentError, base64Budget, chunkBytesFor, decodedByteLength, formatBytes, parseRelayLimits, parseUploadResult,
  RELAY_UPLOAD_MAX_BYTES, UPLOAD_TIMEOUT_MS, uploadParams, uploadTransportOf, type EncodedImage, type UploadedFile } from './attachments';

/** A file explicitly selected, dropped or pasted by the user. No filesystem paths. */
export type AttachmentFile = {
  name: string; mimeType: string; size: number;
  readBase64(): Promise<string>;
  /** Bytes `start` to `end` (exclusive) as base64, for chunked uploads of any size. */
  readChunk?(start: number, end: number): Promise<string>;
  compressImage?(budget: number): Promise<EncodedImage | null>;
};

/** Chunk ids name the part file on the computer: letters, digits, `-` and `_`. */
export function uploadId(random: (bytes: Uint8Array) => Uint8Array = defaultRandom): string {
  return `up-${Array.from(random(new Uint8Array(12)), byte => byte.toString(16).padStart(2, '0')).join('')}`;
}

function defaultRandom(bytes: Uint8Array): Uint8Array {
  if (typeof globalThis.crypto?.getRandomValues === 'function') {
    globalThis.crypto.getRandomValues(bytes as Uint8Array<ArrayBuffer>);
    return bytes;
  }
  for (let index = 0; index < bytes.length; index++) bytes[index] = Math.floor(Math.random() * 256);
  return bytes;
}

const percent = (done: number, total: number) => (total > 0 ? Math.floor((done / total) * 100) : 100);

type Callbacks = { progress(label: string): void; uploaded(file: UploadedFile): Promise<void>; current(): boolean };

export async function uploadAttachments(channel: RpcChannel, target: SurfaceTarget, files: readonly AttachmentFile[], callbacks: Callbacks): Promise<number> {
  // Freeze routing before any file read or RPC. Switching views must never send
  // an attachment or its path to the newly selected terminal.
  const destination = { workspace_id: target.workspaceId, surface_id: target.surfaceId };
  const limits = parseRelayLimits(await channel.call('relay.info', destination, 5_000).catch(error => {
    // Only a missing legacy capability uses the older relay's smaller limit.
    if (error instanceof RpcCallError && ['method_not_found', '-32601'].includes(error.code)) return null;
    throw error;
  }));
  const chunkBytes = limits ? chunkBytesFor(limits) : null;
  const budget = base64Budget(uploadTransportOf(channel), limits, RELAY_UPLOAD_MAX_BYTES);
  const byteLimit = Math.floor(budget / 4) * 3;
  let count = 0;
  for (const file of files) {
    if (!callbacks.current()) break;
    const position = `${count + 1}/${files.length}`;
    if (chunkBytes && file.readChunk) {
      // Any size: the original bytes, a chunk at a time, never compressed.
      const result = await uploadInChunks(channel, destination, file, file.readChunk.bind(file), chunkBytes, position, callbacks);
      if (!result) break;
      await callbacks.uploaded(result);
      count++;
      continue;
    }
    let filename = file.name || 'attachment', mimeType = file.mimeType || 'application/octet-stream', base64: string;
    if (file.size > byteLimit) {
      if (!file.compressImage) throw new AttachmentError(`“${filename}”超过这台电脑的 ${formatBytes(byteLimit)} 文件上限，更新电脑上的 Panecast 后没有大小限制`);
      callbacks.progress(`正在压缩图片：${filename}…`);
      const image = await file.compressImage(budget);
      if (!image) throw new AttachmentError(`“${filename}”压缩后仍超过当前连接的文件上限`);
      base64 = image.base64; mimeType = 'image/jpeg'; filename = filename.replace(/\.[^.]*$/, '') + '.jpg';
    } else {
      callbacks.progress(`正在读取：${filename}…`);
      base64 = await file.readBase64();
    }
    if (base64.length > budget) throw new AttachmentError(`“${filename}”超过当前连接的文件上限`);
    if (!callbacks.current()) break;
    callbacks.progress(`正在上传 ${position}：${filename}（${formatBytes(decodedByteLength(base64))}）…`);
    const result = parseUploadResult(await channel.call('file.upload', { ...uploadParams(filename, base64, mimeType), ...destination }, UPLOAD_TIMEOUT_MS));
    await callbacks.uploaded(result);
    count++;
  }
  return count;
}

/** One file as chunked `file.upload` calls, in order; null when the user moved on. */
async function uploadInChunks(channel: RpcChannel, destination: Record<string, string>, file: AttachmentFile,
  readChunk: (start: number, end: number) => Promise<string>, chunkBytes: number, position: string, callbacks: Callbacks): Promise<UploadedFile | null> {
  const filename = file.name || 'attachment', mimeType = file.mimeType || 'application/octet-stream', id = uploadId();
  const total = Math.max(0, file.size);
  for (let offset = 0; ;) {
    if (!callbacks.current()) return null;
    const end = Math.min(total, offset + chunkBytes), done = end >= total;
    callbacks.progress(`正在上传 ${position}：${filename}（${total > chunkBytes ? `${percent(offset, total)}%，` : ''}${formatBytes(total)}）…`);
    const data = await readChunk(offset, end);
    if (decodedByteLength(data) !== end - offset) throw new AttachmentError(`无法完整读取“${filename}”，文件可能在上传时被修改`);
    const result = await channel.call('file.upload', { ...destination, upload_id: id, offset, data_base64: data, done,
      ...(done ? { filename, mime_type: mimeType } : {}) }, UPLOAD_TIMEOUT_MS);
    if (done) return parseUploadResult(result);
    offset = end;
  }
}
