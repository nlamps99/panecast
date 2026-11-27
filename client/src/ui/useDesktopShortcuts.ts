import { router } from 'expo-router';
import { useEffect, useRef } from 'react';
import { Platform } from 'react-native';

import { desktopBridge, desktopOnWindows } from '../platform/desktop';
import type { Machine } from '../state/appStore';
import { openSurface } from '../state/navigation';
import { sessionMemory } from '../state/sessionMemory';
import { SurfaceActions } from '../session/surfaceActions';
import { desktopCommand, emitDesktopCommand, hideDesktopWindow, menuCommand, menuShortcut, setSidebarHidden, sidebarState, type DesktopCommand } from './desktopShell';
import { sidebarWorkspaces } from './sidebarModel';
import { zoomDesktopTerminal } from './terminalZoom';

/** Where the window is: the route on screen and whether the sidebar shell is up. */
export type DesktopContext = { pathname: string; shell: boolean };

/** The workspaces exactly as the sidebar lists them, and the current terminal's place among them. */
function terminalsAround(machine: Machine) {
  const state = machine.workspaces.getState();
  const target = machine.session.getState().target;
  const pinned = sessionMemory.computer(machine.computer?.id ?? 'demo').pinned;
  const workspaces = sidebarWorkspaces(state.workspaces, state.surfaces, pinned, sidebarState().query);
  const workspaceIndex = target ? workspaces.findIndex((w) => w.id === target.workspaceId) : -1;
  // The sidebar and the tab row list a workspace's terminals in the computer's order.
  const surfaces = target ? state.surfaces[target.workspaceId] ?? state.known.surfaces[target.workspaceId] ?? [] : [];
  return { state, target, workspaces, workspaceIndex, surfaces, surfaceIndex: target ? surfaces.findIndex((s) => s.id === target.surfaceId) : -1 };
}

export function runDesktopCommand(machine: Machine, command: DesktopCommand, context: DesktopContext = { pathname: '/terminal', shell: true }): boolean {
  const around = terminalsAround(machine);
  switch (command.kind) {
    case 'terminal': {
      const { target, surfaces } = around;
      const surface = command.index < 0 ? surfaces.at(-1) : surfaces[command.index];
      if (!target || !surface) return false;
      openSurface(machine, target.workspaceId, surface.id);
      return true;
    }
    case 'cycle': {
      const { target, surfaces, surfaceIndex } = around;
      if (!target || surfaces.length < 2) return false;
      const next = surfaces[(surfaceIndex + command.step + surfaces.length) % surfaces.length];
      openSurface(machine, target.workspaceId, next.id);
      return true;
    }
    case 'workspace': {
      const { workspaces, workspaceIndex, state } = around;
      if (!workspaces.length) return false;
      const workspace = workspaces[((workspaceIndex < 0 ? 0 : workspaceIndex + command.step) + workspaces.length) % workspaces.length];
      const surface = (state.surfaces[workspace.id] ?? state.known.surfaces[workspace.id] ?? [])[0];
      if (!surface) return false;
      openSurface(machine, workspace.id, surface.id);
      return true;
    }
    case 'new': {
      const { target } = around;
      // A shared window may add terminals too; its computer enforces the limit.
      if (!target || !machine.channel.isOpen) return false;
      void new SurfaceActions(machine).create(target.workspaceId);
      router.navigate('/terminal');
      return true;
    }
    case 'newWorkspace':
      // The sidebar asks for the name; without it, the workspace list does.
      if (!context.shell) router.navigate('/');
      emitDesktopCommand(command);
      return true;
    case 'close':
      // The terminal screen closes its terminal, after the usual confirmation.
      if (context.pathname === '/terminal' && around.target) emitDesktopCommand(command);
      else hideDesktopWindow();
      return true;
    case 'sidebar':
      setSidebarHidden(!sidebarState().hidden);
      return true;
    case 'font':
      // An explicit size stepped from the one on screen; ⌘0 fits the window again.
      zoomDesktopTerminal(command.step);
      return true;
    case 'settings':
      router.navigate('/settings');
      return true;
    case 'find':
    case 'focus':
      router.navigate('/terminal');
      emitDesktopCommand(command);
      return true;
  }
}

/**
 * Window-wide keyboard shortcuts. The Mac menu bar owns the keys it shows
 * (`menuShortcut`): the page lets them through to it, and `useDesktopMenu`
 * runs the item when it arrives, so each shortcut runs once.
 */
export function useDesktopShortcuts(machine: Machine | null, enabled: boolean, pathname = '/terminal'): void {
  const context = useRef<DesktopContext>({ pathname, shell: enabled });
  useEffect(() => { context.current = { pathname, shell: enabled }; }, [pathname, enabled]);
  useEffect(() => {
    if (!enabled || !machine || Platform.OS !== 'web' || typeof window === 'undefined') return;
    const menuBar = !desktopOnWindows() && typeof desktopBridge()?.onMenu === 'function';
    const keydown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      if (menuBar && menuShortcut(event)) return;
      const command = desktopCommand(event);
      if (!command || !runDesktopCommand(machine, command, context.current)) return;
      event.preventDefault();
      event.stopPropagation();
    };
    // Capture phase: decided before the terminal input sees the key.
    window.addEventListener('keydown', keydown, true);
    return () => window.removeEventListener('keydown', keydown, true);
  }, [machine, enabled]);
}

/**
 * The Mac menu bar's items, on every screen and at any window width: the
 * root layout listens, so they work before a computer is paired too. Without
 * one, ⌘W closes (hides) the window and the sidebar still toggles; the rest
 * need a computer and do nothing.
 */
export function useDesktopMenu(machine: Machine | null, pathname: string, shell: boolean): void {
  const latest = useRef({ machine, context: { pathname, shell } });
  useEffect(() => { latest.current = { machine, context: { pathname, shell } }; }, [machine, pathname, shell]);
  useEffect(() => {
    const bridge = desktopBridge();
    if (!bridge?.onMenu) return;
    return bridge.onMenu((id) => {
      const command = menuCommand(id);
      if (!command) return;
      const { machine: current, context } = latest.current;
      if (current) runDesktopCommand(current, command, context);
      else if (command.kind === 'close') hideDesktopWindow();
      else if (command.kind === 'sidebar') setSidebarHidden(!sidebarState().hidden);
    });
  }, []);
}
