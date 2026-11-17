import { RpcError } from '../tmux.mjs';
// A namespace import: gateways older than batched input have no inputItems.
import * as relayServer from '../server.mjs';
import { HubSession } from './session.mjs';
import { scoped, scopeResult } from './ids.mjs';

/**
 * Keys a guest may send: enough to answer Claude's menus and interrupt it.
 * Nothing deletes text, so a guest cannot turn typed text into a prompt that
 * starts with a command character; Tab is left out because it can accept text
 * Claude suggests.
 */
export const GUEST_KEYS = new Set(['enter', 'escape', 'up', 'down', 'left', 'right', 'pgup', 'pgdn', 'ctrl-c']);
/** Methods a guest may call, always for the shared terminal only. */
const TARGETED = new Set(['surface.subscribe', 'surface.unsubscribe', 'surface.history', 'surface.read_text',
  'terminal.replay', 'terminal.scroll', 'terminal.conversation', 'surface.focus', 'surface.send_text', 'surface.send_key', 'surface.input', 'terminal.paste']);
// C0 and C1 controls except tab. A newline or escape sequence typed into the
// terminal could submit, or end a paste, outside the hub's checks.
const CONTROL = /[\u0000-\u0008\u000a-\u001f\u007f-\u009f]/;
// A paste keeps newlines literal; an escape could still end it early.
const PASTE_CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/;
// A prompt that starts with ! runs a shell command outside Claude's sandbox.
// The ! is refused anywhere, not only first: an open menu can swallow the
// characters before it and leave it at the start of the prompt.
const SHELL = /!/;
// The window starts Claude with slash commands disabled; refusing a leading /
// as well keeps a window started some other way from taking commands.
const COMMAND = /^\s*\//;

const forbidden = () => new RpcError('forbidden', '分享窗口只能操作被分享的这一个终端');

/** Checks what a guest types into the shared Claude. */
export function guestText(text) {
  if (typeof text !== 'string' || text.length === 0 || text.length > 32_000) throw new RpcError('invalid_params', '请输入要发送的文字');
  if (CONTROL.test(text)) throw new RpcError('guest_input', '分享窗口一次只能发送一行文字，不能包含换行或控制字符');
  if (SHELL.test(text)) throw new RpcError('guest_shell', '分享窗口不能输入半角感叹号 !，可以改用全角 ！');
  if (COMMAND.test(text)) throw new RpcError('guest_command', '分享窗口不能使用 / 开头的命令，请换一种说法');
  return text;
}

/** A pasted message: lines stay in one prompt, so newlines are allowed; the rest is checked like typed text. */
export function guestPaste(text) {
  if (typeof text !== 'string' || !text.trim() || text.length > 32_000) throw new RpcError('invalid_params', '请输入要发送的文字');
  if (PASTE_CONTROL.test(text)) throw new RpcError('guest_input', '消息里不能包含控制字符');
  if (SHELL.test(text)) throw new RpcError('guest_shell', '分享窗口不能输入半角感叹号 !，可以改用全角 ！');
  if (COMMAND.test(text)) throw new RpcError('guest_command', '分享窗口不能使用 / 开头的命令，请换一种说法');
  return text;
}

export function guestKey(key) {
  if (typeof key !== 'string' || !GUEST_KEYS.has(key)) throw new RpcError('guest_key', '分享窗口只支持回车、Esc、方向键、翻页和 Ctrl-C');
  return key;
}

/**
 * A connection that holds a guest key. It sees one source with one
 * workspace and one terminal, and receives no notifications. The share is
 * checked again on every request, so a revoke applies even before the broker
 * drops the connection; a share that cannot be read refuses everything.
 */
export class GuestSession extends HubSession {
  constructor(registry, config, send, close, notify, { shares, deviceId, shareId }) {
    super(registry, config, send, close, notify);
    Object.assign(this, { shares, deviceId, shareId, guest: true, checkedAt: Date.now() });
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
      const info = { backend: 'hub', protocol_version: 1, sources: [this.info(share)], share: { id: share.id, name: share.name, workspace_id: own.workspace_id, surface_id: own.surface_id } };
      if (p.source_id !== undefined || p.workspace_id !== undefined || p.surface_id !== undefined) {
        this.check(p, own);
        const limits = await this.client(share.source_id).call('relay.info', {});
        if (Number.isFinite(limits.max_message_bytes)) info.max_message_bytes = Math.min(32 * 1024 * 1024, limits.max_message_bytes);
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
    if (!TARGETED.has(method)) throw forbidden();
    this.check(p, own);
    if (p.workspace_id !== own.workspace_id || p.surface_id !== own.surface_id) throw forbidden();
    if (method === 'surface.send_text') return super.dispatch(method, { workspace_id: p.workspace_id, surface_id: p.surface_id, text: guestText(p.text) });
    if (method === 'surface.send_key') return super.dispatch(method, { workspace_id: p.workspace_id, surface_id: p.surface_id, key: guestKey(p.key) });
    if (method === 'surface.input') {
      // The hub sends these straight to the terminal, so every item is checked before any is sent.
      if (typeof relayServer.inputItems !== 'function') throw new RpcError('method_not_found', '统一网关不支持这个操作');
      const items = relayServer.inputItems(p).map((item) => item.text !== undefined ? { text: guestText(item.text) } : { key: guestKey(item.key) });
      return super.dispatch(method, { workspace_id: p.workspace_id, surface_id: p.surface_id, items });
    }
    if (method === 'terminal.paste') {
      if (p.submit_key !== 'return') throw new RpcError('invalid_params', '消息或目标无效');
      return super.dispatch(method, { workspace_id: p.workspace_id, surface_id: p.surface_id, text: guestPaste(p.text), submit_key: 'return' });
    }
    return super.dispatch(method, p);
  }

  check(p, own) {
    if (p.source_id !== undefined && p.source_id !== own.source) throw forbidden();
    if (p.window_id !== undefined && p.window_id !== own.window_id) throw forbidden();
    if (p.pane_id !== undefined) throw forbidden();
    if (p.workspace_id !== undefined && p.workspace_id !== own.workspace_id) throw forbidden();
    if (p.surface_id !== undefined && p.surface_id !== own.surface_id) throw forbidden();
  }
}
