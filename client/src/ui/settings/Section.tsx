import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { colors } from '../theme';

/** A titled card of rows, iOS-settings style. */
export function Section({ title, footnote, children }: { title: string; footnote?: string; children: ReactNode }) {
  return (
    <View style={settingsStyles.section}>
      <Text style={settingsStyles.sectionTitle}>{title}</Text>
      <View style={settingsStyles.card}>{children}</View>
      {footnote ? <Text style={settingsStyles.footnote}>{footnote}</Text> : null}
    </View>
  );
}

/** A full-width button row; `divided` draws a line above it. */
export function ActionRow({
  label,
  destructive,
  divided = true,
  onPress,
}: {
  label: string;
  destructive?: boolean;
  divided?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [settingsStyles.row, divided && settingsStyles.divided, pressed && settingsStyles.pressed]}
      accessibilityRole="button"
    >
      <Text style={[settingsStyles.action, destructive && settingsStyles.destructive]}>{label}</Text>
    </Pressable>
  );
}

export function Stepper({ label, a11y, disabled, onPress }: { label: string; a11y: string; disabled: boolean; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [settingsStyles.stepper, (pressed || disabled) && settingsStyles.stepperDim]}
      accessibilityRole="button"
      accessibilityLabel={a11y}
    >
      <Text style={settingsStyles.stepperText}>{label}</Text>
    </Pressable>
  );
}

export const settingsStyles = StyleSheet.create({
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
