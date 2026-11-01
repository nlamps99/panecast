import { router } from 'expo-router';

import type { Machine } from './appStore';

/** Opens a terminal: subscribe to it, clear its workspace's unread count, and switch to the terminal tab. */
export function openSurface(machine: Machine, workspaceId: string, surfaceId: string): void {
  machine.session.setTarget({ workspaceId, surfaceId });
  machine.inbox.markWorkspaceRead(workspaceId);
  router.navigate('/terminal');
}

/** From the terminal back to the workspace list. */
export function backToWorkspaces(): void {
  router.navigate('/');
}
