import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View, useWindowDimensions } from 'react-native';
import Swipeable, { type SwipeableMethods } from 'react-native-gesture-handler/ReanimatedSwipeable';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { canManage, windowLabel, type SurfaceInfo, type WorkspaceInfo } from '../../session/surfaces';
import { actionErrorText, workspaceActionsFor } from '../../session/workspaceActions';
import type { CloseReason, ConnectionStatus } from '../../protocol/connection';
import { useConnectionStatus, useMachine, useStore } from '../../state/hooks';
import { openRecentSurface, openSurface } from '../../state/navigation';
import { sessionMemory, useSessionMemory } from '../../state/sessionMemory';
import { Icon } from '../../ui/Icon';
import { ComputerSwitcher } from '../../ui/ComputerSwitcher';
import { NameDialog } from '../../ui/NameDialog';
import { isGuest, offlineNotice, statusBanner } from '../../ui/status';
import { appStore } from '../../state/appStore';
import { SignedOutNotice } from '../../ui/SignedOutNotice';
import { StatusBarScrim } from '../../ui/StatusBarScrim';
import { colors, fonts } from '../../ui/theme';
import { WindowChips } from '../../ui/WindowChips';
import { WorkspaceMenu, type WorkspaceMenuStage } from '../../ui/WorkspaceMenu';
import { activityKey, compareActivity, type ActivityState } from '../../session/terminalActivity';
import { TerminalActivityBadge, useTerminalActivity } from '../../ui/TerminalActivityBadge';
import { CloseButton } from '../../ui/CloseButton';
import { confirmClose } from '../../platform/confirm';
import { requestWorkspaceClose } from '../../session/closeRequests';
import { desktopBridge } from '../../platform/desktop';

/** How long the list may say 正在连接 before it explains what might be wrong. */
const SLOW_CONNECT_MS = 10_000;

/**
 * Phones swipe a card left for 置顶 and 关闭, which keeps the narrow title row
 * for the name; the iPad and the desktop keep the ☆ and × buttons.
 */
function usePhoneSwipe(): boolean {
  const { width, height } = useWindowDimensions();
  return desktopBridge() === null && Math.min(width, height) < 600;
}

/** The workspace whose long-press menu is up. `key` remounts it per opening; `open` false while it fades out. */
type MenuState = { key: number; workspace: WorkspaceInfo; stage: WorkspaceMenuStage; open: boolean };

