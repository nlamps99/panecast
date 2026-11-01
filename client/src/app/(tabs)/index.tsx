import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { SurfaceInfo, WorkspaceInfo } from '../../session/surfaces';
import { useConnectionStatus, useMachine, useStore } from '../../state/hooks';
import { openSurface } from '../../state/navigation';
import { Icon } from '../../ui/Icon';
import { ComputerSwitcher } from '../../ui/ComputerSwitcher';
import { statusBanner } from '../../ui/status';
import { colors, fonts } from '../../ui/theme';

/** The first screen: the Mac's workspaces, each with its terminals. */
export default function WorkspacesScreen() {
  const insets = useSafeAreaInsets();
  const machine = useMachine();
  const status = useConnectionStatus(machine.channel);
  const { workspaces, surfaces, loaded, error } = useStore(machine.workspaces);
  const { target } = useStore(machine.session);
  const { unreadByWorkspace } = useStore(machine.inbox);
  const [query, setQuery] = useState('');
  // Only a pull shows the spinner; refreshes on focus and on cmux events stay quiet.
  const [pulling, setPulling] = useState(false);
  const banner = statusBanner(status);

  useFocusEffect(
    useCallback(() => {
      void machine.workspaces.refresh();
    }, [machine]),
  );

  const needle = query.trim().toLowerCase();
  const shown = needle
    ? workspaces.filter(
        (w) =>
          w.title.toLowerCase().includes(needle) ||
          (surfaces[w.id] ?? []).some((s) => s.title.toLowerCase().includes(needle)),
      )
    : workspaces;

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={[styles.content, { paddingTop: insets.top + 12, paddingLeft: insets.left + 16, paddingRight: insets.right + 16 }]}
      keyboardDismissMode="on-drag"
      keyboardShouldPersistTaps="handled"
      refreshControl={
        <RefreshControl
          refreshing={pulling}
          onRefresh={() => {
            setPulling(true);
            void machine.workspaces.refresh().finally(() => setPulling(false));
          }}
          tintColor={colors.muted}
        />
      }
    >
      <View style={styles.header}>
        <Text style={styles.title}>工作区</Text>
        <ComputerSwitcher />
      </View>

      {banner ? <Text style={styles.banner}>{banner}</Text> : null}

      <View style={styles.search}>
        <Icon name="search" size={15} color={colors.muted} />
        <TextInput
          defaultValue=""
          onChangeText={setQuery}
          placeholder="筛选工作区或终端"
          placeholderTextColor={colors.muted}
          autoCapitalize="none"
          autoCorrect={false}
          clearButtonMode="while-editing"
          style={styles.searchInput}
        />
      </View>

      {error ? <Text style={styles.error}>读取工作区失败：{error}</Text> : null}

      {shown.map((workspace) => (
        <WorkspaceCard
          key={workspace.id}
          workspace={workspace}
          surfaces={surfaces[workspace.id] ?? []}
          unread={unreadByWorkspace[workspace.id] ?? 0}
          currentSurfaceId={target?.workspaceId === workspace.id ? target.surfaceId : null}
          onOpen={(surfaceId) => openSurface(machine, workspace.id, surfaceId)}
        />
      ))}

      {loaded && workspaces.length === 0 && !error ? (
        <View style={styles.empty}>
          <Text style={styles.emptyTitle}>没有工作区</Text>
          <Text style={styles.emptyText}>确认 Mac 上的 cmux 已经打开，然后下拉刷新。</Text>
        </View>
      ) : null}
      {!loaded ? <Text style={styles.emptyText}>{status.state === 'open' ? '正在读取工作区…' : '正在连接电脑…'}</Text> : null}
      {loaded && workspaces.length > 0 && shown.length === 0 ? <Text style={styles.emptyText}>没有匹配「{query}」的工作区</Text> : null}
    </ScrollView>
  );
}

type CardProps = {
  workspace: WorkspaceInfo;
  surfaces: readonly SurfaceInfo[];
  unread: number;
  currentSurfaceId: string | null;
  onOpen: (surfaceId: string) => void;
};

