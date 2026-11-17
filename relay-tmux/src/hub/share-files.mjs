import { constants, createReadStream } from 'node:fs';
import { chmod, lstat, mkdir, open, readdir, realpath, rename, stat, unlink } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { createHash } from 'node:crypto';
import { basename, extname, isAbsolute, join, relative, sep } from 'node:path';

import { RpcError } from '../tmux.mjs';

/**
 * Files of a shared window, for its guests. A guest gets a short-lived
 * download link instead of the bytes: the gateway uploads the file once to the
 * file relay the broker names, and the guest's own apps open the link.
 *
 * Whatever is in the shared directory may have been written by a guest's
 * Claude, which can create links there. Every read therefore resolves the
 * path, opens it without following a final link, and checks that the opened
 * file is still the one inside the directory.
 */
export const MAX_LINK_BYTES = 50 * 1024 * 1024;
export const MAX_UPLOAD_BYTES = 12 * 1024 * 1024;
const SKIP = new Set(['node_modules', '__pycache__']);

const TYPES = {
  pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', heic: 'image/heic',
  svg: 'image/svg+xml', html: 'text/html', htm: 'text/html', zip: 'application/zip',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  doc: 'application/msword', xls: 'application/vnd.ms-excel', ppt: 'application/vnd.ms-powerpoint',
};
const TEXT = new Set(['txt', 'md', 'markdown', 'tex', 'bib', 'csv', 'tsv', 'json', 'yaml', 'yml', 'toml', 'xml', 'log', 'ini', 'cfg',
  'py', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'sh', 'r', 'm', 'c', 'h', 'cpp', 'hpp', 'java', 'go', 'rs', 'rb', 'swift', 'kt', 'sql', 'css']);

export function mimeFor(name) {
  const extension = extname(String(name)).slice(1).toLowerCase();
  return TYPES[extension] ?? (TEXT.has(extension) ? 'text/plain' : 'application/octet-stream');
}

const outside = () => new RpcError('forbidden', '只能打开分享目录里的文件');

