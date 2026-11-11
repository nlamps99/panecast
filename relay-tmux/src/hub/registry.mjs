import { RpcError, TmuxBackend } from '../tmux.mjs';
import { CodexSource } from './codex.mjs';
import { localEndpoint } from './rpc.mjs';
import { targetParams } from './ids.mjs';

export const usableCmux = (source) => source.type === 'cmux' &&
  [source.url, source.token, source.device_id].every((value) => typeof value === 'string' && value && !value.startsWith('REPLACE_'));

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
      // Older configs carry a cmux placeholder that discovery fills in later.
      if (raw.type === 'cmux' && !usableCmux(raw)) continue;
      // Every configured source has full access; removing it from the config is how it is turned off.
      const config = { ...raw, enabled: true, access: 'control', name: String(raw.name ?? raw.id).slice(0, 100) };
      if (config.type === 'cmux') localEndpoint(config.url);
      if (config.type === 'codex') {
        if (!['attach', 'managed', 'history'].includes(config.mode ?? 'attach')) throw new Error('Invalid Codex mode');
        if (config.mode === 'history') config.mode = 'managed';
      }
      const old = this.sources.get(config.id);
      next.set(config.id, old && JSON.stringify(old.config) === JSON.stringify(config) ? old : { config, status: 'unknown' });
    }
    const changed = [];
    for (const [id, source] of this.sources) if (next.get(id) !== source) { source.codex?.close(); changed.push(id); }
    for (const [id, source] of next) if (this.sources.get(id) !== source && !changed.includes(id)) changed.push(id);
    this.sources = next;
    if (changed.length) this.emit({ type: 'event', category: 'source', name: 'source.changed', payload: { source_ids: changed } });
  }

  get(id) {
    const source = this.sources.get(id);
    if (!source) throw new RpcError('source_revoked', '来源不存在或已从电脑端配置中移除');
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
    return { id: c.id, name: c.name, type: c.type, access: c.access, enabled: c.enabled, status: source.status,
      mode: c.type === 'codex' ? c.mode ?? 'attach' : 'terminal',
      capabilities: { read: true, control: true, terminal: c.type !== 'codex', agent: c.type === 'codex',
        realtime: true, create: true, resume: true },
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
