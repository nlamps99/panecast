import { useSyncExternalStore } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import type { Machine } from '../state/appStore';
import type { ActivityState, TerminalActivity } from '../session/terminalActivity';
import { colors } from './theme';

const empty: ActivityState = {};
const getEmpty = () => empty;
const subscribeEmpty = () => () => {};
export function useTerminalActivity(machine: Machine): ActivityState {
  return useSyncExternalStore(machine.activity?.subscribe ?? subscribeEmpty, machine.activity?.getState ?? getEmpty, getEmpty);
}

export function TerminalActivityBadge({ activity }: { activity?: TerminalActivity }) {
  if (!activity || !['running', 'completed'].includes(activity.status)) return null;
  const running = activity.status === 'running';
  return <View style={styles.row} accessibilityLabel={running ? '正在处理' : '已完成'}>
    {running ? <ActivityIndicator size="small" color={colors.green} /> : null}
    <Text style={[styles.label, { color: running ? colors.green : colors.muted }]}>{running ? '正在处理' : '✓ 已完成'}</Text>
  </View>;
}
const styles = StyleSheet.create({ row: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 4 }, label: { fontSize: 11 } });
