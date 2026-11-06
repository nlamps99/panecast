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

export function scopeResult(source, value, objectId = false) {
  if (Array.isArray(value)) return value.map((item) => scopeResult(source, item, objectId));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
    typeof item === 'string' && (targets.has(key) || (key === 'id' && objectId))
      ? scoped(source, item)
      : scopeResult(source, item, objects.has(key)),
  ]));
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