/** The first screen: the Mac's workspaces, each with its terminals. */
export default function WorkspacesScreen() {
  const insets = useSafeAreaInsets();
  const machine = useMachine();
  const activity = useTerminalActivity(machine);
  const computerId = machine.computer?.id ?? 'demo';
  const memory = useSessionMemory(computerId);
  const [recentError, setRecentError] = useState<string | null>(null);
  const [closeError, setCloseError] = useState<string | null>(null);
  const status = useConnectionStatus(machine.channel);
  const { workspaces, surfaces, windows, selectedWindowId, loaded, error } = useStore(machine.workspaces);
  const actions = workspaceActionsFor(machine);
  const { creating, pending, error: actionError } = useStore(actions);
  const { target } = useStore(machine.session);
  const { unreadByWorkspace, pendingByWorkspace } = useStore(machine.inbox);
  const [query, setQuery] = useState('');
  // Only a pull shows the spinner; refreshes on focus and on cmux events stay quiet.
  const [pulling, setPulling] = useState(false);
  const [createDialog, setCreateDialog] = useState<{ key: number; open: boolean } | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const swipe = usePhoneSwipe();
  // One card open at a time, as in Mail.
  const openCard = useRef<{ id: string; methods: SwipeableMethods } | null>(null);
  const cardOpened = (id: string, methods: SwipeableMethods) => {
    if (openCard.current && openCard.current.id !== id) openCard.current.methods.close();
    openCard.current = { id, methods };
  };
  // Between retries the status is briefly `connecting`; keep showing why the last attempt failed.
  const steady = useSteadyStatus(status);
  const banner = machine.mode === 'demo' ? null : statusBanner(steady, isGuest(machine));
  const slow = useSlowConnect(machine.mode !== 'demo' && status.state !== 'open' && status.state !== 'auth_failed');
  const offline = machine.mode === 'demo' ? null : offlineNotice(steady, slow);
  const canCreate = status.state === 'open' && !creating && canManage(windows.find((w) => w.id === selectedWindowId));

  useFocusEffect(
    useCallback(() => {
      void machine.workspaces.refresh();
    }, [machine]),
  );

  const needle = query.trim().toLowerCase();
  const shown = [...(needle
    ? workspaces.filter(
        (w) =>
          w.title.toLowerCase().includes(needle) ||
          (surfaces[w.id] ?? []).some((s) => s.title.toLowerCase().includes(needle)),
      )
    : workspaces)].sort((a, b) => Number(memory.pinned.includes(b.id)) - Number(memory.pinned.includes(a.id)) || a.index - b.index);

  // An error goes on its workspace's card; one for a workspace not shown (or for 新建) goes up top.
  const errorOnCard = actionError?.workspaceId && shown.some((w) => w.id === actionError.workspaceId) ? actionError.workspaceId : null;
  const selectedWindow = windows.length > 1 ? windows.find((w) => w.id === selectedWindowId) : undefined;

  const openMenu = (workspace: WorkspaceInfo, stage: WorkspaceMenuStage = 'menu') => {
    if (pending[workspace.id] || !canManage(workspace)) return;
    setMenu((m) => ({ key: (m?.key ?? 0) + 1, workspace, stage, open: true }));
  };
  const dismissMenu = () => setMenu((m) => (m ? { ...m, open: false } : m));
  const openCreate = () => setCreateDialog((d) => ({ key: (d?.key ?? 0) + 1, open: true }));
  const dismissCreate = () => setCreateDialog((d) => (d ? { ...d, open: false } : d));

  return (
    <View style={styles.screen}>
    {/* The list starts below the status bar so the pull-to-refresh spinner isn't hidden under the scrim. */}
    <ScrollView
      style={[styles.screen, { marginTop: insets.top }]}
      contentContainerStyle={[styles.content, { paddingTop: 12, paddingLeft: insets.left + 16, paddingRight: insets.right + 16 }]}
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

      <SignedOutNotice />
      {banner ? <Text style={styles.banner}>{banner}</Text> : null}
      {offline ? (
        <View style={styles.offline} accessibilityRole="alert">
          <Text style={styles.offlineText}>{offline}</Text>
          <Pressable onPress={() => appStore.wake()} style={({ pressed }) => [styles.retry, pressed && styles.pressed]} accessibilityRole="button" accessibilityLabel="立即重新连接">
            <Text style={styles.retryText}>重试</Text>
          </Pressable>
        </View>
      ) : null}
      {memory.recent.length > 0 ? <View style={styles.recentBlock}>
        <Text style={styles.recentTitle}>最近访问</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.recentList}>
          {[...memory.recent].sort((a, b) => compareActivity(activity[activityKey(a)], activity[activityKey(b)], a.at, b.at)).slice(0, 8).map((entry) => <Pressable key={`${entry.workspaceId}:${entry.surfaceId}`} disabled={status.state !== 'open'} style={styles.recentCard}
            accessibilityRole="button" accessibilityLabel={`继续 ${entry.workspaceTitle} 的 ${entry.title}`} onPress={() => {
              setRecentError(null);
              void openRecentSurface(machine, entry).catch((failure: unknown) => setRecentError(failure instanceof Error ? failure.message : '无法打开这个终端'));
            }}><View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}><TerminalActivityBadge activity={activity[activityKey(entry)]} /><Text style={[styles.recentName, { flex: 1 }]} numberOfLines={1}>{entry.title}</Text></View><Text style={styles.recentMeta} numberOfLines={1}>{entry.workspaceTitle}</Text></Pressable>)}
        </ScrollView>
        {recentError ? <Text style={styles.error}>{recentError}</Text> : null}
      </View> : null}

      <WindowChips windows={windows} selectedId={selectedWindowId} activity={activity} onSelect={(id) => void machine.workspaces.selectWindow(id)} />

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
      {closeError ? <ErrorRow text={closeError} onDismiss={() => setCloseError(null)} /> : null}
      {actionError && !errorOnCard ? <ErrorRow text={actionErrorText(actionError)} onDismiss={() => actions.dismissError()} /> : null}

      {shown.map((workspace) => (
        <WorkspaceCard
          key={workspace.id}
          workspace={workspace}
          surfaces={surfaces[workspace.id] ?? []}
          activity={activity}
          connected={status.state === 'open'}
          unread={unreadByWorkspace[workspace.id] ?? 0}
          needsAttention={pendingByWorkspace[workspace.id] ?? 0}
          pinned={memory.pinned.includes(workspace.id)}
          swipe={swipe}
          onSwipeOpen={cardOpened}
          onPin={(value) => sessionMemory.setPinned(computerId, workspace.id, value)}
          currentSurfaceId={target?.workspaceId === workspace.id ? target.surfaceId : null}
          busy={pending[workspace.id] ?? null}
          error={actionError && errorOnCard === workspace.id ? actionErrorText(actionError) : null}
          onOpen={(surfaceId) => openSurface(machine, workspace.id, surfaceId)}
          onMenu={(stage) => openMenu(workspace, stage)}
          onClose={() => {
            setCloseError(null);
            void requestWorkspaceClose(machine, workspace, confirmClose).catch(error => setCloseError(error instanceof Error ? error.message : '无法关闭工作区'));
          }}
          onDismissError={() => actions.dismissError()}
        />
      ))}

      {loaded && workspaces.length === 0 && !error ? (
        <View style={styles.empty}>
          <Text style={styles.emptyTitle}>{selectedWindow ? `${windowLabel(selectedWindow)}里没有工作区` : '没有工作区'}</Text>
          <Text style={styles.emptyText}>
            {canCreate ? '点右上角的 + 新建一个，或者确认电脑上的终端已经打开，然后下拉刷新。' : '确认电脑上的终端已经打开，或从来源页面检查连接和授权。'}
          </Text>
        </View>
      ) : null}
      {!loaded && !offline && !banner ? <Text style={styles.emptyText}>{status.state === 'open' ? '正在读取工作区…' : '正在连接电脑…'}</Text> : null}
      {loaded && workspaces.length > 0 && shown.length === 0 ? <Text style={styles.emptyText}>没有匹配「{query}」的工作区</Text> : null}
      {swipe && shown.length > 0 ? <Text style={styles.hint}>{shown.some(w => canManage(w)) ? '向左滑动卡片可以置顶或关闭；长按可以重命名' : '向左滑动卡片可以置顶'}</Text>
        : shown.some(w => canManage(w)) ? <Text style={styles.hint}>点 × 关闭工作区；长按可以重命名</Text> : null}

      {createDialog ? (
        <NameDialog
          key={createDialog.key}
          visible={createDialog.open}
          title="新建工作区"
          message={selectedWindow ? `会建在${windowLabel(selectedWindow)}里。` : undefined}
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
    <StatusBarScrim />
    </View>
  );
}