/** Files under `root`, newest first. Hidden entries, links and tool folders are left out. */
export async function listShareFiles(root, { limit = 300, scan = 5000, depth = 8 } = {}) {
  const base = await realpath(root).catch(() => { throw new RpcError('not_found', '分享目录不存在'); });
  const files = [];
  const queue = [{ directory: base, path: '', level: 0 }];
  let scanned = 0, truncated = false;
  while (queue.length && !truncated) {
    const { directory, path, level } = queue.shift();
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (++scanned > scan) { truncated = true; break; }
      if (entry.name.startsWith('.') || SKIP.has(entry.name)) continue;
      const child = path ? `${path}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (level < depth) queue.push({ directory: join(directory, entry.name), path: child, level: level + 1 }); else truncated = true;
        continue;
      }
      if (!entry.isFile()) continue;
      const info = await lstat(join(directory, entry.name)).catch(() => null);
      if (info?.isFile()) files.push({ path: child, name: entry.name, size: info.size, mtime_ms: Math.floor(info.mtimeMs) });
    }
  }
  files.sort((a, b) => b.mtime_ms - a.mtime_ms || a.path.localeCompare(b.path));
  return { files: files.slice(0, limit), truncated: truncated || files.length > limit };
}

/** Opens a regular file inside `root`. `path` is relative to it, or absolute as Claude reports it. */
export async function openInside(root, path) {
  if (typeof path !== 'string' || !path || path.length > 4096 || path.includes('\0')) throw new RpcError('invalid_params', '文件路径无效');
  const base = await realpath(root).catch(() => { throw new RpcError('not_found', '分享目录不存在'); });
  let file;
  try { file = await realpath(isAbsolute(path) ? path : join(base, path)); } catch { throw new RpcError('not_found', '找不到这个文件，可能已被移动或删除'); }
  const rel = relative(base, file);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw outside();
  if (rel.split(sep).some((part) => part.startsWith('.'))) throw outside();
  let handle;
  // Non-blocking, so a FIFO placed in the directory cannot stall the gateway.
  try { handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { throw error.code === 'ELOOP' ? outside() : new RpcError('not_found', '找不到这个文件，可能已被移动或删除'); }
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new RpcError('invalid_params', '只能打开普通文件');
    // A file hard-linked into the directory could be any file of this user.
    if (info.nlink > 1) throw outside();
    // A parent swapped for a link between the checks and the open shows up here.
    const again = await realpath(file).catch(() => null);
    const named = again === file ? await stat(file).catch(() => null) : null;
    if (!named || named.ino !== info.ino || named.dev !== info.dev) throw new RpcError('file_changed', '文件正在变化，请稍后再试');
    return { handle, info, path: rel.split(sep).join('/'), name: basename(file) };
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}

async function readAll(handle, size) {
  const data = Buffer.alloc(size + 1);
  let offset = 0;
  while (offset < data.length) {
    const { bytesRead } = await handle.read(data, offset, data.length - offset, offset);
    if (!bytesRead) break;
    offset += bytesRead;
  }
  if (offset !== size) throw new RpcError('file_changed', '文件正在变化，请稍后再试');
  return data.subarray(0, size);
}

const secureURL = (value) => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname));
  } catch { return false; }
};

/** Download links for files of a shared directory, issued through the broker. */
export class ShareFileLinks {
  constructor(broker, { fetch: fetchImpl = fetch, now = Date.now, maxBytes = MAX_LINK_BYTES } = {}) {
    Object.assign(this, { broker, fetch: fetchImpl, now, maxBytes, cache: new Map(), pending: new Map() });
  }

  async link(root, path) {
    const opened = await openInside(root, path);
    const { info } = opened;
    let closeHere = true;
    try {
      if (info.size > this.maxBytes) throw new RpcError('too_large', `文件超过 ${Math.round(this.maxBytes / 1024 / 1024)} MB，请让分享者用别的方式发给你`);
      const key = [root, opened.path, info.size, info.mtimeMs, info.ino].join('\0');
      const cached = this.cache.get(key);
      // A link that is still valid for a while is reused: the file has not changed.
      if (cached && Date.parse(cached.expires_at) - this.now() > 10 * 60_000) return cached;
      if (this.pending.has(key)) return await this.pending.get(key);
      closeHere = false;
      const read = readAll(opened.handle, info.size).finally(() => opened.handle.close().catch(() => {}));
      const published = read.then((data) => this.publish(data, opened.name, opened.path)).then((result) => {
        this.cache.set(key, result);
        while (this.cache.size > 200) this.cache.delete(this.cache.keys().next().value);
        return result;
      }).finally(() => this.pending.delete(key));
      this.pending.set(key, published);
      return await published;
    } finally {
      if (closeHere) await opened.handle.close().catch(() => {});
    }
  }

  async publish(data, name, path) {
    const sha256 = createHash('sha256').update(data).digest('hex');
    const type = mimeFor(name);
    const url = new URL(this.broker.url);
    url.pathname = url.pathname.replace(/\/$/, '') + '/v1/relay/files';
    url.searchParams.set('relay_id', this.broker.relay_id);
    let response;
    try {
      response = await this.fetch(url, { method: 'POST', headers: { authorization: `Bearer ${this.broker.relay_token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ name, type, size: data.length, sha256 }), signal: AbortSignal.timeout(15_000) });
    } catch { throw new RpcError('file_link_failed', '连不上中转服务器，请稍后再试'); }
    if (response.status === 404) throw new RpcError('file_links_unavailable', '中转服务器还不支持发送文件，请分享者升级');
    if (response.status === 413) throw new RpcError('too_large', '文件太大，中转服务器不接收');
    if (response.status === 429) throw new RpcError('busy', '请求文件太频繁，请稍后再试');
    if (response.status !== 201) throw new RpcError('file_link_failed', `中转服务器没有发放下载链接（${response.status}）`);
    const ticket = await response.json().catch(() => null);
    if (!ticket || !secureURL(ticket.upload_url) || !secureURL(ticket.download_url) || typeof ticket.expires_at !== 'string') {
      throw new RpcError('file_link_failed', '中转服务器返回的链接无效');
    }
    let upload;
    try {
      upload = await this.fetch(ticket.upload_url, { method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body: data, signal: AbortSignal.timeout(300_000) });
    } catch { throw new RpcError('file_link_failed', '文件没能传到中转服务器，请稍后再试'); }
    if (upload.status !== 201 && upload.status !== 409) throw new RpcError('file_link_failed', `文件中转服务器没有接收文件（${upload.status}）`);
    return { url: ticket.download_url, name, path, size: data.length, type, expires_at: ticket.expires_at };
  }
}

/** A file name a guest's upload may take: no folders, no hidden names, no `!` the input filter would refuse later. */
export function uploadName(value) {
  // eslint-disable-next-line no-control-regex
  const base = String(value ?? '').split(/[\\/]/).pop().replace(/[\u0000-\u001f\u007f-\u009f]/g, '').replace(/!/g, '！').replace(/^[.\s]+/, '').trim();
  return (base || '附件').slice(-120);
}

