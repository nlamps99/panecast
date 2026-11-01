import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { windowLabel, type SurfaceInfo, type WorkspaceInfo } from '../../session/surfaces';
import { actionErrorText, workspaceActionsFor } from '../../session/workspaceActions';
import { useConnectionStatus, useMachine, useStore } from '../../state/hooks';
import { openSurface } from '../../state/navigation';
import { Icon } from '../../ui/Icon';
import { ComputerSwitcher } from '../../ui/ComputerSwitcher';
import { NameDialog } from '../../ui/NameDialog';
import { statusBanner } from '../../ui/status';
import { colors, fonts } from '../../ui/theme';
import { WindowChips } from '../../ui/WindowChips';
import { WorkspaceMenu, type WorkspaceMenuStage } from '../../ui/WorkspaceMenu';

/** The workspace whose long-press menu is up. `key` remounts it per opening; `open` false while it fades out. */
type MenuState = { key: number; workspace: WorkspaceInfo; stage: WorkspaceMenuStage; open: boolean };

/** The first screen: the Mac's workspaces, each with its terminals. */
export default function WorkspacesScreen() {
  const insets = useSafeAreaInsets();
  const machine = useMachine();
  const status = useConnectionStatus(machine.channel);
  const { workspaces, surfaces, windows, selectedWindowId, loaded, error } = useStore(machine.workspaces);
  const actions = workspaceActionsFor(machine);
  const { creating, pending, error: actionError } = useStore(actions);
  const { target } = useStore(machine.session);
  const { unreadByWorkspace } = useStore(machine.inbox);
  const [query, setQuery] = useState('');
  // Only a pull shows the spinner; refreshes on focus and on cmux events stay quiet.
  const [pulling, setPulling] = useState(false);
  const [createDialog, setCreateDialog] = useState<{ key: number; open: boolean } | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const banner = statusBanner(status);
  const canCreate = status.state === 'open' && !creating;

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

  // An error goes on its workspace's card; one for a workspace not shown (or for 新建) goes up top.
  const errorOnCard = actionError?.workspaceId && shown.some((w) => w.id === actionError.workspaceId) ? actionError.workspaceId : null;
  const selectedWindow = windows.length > 1 ? windows.find((w) => w.id === selectedWindowId) : undefined;

  const openMenu = (workspace: WorkspaceInfo, stage: WorkspaceMenuStage = 'menu') => {
    if (pending[workspace.id]) return;
    setMenu((m) => ({ key: (m?.key ?? 0) + 1, workspace, stage, open: true }));
  };
  const dismissMenu = () => setMenu((m) => (m ? { ...m, open: false } : m));
  const openCreate = () => setCreateDialog((d) => ({ key: (d?.key ?? 0) + 1, open: true }));
  const dismissCreate = () => setCreateDialog((d) => (d ? { ...d, open: false } : d));

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
        <View style={styles.titleRow}>
          <Text style={styles.title}>工作区</Text>
          <Pressable
            onPress={openCreate}
            disabled={!canCreate}
            hitSlop={8}
            style={({ pressed }) => [styles.addButton, pressed && styles.pressed, !canCreate && !creating && styles.dimmed]}
            accessibilityRole="button"
            accessibilityLabel="新建工作区"
            accessibilityState={{ disabled: !canCreate, busy: creating }}
          >
            {creating ? <ActivityIndicator size="small" color={colors.green} /> : <Icon name="add" size={18} color={colors.green} />}
          </Pressable>
        </View>
        <ComputerSwitcher />
      </View>

      {banner ? <Text style={styles.banner}>{banner}</Text> : null}

      <WindowChips windows={windows} selectedId={selectedWindowId} onSelect={(id) => void machine.workspaces.selectWindow(id)} />

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
      {actionError && !errorOnCard ? <ErrorRow text={actionErrorText(actionError)} onDismiss={() => actions.dismissError()} /> : null}

      {shown.map((workspace) => (
        <WorkspaceCard
          key={workspace.id}
          workspace={workspace}
          surfaces={surfaces[workspace.id] ?? []}
          unread={unreadByWorkspace[workspace.id] ?? 0}
          currentSurfaceId={target?.workspaceId === workspace.id ? target.surfaceId : null}
          busy={pending[workspace.id] ?? null}
          error={actionError && errorOnCard === workspace.id ? actionErrorText(actionError) : null}
          onOpen={(surfaceId) => openSurface(machine, workspace.id, surfaceId)}
          onMenu={(stage) => openMenu(workspace, stage)}
          onDismissError={() => actions.dismissError()}
        />
      ))}

      {loaded && workspaces.length === 0 && !error ? (
        <View style={styles.empty}>
          <Text style={styles.emptyTitle}>{selectedWindow ? `${windowLabel(selectedWindow)}里没有工作区` : '没有工作区'}</Text>
          <Text style={styles.emptyText}>
            {canCreate ? '点右上角的 + 新建一个，或者确认 Mac 上的 cmux 已经打开，然后下拉刷新。' : '确认 Mac 上的 cmux 已经打开，然后下拉刷新。'}
          </Text>
        </View>
      ) : null}
      {!loaded ? <Text style={styles.emptyText}>{status.state === 'open' ? '正在读取工作区…' : '正在连接电脑…'}</Text> : null}
      {loaded && workspaces.length > 0 && shown.length === 0 ? <Text style={styles.emptyText}>没有匹配「{query}」的工作区</Text> : null}
      {shown.length > 0 ? <Text style={styles.hint}>长按工作区可以重命名或关闭</Text> : null}

      {createDialog ? (
        <NameDialog
          key={createDialog.key}
          visible={createDialog.open}
          title="新建工作区"
          message={selectedWindow ? `会建在 cmux 的${windowLabel(selectedWindow)}里。` : undefined}
          placeholder="工作区名称"
          confirmLabel="新建"
          onCancel={dismissCreate}
          onSubmit={(title) => {
            dismissCreate();
            void actions.create(title);
          }}
        />
      ) : null}
      {menu ? (
        <WorkspaceMenu
          key={menu.key}
          workspace={menu.workspace}
          stage={menu.stage}
          visible={menu.open}
          onStage={(stage) => setMenu((m) => (m ? { ...m, stage } : m))}
          onDismiss={dismissMenu}
          onRename={(title) => {
            dismissMenu();
            void actions.rename(menu.workspace.id, title);
          }}
          onClose={() => {
            dismissMenu();
            void actions.close(menu.workspace.id);
          }}
        />
      ) : null}
    </ScrollView>
  );
}

