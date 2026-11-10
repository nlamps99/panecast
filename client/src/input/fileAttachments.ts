import type { RpcChannel, SurfaceTarget } from '../session/terminalSession';
import { RpcCallError } from '../protocol/connection';
import { AttachmentError, base64Budget, decodedByteLength, formatBytes, parseRelayLimits, parseUploadResult,
  RELAY_UPLOAD_MAX_BYTES, UPLOAD_TIMEOUT_MS, uploadParams, uploadTransportOf, type EncodedImage, type UploadedFile } from './attachments';

/** A file explicitly selected, dropped or pasted by the user. No filesystem paths. */
export type AttachmentFile = {
  name: string; mimeType: string; size: number;
  readBase64(): Promise<string>;
  compressImage?(budget: number): Promise<EncodedImage | null>;
};

export async function uploadAttachments(channel: RpcChannel, target: SurfaceTarget, files: readonly AttachmentFile[], callbacks: {
  progress(label: string): void;
  uploaded(file: UploadedFile): Promise<void>;
  current(): boolean;
}): Promise<number> {
  // Freeze routing before any file read or RPC. Switching views must never send
  // an attachment or its path to the newly selected terminal.
  const destination = { workspace_id: target.workspaceId, surface_id: target.surfaceId };
  const limits = parseRelayLimits(await channel.call('relay.info', destination, 5_000).catch(error => {
    // Only a missing legacy capability uses the older relay's smaller limit.
    if (error instanceof RpcCallError && ['method_not_found', '-32601'].includes(error.code)) return null;
    throw error;
  }));
  const budget = base64Budget(uploadTransportOf(channel), limits, RELAY_UPLOAD_MAX_BYTES);
  const byteLimit = Math.floor(budget / 4) * 3;
  let count = 0;
  for (const file of files) {
    if (!callbacks.current()) break;
    let filename = file.name || 'attachment', mimeType = file.mimeType || 'application/octet-stream', base64: string;
    if (file.size > byteLimit) {
      if (!file.compressImage) throw new AttachmentError(`“${filename}”超过当前连接的 ${formatBytes(byteLimit)} 文件上限`);
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
    callbacks.progress(`正在上传 ${count + 1}/${files.length}：${filename}（${formatBytes(decodedByteLength(base64))}）…`);
    const result = parseUploadResult(await channel.call('file.upload', { ...uploadParams(filename, base64, mimeType), ...destination }, UPLOAD_TIMEOUT_MS));
    await callbacks.uploaded(result);
    count++;
  }
  return count;
}
