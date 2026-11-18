import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { RpcError } from '../tmux.mjs';
// A namespace import: gateways older than batched input have no inputItems.
import * as relayServer from '../server.mjs';
import { UPLOAD_CHUNK_BYTES } from '../upload.mjs';
import { HubSession } from './session.mjs';
import { scoped, scopeResult } from './ids.mjs';
import { SHARE_MAX_TERMINALS, sharesDirectory, shareTerminalCommand, shareTerminals } from './share.mjs';
import { listShareFiles, MAX_UPLOAD_BYTES, mimeFor, saveUpload, saveUploadChunk } from './share-files.mjs';

/**
 * Adding and closing a share's terminals, one change at a time per share
 * across every guest connection, so two guests cannot pass the limit or
 * close the last two terminals together.
 */
const terminalChanges = new Map();
function oneAtATime(shareId, work) {
  const run = (terminalChanges.get(shareId) ?? Promise.resolve()).then(work);
  const settled = run.then(() => {}, () => {});
  terminalChanges.set(shareId, settled);
  void settled.then(() => { if (terminalChanges.get(shareId) === settled) terminalChanges.delete(shareId); });
  return run;
}

/** Methods a guest may call, always for one of the share's terminals. */
const TARGETED = new Set(['surface.subscribe', 'surface.unsubscribe', 'surface.history', 'surface.read_text',
  'terminal.replay', 'terminal.scroll', 'terminal.conversation', 'surface.focus', 'surface.send_text', 'surface.send_key', 'surface.input', 'terminal.paste']);
/*
 * A guest types and edits freely: every key and slash is allowed except the
 * few below. What stays out is what reaches past the window, checked on
 * Claude Code 2.1.326:
 * - A half-width ! typed into an empty prompt, or a paste that starts with
 *   one, switches Claude to shell mode, which runs commands OUTSIDE its
 *   sandbox. Typed text cannot know whether the prompt is empty (an open menu
 *   takes the characters before it, and the digit 1 picks an option), so a
 *   typed ! becomes a full-width ！. A paste arrives whole: only a leading !
 *   is changed. Text edited into starting with ! stays an ordinary prompt.
 * - Slash commands are off in the window's Claude (--disable-slash-commands),
 *   so a leading / is plain text.
 */
// C0 and C1 controls except tab, newline and return: an escape could encode
// any key (Ctrl-G as a CSI u sequence) or end a paste early.
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;
const BANG = /!/g;
/**
 * Keys that act outside the shared window, whatever other modifiers come with
 * them. Ctrl-Y (and Alt-Y) puts deleted text back as if typed: a deleted
 * `!ls` yanked into an empty prompt starts shell mode.
 */
const CTRL_REFUSED = {
  g: 'Ctrl-G 会在沙箱外用编辑器打开输入框',
  v: 'Ctrl-V 会读取这台电脑的剪贴板',
  z: 'Ctrl-Z 会挂起 Claude，窗口会卡住',
  r: 'Ctrl-R 会搜索这台电脑上所有项目的输入历史',
  y: 'Ctrl-Y 会把删掉的文字当作输入放回，可能进入 shell 模式',
};
const ALT_REFUSED = { y: CTRL_REFUSED.y };
/*
 * Deleting is safe only where the window's Claude refuses a prompt that
 * starts with ! (PROMPT_HOOK in share.mjs): otherwise a guest could edit a
 * prompt into `!ls`, send it as text and recall it from history in shell
 * mode. Windows opened before the hook keep the keys that cannot delete.
 */
const KEEPS_TEXT = new Set(['enter', 'escape', 'up', 'down', 'left', 'right', 'home', 'end', 'pgup', 'pgdn', 'tab', 'f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8', 'f9', 'f10', 'f11', 'f12']);
const KEEPS_TEXT_CTRL = new Set(['c', 'a', 'e', 'b', 'f', 'p', 'n', 'l', 'o', 't', 's', 'x']);
const MODIFIER = /^(ctrl|control|alt|option|opt|shift|cmd|command|meta|super)-(?=.)/;
const SYSTEM_MODIFIERS = new Set(['cmd', 'command', 'meta', 'super']);
const forbidden = () => new RpcError('forbidden', '分享窗口只能操作被分享的工作区里的终端');

/** What a guest types: any text without control characters; a ! is typed as ！ (see above). */
export function guestText(text) {
  if (typeof text !== 'string' || text.length === 0 || text.length > 32_000) throw new RpcError('invalid_params', '请输入要发送的文字');
  if (CONTROL.test(text)) throw new RpcError('guest_input', '消息里不能包含控制字符');
  return text.replace(BANG, '！');
}

