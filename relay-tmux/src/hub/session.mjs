import { RelaySession } from '../server.mjs';
import { RpcError, TmuxBackend } from '../tmux.mjs';
import { RpcPeer, localEndpoint } from './rpc.mjs';
import { scopeResult, scoped, targetParams } from './ids.mjs';
import { TerminalConversationReader, localConversationSource } from './terminal-conversation.mjs';

const READS = new Set(['window.list', 'workspace.list', 'surface.list', 'surface.subscribe', 'surface.unsubscribe', 'surface.history', 'surface.read_text', 'terminal.replay', 'terminal.conversation', 'project.list', 'project.read', 'project.diff', 'relay.diagnostics', 'host.battery']);
const WRITES = new Set(['workspace.create', 'workspace.rename', 'workspace.close', 'workspace.select', 'surface.create', 'surface.close', 'surface.focus', 'surface.send_key', 'surface.send_text', 'terminal.scroll', 'notification.create']);

/** A phone keeps one authenticated connection while sources keep independent transports. */
export class HubSession extends RelaySession {
  constructor(registry, config, send, close, notify) {
    super(registry, config, send, close, notify);
    this.registry = registry; this.clients = new Map(); this.savedSubscriptions = new Map(); this.restoreNeeded = new Set(); this.restoring = new Set(); this.retryAt = new Map();
    this.unlisten = registry.onEvent((frame) => {
      if (frame.name === 'source.changed') {
        for (const id of frame.payload.source_ids) { this.clients.get(id)?.close(); this.clients.delete(id); this.savedSubscriptions.delete(id); this.restoreNeeded.delete(id); }
      }
      // The hub publishes registry events once and journals them independently
      // of phone sessions; this listener only invalidates local transports.
    });
  }

  dispose() { this.unlisten?.(); for (const client of this.clients.values()) client.close(); this.clients.clear(); super.dispose(); }
  tick() {
    for (const client of this.clients.values()) client.tick?.();
    for (const [id, subscriptions] of this.savedSubscriptions) {
      if (subscriptions.size && (this.clients.get(id)?.closed || this.restoreNeeded.has(id)) && !this.restoring.has(id) && Date.now() >= (this.retryAt.get(id) ?? 0)) void this.restore(id);
    }
  }

  async restore(id) {
    this.restoring.add(id);
    try {
      const client = this.client(id);
      for (const params of this.savedSubscriptions.get(id)?.values() ?? []) await client.call('surface.subscribe', params);
      this.restoreNeeded.delete(id); this.retryAt.delete(id);
      if (!this.disposed) this.send({ type: 'event', category: 'source', name: 'source.reconnected', payload: { source_id: id } });
    } catch { this.retryAt.set(id, Date.now() + 3000); }
    finally { this.restoring.delete(id); }
  }

  client(id) {
    const source = this.registry.get(id), c = source.config;
    let client = this.clients.get(id);
    if (client?.closed) { client.close(); this.clients.delete(id); client = null; if (this.savedSubscriptions.get(id)?.size) this.restoreNeeded.add(id); }
    if (client) return client;
    if (c.type === 'tmux') {
      const backend = new TmuxBackend({ socketName: c.tmux_socket });
      const session = new RelaySession(backend, this.config, (frame) => this.forward(id, frame), () => {}, (payload) => this.notify(scopeResult(id, payload, true)));
      void session.process(JSON.stringify({ protocolVersion: 1, deviceId: 'hub' }));
      client = { call: (method, params) => session.dispatch(method, params), tick: () => session.tick(), close: () => session.dispose() };
    } else if (c.type === 'cmux') {
      client = new RpcPeer({ url: localEndpoint(c.url), token: c.token, protocols: ['cmuxremote.v1'],
        hello: { protocolVersion: 1, appVersion: 'panecast-hub/0.1', deviceId: c.device_id } });
      client.onMessage((frame) => this.forward(id, frame));
    } else throw new RpcError('invalid_source', 'Codex 会话请从连接源页面打开');
    this.clients.set(id, client); return client;
  }

  forward(id, frame) {
    if (this.disposed || !this.hello || !this.registry.sources.has(id)) return;
    if (frame.method === 'panecast/disconnected') {
      this.send({ type: 'event', category: 'source', name: 'source.disconnected', payload: { source_id: id } });
      return;
    }
    if (frame.type?.startsWith('screen.') || frame.type === 'event') {
      if (frame.type === 'event' && this.config.hub_event_monitor) return;
      const scopedFrame = scopeResult(id, frame);
      if (frame.type === 'event' && frame.payload?.id) scopedFrame.payload.id = scoped(id, frame.payload.id);
      this.send(scopedFrame);
    }
  }

  async sources() {
    return { sources: await Promise.all([...this.registry.sources.values()].map(async (source) => {
      try {
        if (source.config.type === 'codex') await (await this.registry.codex(source.config.id).connection()).call('thread/loaded/list');
        else await this.client(source.config.id).call('workspace.list', {});
        source.status = 'online'; delete source.error;
      } catch {
        source.status = 'offline'; source.error = source.config.type === 'codex'
          ? '未连接到 Codex 服务，请检查 Codex 是否已安装或桌面桥接是否启动' : '无法连接，请检查终端是否在运行';
      }
      return this.registry.info(source);
    })) };
  }

