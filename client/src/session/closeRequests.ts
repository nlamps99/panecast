import { canManage, type SurfaceInfo, type WorkspaceInfo } from './surfaces';
import { SurfaceActions } from './surfaceActions';
import { workspaceActionsFor, type WorkspaceActionDeps } from './workspaceActions';

export type CloseConfirmation = (title: string, message: string) => Promise<boolean>;

/** Recheck the target after the dialog: the remote topology can change meanwhile. */
export async function requestTerminalClose(deps: WorkspaceActionDeps, actions: SurfaceActions, workspace: WorkspaceInfo, surface: SurfaceInfo, confirm: CloseConfirmation): Promise<void> {
  const snapshot = deps.workspaces.getState();
  const currentWorkspace = snapshot.workspaces.find(w => w.id === workspace.id) ?? snapshot.known.workspaces[workspace.id];
  const surfaces = snapshot.surfaces[workspace.id] ?? snapshot.known.surfaces[workspace.id] ?? [];
  if (!deps.channel.isOpen || !currentWorkspace || !canManage(currentWorkspace) || !surfaces.some(s => s.id === surface.id)) return;
  const last = surfaces.length === 1;
  const message = last
    ? `「${surface.title}」是「${workspace.title}」的最后一个终端。关闭会同时关闭这个工作区，并结束其中正在运行的程序。`
    : `关闭「${surface.title}」会结束其中正在运行的程序。`;
  if (!await confirm(last ? '关闭最后一个终端？' : '关闭终端？', message)) return;
  const latest = deps.workspaces.getState();
  const latestWorkspace = latest.workspaces.find(w => w.id === workspace.id) ?? latest.known.workspaces[workspace.id];
  const remaining = latest.surfaces[workspace.id] ?? latest.known.surfaces[workspace.id] ?? [];
  if (!deps.channel.isOpen || !latestWorkspace || !canManage(latestWorkspace) || !remaining.some(s => s.id === surface.id)) return;
  if (last && remaining.length === 1) await workspaceActionsFor(deps).close(workspace.id);
  else await actions.close(workspace.id, surface.id);
}

export async function requestWorkspaceClose(deps: WorkspaceActionDeps, workspace: WorkspaceInfo, confirm: CloseConfirmation): Promise<void> {
  if (!deps.channel.isOpen || !canManage(workspace)) return;
  const surfaces = deps.workspaces.getState().surfaces[workspace.id] ?? [];
  if (!await confirm(`关闭「${workspace.title}」？`, `这会关闭工作区中的${surfaces.length ? ` ${surfaces.length} 个` : '全部'}终端，并结束其中正在运行的程序。`)) return;
  const latest = deps.workspaces.getState();
  const current = latest.workspaces.find(w => w.id === workspace.id);
  const ids = new Set(surfaces.map(s => s.id));
  if (!deps.channel.isOpen || !current || !canManage(current)) return;
  // Newly created terminals were not part of the confirmation.
  if ((latest.surfaces[workspace.id] ?? []).some(s => !ids.has(s.id))) throw new Error('工作区新增了终端，请重新确认关闭范围');
  await workspaceActionsFor(deps).close(workspace.id);
}