/** A pasted message, kept as it is except a leading ! (see above). */
export function guestPaste(text) {
  if (typeof text !== 'string' || !text.trim() || text.length > 32_000) throw new RpcError('invalid_params', '请输入要发送的文字');
  if (CONTROL.test(text)) throw new RpcError('guest_input', '消息里不能包含控制字符');
  return text.replace(/^(\s*)!/, '$1！');
}

/**
 * Any key except a !, ⌘ shortcuts (they belong to the terminal app on this
 * computer) and the Ctrl keys above. `editing` is false for a window opened
 * before the prompt hook: only keys that keep the typed text then.
 */
export function guestKey(key, { editing = true } = {}) {
  if (typeof key !== 'string' || !key || key.length > 64 || CONTROL.test(key)) throw new RpcError('guest_key', '无效按键');
  const modifiers = new Set();
  let rest = key.toLowerCase();
  for (let match = MODIFIER.exec(rest); match; match = MODIFIER.exec(rest)) {
    modifiers.add(match[1]);
    rest = rest.slice(match[0].length);
  }
  if ([...modifiers].some((name) => SYSTEM_MODIFIERS.has(name))) throw new RpcError('guest_key', '分享窗口不能用 ⌘ 快捷键：它们由这台电脑上的终端处理');
  if (rest === '!' || (rest === '1' && modifiers.has('shift'))) throw new RpcError('guest_key', '半角 ! 会让 Claude 进入 shell 模式，请直接输入文字');
  const ctrl = modifiers.has('ctrl') || modifiers.has('control');
  if (ctrl && CTRL_REFUSED[rest]) throw new RpcError('guest_key', `分享窗口不能用这个组合键：${CTRL_REFUSED[rest]}`);
  if (modifiers.has('alt') && ALT_REFUSED[rest]) throw new RpcError('guest_key', `分享窗口不能用这个组合键：${ALT_REFUSED[rest]}`);
  if (!editing) {
    const keeps = modifiers.has('alt') ? false : ctrl ? KEEPS_TEXT_CTRL.has(rest) : KEEPS_TEXT.has(rest);
    if (!keeps) throw new RpcError('guest_key', '这个分享窗口是旧版创建的，退格、删除等编辑键要等电脑上运行 panecast share reopen 重新打开窗口后才能用');
  }
  return key;
}

/** A line typed and submitted with Enter, which a paste delivers whole, keeping a ! inside it. */
const submittedLine = (items) => items.length === 2 && typeof items[0].text === 'string' && items[0].text.includes('!') && items[1].key === 'enter';

/**
 * A connection that holds a guest key. It sees one source with one
 * workspace and the share's terminals in it, and receives no notifications.
 * The guest may add terminals running the same Claude, up to
 * SHARE_MAX_TERMINALS, and close them while another remains. Terminals the
 * owner opens in that workspace stay out of reach. The share is checked
 * again on every request, so a revoke applies even before the broker drops
 * the connection; a share that cannot be read refuses everything.
 */
export class GuestSession extends HubSession {
  constructor(registry, config, send, close, notify, { shares, deviceId, shareId, fileLinks = null, tasks = null }) {
    super(registry, config, send, close, notify);
    Object.assign(this, { shares, deviceId, shareId, fileLinks, tasks, guest: true, checkedAt: Date.now() });
    void this.current().catch(() => {});
  }

  async current() {
    let share = null;
    try { share = await this.shares.guestShare(this.shareId, this.deviceId); } catch { /* Unreadable store: refuse. */ }
    if (!share) { this.close(); throw new RpcError('share_revoked', '这个分享已失效，请向分享者要新的密钥'); }
    return share;
  }

  tick() {
    super.tick();
    if (Date.now() - this.checkedAt < 5000) return;
    this.checkedAt = Date.now();
    void this.current().catch(() => {});
  }

  /** What the guest may address. `surfaces` maps each terminal's id as the guest sees it to cmux's. */
  target(share) {
    return { source: share.source_id, workspace_id: scoped(share.source_id, share.workspace_id), surface_id: scoped(share.source_id, share.surface_id),
      window_id: scoped(share.source_id, 'default'), surfaces: new Map(shareTerminals(share).map((terminal) => [scoped(share.source_id, terminal.surface_id), terminal.surface_id])) };
  }