  async dispatch(method, p) {
    if (!p || typeof p !== 'object' || Array.isArray(p)) throw new RpcError('invalid_params', '无效请求');
    if (method === 'source.list') return this.sources();
    if (method === 'relay.info') {
      const info = { backend: 'hub', protocol_version: 1, sources: [...this.registry.sources.values()].map((s) => this.registry.info(s)) };
      const { source } = targetParams(p);
      if (!source) return info;
      const entry = this.registry.get(source);
      if (!['cmux', 'tmux'].includes(entry.config.type)) return info;
      const limits = await this.client(source).call('relay.info', {});
      if (Number.isFinite(limits.max_message_bytes) && Number.isFinite(limits.max_upload_bytes)) {
        info.max_message_bytes = Math.min(32 * 1024 * 1024, limits.max_message_bytes);
        info.max_upload_bytes = limits.max_upload_bytes;
      }
      return info;
    }
    if (method === 'relay.snippets') return { snippets: this.config.snippets ?? [] };
    if (method === 'relay.diagnostics') { const result = await this.sources(); return { backend: 'hub', backend_ready: result.sources.some((s) => s.status === 'online'), ...result }; }
    if (method === 'host.battery') return { available: false };
    if (method === 'file.upload') {
      const { source, params } = targetParams(p);
      if (!source) throw new RpcError('invalid_target', '上传前请选择终端来源');
      const entry = this.registry.get(source);
      if (entry.config.type === 'cmux') return this.client(source).call(method, params);
      if (entry.config.type !== 'tmux') throw new RpcError('invalid_source', '请从终端发送附件');
      await this.registry.surface(p);
      return super.dispatch(method, p);
    }
    if (method.startsWith('agent.')) {
      const source = this.registry.get(p.source_id);
      if (source.config.type !== 'codex') throw new RpcError('invalid_source', '请选择 Codex 来源');
      return this.registry.codex(p.source_id).dispatch(method, p);
    }
    if (!READS.has(method) && !WRITES.has(method)) throw new RpcError('method_not_found', '统一网关不支持这个操作');
    if (method === 'window.list') {
      const lists = await Promise.all(this.terminals().map(async (source) => {
        const c = source.config;
        try {
          const result = await this.client(c.id).call('window.list', {});
          const windows = result.windows ?? [];
          if (!windows.length) return [{ id: scoped(c.id, 'default'), ref: c.name, source_id: c.id, access: c.access, key: false }];
          return windows.map((w) => ({ ...scopeResult(c.id, w, true), ref: `${c.name}${windows.length > 1 ? ` · ${w.ref ?? w.index + 1}` : ''}`, source_id: c.id, access: c.access, key: false }));
        } catch {
          try { await this.client(c.id).call('workspace.list', {}); return [{ id: scoped(c.id, 'default'), ref: c.name, source_id: c.id, access: c.access }]; } catch { return []; }
        }
      }));
      return { windows: lists.flat().map((w, index) => ({ ...w, index, key: index === 0 })) };
    }
    let { source: id, params } = targetParams(p);
    if (!id) {
      if (method === 'workspace.list') {
        const lists = await Promise.all(this.terminals().map(async (source) => {
          try { const result = await this.client(source.config.id).call(method, {}); return scopeResult(source.config.id, result).workspaces ?? []; } catch { return []; }
        }));
        return { workspaces: lists.flat() };
      }
      const sources = this.terminals();
      if (method === 'workspace.create' && sources.length === 1) id = sources[0].config.id;
      else throw new RpcError('invalid_target', '请先选择连接源');
    }
    const source = this.registry.get(id);
    if (method === 'terminal.conversation') {
      if (source.config.type !== 'cmux' || !localConversationSource(source.config.url)) return { available: false, provider: 'terminal', conversation_id: null, items: [], next_cursor: null };
      if (!params.workspace_id || !params.surface_id) throw new RpcError('invalid_target', '请选择当前终端');
      let info;
      try { info = await this.client(id).call('surface.resume.get', { workspace_id: params.workspace_id, surface_id: params.surface_id }); }
      catch (error) {
        if (['method_not_found', 'not_supported', '-32601'].includes(String(error.code))) return { available: false, provider: 'terminal', conversation_id: null, items: [], next_cursor: null };
        throw error;
      }
      source.conversationReader ??= new TerminalConversationReader({ codexHome: source.config.codex_home, claudeHome: source.config.claude_home });
      try { return await source.conversationReader.read(info.resume_binding, params); }
      catch (error) { if (error instanceof RpcError) throw error; throw new RpcError('conversation_unavailable', '对话记录暂时不可用，请稍后重试'); }
    }
    if ((method === 'terminal.replay' || method === 'terminal.scroll') && source.config.type !== 'cmux') throw new RpcError('method_not_found', '这个终端来源不支持应用内滚动');
    if (params.window_id === 'default') delete params.window_id;
    if (method === 'surface.unsubscribe') this.savedSubscriptions.get(id)?.delete(params.surface_id);
    const result = scopeResult(id, await this.client(id).call(method, params));
    if (source.config.type === 'cmux' && method === 'surface.subscribe') {
      if (!this.savedSubscriptions.has(id)) this.savedSubscriptions.set(id, new Map());
      this.savedSubscriptions.get(id).set(params.surface_id, params);
    }
    if (method === 'workspace.list') {
      result.window_id = p.window_id ?? (result.window_id || scoped(id, 'default'));
      result.workspaces = (result.workspaces ?? []).map((w) => ({ ...w, source_id: id, access: source.config.access }));
    }
    return result;
  }

  terminals() { return [...this.registry.sources.values()].filter((s) => s.config.type !== 'codex'); }
}
