import type { InboxItem } from './inboxStore';
import type { SurfaceInfo } from './surfaces';
import type { SurfaceTarget } from './terminalSession';

/**
 * The terminal an inbox item opens: its own surface, else the focused (or
 * first) terminal of its workspace. Null when it names no workspace, or names
 * no surface and its workspace has no known terminal.
 */
export function inboxTarget(
  item: Pick<InboxItem, 'workspaceId' | 'surfaceId'>,
  surfaces: Readonly<Record<string, readonly SurfaceInfo[]>>,
): SurfaceTarget | null {
  if (!item.workspaceId) return null;
  const list = surfaces[item.workspaceId] ?? [];
  const surfaceId = item.surfaceId ?? list.find((s) => s.focused)?.id ?? list[0]?.id;
  return surfaceId ? { workspaceId: item.workspaceId, surfaceId } : null;
}

/**
 * Whether the user is looking at the terminal the item is about: on the
 * terminal tab, showing its surface (or, when the item names no surface, a
 * terminal of its workspace).
 */
export function isShowingItem(
  item: Pick<InboxItem, 'workspaceId' | 'surfaceId'>,
  pathname: string,
  target: SurfaceTarget | null,
): boolean {
  if (pathname !== '/terminal' || !target || !item.workspaceId) return false;
  if (target.workspaceId !== item.workspaceId) return false;
  return item.surfaceId === null || item.surfaceId === target.surfaceId;
}

/**
 * Whether a newly arrived item deserves the in-app banner: not when the user
 * is on that terminal already, nor on the inbox, where it appears on top.
 */
export function shouldAnnounce(
  item: Pick<InboxItem, 'workspaceId' | 'surfaceId'>,
  pathname: string,
  target: SurfaceTarget | null,
): boolean {
  if (pathname === '/inbox') return false;
  return !isShowingItem(item, pathname, target);
}