/**
 * Claims a new name in the shared directory, numbered past existing ones, and
 * opens it for writing. The directory itself is not a subfolder Claude could
 * swap; O_EXCL refuses an existing name or link.
 */
async function reserve(root, filename) {
  const base = await realpath(root).catch(() => { throw new RpcError('not_found', '分享目录不存在'); });
  const name = uploadName(filename);
  const extension = extname(name);
  const stem = name.slice(0, name.length - extension.length) || '附件';
  for (let n = 1; n <= 99; n++) {
    const candidate = n === 1 ? name : `${stem} (${n})${extension}`;
    const path = join(base, candidate);
    try { return { path, filename: candidate, handle: await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644) }; }
    catch (error) { if (error.code === 'EEXIST' || error.code === 'ELOOP') continue; throw new RpcError('upload_failed', '文件没能保存到分享目录'); }
  }
  throw new RpcError('upload_failed', '分享目录里同名文件太多，请改个文件名');
}

/** Saves a guest's upload directly in the shared directory, never replacing a file. */
export async function saveUpload(root, filename, data) {
  const { path, filename: name, handle } = await reserve(root, filename);
  try { await handle.writeFile(data); } finally { await handle.close(); }
  return { path, filename: name };
}

const UPLOAD_ID = /^[A-Za-z0-9_-]{8,64}$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
/** One chunk's base64, well under the 32 MiB frame. */
const MAX_CHUNK_BASE64 = 24 * 1024 * 1024;
/** Part files nobody finished: removed when a later upload starts. */
const STALE_PART_MS = 24 * 3600 * 1000;

/**
 * One chunk of a guest's upload of any size (`upload_id`, `offset`, `done`,
 * as in `src/upload.mjs`). Chunks collect in `parts`, the gateway's own
 * folder for the share, so Claude never sees or swaps a half-written file;
 * the last chunk moves the file into the shared directory under a new name.
 * Returns `{upload_id, received}` until then, `{path, filename, size}` after.
 */
export async function saveUploadChunk(parts, root, p) {
  if (typeof p.upload_id !== 'string' || !UPLOAD_ID.test(p.upload_id) || !Number.isSafeInteger(p.offset) || p.offset < 0) throw new RpcError('invalid_params', '上传参数无效');
  if (typeof p.data_base64 !== 'string' || p.data_base64.length > MAX_CHUNK_BASE64 || !BASE64.test(p.data_base64)) throw new RpcError('upload_failed', '文件数据无效');
  const data = Buffer.from(p.data_base64, 'base64');
  await mkdir(parts, { recursive: true, mode: 0o700 });
  const part = join(parts, `${p.upload_id}.part`);
  if (p.offset === 0) await sweepParts(parts);
  else {
    const size = await stat(part).then((info) => info.size, () => null);
    if (size === null) throw new RpcError('upload_failed', '上传已中断，请重新上传');
    if (size !== p.offset) {
      const error = new RpcError('upload_failed', '上传进度不一致，请重新上传');
      error.data = { received: size };
      throw error;
    }
  }
  const writer = await open(part, p.offset === 0 ? 'w' : 'a', 0o600);
  try { await writer.write(data); } finally { await writer.close(); }
  const received = p.offset + data.length;
  if (p.done !== true) return { upload_id: p.upload_id, received };
  // The mode is set while the file is still in the gateway's folder: a chmod
  // of the shared path could follow a link Claude put there.
  await chmod(part, 0o644);
  const { path, filename, handle } = await reserve(root, p.filename);
  try {
    // A rename replaces the claimed name, never a link's target.
    try { await rename(part, path); }
    catch (error) {
      if (error.code !== 'EXDEV') throw new RpcError('upload_failed', '文件没能保存到分享目录');
      // The shared directory is on another disk: copy into the claimed file.
      await pipeline(createReadStream(part), handle.createWriteStream({ autoClose: false }));
      await unlink(part).catch(() => {});
    }
  } finally { await handle.close(); }
  return { path, filename, size: received };
}

async function sweepParts(parts) {
  const now = Date.now();
  for (const entry of await readdir(parts).catch(() => [])) {
    const path = join(parts, entry);
    const info = await stat(path).catch(() => null);
    if (info && now - info.mtimeMs > STALE_PART_MS) await unlink(path).catch(() => {});
  }
}
