const text = (value, limit) => typeof value === 'string' && limit > 0 ? value.slice(-limit) : '';
const visibleTypes = new Set(['userMessage', 'agentMessage', 'plan', 'commandExecution', 'fileChange', 'mcpToolCall']);
const messages = new Set(['userMessage', 'agentMessage', 'plan']);

/** Strip unused tool payloads and bound text before sending history to a phone. */
export function mobileItem(item) {
  if (!item || typeof item.id !== 'string' || !visibleTypes.has(item.type)) return null;
  const result = { id: item.id, type: item.type };
  if (typeof item.clientId === 'string') result.clientId = item.clientId;
  let truncated = false;
  const take = (value, limit) => { if (typeof value === 'string' && value.length > limit) truncated = true; return text(value, limit); };
  if (item.type === 'userMessage') {
    const parts = (Array.isArray(item.content) ? item.content : []).filter((c) => c?.type === 'text');
    if (parts.length > 8) truncated = true;
    result.content = [{ type: 'text', text: take(parts.slice(-8).map((c) => take(c.text, 16_000)).join('\n'), 16_000) }];
  } else if (messages.has(item.type)) result.text = take(item.text, 16_000);
  else if (item.type === 'commandExecution') { result.command = take(item.command, 2000); result.aggregatedOutput = take(item.aggregatedOutput, 6000); }
  else if (item.type === 'fileChange') {
    const changes = Array.isArray(item.changes) ? item.changes : [];
    let remaining = 8000;
    result.changes = changes.slice(0, 20).filter(Boolean).map((change) => {
      const diff = take(change.diff, Math.min(2000, remaining)); remaining -= diff.length;
      return { path: take(change.path, 500), diff };
    });
    if (changes.length > 20) truncated = true;
  } else { result.server = take(item.server, 100); result.tool = take(item.tool, 200); }
  if (typeof item.status === 'string') result.status = item.status;
  if (truncated) result.truncated = true;
  return result;
}

export function mobileTurn(turn) {
  const all = (Array.isArray(turn?.items) ? turn.items : []).map(mobileItem).filter(Boolean);
  const tools = all.filter((item) => !messages.has(item.type));
  const retainedTools = new Set(tools.slice(-30));
  return { id: turn.id, status: typeof turn.status === 'string' ? turn.status : 'unknown',
    items: all.filter((item) => messages.has(item.type) || retainedTools.has(item)),
    omittedItems: Math.max(0, tools.length - retainedTools.size),
    ...(turn.error ? { error: { message: text(turn.error.message, 2000) } } : {}) };
}
