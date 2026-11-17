import { randomBytes } from 'node:crypto';
import { mkdir, open, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { RpcError } from './tmux.mjs';

/**
 * `file.upload`, saved under the upload directory with a unique name.
 *
 * Files of any size arrive in chunks: each call carries `upload_id`, the byte
 * `offset` it starts at and `done` on the last one. The chunks append to a
 * hidden part file named after the id, so a chunk needs no memory of earlier
 * calls and a wrong offset is refused instead of corrupting the file. The
 * last chunk renames the part file into place. A call without `upload_id` is
 * the original single-message upload.
 */
export const UPLOAD_CHUNK_BYTES = 4 * 1024 * 1024;
/** One message, single or chunk: well under the 32 MiB frame. */
const MAX_MESSAGE_BASE64 = 24 * 1024 * 1024;
const ID = /^[A-Za-z0-9_-]{8,64}$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const PART = /^\.panecast-upload-[A-Za-z0-9_-]+\.part$/;
/** Part files nobody finished: removed when a later upload starts. */
const STALE_MS = 24 * 3600 * 1000;

const decode = (value) => {
  if (typeof value !== 'string' || value.length > MAX_MESSAGE_BASE64 || !BASE64.test(value)) throw new RpcError('upload_failed', '文件数据无效');
  return Buffer.from(value, 'base64');
};
const finalName = (filename) => `${Date.now()}-${randomBytes(4).toString('hex')}-${String(filename ?? 'file').replace(/[^\p{L}\p{N}._-]/gu, '_').slice(-120)}`;
const result = (directory, name, bytes, mimeType) => ({ path: join(directory, name), filename: name, size: bytes, bytes, mime_type: mimeType ?? 'application/octet-stream' });

export async function saveUpload(directory, p) {
  await mkdir(directory, { recursive: true });
  if (p.upload_id === undefined) {
    const data = decode(p.data_base64), name = finalName(p.filename ?? 'image.png');
    await writeFile(join(directory, name), data, { mode: 0o600 });
    return result(directory, name, data.length, p.mime_type ?? 'image/png');
  }
  if (typeof p.upload_id !== 'string' || !ID.test(p.upload_id) || !Number.isSafeInteger(p.offset) || p.offset < 0) throw new RpcError('invalid_params', '上传参数无效');
  const data = decode(p.data_base64), part = join(directory, `.panecast-upload-${p.upload_id}.part`);
  if (p.offset === 0) await sweep(directory);
  else {
    const size = await stat(part).then((info) => info.size, () => null);
    if (size === null) throw new RpcError('upload_failed', '上传已中断，请重新上传');
    if (size !== p.offset) {
      const error = new RpcError('upload_failed', '上传进度不一致，请重新上传');
      error.data = { received: size };
      throw error;
    }
  }
  const handle = await open(part, p.offset === 0 ? 'w' : 'a', 0o600);
  try { await handle.write(data); } finally { await handle.close(); }
  const received = p.offset + data.length;
  if (p.done !== true) return { upload_id: p.upload_id, received };
  const name = finalName(p.filename);
  await rename(part, join(directory, name));
  return result(directory, name, received, p.mime_type);
}

async function sweep(directory) {
  const now = Date.now();
  for (const entry of await readdir(directory).catch(() => [])) {
    if (!PART.test(entry)) continue;
    const path = join(directory, entry);
    const info = await stat(path).catch(() => null);
    if (info && now - info.mtimeMs > STALE_MS) await unlink(path).catch(() => {});
  }
}
