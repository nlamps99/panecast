import Constants from 'expo-constants';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { PROTOCOL_VERSION } from '../../protocol/frames';
import { appStore } from '../../state/appStore';
import { useConnectionStatus, useMachine } from '../../state/hooks';
import { FONT_SIZE_MAX, FONT_SIZE_MIN, setPrefs, usePrefs } from '../../state/prefs';
import { Icon } from '../../ui/Icon';
import { machineLabel, statusColor, statusLabel } from '../../ui/status';
import { colors } from '../../ui/theme';

export default function SettingsScreen() {
  const insets = useSafeAreaInsets();
  const machine = useMachine();
  const status = useConnectionStatus(machine.channel);
  const { fontSize } = usePrefs();
  const label = machineLabel(machine);
  const demo = machine.mode === 'demo';

  const unpair = () => {
    Alert.alert('取消配对', '这台手机会忘记这台电脑，之后需要重新扫码。', [
      { text: '取消', style: 'cancel' },
      { text: '取消配对', style: 'destructive', onPress: () => void appStore.unpair() },
    ]);
  };

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={[styles.content, { paddingTop: insets.top + 12, paddingLeft: insets.left + 16, paddingRight: insets.right + 16 }]}
    >
      <Text style={styles.title}>设置</Text>

      <Section title="电脑">
        <View style={styles.row}>
          <Icon name="computer" size={18} color={colors.inkDim} />
          <View style={styles.rowText}>
            <Text style={styles.rowTitle}>{label.name}</Text>
            <Text style={styles.rowDetail} numberOfLines={1}>
              {label.detail}
            </Text>
          </View>
          <View style={[styles.dot, { backgroundColor: demo ? colors.yellow : statusColor(status) }]} />
          <Text style={styles.rowValue}>{demo ? '演示' : statusLabel(status)}</Text>
        </View>
        {demo ? (
          <ActionRow label="退出演示" onPress={() => void appStore.exitDemo()} />
        ) : (
          <ActionRow label="取消配对" destructive onPress={unpair} />
        )}
      </Section>

      <Section title="终端" footnote="也可以在终端上双指捏合调整字号。">
        <View style={styles.row}>
          <Text style={[styles.rowTitle, styles.grow]}>字号</Text>
          <Text style={styles.rowValue}>{fontSize} pt</Text>
          <Stepper label="A−" a11y="缩小字号" disabled={fontSize <= FONT_SIZE_MIN} onPress={() => setPrefs({ fontSize: fontSize - 1 })} />
          <Stepper label="A+" a11y="放大字号" disabled={fontSize >= FONT_SIZE_MAX} onPress={() => setPrefs({ fontSize: fontSize + 1 })} />
        </View>
      </Section>

      <Section title="关于">
        <View style={styles.row}>
          <Text style={[styles.rowTitle, styles.grow]}>Panecast</Text>
          <Text style={styles.rowValue}>
            {Constants.expoConfig?.version ?? '0.1.0'} · 协议 v{PROTOCOL_VERSION}
          </Text>
        </View>
      </Section>
    </ScrollView>
  );
}

function Section({ title, footnote, children }: { title: string; footnote?: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      <View style={styles.card}>{children}</View>
      {footnote ? <Text style={styles.footnote}>{footnote}</Text> : null}
    </View>
  );
}

function ActionRow({ label, destructive, onPress }: { label: string; destructive?: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.row, styles.divided, pressed && styles.pressed]} accessibilityRole="button">
      <Text style={[styles.action, destructive && styles.destructive]}>{label}</Text>
    </Pressable>
  );
}

function Stepper({ label, a11y, disabled, onPress }: { label: string; a11y: string; disabled: boolean; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [styles.stepper, (pressed || disabled) && styles.stepperDim]}
      accessibilityRole="button"
      accessibilityLabel={a11y}
    >
      <Text style={styles.stepperText}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.canvas },
  content: { paddingBottom: 24, gap: 22 },
  title: { color: colors.ink, fontSize: 28, fontWeight: '700' },
  section: { gap: 6 },
  sectionTitle: { color: colors.muted, fontSize: 13, paddingHorizontal: 4 },
  card: { borderRadius: 12, backgroundColor: colors.surface, overflow: 'hidden' },
  footnote: { color: colors.mutedDim, fontSize: 12, paddingHorizontal: 4 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 50, paddingHorizontal: 14, paddingVertical: 8 },
  divided: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.divider },
  pressed: { backgroundColor: colors.surfaceRaised },
  rowText: { flex: 1, gap: 2 },
  rowTitle: { color: colors.ink, fontSize: 15 },
  rowDetail: { color: colors.muted, fontSize: 12 },
  rowValue: { color: colors.muted, fontSize: 13 },
  grow: { flex: 1 },
  dot: { width: 7, height: 7, borderRadius: 4 },
  action: { flex: 1, color: colors.blue, fontSize: 15, textAlign: 'center' },
  destructive: { color: colors.red },
  stepper: { width: 44, height: 32, borderRadius: 8, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surfaceRaised },
  stepperDim: { opacity: 0.5 },
  stepperText: { color: colors.ink, fontSize: 15 },
});
