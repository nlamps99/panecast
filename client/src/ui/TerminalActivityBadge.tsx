import { useSyncExternalStore } from 'react';
import { ActivityIndicator } from 'react-native';
import type { Machine } from '../state/appStore';
import type { ActivityState, TerminalActivity } from '../session/terminalActivity';
import { colors } from './theme';

const empty: ActivityState = {};
const getEmpty = () => empty;
const subscribeEmpty = () => () => {};
export function useTerminalActivity(machine: Machine): ActivityState {
  return useSyncExternalStore(machine.activity?.subscribe ?? subscribeEmpty, machine.activity?.getState ?? getEmpty, getEmpty);
}

export function TerminalActivityBadge({ activity, color = colors.green }: { activity?: TerminalActivity; color?: string }) {
  if (activity?.status !== 'running') return null;
  return <ActivityIndicator size={12} color={color} accessibilityLabel="正在运行" testID="terminal-running-indicator" />;
}
