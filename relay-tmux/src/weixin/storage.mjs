import { open, mkdir, readFile, rename, unlink, lstat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { weixinOrigin } from './api.mjs';

export const weixinDirectory = config => join(config.state_directory ?? join(homedir(), '.cmuxremote', 'hub'), 'weixin');
export const accountPath = directory => join(directory, 'account.json');
export const statePath = (directory, account) => join(directory, `state-${createHash('sha256').update(account.botId + ':' + account.ownerId).digest('hex').slice(0, 20)}.json`);
export async function readPrivate(path) {
  try {
    const info = await lstat(path);
    if (!info.isFile() || (typeof process.getuid === 'function' && info.uid !== process.getuid()) || (info.mode & 0o077)) throw new Error('微信状态文件权限不正确，应仅允许当前用户读写');
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) { if (error.code === 'ENOENT') return null; throw new Error('微信状态无法读取；原文件已保留，请检查文件格式和权限'); }
}
export async function savePrivate(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, 'wx', 0o600);
  try { await file.writeFile(JSON.stringify(value) + '\n'); await file.sync(); } finally { await file.close(); }
  try {
    await rename(temporary, path);
    const directory = await open(dirname(path), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  } finally { await unlink(temporary).catch(() => {}); }
}
export async function readAccount(directory) {
  const account = await readPrivate(accountPath(directory));
  if (!account || account.enabled === false) return null;
  if (account.version !== 1 || ![account.botId, account.ownerId, account.token, account.epoch].every(v => typeof v === 'string' && v.length > 0 && v.length < 8192)) throw new Error('微信绑定记录无效，请重新绑定');
  account.origin = weixinOrigin(account.origin);
  return account;
}

/** Serialize whole-state writes; advance memory only after atomic persistence. */
export class WeixinState {
  constructor(path) { this.path = path; this.queue = Promise.resolve(); this.value = { version: 1, cursor: '', context: '', inbox: [], outbox: [], seen: [], delivered: [], target: null, baseline: null, eventCursor: null, notice: null }; }
  async load() {
    const data = await readPrivate(this.path);
    if (data) {
      if (data.version !== 1 || !['inbox', 'outbox', 'seen', 'delivered'].every(k => Array.isArray(data[k]))) throw new Error('微信收发记录损坏；已停止处理，原文件已保留');
      this.value = data;
    }
    await this.change(state => {
      let interrupted = 0;
      state.inbox = state.inbox.filter(entry => {
        if (entry.status !== 'processing') return true;
        interrupted++; state.seen.push(entry.id); return false;
      });
      for (const entry of state.outbox) if (entry.status === 'sending') { entry.status = 'unknown'; interrupted++; }
      if (interrupted) state.notice = '上次有操作或回复未确认，已停止自动重试。请用 /read 查看终端，再决定是否重新发送。';
    });
  }
  change(update) {
    const task = this.queue.then(async () => { const next = structuredClone(this.value); update(next); next.seen = next.seen.slice(-10000); next.delivered = next.delivered.slice(-2000); await savePrivate(this.path, next); this.value = next; });
    // A failed write is fatal: later mutations must not jump past it.
    this.queue = task; return task;
  }
}

/** One poller per account directory, including across separate hub processes. */
export async function acquireLock(directory, name = 'runtime') {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `${name}.lock`), owner = { pid: process.pid, id: randomUUID() };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const file = await open(path, 'wx', 0o600);
      try { await file.writeFile(JSON.stringify(owner)); } finally { await file.close(); }
      return async () => { const current = await readPrivate(path); if (current?.id === owner.id) await unlink(path); };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const existing = await readPrivate(path);
      if (!Number.isSafeInteger(existing?.pid) || existing.pid < 1) throw new Error('微信进程锁无效，请检查后台进程');
      try { process.kill(existing.pid, 0); } catch (failure) {
        if (failure.code === 'ESRCH') { await unlink(path); continue; }
      }
      throw new Error('微信通道已在另一个进程运行');
    }
  }
  throw new Error('无法取得微信进程锁');
}
