import type { AgentThread, AgentTurn } from './sourceStore';

/** A historical inProgress row is not proof that this thread is still running. */
export function currentAgentTurn(thread: AgentThread, turns: AgentTurn[], reported: unknown): string | null {
  if (typeof reported === 'string') return reported;
  if (reported === null || thread.live === false || thread.status?.type !== 'active') return null;
  const latest = turns.at(-1);
  return latest?.status === 'inProgress' ? latest.id : null;
}

let inputSequence = 0;
export function newAgentMessageId(): string {
  return `panecast-${Date.now().toString(36)}-${++inputSequence}-${Math.random().toString(36).slice(2, 10)}`;
}
