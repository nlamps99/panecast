import { useEffect, useState } from 'react';
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { describeError, type RpcChannel, type SurfaceTarget } from '../session/terminalSession';
import { listSurfaces, listWorkspaces, type SurfaceInfo, type WorkspaceInfo } from '../session/surfaces';
import { FONT_SIZE_MAX, FONT_SIZE_MIN, setPrefs, usePrefs } from '../state/prefs';
import { colors } from './theme';

type Group = { workspace: WorkspaceInfo; surfaces: SurfaceInfo[] };

type Props = {
  visible: boolean;
  channel: RpcChannel;
  current: SurfaceTarget | null;
  /** "取消配对" for a real Mac, "退出演示" in the demo. */
  leaveLabel: string;
  onPick: (target: SurfaceTarget) => void;
  onLeave: () => void;
  onClose: () => void;
};

/** Terminals on the Mac, display settings, and leaving. Full workspace management comes later. */
export function TerminalMenu({ visible, channel, current, leaveLabel, onPick, onLeave, onClose }: Props) {
  const insets = useSafeAreaInsets();
  const { fontSize } = usePrefs();
  const [groups, setGroups] = useState<Group[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    (async () => {
      setGroups(null);
      setError(null);
      try {
        const workspaces = await listWorkspaces(channel);
        const loaded: Group[] = [];
        for (const workspace of workspaces) {
          loaded.push({ workspace, surfaces: await listSurfaces(channel, workspace.id) });
        }
        if (!cancelled) setGroups(loaded);
      } catch (failure) {
        if (!cancelled) setError(describeError(failure));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [visible, channel]);

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={[styles.sheet, { paddingBottom: insets.bottom + 12 }]}>
        <View style={styles.header}>
          <Text style={styles.title}>终端</Text>
          <Pressable onPress={onClose} hitSlop={10} accessibilityRole="button">
            <Text style={styles.close}>完成</Text>
          </Pressable>
        </View>
        <ScrollView contentContainerStyle={styles.list}>
          {error ? <Text style={styles.error}>{error}</Text> : null}
          {!groups && !error ? <ActivityIndicator color={colors.muted} style={styles.spinner} /> : null}
          {groups?.map(({ workspace, surfaces }) => (
            <View key={workspace.id} style={styles.group}>
              <Text style={styles.sectionTitle} numberOfLines={1}>
                {workspace.title}
              </Text>
              <View style={styles.card}>
                {surfaces.length === 0 ? <Text style={styles.empty}>没有终端</Text> : null}
                {surfaces.map((surface, index) => {
                  const selected = current?.surfaceId === surface.id;
                  return (
                    <Pressable
                      key={surface.id}
                      onPress={() => onPick({ workspaceId: workspace.id, surfaceId: surface.id })}
                      style={({ pressed }) => [styles.item, index > 0 && styles.itemDivider, pressed && styles.itemPressed]}
                      accessibilityRole="button"
                      accessibilityState={{ selected }}
                    >
                      <Text style={[styles.check, !selected && styles.checkHidden]}>✓</Text>
                      <Text style={styles.itemTitle} numberOfLines={1}>
                        {surface.title}
                      </Text>
                      {surface.focused ? <Text style={styles.badge}>电脑上正在用</Text> : null}
                    </Pressable>
                  );
                })}
              </View>
            </View>
          ))}

          <View style={styles.group}>
            <Text style={styles.sectionTitle}>显示</Text>
            <View style={[styles.card, styles.fontRow]}>
              <Text style={styles.itemTitle}>字号 {fontSize} pt</Text>
              <Stepper
                label="A−"
                a11y="缩小字号"
                disabled={fontSize <= FONT_SIZE_MIN}
                onPress={() => setPrefs({ fontSize: fontSize - 1 })}
              />
              <Stepper
                label="A+"
                a11y="放大字号"
                disabled={fontSize >= FONT_SIZE_MAX}
                onPress={() => setPrefs({ fontSize: fontSize + 1 })}
              />
            </View>
            <Text style={styles.footnote}>也可以在终端上双指捏合调整。</Text>
          </View>

          <Pressable onPress={onLeave} style={({ pressed }) => [styles.card, styles.leave, pressed && styles.itemPressed]} accessibilityRole="button">
            <Text style={styles.leaveText}>{leaveLabel}</Text>
          </Pressable>
        </ScrollView>
      </View>
    </Modal>
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
  sheet: { flex: 1, backgroundColor: colors.canvas },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  title: { color: colors.ink, fontSize: 17, fontWeight: '600' },
  close: { color: colors.blue, fontSize: 16, fontWeight: '600' },
  list: { paddingHorizontal: 16, paddingBottom: 16, gap: 22 },
  spinner: { marginTop: 24 },
  error: { color: colors.red, fontSize: 14 },
  group: { gap: 6 },
  sectionTitle: { color: colors.muted, fontSize: 13, paddingHorizontal: 4 },
  card: { borderRadius: 10, backgroundColor: colors.surface, overflow: 'hidden' },
  empty: { color: colors.mutedDim, fontSize: 14, padding: 14 },
  item: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, paddingVertical: 13 },
  itemDivider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.divider },
  itemPressed: { backgroundColor: colors.surfaceRaised },
  check: { color: colors.green, fontSize: 15, width: 14 },
  checkHidden: { opacity: 0 },
  itemTitle: { flex: 1, color: colors.ink, fontSize: 15 },
  badge: { color: colors.muted, fontSize: 12 },
  fontRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 14, paddingVertical: 8 },
  stepper: {
    width: 44,
    height: 32,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surfaceRaised,
  },
  stepperDim: { opacity: 0.5 },
  stepperText: { color: colors.ink, fontSize: 15 },
  footnote: { color: colors.mutedDim, fontSize: 12, paddingHorizontal: 4 },
  leave: { alignItems: 'center', paddingVertical: 13 },
  leaveText: { color: colors.red, fontSize: 15 },
});
