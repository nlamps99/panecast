import { useEffect, useState } from 'react';
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { describeError, type RpcChannel, type SurfaceTarget } from '../session/terminalSession';
import { listSurfaces, listWorkspaces, type SurfaceInfo, type WorkspaceInfo } from '../session/surfaces';
import { colors } from './theme';

type Group = { workspace: WorkspaceInfo; surfaces: SurfaceInfo[] };

type Props = {
  visible: boolean;
  channel: RpcChannel;
  current: SurfaceTarget | null;
  onPick: (target: SurfaceTarget) => void;
  onUnpair: () => void;
  onClose: () => void;
};

/** A plain list of the Mac's terminals. Full workspace management comes later. */
export function SurfacePicker({ visible, channel, current, onPick, onUnpair, onClose }: Props) {
  const insets = useSafeAreaInsets();
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
          <Text style={styles.title}>选择终端</Text>
          <Pressable onPress={onClose} hitSlop={10} accessibilityRole="button">
            <Text style={styles.close}>完成</Text>
          </Pressable>
        </View>
        <ScrollView contentContainerStyle={styles.list}>
          {error ? <Text style={styles.error}>{error}</Text> : null}
          {!groups && !error ? <ActivityIndicator color={colors.muted} style={styles.spinner} /> : null}
          {groups?.map(({ workspace, surfaces }) => (
            <View key={workspace.id} style={styles.group}>
              <Text style={styles.workspace} numberOfLines={1}>
                {workspace.title}
              </Text>
              {surfaces.length === 0 ? <Text style={styles.empty}>没有终端</Text> : null}
              {surfaces.map((surface) => {
                const selected = current?.surfaceId === surface.id;
                return (
                  <Pressable
                    key={surface.id}
                    onPress={() => onPick({ workspaceId: workspace.id, surfaceId: surface.id })}
                    style={({ pressed }) => [styles.surface, (pressed || selected) && styles.surfaceSelected]}
                    accessibilityRole="button"
                  >
                    <Text style={styles.surfaceTitle} numberOfLines={1}>
                      {surface.title}
                    </Text>
                    {surface.focused ? <Text style={styles.badge}>电脑上正在用</Text> : null}
                  </Pressable>
                );
              })}
            </View>
          ))}
          <Pressable onPress={onUnpair} style={styles.unpair} accessibilityRole="button">
            <Text style={styles.unpairText}>取消配对</Text>
          </Pressable>
        </ScrollView>
      </View>
    </Modal>
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
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.divider,
  },
  title: { color: colors.ink, fontSize: 17, fontWeight: '600' },
  close: { color: colors.blue, fontSize: 16 },
  list: { padding: 16, gap: 18 },
  spinner: { marginTop: 24 },
  error: { color: colors.red, fontSize: 14 },
  group: { gap: 6 },
  workspace: { color: colors.muted, fontSize: 13, fontWeight: '600' },
  empty: { color: colors.mutedDim, fontSize: 13 },
  surface: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 12,
    borderRadius: 8,
    backgroundColor: colors.surface,
  },
  surfaceSelected: { backgroundColor: colors.surfaceRaised },
  surfaceTitle: { flex: 1, color: colors.ink, fontSize: 15 },
  badge: { color: colors.green, fontSize: 11 },
  unpair: { marginTop: 12, paddingVertical: 12, alignItems: 'center' },
  unpairText: { color: colors.red, fontSize: 15 },
});