/** True once `connecting` has lasted SLOW_CONNECT_MS; resets as soon as it stops. */
function useSlowConnect(connecting: boolean): boolean {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (!connecting) return;
    const timer = setTimeout(() => setSlow(true), SLOW_CONNECT_MS);
    return () => {
      clearTimeout(timer);
      setSlow(false);
    };
  }, [connecting]);
  return connecting && slow;
}

/** A reconnect attempt keeps the reason the previous one failed, so the banner does not flicker. */
function useSteadyStatus(status: ConnectionStatus): ConnectionStatus {
  const [reason, setReason] = useState<CloseReason | null>(null);
  if (status.state === 'waiting' && status.reason !== reason) setReason(status.reason);
  if ((status.state === 'open' || status.state === 'auth_failed') && reason !== null) setReason(null);
  if (status.state === 'connecting' && status.attempt > 0 && reason) return { state: 'waiting', attempt: status.attempt, retryAt: 0, reason };
  return status;
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
  activity: ActivityState;
  connected: boolean;
  unread: number;
  needsAttention: number;
  pinned: boolean;
  onPin: (pinned: boolean) => void;
  /** 置顶 and 关闭 sit behind a left swipe instead of in the title row. */
  swipe: boolean;
  onSwipeOpen: (id: string, methods: SwipeableMethods) => void;
  currentSurfaceId: string | null;
  /** A rename or close running on this workspace; the card is disabled meanwhile. */
  busy: 'rename' | 'close' | null;
  error: string | null;
  onOpen: (surfaceId: string) => void;
  onMenu: (stage?: WorkspaceMenuStage) => void;
  onClose: () => void;
  onDismissError: () => void;
};

