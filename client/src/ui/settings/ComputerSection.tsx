import { Alert, Text, View } from 'react-native';

import { appStore } from '../../state/appStore';
import { useConnectionStatus, useMachine } from '../../state/hooks';
import { Icon } from '../Icon';
import { machineLabel, statusColor, statusLabel } from '../status';
import { colors } from '../theme';
import { ActionRow, Section, settingsStyles as s } from './Section';

/** The paired computer(s): status, unpair, leave the demo. */
export function ComputerSection() {
  const machine = useMachine();
  const status = useConnectionStatus(machine.channel);
  const label = machineLabel(machine);
  const demo = machine.mode === 'demo';

  const unpair = () => {
    Alert.alert('取消配对', '这台手机会忘记这台电脑，之后需要重新扫码。', [
      { text: '取消', style: 'cancel' },
      { text: '取消配对', style: 'destructive', onPress: () => void appStore.unpair() },
    ]);
  };

  return (
    <Section title="电脑">
      <View style={s.row}>
        <Icon name="computer" size={18} color={colors.inkDim} />
        <View style={s.rowText}>
          <Text style={s.rowTitle}>{label.name}</Text>
          <Text style={s.rowDetail} numberOfLines={1}>
            {label.detail}
          </Text>
        </View>
        <View style={[s.dot, { backgroundColor: demo ? colors.yellow : statusColor(status) }]} />
        <Text style={s.rowValue}>{demo ? '演示' : statusLabel(status)}</Text>
      </View>
      {demo ? <ActionRow label="退出演示" onPress={() => appStore.exitDemo()} /> : <ActionRow label="取消配对" destructive onPress={unpair} />}
    </Section>
  );
}
