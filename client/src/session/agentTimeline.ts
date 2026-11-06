import type { AgentItem, AgentTurn } from './sourceStore';

const MESSAGES = new Set(['userMessage', 'agentMessage', 'plan']);
const NO_EXPANSIONS: ReadonlySet<string> = new Set();

export type AgentToolGroup = {
  kind: 'tools';
  key: string;
  items: readonly AgentItem[];
  expanded: boolean;
};
export type AgentTimelineRow =
  | { kind: 'item'; key: string; item: AgentItem }
  | AgentToolGroup
  | { kind: 'status'; key: string; turnId: string; error: string; omitted: number };

/** Collapsed tools occupy one row; expanded tools remain individually virtualized. */
export function agentTimeline(turns: readonly AgentTurn[], expanded: ReadonlySet<string> = NO_EXPANSIONS, activeTurnId: string | null = null): AgentTimelineRow[] {
  const rows: AgentTimelineRow[] = [];
  for (const turn of turns) {
    let anchor: string | null = null;
    let tools: AgentItem[] = [];
    const appendItem = (item: AgentItem) => rows.push({ kind: 'item', key: JSON.stringify([turn.id, 'item', item.id]), item });
    const flushTools = () => {
      if (!tools.length) return;
      // Anchor to the preceding message, so new output and retention trimming
      // do not reset a group's expansion or move it across an assistant reply.
      const key = JSON.stringify([turn.id, 'tools', anchor]);
      const open = expanded.has(key);
      rows.push({ kind: 'tools', key, items: tools, expanded: open });
      if (open) tools.forEach(appendItem);
      tools = [];
    };
    for (const item of turn.items) {
      if (MESSAGES.has(item.type)) {
        flushTools();
        appendItem(item);
        anchor = item.id;
      } else tools.push(item);
    }
    flushTools();
    const error = turn.error?.message ?? '', omitted = turn.omittedItems ?? 0;
    if (error || omitted > 0 || turn.id === activeTurnId) rows.push({ kind: 'status', key: JSON.stringify([turn.id, 'status']), turnId: turn.id, error, omitted });
  }
  return rows;
}
