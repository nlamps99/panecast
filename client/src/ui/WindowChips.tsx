import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { windowLabel, type WindowInfo } from '../session/surfaces';
import { colors, fonts } from './theme';

type Props = {
  windows: readonly WindowInfo[];
  selectedId: string | null;
  onSelect: (windowId: string) => void;
};

/**
 * Picks which cmux window's workspaces are listed. Hidden with a single window
 * (and with older cmux, which reports none), where it would only be noise.
 */
export function WindowChips({ windows, selectedId, onSelect }: Props) {
  if (windows.length < 2) return null;
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.row} keyboardShouldPersistTaps="handled">
      {windows.map((window) => {
        const selected = window.id === selectedId;
        const label = windowLabel(window);
        const count = window.workspaceCount;
        return (
          <Pressable
            key={window.id}
            onPress={() => {
              if (!selected) onSelect(window.id);
            }}
            style={({ pressed }) => [styles.chip, selected && styles.chipSelected, pressed && !selected && styles.pressed]}
            accessibilityRole="button"
            accessibilityState={{ selected }}
            accessibilityLabel={[label, count !== null ? `${count} 个工作区` : null, window.key ? '电脑上正在用' : null]
              .filter(Boolean)
              .join('，')}
          >
            {window.key ? <View style={[styles.keyDot, selected && styles.keyDotSelected]} /> : null}
            <Text style={[styles.label, selected && styles.labelSelected]}>{label}</Text>
            {count !== null ? <Text style={[styles.count, selected && styles.countSelected]}>{count}</Text> : null}
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  row: { gap: 8 },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    height: 34,
    paddingHorizontal: 12,
    borderRadius: 8,
    backgroundColor: colors.surfaceSunken,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.divider,
  },
  chipSelected: { backgroundColor: colors.green, borderColor: colors.green },
  pressed: { backgroundColor: colors.surfaceRaised },
  keyDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: colors.green },
  keyDotSelected: { backgroundColor: colors.canvas },
  label: { color: colors.ink, fontSize: 13, fontWeight: '600' },
  labelSelected: { color: colors.canvas },
  count: { color: colors.muted, fontFamily: fonts.mono, fontSize: 11 },
  countSelected: { color: colors.surfaceSunken },
});
