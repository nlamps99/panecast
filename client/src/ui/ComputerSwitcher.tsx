import { StyleSheet, Text, View } from 'react-native';

import { useConnectionStatus, useMachine } from '../state/hooks';
import { machineLabel, statusColor, statusLabel } from './status';
import { colors } from './theme';

/** Under the 工作区 title: which computer this is and how it is connected. */
export function ComputerSwitcher() {
  const machine = useMachine();
  const status = useConnectionStatus(machine.channel);
  const label = machineLabel(machine);
  return (
    <View style={styles.row}>
      <View style={[styles.dot, { backgroundColor: machine.mode === 'demo' ? colors.yellow : statusColor(status) }]} />
      <Text style={styles.text} numberOfLines={1}>
        {label.name} · {machine.mode === 'demo' ? '演示' : statusLabel(status)}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  dot: { width: 7, height: 7, borderRadius: 4 },
  text: { flexShrink: 1, color: colors.muted, fontSize: 13 },
});
