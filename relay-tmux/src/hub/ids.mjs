import { RpcError } from '../tmux.mjs';

export function scoped(source, id) {
  return `${source}~${Buffer.from(String(id)).toString('base64url')}`;
}

export function unscoped(value) {
  if (typeof value !== 'string' || value.length > 4096) throw new RpcError('invalid_target', '请选择一个连接源');
  const match = /^([\w-]{1,64})~([\w-]+)$/.exec(value);
  if (!match) throw new RpcError('invalid_target', '无效的连接源或会话');
  const id = Buffer.from(match[2], 'base64url').toString();
  if (scoped(match[1], id) !== value) throw new RpcError('invalid_target', '无效的会话编码');
  return { source: match[1], id };
}

const targets = new Set(['workspace_id', 'surface_id', 'window_id', 'pane_id']);
const objects = new Set(['workspaces', 'surfaces', 'windows', 'workspace', 'surface', 'window']);

/**
 * A copy of `value` with its native target IDs scoped to `source`. Every
 * forwarded screen frame passes through here, so it copies in plain loops:
 * no entry arrays per object, no call per row of text.
 */
export function scopeResult(source, value, objectId = false) {
  if (Array.isArray(value)) {
    const copy = new Array(value.length);
    for (let i = 0; i < value.length; i++) { const item = value[i]; copy[i] = item && typeof item === 'object' ? scopeResult(source, item, objectId) : item; }
    return copy;
  }
  if (!value || typeof value !== 'object') return value;
  const copy = {};
  for (const key of Object.keys(value)) {
    const item = value[key];
    const next = typeof item === 'string' ? (targets.has(key) || (key === 'id' && objectId) ? scoped(source, item) : item)
      : item && typeof item === 'object' ? scopeResult(source, item, objects.has(key)) : item;
    // JSON can carry a "__proto__" key; keep it a plain property, as Object.fromEntries did.
    if (key === '__proto__') Object.defineProperty(copy, key, { value: next, enumerable: true, writable: true, configurable: true });
    else copy[key] = next;
  }
  return copy;
}

export function targetParams(params) {
  let source = params.source_id;
  const native = { ...params };
  delete native.source_id;
  for (const key of targets) {
    if (params[key] == null) continue;
    const target = unscoped(params[key]);
    if (source && source !== target.source) throw new RpcError('invalid_target', '不能混用不同连接源的会话');
    source = target.source;
    native[key] = target.id;
  }
  return { source, params: native };
}