  /** The share's terminals still open in cmux. */
  async liveTerminals(share) {
    const { surfaces = [] } = await this.client(share.source_id).call('surface.list', { workspace_id: share.workspace_id });
    const open = new Set(surfaces.map((surface) => surface.id));
    return shareTerminals(share).filter((terminal) => open.has(terminal.surface_id));
  }

  /** A new terminal in the shared workspace, running the same Claude as the first one with its own session. */
  addTerminal(p, own) {
    if (p.workspace_id !== own.workspace_id || (p.type !== undefined && p.type !== 'terminal')) throw forbidden();
    return oneAtATime(this.shareId, async () => {
      // Read again: another guest may have changed the terminals meanwhile.
      const share = await this.current();
      if (this.target(share).workspace_id !== own.workspace_id) throw forbidden();
      const live = await this.liveTerminals(share);
      if (live.length >= SHARE_MAX_TERMINALS) throw new RpcError('share_terminal_limit', `分享窗口最多 ${SHARE_MAX_TERMINALS} 个终端，请先关掉不用的`);
      const sessionId = randomUUID();
      let command;
      try { command = await shareTerminalCommand(this.config, share, sessionId); }
      catch (error) { throw new RpcError('share_terminal_failed', error.message); }
      const client = this.client(share.source_id);
      // Never focus: that would switch what the owner sees in cmux.
      const created = await client.call('surface.create', { workspace_id: share.workspace_id, type: 'terminal', cwd: share.directory, initial_command: command, focus: false });
      const surfaceId = created?.surface_id ?? created?.id;
      if (typeof surfaceId !== 'string' || !surfaceId) throw new RpcError('share_terminal_failed', '电脑没有返回新终端');
      try {
        await this.shares.update(share.id, (entry) => {
          if (entry.workspace_id !== share.workspace_id) throw new Error('the share moved to another workspace');
          // Terminals closed in cmux meanwhile leave the record too.
          const open = new Set(live.map((terminal) => terminal.surface_id));
          entry.terminals = [...shareTerminals(entry).filter((terminal) => open.has(terminal.surface_id)),
            { surface_id: surfaceId, session_id: sessionId, created_at: new Date().toISOString() }];
        });
      } catch {
        // A terminal the share does not list would be the owner's: close it rather than leave it.
        await client.call('surface.close', { workspace_id: share.workspace_id, surface_id: surfaceId }).catch(() => {});
        throw new RpcError('share_terminal_failed', '新终端没能加入分享，已经关掉');
      }
      return { workspace_id: own.workspace_id, surface_id: scoped(share.source_id, surfaceId), type: 'terminal' };
    });
  }

  /** Closes one of the share's terminals; the last one stays. */
  closeTerminal(p, own) {
    if (p.workspace_id !== own.workspace_id || !own.surfaces.has(p.surface_id)) throw forbidden();
    return oneAtATime(this.shareId, async () => {
      const share = await this.current();
      const mine = this.target(share);
      const surfaceId = mine.surfaces.get(p.surface_id);
      if (mine.workspace_id !== own.workspace_id || !surfaceId) throw forbidden();
      const live = await this.liveTerminals(share);
      if (live.some((terminal) => terminal.surface_id === surfaceId)) {
        if (live.length <= 1) throw new RpcError('share_last_terminal', '分享窗口至少要留一个终端，最后一个不能关');
        await this.client(share.source_id).call('surface.close', { workspace_id: share.workspace_id, surface_id: surfaceId });
      }
      await this.shares.update(share.id, (entry) => {
        if (entry.workspace_id !== share.workspace_id) return;
        const open = new Set(live.map((terminal) => terminal.surface_id));
        const rest = shareTerminals(entry).filter((terminal) => terminal.surface_id !== surfaceId && open.has(terminal.surface_id));
        entry.terminals = rest;
        // The first window's fields follow a terminal that is still open, for gateways that read only those.
        if (entry.surface_id === surfaceId && rest[0]) Object.assign(entry, { surface_id: rest[0].surface_id, session_id: rest[0].session_id });
      }).catch(() => { /* Closed in cmux; a stale entry is dropped on the next change. */ });
      return {};
    });
  }

  info(share, status) {
    const source = this.registry.get(share.source_id);
    return { ...this.registry.info(source), name: share.name, status: status ?? source.status, capabilities: { read: true, control: true, terminal: true, agent: false, realtime: true, create: false, resume: false } };
  }

  async findWorkspace(share) {
    const client = this.client(share.source_id);
    let windows = [];
    try { windows = (await client.call('window.list', {})).windows ?? []; } catch { /* cmux without windows */ }
    for (const window of windows.length ? windows : [{ id: null }]) {
      const { workspaces = [] } = await client.call('workspace.list', window.id ? { window_id: window.id } : {});
      const found = workspaces.find((workspace) => workspace.id === share.workspace_id);
      if (found) return found;
    }
    return null;
  }

