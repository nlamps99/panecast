import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Alert } from '../../platform/alert';

import { appStore } from '../../state/appStore';
import type { TransportPreference } from '../../state/computers';
import { useAppState } from '../../state/hooks';
import { colors } from '../theme';
import { LAN_HINT } from '../TransportBadge';
import { Section, settingsStyles as s } from './Section';

type Option = { value: TransportPreference; title: string; detail: string; needsLan: boolean };

const OPTIONS: Option[] = [
  { value: 'auto', title: '自动', detail: '和电脑在同一个 Wi-Fi 时走局域网，否则走服务器', needsLan: false },
  { value: 'broker', title: '仅服务器', detail: '总是经服务器连接，链路加密', needsLan: false },
  { value: 'lan', title: '仅局域网', detail: '只直连电脑，离开这个 Wi-Fi 就连不上', needsLan: true },
];

/**
 * How one computer is reached: 自动 / 仅服务器 / 仅局域网. 仅局域网 is disabled
 * when the computer has no LAN pairing (its QR carried no LAN address, or the
 * phone was not on the Mac's Wi-Fi when pairing).
 */
export function TransportPicker({ computerId, title = '连接方式' }: { computerId: string; title?: string }) {
  const { computers } = useAppState();
  const [saving, setSaving] = useState(false);
  const computer = computers.computers.find((c) => c.id === computerId);
  if (!computer) return null;
  const hasLan = Boolean(computer.lan);
  const current = computers.transport?.[computerId] ?? 'auto';

  const choose = async (value: TransportPreference) => {
    if (value === current || saving) return;
    setSaving(true);
    try {
      await appStore.setTransport(computerId, value);
    } catch (error) {
      Alert.alert('没能保存连接方式', error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  const footnote = hasLan
    ? LAN_HINT
    : '这台电脑没有局域网配对，只能经服务器连接。要用局域网，请在电脑的 Wi-Fi 下重新扫码配对。';

  return (
    <Section title={title} footnote={footnote}>
      {OPTIONS.map((option, index) => {
        const disabled = option.needsLan && !hasLan;
        const selected = option.value === current;
        return (
          <Pressable
            key={option.value}
            onPress={() => void choose(option.value)}
            disabled={disabled || saving}
            style={({ pressed }) => [s.row, index > 0 && s.divided, pressed && s.pressed]}
            accessibilityRole="radio"
            accessibilityState={{ checked: selected, disabled }}
            accessibilityLabel={option.title}
            accessibilityHint={option.detail}
          >
            <View style={[s.rowText, disabled && styles.disabled]}>
              <Text style={s.rowTitle}>{option.title}</Text>
              <Text style={s.rowDetail}>{option.detail}</Text>
            </View>
            {selected ? <Text style={styles.check}>✓</Text> : null}
          </Pressable>
        );
      })}
    </Section>
  );
}

const styles = StyleSheet.create({
  disabled: { opacity: 0.4 },
  check: { color: colors.blue, fontSize: 16 },
});
