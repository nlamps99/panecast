import type { ConnectionStatus } from '../protocol/connection';
import type { SurfaceInfo, WorkspaceInfo } from '../session/surfaces';

/**
 * The sidebar's workspaces: pinned first, then in the computer's own order.
 * Running terminals and recent visits only show as indicators; ordering by
 * them moved rows under the pointer every time the activity poll ran.
 * ⌘⌥↑ / ⌘⌥↓ walk this same list.
 */
export function sidebarWorkspaces(
  workspaces: readonly WorkspaceInfo[],
  surfaces: Readonly<Record<string, readonly SurfaceInfo[]>>,
  pinned: readonly string[],
  query = '',
): WorkspaceInfo[] {
  const needle = query.trim().toLocaleLowerCase();
  const matches = (workspace: WorkspaceInfo) => !needle || workspace.title.toLocaleLowerCase().includes(needle)
    || (surfaces[workspace.id] ?? []).some((surface) => surface.title.toLocaleLowerCase().includes(needle));
  const position = new Map(workspaces.map((workspace, index) => [workspace.id, index]));
  return workspaces.filter(matches).sort((a, b) => Number(pinned.includes(b.id)) - Number(pinned.includes(a.id))
    || a.index - b.index || (position.get(a.id) ?? 0) - (position.get(b.id) ?? 0));
}

/** What the sidebar says when it lists nothing; null while it lists something. */
export function sidebarEmptyText({ status, loaded, total, shown }: { status: ConnectionStatus; loaded: boolean; total: number; shown: number }): string | null {
  if (shown > 0) return null;
  if (total > 0) return '没有匹配的工作区';
  if (status.state === 'open') return loaded ? '没有工作区' : '正在加载…';
  if (status.state === 'connecting' && status.attempt === 0) return '正在加载…';
  return '未连接';
}
