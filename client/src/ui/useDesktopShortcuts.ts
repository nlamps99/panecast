import { router } from 'expo-router';
import { useEffect } from 'react';
import { Platform } from 'react-native';

import type { Machine } from '../state/appStore';
import { openSurface } from '../state/navigation';
import { clampFontSize, DEFAULT_PREFS, getPrefs, setPrefs } from '../state/prefs';
import { SurfaceActions } from '../session/surfaceActions';
import { desktopCommand, emitDesktopCommand, type DesktopCommand } from './desktopShell';

/** The workspaces in sidebar order and the current terminal's place among them. */
function terminalsAround(machine: Machine) {
  const state = machine.workspaces.getState();
  const target = machine.session.getState().target;
  const workspaces = state.workspaces;
  const workspaceIndex = target ? workspaces.findIndex((w) => w.id === target.workspaceId) : -1;
  const surfaces = target ? state.surfaces[target.workspaceId] ?? state.known.surfaces[target.workspaceId] ?? [] : [];
  return { state, target, workspaces, workspaceIndex, surfaces, surfaceIndex: target ? surfaces.findIndex((s) => s.id === target.surfaceId) : -1 };
}

export function runDesktopCommand(machine: Machine, command: DesktopCommand): boolean {
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
      // A shared window holds exactly one terminal; its computer refuses new ones.
      if (!target || !machine.channel.isOpen || machine.computer?.share) return false;
      void new SurfaceActions(machine).create(target.workspaceId);
      return true;
    }
    case 'font': {
      const size = command.step === 0 ? DEFAULT_PREFS.fontSize : clampFontSize(getPrefs().fontSize + command.step);
      setPrefs({ fontSize: size });
      return true;
    }
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

/** Window-wide keyboard shortcuts for the desktop app. */
export function useDesktopShortcuts(machine: Machine | null, enabled: boolean): void {
  useEffect(() => {
    if (!enabled || !machine || Platform.OS !== 'web' || typeof window === 'undefined') return;
    const keydown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      const command = desktopCommand(event);
      if (!command || !runDesktopCommand(machine, command)) return;
      event.preventDefault();
      event.stopPropagation();
    };
    // Capture phase: decided before the terminal input sees the key.
    window.addEventListener('keydown', keydown, true);
    return () => window.removeEventListener('keydown', keydown, true);
  }, [machine, enabled]);
}
