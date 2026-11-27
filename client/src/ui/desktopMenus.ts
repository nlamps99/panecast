import { confirmClose } from '../platform/confirm';
import { requestTerminalClose, requestWorkspaceClose } from '../session/closeRequests';
import { canCloseTerminal, canManage, type SurfaceInfo, type WorkspaceInfo } from '../session/surfaces';
import type { SurfaceActions } from '../session/surfaceActions';
import { describeError, type SurfaceTarget } from '../session/terminalSession';
import type { WorkspaceActionDeps } from '../session/workspaceActions';
import { sessionMemory } from '../state/sessionMemory';
import type { ContextMenuItem } from './ContextMenu';

type Common = {
  deps: WorkspaceActionDeps;
  workspace: WorkspaceInfo;
  connected: boolean;
  /** An action is running in this workspace; its controls wait. */
  busy: boolean;
  onError: (message: string) => void;
};

/**
 * A terminal's right-click menu, in the sidebar and on its tab. Read-only
 * sources get none of it, and shared windows cannot rename. Closing asks
 * first, as the × does. `rename` comes from `useTerminalRename`.
 */
export function terminalMenuItems({ deps, actions, rename, workspace, surface, count, connected, busy, onError }: Common & {
  actions: SurfaceActions; rename: { rename(target: SurfaceTarget, title: string): void; clear(target: SurfaceTarget): void }; surface: SurfaceInfo; count: number;
}): ContextMenuItem[] {
  const disabled = !connected || busy;
  const target = { workspaceId: workspace.id, surfaceId: surface.id };
  return [
    ...(canManage(workspace) ? [
      { label: '重命名…', disabled, onPress: () => rename.rename(target, surface.title) },
      { label: '恢复默认名称', disabled, onPress: () => rename.clear(target) },
      'separator' as const,
    ] : []),
    ...(workspace.access !== 'read' ? [{ label: '新建终端', disabled, onPress: () => { void actions.create(workspace.id); } }] : []),
    'separator',
    ...(canCloseTerminal(workspace, count) ? [{ label: '关闭终端…', destructive: true, disabled, onPress: () => {
      void requestTerminalClose(deps, actions, workspace, surface, confirmClose).catch((error: unknown) => onError(describeError(error)));
    } }] : []),
  ];
}

/** A workspace's right-click menu in the sidebar. Pinning is local, so read-only sources keep it. */
export function workspaceMenuItems({ deps, workspace, connected, busy, onError, computerId, pinned, onRename }: Common & { computerId: string; pinned: boolean; onRename: () => void }): ContextMenuItem[] {
  const manage = canManage(workspace);
  const disabled = !connected || busy;
  return [
    ...(manage ? [{ label: '重命名…', disabled, onPress: onRename }] : []),
    { label: pinned ? '取消置顶' : '置顶', onPress: () => sessionMemory.setPinned(computerId, workspace.id, !pinned) },
    'separator',
    ...(manage ? [{ label: '关闭工作区…', destructive: true, disabled, onPress: () => {
      void requestWorkspaceClose(deps, workspace, confirmClose).catch((error: unknown) => onError(describeError(error)));
    } }] : []),
  ];
}
