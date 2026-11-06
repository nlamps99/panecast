import type { AgentItem, AgentThread, AgentTurn } from './sourceStore';

const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown, limit = 16_000): string => typeof value === 'string' ? value.slice(-limit) : '';
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const visible = new Set(['userMessage', 'agentMessage', 'plan', 'commandExecution', 'fileChange', 'mcpToolCall']);
const messages = new Set(['userMessage', 'agentMessage', 'plan']);

/** Network data is not a TypeScript value until it has been checked. */
export function agentItem(value: unknown): AgentItem | null {
  const item = record(value);
  if (typeof item.id !== 'string' || typeof item.type !== 'string' || !visible.has(item.type)) return null;
  const limit = item.type === 'commandExecution' ? 6000 : 16_000;
  const parts = array(item.content).map(record).filter((c) => c.type === 'text');
  const content = parts.slice(-8).map((c) => text(c.text)).join('\n');
  return { id: item.id, type: item.type, text: text(item.text, limit),
    ...(typeof item.clientId === 'string' ? { clientId: item.clientId } : {}),
    content: [{ type: 'text', text: text(content) }],
    command: text(item.command, 2000), aggregatedOutput: text(item.aggregatedOutput, 6000), status: text(item.status, 100),
    changes: array(item.changes).slice(0, 20).map(record).map((c) => ({ path: text(c.path, 500), diff: text(c.diff, 2000) })),
    server: text(item.server, 100), tool: text(item.tool, 200), truncated: item.truncated === true || content.length > 16_000 || parts.length > 8 || parts.some((p) => typeof p.text === 'string' && p.text.length > 16_000)
      || (typeof item.text === 'string' && item.text.length > limit)
      || (typeof item.aggregatedOutput === 'string' && item.aggregatedOutput.length > 6000) };
}

export function agentTurn(value: unknown): AgentTurn | null {
  const turn = record(value);
  if (typeof turn.id !== 'string') return null;
  const items = array(turn.items).map(agentItem).filter((item): item is AgentItem => item !== null);
  const tools = items.filter((item) => !messages.has(item.type)), recent = new Set(tools.slice(-30));
  return { id: turn.id, status: text(turn.status, 100), items: items.filter((item) => messages.has(item.type) || recent.has(item)),
    omittedItems: (typeof turn.omittedItems === 'number' ? Math.max(0, turn.omittedItems) : 0) + tools.length - recent.size,
    ...(turn.error ? { error: { message: text(record(turn.error).message, 2000) } } : {}) };
}

export function agentTurns(value: unknown): AgentTurn[] { return array(value).map(agentTurn).filter((turn): turn is AgentTurn => turn !== null); }

export function agentThread(value: unknown): AgentThread | null {
  const thread = record(value);
  if (typeof thread.id !== 'string') return null;
  return { id: thread.id, name: text(thread.name, 300) || 'Codex 会话', cwd: text(thread.cwd, 4096),
    status: { type: text(record(thread.status).type, 100) || 'unknown' },
    ...(typeof thread.live === 'boolean' ? { live: thread.live } : {}) };
}
