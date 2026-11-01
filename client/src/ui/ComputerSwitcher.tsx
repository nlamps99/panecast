import { router } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { appStore } from '../state/appStore';
import { computerAddress } from '../state/computers';
import { useAppState, useConnectionStatus } from '../state/hooks';
import { openPairing } from '../state/pairingRoute';
import { runOrAlert } from './computerActions';
import { Icon } from './Icon';
import { Sheet, SheetRow, useSheet } from './Sheet';
import { machineLabel, statusColor, statusLabel } from './status';
import { TransportBadge } from './TransportBadge';
import { colors } from './theme';

/**
 * Under the 工作区 title: which computer this is and how it is connected.
 * Tapping it opens a sheet to switch computers, add one, or try the demo.
 */
export function ComputerSwitcher() {
  const { machine, computers } = useAppState();
  const status = useConnectionStatus(machine?.channel ?? null);
  const sheet = useSheet();
  if (!machine) return null;

  const demo = machine.mode === 'demo';
  const currentId = machine.computer?.id ?? null;
  const label = machineLabel(machine);
  const stateText = demo ? '演示' : statusLabel(status);
  const dotColor = demo ? colors.yellow : statusColor(status);

  const choose = (computerId: string) => {
    sheet.close();
    if (computerId !== currentId) runOrAlert(() => appStore.select(computerId));
  };

  const chooseDemo = () => {
    sheet.close();
    appStore.enterDemo();
  };

  return (
    <>
      <Pressable
        onPress={sheet.open}
        hitSlop={8}
        style={({ pressed }) => [styles.trigger, pressed && styles.pressed]}
        accessibilityRole="button"
        accessibilityLabel={`当前电脑：${label.name}，${stateText}`}
        accessibilityHint="切换电脑"
      >
        <View style={[styles.dot, { backgroundColor: dotColor }]} />
        <Text style={styles.text} numberOfLines={1}>
          {label.name} · {stateText}
        </Text>
        {!demo && status.state === 'open' ? <TransportBadge channel={machine.channel} /> : null}
        <Icon name="expand" size={11} color={colors.muted} />
      </Pressable>

      <Sheet visible={sheet.visible} title="切换电脑" onClose={() => sheet.close()} onClosed={sheet.onClosed}>
        {computers.computers.map((computer, index) => {
          const current = computer.id === currentId;
          return (
            <SheetRow
              key={computer.id}
              icon="computer"
              iconColor={current ? colors.green : colors.inkDim}
              title={computer.name}
              detail={current ? `${stateText} · ${computerAddress(computer)}` : computerAddress(computer)}
              detailColor={current ? dotColor : colors.muted}
              divided={index > 0}
              selected={current}
              trailing={current ? <Icon name="check" size={16} color={colors.green} /> : null}
              onPress={() => choose(computer.id)}
            />
          );
        })}
        <SheetRow
          icon="demo"
          iconColor={demo ? colors.yellow : colors.inkDim}
          title="演示"
          detail="不连接电脑，用演示数据试试"
          divided={computers.computers.length > 0}
          selected={demo}
          trailing={demo ? <Icon name="check" size={16} color={colors.green} /> : null}
          onPress={chooseDemo}
        />
        <SheetRow icon="add" iconColor={colors.blue} title="添加电脑" titleColor={colors.blue} onPress={() => sheet.close(() => openPairing())} />
        <SheetRow icon="settings" title="管理电脑" detail="改名、移除" onPress={() => sheet.close(() => router.navigate('/settings'))} />
      </Sheet>
    </>
  );
}

const styles = StyleSheet.create({
  trigger: { flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start', gap: 7, borderRadius: 6, paddingVertical: 2 },
  pressed: { opacity: 0.6 },
  dot: { width: 7, height: 7, borderRadius: 4 },
  text: { flexShrink: 1, color: colors.muted, fontSize: 13 },
});
