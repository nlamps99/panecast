import { join } from 'node:path';
import { RpcError } from '../tmux.mjs';
// A namespace import: gateways older than batched input have no inputItems.
import * as relayServer from '../server.mjs';
import { UPLOAD_CHUNK_BYTES } from '../upload.mjs';
import { HubSession } from './session.mjs';
import { scoped, scopeResult } from './ids.mjs';
import { sharesDirectory } from './share.mjs';
import { listShareFiles, MAX_UPLOAD_BYTES, mimeFor, saveUpload, saveUploadChunk } from './share-files.mjs';

/** Methods a guest may call, always for the shared terminal only. */
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
const forbidden = () => new RpcError('forbidden', '分享窗口只能操作被分享的这一个终端');

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
 * workspace and one terminal, and receives no notifications. The share is
 * checked again on every request, so a revoke applies even before the broker
 * drops the connection; a share that cannot be read refuses everything.
 */
export class GuestSession extends HubSession {
  constructor(registry, config, send, close, notify, { shares, deviceId, shareId, fileLinks = null }) {
    super(registry, config, send, close, notify);
    Object.assign(this, { shares, deviceId, shareId, fileLinks, guest: true, checkedAt: Date.now() });
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

  target(share) {
    return { source: share.source_id, workspace_id: scoped(share.source_id, share.workspace_id), surface_id: scoped(share.source_id, share.surface_id),
      window_id: scoped(share.source_id, 'default') };
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
        files: { list: true, links: Boolean(this.fileLinks), upload: true }, ...(share.full === true ? { full: true } : {}) } };
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
    // `shared`: takes input, but the guest cannot create, rename or close anything.
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
      return { surfaces: surfaces.filter((surface) => surface.id === share.surface_id).map((surface) => scopeResult(share.source_id, surface, true)) };
    }
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
    if (method === 'file.upload') {
      this.check(p, own);
      if (p.workspace_id !== own.workspace_id || p.surface_id !== own.surface_id) throw forbidden();
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
    if (p.workspace_id !== own.workspace_id || p.surface_id !== own.surface_id) throw forbidden();
    // A full-access share runs Claude without a sandbox: input goes to the one terminal as typed.
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
    if (p.surface_id !== undefined && p.surface_id !== own.surface_id) throw forbidden();
  }
}