function WorkspaceCard({ workspace, surfaces, activity, connected, unread, needsAttention, pinned, onPin, swipe, onSwipeOpen, currentSurfaceId, busy, error, onOpen, onMenu, onClose, onDismissError }: CardProps) {
  const swipeable = useRef<SwipeableMethods>(null);
  // A tap on an open card closes it, as in Mail, instead of opening the terminal.
  const [swiped, setSwiped] = useState(false);
  const closable = canManage(workspace);
  const closeDisabled = busy !== null || !connected;
  const pinLabel = pinned ? '取消置顶' : '置顶';
  const fromSwipe = (action: () => void) => { swipeable.current?.close(); action(); };
  const primary = surfaces.find((s) => s.id === currentSurfaceId) ?? surfaces.find((s) => s.focused) ?? surfaces[0];
  const isCurrent = currentSurfaceId !== null;
  const surfaceActivity = (surface: SurfaceInfo) => activity[activityKey({ workspaceId: workspace.id, surfaceId: surface.id })];
  const running = surfaces.filter((surface) => surfaceActivity(surface)?.status === 'running');
  const meta = busy === 'rename' ? '正在重命名…' : busy === 'close' ? '正在关闭…' : `${surfaces.length} 个终端${workspace.access === 'read' ? ' · 只读' : workspace.access === 'shared' ? ' · 别人分享的窗口' : ''}${workspace.selected ? ' · 电脑上正在用' : ''}`;
  const card = (
    <View style={[styles.card, isCurrent && styles.cardCurrent, busy && styles.cardBusy]}>
      <Pressable
        onPress={() => { if (swiped) swipeable.current?.close(); else if (primary) onOpen(primary.id); }}
        onLongPress={() => onMenu()}
        disabled={busy !== null}
        style={({ pressed }) => [styles.cardHeader, pressed && styles.pressed]}
        accessibilityRole="button"
        accessibilityLabel={`${workspace.title}，${surfaces.length} 个终端${needsAttention ? `，${needsAttention} 项待处理` : ''}${swipe && pinned ? '，已置顶' : ''}`}
        accessibilityHint={swipe ? '向左滑动可以置顶或关闭，长按可以重命名' : '长按可以重命名或关闭'}
        accessibilityState={{ disabled: busy !== null, busy: busy !== null }}
        accessibilityValue={running.length ? { text: `${running.length} 个正在运行` } : undefined}
        accessibilityActions={[
          { name: 'longpress', label: '更多操作' },
          { name: 'rename', label: '重命名' },
          { name: 'close', label: '关闭' },
          { name: 'pin', label: pinLabel },
        ]}
        onAccessibilityAction={(event) => {
          const action = event.nativeEvent.actionName;
          if (action === 'pin') onPin(!pinned);
          else onMenu(action === 'rename' || action === 'close' ? action : 'menu');
        }}
      >
        <View style={[styles.index, isCurrent && styles.indexCurrent]}>
          <Text style={[styles.indexText, isCurrent && styles.indexTextCurrent]}>{String(workspace.index + 1).padStart(2, '0')}</Text>
        </View>
        <View style={styles.cardText}>
          <View style={styles.cardTitleRow}>
            {running.length ? <TerminalActivityBadge activity={surfaceActivity(running[0])} /> : null}
            <Text style={styles.cardTitle} numberOfLines={1}>
              {workspace.title}
            </Text>
            {swipe && pinned ? <Text style={styles.pinMark}>★</Text> : null}
          </View>
          <Text style={styles.cardMeta} numberOfLines={1}>
            {needsAttention ? <Text style={{ color: colors.yellow }}>{needsAttention} 项待处理 · </Text> : null}
            {running.length && !busy ? <Text style={{ color: colors.green }}>{surfaces.length > 1 ? `${running.length} 个正在运行` : '正在运行'} · </Text> : null}{meta}
          </Text>
        </View>
        {swipe ? null : <Pressable onPress={(event) => { event.stopPropagation(); onPin(!pinned); }} hitSlop={6} style={styles.pin} accessibilityRole="button" accessibilityLabel={`${pinLabel} ${workspace.title}`}>
          <Text style={[styles.pinText, pinned && styles.pinActive]}>{pinned ? '★' : '☆'}</Text>
        </Pressable>}
        {swipe || !closable ? null : <CloseButton label={`关闭工作区 ${workspace.title}`} disabled={closeDisabled} onPress={onClose} />}
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
            const runningHere = surfaceActivity(surface)?.status === 'running';
            return (
              <Pressable
                key={surface.id}
                onPress={() => onOpen(surface.id)}
                onLongPress={() => onMenu()}
                disabled={busy !== null}
                style={({ pressed }) => [styles.surface, pressed && styles.pressed]}
                accessibilityRole="button"
                accessibilityLabel={`打开终端 ${surface.title}`}
                accessibilityValue={runningHere ? { text: '正在运行' } : undefined}
              >
                {runningHere ? <View style={styles.surfaceMarkBox}><TerminalActivityBadge activity={surfaceActivity(surface)} /></View>
                  : <Text style={[styles.surfaceMark, current && styles.surfaceMarkCurrent]}>{current ? '›' : '·'}</Text>}
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
  if (!swipe) return card;
  // The swipeable draws the actions as the card slides away. Taps inside its
  // action area did not reach the buttons there (the row stayed open and
  // nothing happened), so while the card is open the buttons that take the
  // tap sit over that area, outside the swipeable.
  const actions = (interactive: boolean) => (
    <View style={styles.swipeActions} pointerEvents={interactive ? 'auto' : 'none'}
      accessibilityElementsHidden={!interactive} importantForAccessibility={interactive ? 'auto' : 'no-hide-descendants'}>
      <Pressable onPress={() => fromSwipe(() => onPin(!pinned))} style={({ pressed }) => [styles.swipeAction, !interactive && styles.pinAction, pressed && styles.swipePressed]}
        accessibilityRole="button" accessibilityLabel={`${pinLabel} ${workspace.title}`}>
        {interactive ? null : <Text style={styles.swipeText}>{pinLabel}</Text>}
      </Pressable>
      {closable ? (
        <Pressable onPress={() => fromSwipe(onClose)} disabled={closeDisabled}
          style={({ pressed }) => [styles.swipeAction, !interactive && styles.closeAction, !interactive && closeDisabled && styles.dimmed, pressed && styles.swipePressed]}
          accessibilityRole="button" accessibilityLabel={`关闭工作区 ${workspace.title}`} accessibilityState={{ disabled: closeDisabled }}>
          {interactive ? null : <Text style={[styles.swipeText, styles.closeText]}>关闭</Text>}
        </Pressable>
      ) : null}
    </View>
  );
  return (
    <View>
      <Swipeable
        ref={swipeable}
        enabled={busy === null}
        friction={1.5}
        rightThreshold={40}
        overshootRight={false}
        containerStyle={styles.swipeContainer}
        onSwipeableWillOpen={() => { setSwiped(true); if (swipeable.current) onSwipeOpen(workspace.id, swipeable.current); }}
        onSwipeableWillClose={() => setSwiped(false)}
        renderRightActions={() => actions(false)}
      >
        {card}
      </Swipeable>
      {swiped ? <View style={styles.swipeOverlay} pointerEvents="box-none">{actions(true)}</View> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  recentBlock: { gap: 8 }, recentTitle: { color: colors.inkDim, fontSize: 13 }, recentList: { gap: 8 }, recentCard: { width: 160, borderRadius: 8, backgroundColor: colors.surface, padding: 10, gap: 4 }, recentName: { color: colors.ink, fontSize: 13 }, recentMeta: { color: colors.muted, fontSize: 11 },
  pin: { padding: 5 }, pinText: { color: colors.mutedDim, fontSize: 20 }, pinActive: { color: colors.yellow },
  pinMark: { color: colors.yellow, fontSize: 13 },
  swipeContainer: { borderRadius: 12 },
  swipeActions: { flexDirection: 'row' },
  swipeAction: { width: 76, alignItems: 'center', justifyContent: 'center' },
  pinAction: { backgroundColor: colors.surfaceRaised },
  closeAction: { backgroundColor: colors.red },
  swipeText: { color: colors.ink, fontSize: 15, fontWeight: '600' },
  swipeOverlay: { position: 'absolute', top: 0, right: 0, bottom: 0, flexDirection: 'row' },
  swipePressed: { backgroundColor: 'rgba(0, 0, 0, 0.2)' },
  closeText: { color: colors.canvas },
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
  offline: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingLeft: 12, paddingVertical: 4, borderRadius: 10, backgroundColor: colors.surface, borderLeftWidth: 3, borderLeftColor: colors.orange },
  offlineText: { flex: 1, color: colors.ink, fontSize: 13, lineHeight: 18, paddingVertical: 8 },
  retry: { minWidth: 64, minHeight: 44, paddingHorizontal: 14, alignItems: 'center', justifyContent: 'center', borderRadius: 8 },
  retryText: { color: colors.blue, fontSize: 15, fontWeight: '600' },
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
  cardTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  cardTitle: { flexShrink: 1, color: colors.ink, fontSize: 16, fontWeight: '600' },
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
  surfaceMarkBox: { width: 12, alignItems: 'center' },
  surfaceMarkCurrent: { color: colors.green },
  surfaceTitle: { flex: 1, color: colors.inkDim, fontSize: 14 },
  surfaceTitleCurrent: { color: colors.ink },
  surfaceBadge: { color: colors.muted, fontSize: 11 },
  empty: { alignItems: 'center', gap: 6, paddingVertical: 40 },
  emptyTitle: { color: colors.inkDim, fontSize: 15 },
  emptyText: { color: colors.muted, fontSize: 13, textAlign: 'center' },
  hint: { color: colors.mutedDim, fontSize: 12, textAlign: 'center', marginTop: 4 },
});
