import { RpcCallError } from '../protocol/connection';
import type { RpcChannel, SurfaceTarget } from './terminalSession';

/** The gateway's limit for a terminal's name. */
export const TERMINAL_NAME_MAX = 200;
export const RENAME_UNSUPPORTED = '这个终端不支持重命名';

/**
 * Older gateways do not know `surface.action`; tmux sources refuse it. Neither
 * will start working on a retry.
 */
const UNSUPPORTED = new Set(['method_not_found', 'invalid_params', 'not_supported', '-32601', '-32602']);

type Deps = { channel: RpcChannel; workspaces: { refresh(): Promise<void> } };

/**
 * Renames a terminal in cmux (`surface.action` rename), or with `title`
 * null gives it back its default name (`clear_name`). The list is refreshed
 * after a change, so every view shows the new name. Resolves `unsupported`
 * where the source cannot rename terminals; other failures reject with a
 * message to show.
 */
export async function renameTerminal(deps: Deps, target: SurfaceTarget, title: string | null): Promise<'renamed' | 'unchanged' | 'unsupported'> {
  const name = title?.trim() ?? null;
  if (name !== null) {
    if (!name) return 'unchanged';
    if ([...name].length > TERMINAL_NAME_MAX) throw new Error(`终端名称最多 ${TERMINAL_NAME_MAX} 个字符`);
  }
  const ids = { workspace_id: target.workspaceId, surface_id: target.surfaceId };
  try {
    await deps.channel.call('surface.action', name === null ? { ...ids, action: 'clear_name' } : { ...ids, action: 'rename', title: name });
  } catch (error) {
    if (error instanceof RpcCallError && UNSUPPORTED.has(String(error.code))) return 'unsupported';
    throw error;
  }
  await deps.workspaces.refresh().catch(() => {});
  return 'renamed';
}
