import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const sharesDirectory = (config) => join(config.state_directory ?? join(homedir(), '.cmuxremote', 'hub'), 'shares');
export const sharesFile = (config) => join(sharesDirectory(config), 'shares.json');

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
  const share = shares.find((entry) => !entry.revoked_at && entry.source_id === sourceId && entry.workspace_id === workspaceId
    && entry.surface_id === surfaceId && UUID.test(entry.session_id ?? ''));
  return share ? { kind: 'claude', checkpoint_id: share.session_id } : null;
}
