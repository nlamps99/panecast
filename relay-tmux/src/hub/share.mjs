import { randomBytes } from 'node:crypto';
import { mkdir, readFile, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeJSON } from '../push.mjs';
import { SourceRegistry } from './registry.mjs';
import { HubSession } from './session.mjs';
import { localConversationSource } from './terminal-conversation.mjs';

const exec = promisify(execFile);
const KEY_PREFIX = 'pcs1.';
/** Tools the shared Claude may use. Bash runs inside Claude Code's OS sandbox. */
export const SHARE_TOOLS = 'Bash,Read,Edit,Write,Glob,Grep,NotebookEdit,WebSearch,TodoWrite,AskUserQuestion';

export const sharesDirectory = (config) => join(config.state_directory ?? join(homedir(), '.cmuxremote', 'hub'), 'shares');
export const sharesFile = (config) => join(sharesDirectory(config), 'shares.json');

/** The one string a guest pastes: where the window's computer is and the guest's own credential. */
export function encodeShareKey({ serverUrl, relayId, deviceId, token, name }) {
  return KEY_PREFIX + Buffer.from(JSON.stringify({ v: 1, s: serverUrl, r: relayId, d: deviceId, t: token, n: name })).toString('base64url');
}

export function decodeShareKey(text) {
  const value = String(text ?? '').trim();
  if (!value.startsWith(KEY_PREFIX)) return null;
  try {
    const key = JSON.parse(Buffer.from(value.slice(KEY_PREFIX.length), 'base64url').toString('utf8'));
    if (key.v !== 1 || ![key.s, key.r, key.d, key.t].every((part) => typeof part === 'string' && part)) return null;
    return { serverUrl: key.s, relayId: key.r, deviceId: key.d, token: key.t, name: typeof key.n === 'string' ? key.n : '' };
  } catch { return null; }
}

/**
 * Shared windows and the guests of each, in one owner-only file. The running
 * hub reads it for every guest request, so the CLI changes it without IPC.
 */
export class ShareStore {
  constructor(path) { this.path = path; this.cache = null; this.cachedAt = 0; }

