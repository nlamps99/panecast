import type { AgentItem } from './sourceStore';

/** Merge snapshots and older pages by stable record IDs, preserving late tool results. */
export function mergeTerminalItems(previous: readonly AgentItem[], incoming: readonly AgentItem[]): AgentItem[] {
  const map = new Map(previous.map(item => [item.id, item]));
  for (const item of incoming) {
    const old = map.get(item.id);
    if (!old) { map.set(item.id, item); continue; }
    const newest = (item.updatedSequence ?? item.sequence ?? 0) >= (old.updatedSequence ?? old.sequence ?? 0) ? item : old;
    const older = newest === item ? old : item;
    map.set(item.id, { ...older, ...newest, type: newest.type === 'toolExecution' && older.type !== 'toolExecution' ? older.type : newest.type,
      command: newest.command || older.command, tool: newest.tool || older.tool,
      changes: newest.changes?.length ? newest.changes : older.changes,
      aggregatedOutput: newest.aggregatedOutput || older.aggregatedOutput,
      sequence: Math.min(old.sequence ?? 0, item.sequence ?? 0) });
  }
  return [...map.values()].sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));
}
