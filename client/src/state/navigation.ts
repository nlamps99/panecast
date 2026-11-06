import { router } from 'expo-router';

import { appStore, type Machine } from './appStore';
import { listSurfaces } from '../session/surfaces';
import { sessionMemory, type RecentTerminal } from './sessionMemory';

/** Opens a terminal: subscribe to it, clear its workspace's unread count, and switch to the terminal tab. */
export function openSurface(machine: Machine, workspaceId: string, surfaceId: string): void {
  machine.session.setTarget({ workspaceId, surfaceId });
  if (machine.computer) {
    const state = machine.workspaces.getState();
    const workspace = state.workspaces.find((w) => w.id === workspaceId) ?? state.known.workspaces[workspaceId];
    const surface = (state.surfaces[workspaceId] ?? state.known.surfaces[workspaceId] ?? []).find((s) => s.id === surfaceId);
    sessionMemory.visit(machine.computer.id, { workspaceId, surfaceId, title: surface?.title ?? '终端', workspaceTitle: workspace?.title ?? '工作区', windowId: state.workspaces.some((w) => w.id === workspaceId) ? state.selectedWindowId : null });
  }
  machine.inbox.markWorkspaceRead(workspaceId);
  router.navigate('/terminal');
}

/** From the terminal back to the workspace list. */
export function backToWorkspaces(): void {
  router.navigate('/');
}

export async function openRecentSurface(machine: Machine, entry: RecentTerminal): Promise<void> {
  if (!machine.channel.isOpen) throw new Error('连接恢复后可以打开最近访问的终端');
  const intent = machine.session.reserveSelection();
  const surfaces = await listSurfaces(machine.channel, entry.workspaceId);
  if (appStore.getState().machine !== machine || machine.session.selectionVersion !== intent) return;
  if (!surfaces.some((s) => s.id === entry.surfaceId)) {
    if (machine.computer) sessionMemory.forgetTarget(machine.computer.id, entry);
    throw new Error('这个终端已关闭，已从最近访问中移除');
  }
  if (entry.windowId) await machine.workspaces.selectWindow(entry.windowId);
  if (appStore.getState().machine !== machine || machine.session.selectionVersion !== intent) return;
  openSurface(machine, entry.workspaceId, entry.surfaceId);
}