  async read() {
    let text;
    try { text = await readFile(this.path, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    const value = JSON.parse(text);
    if (value?.version !== 1 || !Array.isArray(value.shares)) throw new Error('分享记录文件格式无效');
    return value.shares;
  }

  async write(shares) { await writeJSON(this.path, { version: 1, shares }); this.cache = null; }

  /** The share a guest connection may use, or null. Throws when the file cannot be read, which refuses the guest. */
  async guestShare(shareId, deviceId) {
    if (!this.cache || Date.now() - this.cachedAt > 2000) { this.cache = await this.read(); this.cachedAt = Date.now(); }
    return this.cache.find((share) => share.id === shareId && !share.revoked_at &&
      share.guests?.some((guest) => guest.device_id === deviceId && !guest.revoked_at)) ?? null;
  }

  async find(reference) {
    const shares = await this.read();
    const matches = shares.filter((share) => share.id === reference || share.name === reference);
    if (matches.length !== 1) throw new Error(matches.length ? '有多个同名分享，请改用分享编号' : '找不到这个分享，运行 panecast share list 查看');
    return { shares, share: matches[0] };
  }
}

/** Issues and revokes guest credentials on the broker with this computer's relay token. */
export class BrokerGuests {
  constructor(broker, fetchImpl = fetch) {
    if (!broker?.url || !broker.relay_id || !broker.relay_token) throw new Error('分享窗口需要中转服务器。请先运行 panecast setup 配置 broker。');
    const url = new URL(broker.url);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) throw new Error('中转服务器地址必须使用 HTTPS');
    Object.assign(this, { broker, fetch: fetchImpl });
  }

  async request(method, path, body) {
    const url = new URL(this.broker.url);
    url.pathname = url.pathname.replace(/\/$/, '') + path;
    url.searchParams.set('relay_id', this.broker.relay_id);
    const response = await this.fetch(url, { method, headers: { authorization: `Bearer ${this.broker.relay_token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15_000) });
    if (response.status === 404 && path === '/v1/relay/guests') throw new Error('中转服务器还不支持窗口分享，请先升级 broker');
    return response;
  }

  async create(shareId, name) {
    const response = await this.request('POST', '/v1/relay/guests', { share_id: shareId, name });
    if (response.status === 409) throw new Error('这台电脑的分享密钥已达上限，请先撤销不用的密钥');
    if (response.status === 401) throw new Error('中转服务器拒绝了这台电脑的凭据');
    if (response.status !== 201) throw new Error(`中转服务器没有发放密钥（${response.status}）`);
    const result = await response.json();
    if (typeof result.device_id !== 'string' || typeof result.token !== 'string') throw new Error('中转服务器返回的密钥无效');
    return { deviceId: result.device_id, token: result.token };
  }

  async revoke(deviceId) {
    const response = await this.request('DELETE', `/v1/relay/guests/${encodeURIComponent(deviceId)}`);
    if (response.status !== 204 && response.status !== 404) throw new Error(`中转服务器没有撤销密钥（${response.status}）`);
  }

  async list() {
    const response = await this.request('GET', '/v1/relay/guests');
    if (response.status !== 200) throw new Error(`无法读取中转服务器上的密钥（${response.status}）`);
    return (await response.json()).guests ?? [];
  }
}

/** Claude Code settings for a shared window: the OS sandbox confines Bash to the directory. */
export function shareSettings(directory, { allowDomains = [], allowRead = [] } = {}) {
  return {
    // A suggestion accepted with a key could put a ! command into the prompt.
    promptSuggestionEnabled: false,
    permissions: {
      disableBypassPermissionsMode: 'disable',
      // Files the owner's own tools may later run: git hooks, editor tasks, Claude and MCP configuration.
      deny: ['Edit(**/.git/**)', 'Edit(**/.claude/**)', 'Edit(**/.mcp.json)', 'Edit(**/.vscode/**)'],
    },
    sandbox: {
      enabled: true,
      allowUnsandboxedCommands: false,
      failIfUnavailable: true,
      filesystem: { denyRead: ['~/'], allowRead: [directory, ...allowRead] },
      network: { strictAllowlist: true, allowedDomains: allowDomains },
    },
  };
}

const quote = (value) => "'" + String(value).replace(/'/g, "'\\''") + "'";

/** The shell command cmux runs in the new terminal. `exec` leaves no shell behind when Claude exits. */
export function shareCommand(binary, settingsPath) {
  return ['exec', '/usr/bin/env', '-u', 'CLAUDECODE', '-u', 'CLAUDE_CODE_ENTRYPOINT', quote(binary),
    '--restricted', '--disable-slash-commands', '--strict-mcp-config',
    '--tools', quote(SHARE_TOOLS), '--settings', quote(settingsPath),
    '--permission-mode', 'acceptEdits', '--allowedTools=Bash'].join(' ');
}

/**
 * The directory a share may expose. It must not hold the home folder or
 * Panecast's or Claude's own state, since the guest can read all of it.
 */
export async function shareDirectory(requested, name, home = homedir()) {
  const directory = resolve(requested ?? join(home, 'Panecast-Shares', name));
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const real = await realpath(directory), realHome = await realpath(home);
  if (!(await stat(real)).isDirectory()) throw new Error('分享目录不是文件夹');
  const inside = (parent, child) => { const path = relative(parent, child); return path === '' || (!path.startsWith('..') && !isAbsolute(path)); };
  if (inside(real, realHome) || real === sep) throw new Error('分享目录不能是主目录或它的上级目录');
  for (const protectedPath of ['.ssh', '.cmuxremote', '.claude', '.config', '.aws', '.gnupg', 'Library']) {
    if (inside(join(realHome, protectedPath), real)) throw new Error('分享目录不能放在系统或凭据目录里');
  }
  return real;
}

export function validName(name) {
  const value = String(name ?? '').trim();
  if (!value || value.length > 60 || /[/\\\u0000-\u001f]/.test(value) || value.startsWith('.')) throw new Error('分享名称需要 1 到 60 个字符，不能包含斜杠或以点开头');
  return value;
}

async function claudeBinary() {
  if (process.env.PANECAST_CLAUDE_BIN) return process.env.PANECAST_CLAUDE_BIN;
  const PATH = [process.env.PATH, '/opt/homebrew/bin', '/usr/local/bin', join(homedir(), '.local/bin')].filter(Boolean).join(':');
  const { stdout } = await exec('/usr/bin/which', ['claude'], { env: { ...process.env, PATH } }).catch(() => ({ stdout: '' }));
  if (!stdout.trim()) throw new Error('找不到 claude 命令，请先安装 Claude Code');
  return stdout.trim();
}

/** Opens a visible cmux workspace in the directory and starts the confined Claude in it. */
export async function openShareWindow(config, { name, directory, settingsPath, sourceId }) {
  const registry = new SourceRegistry(config.sources ?? []);
  const session = new HubSession(registry, config, () => {}, () => {}, () => {});
  try {
    const source = sourceId ? registry.get(sourceId) : [...registry.sources.values()].find((s) => s.config.type === 'cmux' && localConversationSource(s.config.url));
    if (!source || source.config.type !== 'cmux' || !localConversationSource(source.config.url)) throw new Error('需要本机的 cmux 来源，请先打开 cmux 并运行 panecast restart');
    const client = session.client(source.config.id);
    const command = shareCommand(await claudeBinary(), settingsPath);
    const created = await client.call('workspace.create', { title: `分享 · ${name}`, cwd: directory, initial_command: command, focus: false });
    const workspaceId = created.workspace_id ?? created.workspace?.id;
    if (!workspaceId) throw new Error('cmux 没有返回新工作区');
    let surfaceId = created.surface_id;
    if (!surfaceId) surfaceId = ((await client.call('surface.list', { workspace_id: workspaceId })).surfaces ?? []).find((s) => s.type === 'terminal')?.id;
    if (!surfaceId) throw new Error('工作区已创建，但没有找到终端');
    return { sourceId: source.config.id, workspaceId, surfaceId };
  } finally { session.dispose(); registry.close(); }
}

const newId = () => `s${randomBytes(6).toString('hex')}`;
const flagValues = (args, name) => args.flatMap((arg, index) => arg === name && args[index + 1] ? [args[index + 1]] : []);
const flag = (args, name) => flagValues(args, name).at(-1);

async function issueKey(config, store, shares, share, label) {
  const guests = new BrokerGuests(config.broker);
  const issued = await guests.create(share.id, share.name);
  share.guests.push({ device_id: issued.deviceId, label, created_at: new Date().toISOString(), revoked_at: null });
  try { await store.write(shares); }
  catch (error) { await guests.revoke(issued.deviceId).catch(() => {}); throw error; }
  return encodeShareKey({ serverUrl: config.broker.url, relayId: config.broker.relay_id, deviceId: issued.deviceId, token: issued.token, name: share.name });
}

function printKey(key, label) {
  console.log(`\n${label ? `给「${label}」的` : ''}分享密钥（只显示这一次，请直接发给对方）：\n\n${key}\n`);
  console.log('对方在 Panecast 里选「添加电脑」，粘贴这个密钥即可连接这一个窗口。');
}

export async function shareCLI(args, configPath) {
  let config;
  try { config = JSON.parse(await readFile(configPath, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') throw new Error('尚未配置。请先运行 panecast setup。'); throw error; }
  const store = new ShareStore(sharesFile(config));
  const action = args[0] ?? 'list';
  if (action === 'create') {
    const name = validName(args[1]);
    const shares = await store.read();
    if (shares.some((share) => share.name === name && !share.revoked_at)) throw new Error('已有同名的分享，请换一个名称');
    // Fail before opening a window when the broker cannot issue keys.
    await new BrokerGuests(config.broker).list();
    const directory = await shareDirectory(flag(args, '--dir'), name);
    const id = newId();
    const settingsPath = join(sharesDirectory(config), id, 'claude-settings.json');
    await writeJSON(settingsPath, shareSettings(directory, { allowDomains: flagValues(args, '--allow-domain'), allowRead: flagValues(args, '--allow-read').map((path) => resolve(path)) }));
    const target = await openShareWindow(config, { name, directory, settingsPath, sourceId: flag(args, '--source') });
    const share = { id, name, directory, source_id: target.sourceId, workspace_id: target.workspaceId, surface_id: target.surfaceId,
      created_at: new Date().toISOString(), revoked_at: null, guests: [] };
    shares.push(share);
    await store.write(shares);
    console.log(`已在 cmux 打开工作区「分享 · ${name}」，目录：${directory}`);
    console.log('第一次使用时，请在这个窗口里确认「信任这个文件夹」。');
    printKey(await issueKey(config, store, shares, share, flag(args, '--guest') ?? ''), flag(args, '--guest'));
    return;
  }
  if (action === 'key') {
    const { shares, share } = await store.find(args[1]);
    if (share.revoked_at) throw new Error('这个分享已停止');
    const label = flag(args, '--guest') ?? '';
    printKey(await issueKey(config, store, shares, share, label), label);
    return;
  }
  if (action === 'list') {
    const shares = await store.read();
    if (!shares.length) { console.log('还没有分享的窗口。运行 panecast share create 名称 来创建。'); return; }
    for (const share of shares) {
      console.log(`${share.id}\t${share.name}\t${share.revoked_at ? '已停止' : '分享中'}\t${share.directory}`);
      for (const [index, guest] of share.guests.entries()) {
        console.log(`  ${index + 1}. ${guest.label || '未命名'}\t${guest.revoked_at ? '已撤销' : '有效'}\t${guest.created_at.slice(0, 16).replace('T', ' ')}`);
      }
    }
    return;
  }
  if (action === 'revoke') {
    const { shares, share } = await store.find(args[1]);
    const which = flag(args, '--guest');
    // A guest revoked here earlier but not yet removed from the broker is retried.
    const targets = share.guests.filter((guest, index) => !guest.removed_at && (!which || guest.label === which || String(index + 1) === which));
    if (which && !targets.length) throw new Error('找不到这个访客的有效密钥');
    const guests = new BrokerGuests(config.broker);
    const now = new Date().toISOString();
    // Mark locally first: the hub then refuses these guests even if the broker cannot be reached.
    for (const guest of targets) guest.revoked_at ??= now;
    if (!which) share.revoked_at ??= now;
    await store.write(shares);
    const failed = [];
    for (const guest of targets) {
      try { await guests.revoke(guest.device_id); guest.removed_at = new Date().toISOString(); } catch { failed.push(guest); }
    }
    await store.write(shares);
    console.log(which ? `已撤销「${which}」的密钥。` : `已停止分享「${share.name}」，所有密钥都已失效。cmux 里的窗口保留，可以自己关闭。`);
    if (failed.length) console.log(`有 ${failed.length} 个密钥没能在中转服务器上删除；这台电脑已经拒绝它们，网络恢复后再运行一次 revoke 即可清理。`);
    return;
  }
  throw new Error('用法：panecast share create 名称 [--dir 目录] [--guest 名字] [--allow-domain 域名] | key 分享 [--guest 名字] | list | revoke 分享 [--guest 名字或序号]');
}
