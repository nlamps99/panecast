import { Pressable, StyleSheet, Text } from 'react-native';

import type { HostBattery } from '../session/hostStatus';
import { Icon, type IconName } from './Icon';
import { colors } from './theme';

const LOW_PERCENT = 20;

/** The Mac's battery level in the terminal header. Tap to refresh. */
export function BatteryBadge({ battery, onPress }: { battery: HostBattery; onPress: () => void }) {
  const low = !battery.charging && battery.percent <= LOW_PERCENT;
  const tint = low ? colors.red : colors.green;
  const label = battery.charging ? `电脑电量 ${battery.percent}%，正在充电` : `电脑电量 ${battery.percent}%`;
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.badge, pressed && styles.pressed]}
      hitSlop={6}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      <Icon name={batteryIcon(battery)} size={13} color={tint} />
      <Text style={[styles.text, { color: tint }]}>{battery.percent}%</Text>
    </Pressable>
  );
}

function batteryIcon(battery: HostBattery): IconName {
  if (battery.charging) return 'batteryCharging';
  if (battery.percent >= 90) return 'batteryFull';
  if (battery.percent >= 60) return 'batteryHigh';
  if (battery.percent >= 35) return 'batteryHalf';
  return 'batteryLow';
}

const styles = StyleSheet.create({
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    height: 22,
    paddingHorizontal: 6,
    borderRadius: 4,
    backgroundColor: colors.surfaceRaised,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.divider,
  },
  pressed: { backgroundColor: colors.surface },
  text: { fontSize: 11, fontWeight: '600', fontVariant: ['tabular-nums'] },
});
