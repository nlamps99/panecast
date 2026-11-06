import { RpcError, TmuxBackend } from '../tmux.mjs';
import { CodexSource } from './codex.mjs';
import { localEndpoint } from './rpc.mjs';
import { targetParams } from './ids.mjs';

export class SourceRegistry {
  constructor(configs, options = {}) {
    this.sources = new Map(); this.listeners = new Set(); this.options = options;
    this.reload(configs);
  }
  onEvent(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  emit(frame) { for (const listener of this.listeners) listener(frame); }

  reload(configs) {
    if (!Array.isArray(configs)) throw new Error('sources must be an array');
    const next = new Map();
    for (const raw of configs) {
      if (!raw || typeof raw.id !== 'string' || !/^[\w-]{1,64}$/.test(raw.id) || next.has(raw.id)) throw new Error('Source IDs must be unique, using letters, digits, _ or -');
      if (!['cmux', 'tmux', 'codex'].includes(raw.type)) throw new Error('Unsupported source type');
      if (!['read', 'control'].includes(raw.access ?? 'read')) throw new Error('Source access must be read or control');
      const config = { ...raw, enabled: raw.enabled === true, access: raw.access ?? 'read', name: String(raw.name ?? raw.id).slice(0, 100) };
      if (config.type === 'cmux') {
        if (config.enabled && (!config.url || !config.token || !config.device_id)) throw new Error('cmux requires an authorized relay url, token, and device_id');
        if (config.url) localEndpoint(config.url);
      }
      if (config.type === 'codex' && !['attach', 'managed', 'history'].includes(config.mode ?? 'attach')) throw new Error('Invalid Codex mode');
      const old = this.sources.get(config.id);
      next.set(config.id, old && JSON.stringify(old.config) === JSON.stringify(config) ? old : { config, status: config.enabled ? 'unknown' : 'revoked' });
    }
    const changed = [];
    for (const [id, source] of this.sources) if (next.get(id) !== source) { source.codex?.close(); changed.push(id); }
    for (const [id, source] of next) if (this.sources.get(id) !== source && !changed.includes(id)) changed.push(id);
    this.sources = next;
    if (changed.length) this.emit({ type: 'event', category: 'source', name: 'source.changed', payload: { source_ids: changed } });
  }

  get(id) {
    const source = this.sources.get(id);
    if (!source || !source.config.enabled) throw new RpcError('source_revoked', '来源未授权或授权已撤销，请在电脑端管理连接源');
    return source;
  }

  codex(id) {
    const source = this.get(id);
    if (source.config.type !== 'codex') throw new RpcError('invalid_source', '请选择 Codex 来源');
    source.codex ??= new CodexSource(source.config, (frame) => this.emit(frame), this.options.peerFactory);
    return source.codex;
  }

  info(source) {
    const c = source.config;
    const canControl = c.enabled && c.access === 'control' && (c.type !== 'codex' || c.mode !== 'history');
    return { id: c.id, name: c.name, type: c.type, access: c.access, enabled: c.enabled, status: source.status,
      mode: c.type === 'codex' ? c.mode ?? 'attach' : 'terminal',
      capabilities: { read: c.enabled, control: canControl, terminal: c.type !== 'codex', agent: c.type === 'codex',
        realtime: c.enabled && (c.type !== 'codex' || canControl), create: canControl, resume: canControl },
      ...(source.error ? { error: source.error } : {}) };
  }

  async surface(p) {
    const { source: id, params } = targetParams(p);
    const source = this.get(id);
    if (source.config.type !== 'tmux') throw new RpcError('invalid_source', '本地通知 hook 只用于 tmux 来源');
    return new TmuxBackend({ socketName: source.config.tmux_socket }).surface(params);
  }

  close() { for (const source of this.sources.values()) source.codex?.close(); this.listeners.clear(); }
}
