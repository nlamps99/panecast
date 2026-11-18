import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const sharesDirectory = (config) => join(config.state_directory ?? join(homedir(), '.cmuxremote', 'hub'), 'shares');
export const sharesFile = (config) => join(sharesDirectory(config), 'shares.json');

/**
 * The terminals of a share, each with its Claude session: the window opened
 * by `panecast share` and any a guest added. Shares made before guests could
 * add terminals have only `surface_id` and `session_id`.
 */
export function shareTerminals(share) {
  if (Array.isArray(share?.terminals)) return share.terminals.filter((terminal) => typeof terminal?.surface_id === 'string' && terminal.surface_id);
  return share?.surface_id ? [{ surface_id: share.surface_id, session_id: share.session_id ?? null }] : [];
}

/**
 * The session a shared window's Claude writes to. `panecast share` starts
 * it with `--session-id` and keeps the id with the share, because cmux
 * holds no resume binding for a window it did not launch through its
 * Claude wrapper. Read for owner and guests alike, so both can browse the
 * window's history from its record. Null when the window is not a share.
 */
export async function shareConversationBinding(config, sourceId, workspaceId, surfaceId) {
  let shares;
  try { shares = JSON.parse(await readFile(sharesFile(config), 'utf8')).shares; } catch { return null; }
  if (!Array.isArray(shares)) return null;
  for (const entry of shares) {
    if (entry.revoked_at || entry.source_id !== sourceId || entry.workspace_id !== workspaceId) continue;
    const terminal = shareTerminals(entry).find((candidate) => candidate.surface_id === surfaceId);
    if (terminal && UUID.test(terminal.session_id ?? '')) return { kind: 'claude', checkpoint_id: terminal.session_id };
  }
  return null;
}