function WorkspaceCard({ workspace, surfaces, unread, currentSurfaceId, onOpen }: CardProps) {
  const primary = surfaces.find((s) => s.id === currentSurfaceId) ?? surfaces.find((s) => s.focused) ?? surfaces[0];
  const isCurrent = currentSurfaceId !== null;
  return (
    <View style={[styles.card, isCurrent && styles.cardCurrent]}>
      <Pressable
        onPress={() => primary && onOpen(primary.id)}
        disabled={!primary}
        style={({ pressed }) => [styles.cardHeader, pressed && styles.pressed]}
        accessibilityRole="button"
        accessibilityLabel={`${workspace.title}，${surfaces.length} 个终端`}
      >
        <View style={[styles.index, isCurrent && styles.indexCurrent]}>
          <Text style={[styles.indexText, isCurrent && styles.indexTextCurrent]}>{String(workspace.index + 1).padStart(2, '0')}</Text>
        </View>
        <View style={styles.cardText}>
          <Text style={styles.cardTitle} numberOfLines={1}>
            {workspace.title}
          </Text>
          <Text style={styles.cardMeta} numberOfLines={1}>
            {surfaces.length} 个终端{workspace.selected ? ' · 电脑上正在用' : ''}
          </Text>
        </View>
        {unread > 0 ? (
          <View style={styles.unread}>
            <Text style={styles.unreadText}>{unread > 99 ? '99+' : unread}</Text>
          </View>
        ) : null}
        <Icon name="forward" size={14} color={isCurrent ? colors.green : colors.muted} />
      </Pressable>
      {surfaces.length > 1 || (surfaces.length === 1 && surfaces[0].title !== workspace.title)
        ? surfaces.map((surface) => {
            const current = surface.id === currentSurfaceId;
            return (
              <Pressable
                key={surface.id}
                onPress={() => onOpen(surface.id)}
                style={({ pressed }) => [styles.surface, pressed && styles.pressed]}
                accessibilityRole="button"
                accessibilityLabel={`打开终端 ${surface.title}`}
              >
                <Text style={[styles.surfaceMark, current && styles.surfaceMarkCurrent]}>{current ? '›' : '·'}</Text>
                <Text style={[styles.surfaceTitle, current && styles.surfaceTitleCurrent]} numberOfLines={1}>
                  {surface.title}
                </Text>
                {surface.focused ? <Text style={styles.surfaceBadge}>电脑上正在用</Text> : null}
              </Pressable>
            );
          })
        : null}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.canvas },
  content: { paddingBottom: 24, gap: 12 },
  header: { gap: 6, marginBottom: 4 },
  title: { color: colors.ink, fontSize: 28, fontWeight: '700' },
  banner: { color: colors.yellow, fontSize: 13, lineHeight: 18, padding: 12, borderRadius: 10, backgroundColor: colors.surface },
  search: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    height: 40,
    paddingHorizontal: 12,
    borderRadius: 10,
    backgroundColor: colors.surfaceSunken,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.divider,
  },
  searchInput: { flex: 1, color: colors.ink, fontSize: 15, paddingVertical: 0 },
  error: { color: colors.red, fontSize: 13 },
  card: {
    borderRadius: 12,
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.divider,
    overflow: 'hidden',
  },
  cardCurrent: { borderColor: colors.green },
  cardHeader: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 12, paddingVertical: 12 },
  pressed: { backgroundColor: colors.surfaceRaised },
  index: {
    width: 40,
    height: 40,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surfaceSunken,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.divider,
  },
  indexCurrent: { borderColor: colors.green },
  indexText: { color: colors.muted, fontFamily: fonts.mono, fontSize: 13 },
  indexTextCurrent: { color: colors.green },
  cardText: { flex: 1, gap: 3 },
  cardTitle: { color: colors.ink, fontSize: 16, fontWeight: '600' },
  cardMeta: { color: colors.muted, fontSize: 12 },
  unread: {
    minWidth: 20,
    height: 20,
    paddingHorizontal: 6,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.red,
  },
  unreadText: { color: colors.canvas, fontSize: 11, fontWeight: '700' },
  surface: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 11,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.divider,
  },
  surfaceMark: { width: 12, color: colors.muted, fontFamily: fonts.mono, fontSize: 14 },
  surfaceMarkCurrent: { color: colors.green },
  surfaceTitle: { flex: 1, color: colors.inkDim, fontSize: 14 },
  surfaceTitleCurrent: { color: colors.ink },
  surfaceBadge: { color: colors.muted, fontSize: 11 },
  empty: { alignItems: 'center', gap: 6, paddingVertical: 40 },
  emptyTitle: { color: colors.inkDim, fontSize: 15 },
  emptyText: { color: colors.muted, fontSize: 13, textAlign: 'center' },
});