function ErrorRow({ text, onDismiss }: { text: string; onDismiss: () => void }) {
  return (
    <Pressable onPress={onDismiss} style={styles.errorRow} accessibilityRole="button" accessibilityHint="收起这条错误">
      <Text style={styles.errorRowText}>{text}</Text>
      <Text style={styles.errorRowDismiss}>收起</Text>
    </Pressable>
  );
}

type CardProps = {
  workspace: WorkspaceInfo;
  surfaces: readonly SurfaceInfo[];
  unread: number;
  currentSurfaceId: string | null;
  /** A rename or close running on this workspace; the card is disabled meanwhile. */
  busy: 'rename' | 'close' | null;
  error: string | null;
  onOpen: (surfaceId: string) => void;
  onMenu: (stage?: WorkspaceMenuStage) => void;
  onDismissError: () => void;
};

function WorkspaceCard({ workspace, surfaces, unread, currentSurfaceId, busy, error, onOpen, onMenu, onDismissError }: CardProps) {
  const primary = surfaces.find((s) => s.id === currentSurfaceId) ?? surfaces.find((s) => s.focused) ?? surfaces[0];
  const isCurrent = currentSurfaceId !== null;
  const meta = busy === 'rename' ? '正在重命名…' : busy === 'close' ? '正在关闭…' : `${surfaces.length} 个终端${workspace.selected ? ' · 电脑上正在用' : ''}`;
  return (
    <View style={[styles.card, isCurrent && styles.cardCurrent, busy && styles.cardBusy]}>
      <Pressable
        onPress={() => primary && onOpen(primary.id)}
        onLongPress={() => onMenu()}
        disabled={busy !== null}
        style={({ pressed }) => [styles.cardHeader, pressed && styles.pressed]}
        accessibilityRole="button"
        accessibilityLabel={`${workspace.title}，${surfaces.length} 个终端`}
        accessibilityHint="长按可以重命名或关闭"
        accessibilityState={{ disabled: busy !== null, busy: busy !== null }}
        accessibilityActions={[
          { name: 'longpress', label: '更多操作' },
          { name: 'rename', label: '重命名' },
          { name: 'close', label: '关闭' },
        ]}
        onAccessibilityAction={(event) => {
          const action = event.nativeEvent.actionName;
          onMenu(action === 'rename' || action === 'close' ? action : 'menu');
        }}
      >
        <View style={[styles.index, isCurrent && styles.indexCurrent]}>
          <Text style={[styles.indexText, isCurrent && styles.indexTextCurrent]}>{String(workspace.index + 1).padStart(2, '0')}</Text>
        </View>
        <View style={styles.cardText}>
          <Text style={styles.cardTitle} numberOfLines={1}>
            {workspace.title}
          </Text>
          <Text style={styles.cardMeta} numberOfLines={1}>
            {meta}
          </Text>
        </View>
        {unread > 0 ? (
          <View style={styles.unread}>
            <Text style={styles.unreadText}>{unread > 99 ? '99+' : unread}</Text>
          </View>
        ) : null}
        {busy ? (
          <ActivityIndicator size="small" color={colors.muted} />
        ) : (
          <Icon name="forward" size={14} color={isCurrent ? colors.green : colors.muted} />
        )}
      </Pressable>
      {error ? (
        <View style={styles.cardError}>
          <ErrorRow text={error} onDismiss={onDismissError} />
        </View>
      ) : null}
      {surfaces.length > 1 || (surfaces.length === 1 && surfaces[0].title !== workspace.title)
        ? surfaces.map((surface) => {
            const current = surface.id === currentSurfaceId;
            return (
              <Pressable
                key={surface.id}
                onPress={() => onOpen(surface.id)}
                onLongPress={() => onMenu()}
                disabled={busy !== null}
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
  titleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  title: { color: colors.ink, fontSize: 28, fontWeight: '700' },
  addButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.divider,
  },
  dimmed: { opacity: 0.4 },
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
  errorRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, padding: 10, borderRadius: 8, backgroundColor: colors.surfaceSunken },
  errorRowText: { flex: 1, color: colors.red, fontSize: 13, lineHeight: 18 },
  errorRowDismiss: { color: colors.muted, fontSize: 12, lineHeight: 18 },
  card: {
    borderRadius: 12,
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.divider,
    overflow: 'hidden',
  },
  cardCurrent: { borderColor: colors.green },
  cardBusy: { opacity: 0.6 },
  cardError: { paddingHorizontal: 12, paddingBottom: 12 },
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
  hint: { color: colors.mutedDim, fontSize: 12, textAlign: 'center', marginTop: 4 },
});