  async dispatch(method, p) {
    if (!p || typeof p !== 'object' || Array.isArray(p)) throw new RpcError('invalid_params', '无效请求');
    const share = await this.current();
    const own = this.target(share);
    if (method === 'relay.info') {
      const info = { backend: 'hub', protocol_version: 1, sources: [this.info(share)], share: { id: share.id, name: share.name, workspace_id: own.workspace_id, surface_id: own.surface_id,
        max_terminals: SHARE_MAX_TERMINALS, files: { list: true, links: Boolean(this.fileLinks), upload: true }, ...(share.full === true ? { full: true } : {}), ...(share.network === 'open' ? { network: 'open' } : {}),
        ...(share.tasks === true && this.tasks ? { tasks: true } : {}) } };
      if (p.source_id !== undefined || p.workspace_id !== undefined || p.surface_id !== undefined) {
        this.check(p, own);
        const limits = await this.client(share.source_id).call('relay.info', {});
        if (Number.isFinite(limits.max_message_bytes)) {
          info.max_message_bytes = Math.min(32 * 1024 * 1024, limits.max_message_bytes);
          info.max_upload_bytes = MAX_UPLOAD_BYTES;
          info.upload_chunk_bytes = UPLOAD_CHUNK_BYTES;
        }
      }
      return info;
    }
    if (method === 'source.list' || method === 'relay.diagnostics') {
      let status = 'online';
      try { await this.client(share.source_id).call('workspace.list', {}); } catch { status = 'offline'; }
      const sources = [this.info(share, status)];
      return method === 'source.list' ? { sources } : { backend: 'hub', backend_ready: status === 'online', sources };
    }
    if (method === 'relay.snippets') return { snippets: [] };
    if (method === 'host.battery') return { available: false };
    // `shared`: takes input and may add or close the share's terminals, but not create, rename or close workspaces.
    if (method === 'window.list') return { windows: [{ id: own.window_id, ref: share.name, title: share.name, source_id: share.source_id, access: 'shared', index: 0, key: true }] };
    if (method === 'workspace.list') {
      if (p.source_id !== undefined && p.source_id !== share.source_id) throw forbidden();
      if (p.window_id !== undefined && p.window_id !== own.window_id) throw forbidden();
      const found = await this.findWorkspace(share);
      const workspaces = found ? [{ ...scopeResult(share.source_id, found, true), source_id: share.source_id, access: 'shared' }] : [];
      return { workspaces, window_id: own.window_id };
    }
    if (method === 'surface.list') {
      this.check(p, own);
      if (p.workspace_id !== own.workspace_id) throw forbidden();
      const { surfaces = [] } = await this.client(share.source_id).call('surface.list', { workspace_id: share.workspace_id });
      const mine = new Set(own.surfaces.values());
      return { surfaces: surfaces.filter((surface) => mine.has(surface.id)).map((surface) => scopeResult(share.source_id, surface, true)) };
    }
    if (method === 'surface.create') { this.check(p, own); return this.addTerminal(p, own); }
    if (method === 'surface.close') { this.check(p, own); return this.closeTerminal(p, own); }
    // Each entry goes back through this dispatch, so each is checked on its own.
    if (method === 'terminal.conversation.batch') {
      if (typeof this.conversationBatch !== 'function') throw new RpcError('method_not_found', '统一网关不支持这个操作');
      return this.conversationBatch(p);
    }
    // Files of the shared directory only. A guest's own apps open the files from a download link.
    if (method === 'share.files.list') return listShareFiles(share.directory);
    if (method === 'share.file.link') {
      if (!this.fileLinks) throw new RpcError('file_links_unavailable', '这台电脑没有配置中转服务器，不能发送文件');
      return this.fileLinks.link(share.directory, p.path);
    }
    // A share created with --tasks takes tasks for its first terminal (share-tasks.mjs).
    if (method.startsWith('task.')) {
      if (share.tasks !== true || !this.tasks) throw new RpcError('tasks_disabled', '这个分享没有开启任务接口');
      if (method === 'task.submit') return { task: await this.tasks.submit(share, p) };
      if (typeof p.task_id !== 'string' && method !== 'task.list') throw new RpcError('invalid_params', '缺少任务编号');
      if (method === 'task.get') return { task: await this.tasks.get(share, p.task_id, p.wait_s) };
      if (method === 'task.cancel') return { task: await this.tasks.cancel(share, p.task_id) };
      if (method === 'task.list') return { tasks: await this.tasks.list(share, p.limit) };
      throw forbidden();
    }
    if (method === 'file.upload') {
      this.check(p, own);
      if (p.workspace_id !== own.workspace_id || !own.surfaces.has(p.surface_id)) throw forbidden();
      // Any size, in chunks that collect in the gateway's own folder for this share.
      if (p.upload_id !== undefined) {
        const saved = await saveUploadChunk(this.uploadParts(share), share.directory, p);
        if (!saved.filename) return saved;
        return { path: `./${saved.filename}`, filename: saved.filename, size: saved.size, bytes: saved.size, mime_type: mimeFor(saved.filename) };
      }
      if (typeof p.data_base64 !== 'string' || p.data_base64.length > Math.ceil(MAX_UPLOAD_BYTES / 3) * 4 || !/^[\w+/]*={0,2}$/.test(p.data_base64)) {
        throw new RpcError('upload_failed', `文件超过 ${MAX_UPLOAD_BYTES / 1024 / 1024} MB 或格式无效`);
      }
      const data = Buffer.from(p.data_base64, 'base64');
      const saved = await saveUpload(share.directory, p.filename, data);
      // Relative to the shared folder, where Claude runs: a message starting with an absolute path would read as a / command.
      return { path: `./${saved.filename}`, filename: saved.filename, size: data.length, bytes: data.length, mime_type: mimeFor(saved.filename) };
    }
    if (!TARGETED.has(method)) throw forbidden();
    this.check(p, own);
    if (p.workspace_id !== own.workspace_id || !own.surfaces.has(p.surface_id)) throw forbidden();
    // A full-access share runs Claude without a sandbox: input goes to its terminals as typed.
    if (share.full === true) return super.dispatch(method, p);
    if (method === 'surface.send_text') return super.dispatch(method, { workspace_id: p.workspace_id, surface_id: p.surface_id, text: guestText(p.text) });
    const editing = share.prompt_hook === true;
    if (method === 'surface.send_key') return super.dispatch(method, { workspace_id: p.workspace_id, surface_id: p.surface_id, key: guestKey(p.key, { editing }) });
    if (method === 'surface.input') {
      // The hub sends these straight to the terminal, so every item is checked before any is sent.
      if (typeof relayServer.inputItems !== 'function') throw new RpcError('method_not_found', '统一网关不支持这个操作');
      const items = relayServer.inputItems(p);
      // A whole line keeps its ! when the terminal can take it as one paste.
      if (submittedLine(items) && await this.pastes(share)) {
        return super.dispatch('terminal.paste', { workspace_id: p.workspace_id, surface_id: p.surface_id, text: guestPaste(items[0].text), submit_key: 'return' });
      }
      const checked = items.map((item) => item.text !== undefined ? { text: guestText(item.text) } : { key: guestKey(item.key, { editing }) });
      return super.dispatch(method, { workspace_id: p.workspace_id, surface_id: p.surface_id, items: checked });
    }
    if (method === 'terminal.paste') {
      if (p.submit_key !== 'return') throw new RpcError('invalid_params', '消息或目标无效');
      return super.dispatch(method, { workspace_id: p.workspace_id, surface_id: p.surface_id, text: guestPaste(p.text), submit_key: 'return' });
    }
    return super.dispatch(method, p);
  }

  /** Part files of unfinished uploads: the gateway's folder for the share, never the shared directory. */
  uploadParts(share) {
    if (!/^[\w-]{1,80}$/.test(share.id)) throw new RpcError('upload_failed', '分享编号无效');
    return join(sharesDirectory(this.config), share.id, 'uploads');
  }

  /** Whether the shared terminal takes `terminal.paste`, asked once per connection. */
  pastes(share) {
    this.pasteCapability ??= this.client(share.source_id).call('system.capabilities', {})
      .then((result) => (result.methods ?? []).includes('terminal.paste'), () => false);
    return this.pasteCapability;
  }

  check(p, own) {
    if (p.source_id !== undefined && p.source_id !== own.source) throw forbidden();
    if (p.window_id !== undefined && p.window_id !== own.window_id) throw forbidden();
    if (p.pane_id !== undefined) throw forbidden();
    if (p.workspace_id !== undefined && p.workspace_id !== own.workspace_id) throw forbidden();
    if (p.surface_id !== undefined && !own.surfaces.has(p.surface_id)) throw forbidden();
  }
}
