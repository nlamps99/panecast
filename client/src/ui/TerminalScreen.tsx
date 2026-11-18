import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Pressable, ScrollView, StyleSheet, Switch, Text, View, useWindowDimensions } from 'react-native';
import { confirmClose } from '../platform/confirm';
import { desktopBridge } from '../platform/desktop';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { TerminalInputHandle } from '../../modules/terminal-input';
import type { ConnectionStatus } from '../protocol/connection';
import { HostStatusStore } from '../session/hostStatus';
import { SurfaceActions } from '../session/surfaceActions';
import { canCloseTerminal, pickDefaultTarget } from '../session/surfaces';
import { requestTerminalClose } from '../session/closeRequests';
import { actionErrorText, workspaceActionsFor } from '../session/workspaceActions';
import { describeError } from '../session/terminalSession';
import { TerminalConversationStore } from '../session/terminalConversation';
import { useConnectionStatus, useMachine, useStore } from '../state/hooks';
import { backToWorkspaces } from '../state/navigation';
import { clampFontSize, FONT_SIZE_MAX, FONT_SIZE_MIN, setPrefs, usePrefs } from '../state/prefs';
import { sessionMemory } from '../state/sessionMemory';
import { BatteryBadge } from './BatteryBadge';
import { Icon } from './Icon';
import { InputBar } from './InputBar';
import { ProjectBrowser } from './ProjectBrowser';
import { SharedFilesBar, SharedFilesSheet } from './SharedFiles';
import { SharedFilesStore } from '../session/sharedFiles';
import { statusBanner, statusColor, statusLabel } from './status';
import { Sheet, SheetRow, useSheet } from './Sheet';
import { terminalColumns, TerminalView, type TerminalViewHandle } from './TerminalView';
import { TerminalChatView } from './TerminalChatView';
import { colors } from './theme';
import { useKeyboardVisible } from './useKeyboardVisible';
import { WorkspaceSidebar } from './WorkspaceSidebar';
import { onDesktopCommand, useDesktopShell } from './desktopShell';
import { CloseButton } from './CloseButton';
import { activityKey } from '../session/terminalActivity';
import { TerminalActivityBadge, useTerminalActivity } from './TerminalActivityBadge';

/**
 * The terminal tab. Top to bottom: back to the list, the workspace and its
 * terminals (hidden while typing), the terminal, the key row, and the input
 * right above the keyboard. The tab bar is hidden here.
 *
 * In the chip row, "+" opens a new terminal in the workspace and × (or a long
 * press) closes one on the computer. The title row shows the Mac's battery.
 *
 * On a phone the title row also holds the chat/terminal switch and a "⋯"
 * menu (files, search and copy, wrapping, text size), so the rows that held
 * them go to the terminal. The desktop keeps them in rows of their own.
 */
export function TerminalScreen() {
  const { width, height } = useWindowDimensions();
  const { tabletSidebar } = usePrefs();
  const insets = useSafeAreaInsets();
  // The desktop window draws its sidebar around every page; tablets get one here.
  const desktopShell = useDesktopShell();
  const split = !desktopShell && tabletSidebar && width >= 850 && Math.min(width, height) >= 600;
  return <View style={styles.layout}>
    {split ? <View style={{ paddingTop: insets.top, paddingBottom: insets.bottom, backgroundColor: colors.surfaceSunken }}><WorkspaceSidebar /></View> : null}
    <TerminalPane sidebar={split || desktopShell} />
  </View>;
}

function TerminalPane({ sidebar }: { sidebar: boolean }) {
  const insets = useSafeAreaInsets();
  const { width: windowWidth } = useWindowDimensions();
  const machine = useMachine();
  const { channel, session } = machine;
  const status = useConnectionStatus(channel);
  const state = useStore(session);
  const { workspaces, surfaces, known } = useStore(machine.workspaces);
  const { fontSize, inputMode, desktopInputMode, terminalPresentation, terminalWrap } = usePrefs();
  const desktop = desktopBridge() !== null;
  const compact = !desktop;
  const menu = useSheet();
  const terminalView = useRef<TerminalViewHandle>(null);
  const chat = terminalPresentation === 'chat';
  const conversation = useMemo(() => new TerminalConversationStore(channel, session, machine.terminalRepository), [channel, session, machine.terminalRepository]);
  const inputRef = useRef<TerminalInputHandle>(null);
  const desktopShell = useDesktopShell();
  const keyboardVisible = useKeyboardVisible();
  const [targetError, setTargetError] = useState<string | null>(null);
  const [projectOpen, setProjectOpen] = useState(false);
  // A window someone shared: its folder's files open with this device's own apps.
  const shared = Boolean(machine.computer?.share);
  const sharedFiles = useMemo(() => shared ? new SharedFilesStore(channel) : null, [shared, channel]);
  const [filesOpen, setFilesOpen] = useState(false);
  const showFiles = () => shared ? setFilesOpen(true) : setProjectOpen(true);
  const [terminalActive, setTerminalActive] = useState(false);
  const target = state.target;
  const isOpen = status.state === 'open';
  const actions = useMemo(() => new SurfaceActions(machine), [machine]);
  const { running, error: actionError } = useStore(actions);
  const workspaceActions = workspaceActionsFor(machine);
  const workspaceActionState = useStore(workspaceActions);
  const host = useMemo(() => new HostStatusStore(channel), [channel]);
  const { battery } = useStore(host);
  const activity = useTerminalActivity(machine);
  useEffect(() => () => conversation.dispose(), [conversation]);
  useEffect(() => {
    if (!sharedFiles || !terminalActive) return;
    sharedFiles.start();
    return () => sharedFiles.stop();
  }, [sharedFiles, terminalActive]);
  useEffect(() => {
    if (terminalActive && chat) conversation.start(); else conversation.stop();
    return () => conversation.stop();
  }, [conversation, terminalActive, chat]);

  // Battery: read on focus, then every minute until the tab loses focus.
  useFocusEffect(
    useCallback(() => {
      setTerminalActive(true);
      host.start();
      const current = machine.session.getState().target;
      if (machine.computer && current) {
        const previous = sessionMemory.computer(machine.computer.id).recent.find((entry) => entry.workspaceId === current.workspaceId && entry.surfaceId === current.surfaceId);
        if (previous) sessionMemory.visit(machine.computer.id, previous);
      }
      return () => { setTerminalActive(false); host.stop(); };
    }, [host, machine]),
  );

  // An action's error belongs to the workspace it was made in.
  const workspaceId = target?.workspaceId;
  useEffect(() => {
    actions.clearError();
  }, [actions, workspaceId]);

  // Opened from the tab bar before choosing a terminal: follow whatever cmux has focused.
  useEffect(() => {
    if (!isOpen || session.getState().target) return;
    const intent = session.selectionVersion;
    let cancelled = false;
    pickDefaultTarget(channel)
      .then((picked) => {
        if (cancelled || session.getState().target || session.selectionVersion !== intent) return;
        if (picked) {
          setTargetError(null);
          session.setTarget(picked);
        } else {
          setTargetError('电脑上没有打开的终端');
        }
      })
      .catch((error: unknown) => {
        if (!cancelled && !session.getState().target && session.selectionVersion === intent) setTargetError(describeError(error));
      });
    return () => {
      cancelled = true;
    };
  }, [isOpen, channel, session]);

  // The list may show another cmux window; the open terminal keeps its own titles.
  const workspace = workspaces.find((w) => w.id === target?.workspaceId) ?? (target ? known.workspaces[target.workspaceId] : undefined);
  const readOnly = workspace?.access === 'read';
  // Desktop: whatever selected a terminal (sidebar, tab, shortcut), typing goes
  // to it next, and coming back to the window resumes typing where it was.
  const focusInput = useCallback(() => {
    if (!desktop || readOnly) return;
    const active = typeof document !== 'undefined' ? document.activeElement : null;
    // Never take the keys from a field the user is typing in (sidebar filter, dialogs).
    if (active && active !== document.body && (active.tagName === 'INPUT' || (active.tagName === 'TEXTAREA' && !active.closest('#panecast-terminal')))) return;
    if (typeof window !== 'undefined' && window.getSelection()?.isCollapsed === false) return;
    void inputRef.current?.focus();
  }, [desktop, readOnly]);
  useEffect(() => {
    if (!desktop || !terminalActive) return;
    const timer = setTimeout(focusInput, 0);
    return () => clearTimeout(timer);
  }, [desktop, terminalActive, target?.workspaceId, target?.surfaceId, terminalPresentation, focusInput]);
  useEffect(() => {
    if (!desktop || typeof window === 'undefined') return;
    const regained = () => { if (terminalActive) setTimeout(focusInput, 0); };
    window.addEventListener('focus', regained);
    return () => window.removeEventListener('focus', regained);
  }, [desktop, terminalActive, focusInput]);
  useEffect(() => onDesktopCommand((command) => {
    if (command.kind === 'find' && !chat) terminalView.current?.openTools();
    if (command.kind === 'focus') setTimeout(() => { if (!readOnly) void inputRef.current?.focus(); }, 0);
  }), [chat, readOnly]);

  const siblings = target ? (surfaces[target.workspaceId] ?? known.surfaces[target.workspaceId] ?? []) : [];
  const surface = siblings.find((s) => s.id === target?.surfaceId);
  const banner = statusBanner(status) ?? state.subscriptionError ?? targetError;
  // The last reading stays in the store while disconnected; it is stale, so hide it.
  const showBattery = isOpen && battery !== null;
  const side = { paddingLeft: insets.left, paddingRight: insets.right };
  const presentationTabs = (['chat', 'terminal'] as const).map(mode => <Pressable key={mode} onPress={() => setPrefs({ terminalPresentation: mode })}
    style={[compact ? styles.segmentTab : styles.presentationTab, mode === terminalPresentation && styles.presentationSelected]} accessibilityRole="tab" accessibilityState={{ selected: mode === terminalPresentation }}
    accessibilityLabel={mode === 'chat' ? '对话模式' : '终端模式'}>
    <Text style={[styles.presentationText, mode === terminalPresentation && styles.presentationTextSelected]}>{mode === 'chat' ? '对话' : '终端'}</Text>
  </Pressable>);
  const changeFontSize = (delta: number) => setPrefs({ fontSize: clampFontSize(fontSize + delta) });
  // The phone's terminal spans the window, less the safe area.
  const columns = sidebar ? null : terminalColumns(windowWidth - insets.left - insets.right, fontSize);

  return (
    // Android too: edge-to-edge (forced from API 35) stops adjustResize from shrinking the window.
    <KeyboardAvoidingView nativeID="panecast-terminal" style={styles.screen} behavior="padding">
      <View style={[styles.header, compact && styles.compactHeader, side, { paddingTop: insets.top }]}>
        <View style={[styles.titleRow, desktopShell && styles.desktopTitleRow]}>
          {desktopShell ? null : <Pressable
            onPress={backToWorkspaces}
            style={({ pressed }) => [styles.back, pressed && styles.pressed]}
            hitSlop={6}
            accessibilityRole="button"
            accessibilityLabel="返回工作区"
          >
            <Icon name="back" size={17} color={colors.ink} />
          </Pressable>}
          <View style={styles.titleText}>
            <Text style={styles.title} numberOfLines={1}>
              {workspace?.title ?? '终端'}
            </Text>
            <View style={styles.subtitleRow}>
              <View style={[styles.dot, { backgroundColor: machine.mode === 'demo' ? colors.yellow : statusColor(status) }]} />
              <Text style={styles.subtitle} numberOfLines={1}>
                {status.state === 'open' ? (surface?.title ?? '') : statusLabel(status)}
              </Text>
            </View>
          </View>
          {compact ? <View style={styles.segment} accessibilityRole="tablist">{presentationTabs}</View> : null}
          {!compact && target ? <Pressable onPress={showFiles} style={styles.back} accessibilityRole="button" accessibilityLabel={shared ? '查看分享目录里的文件' : '查看项目文件与 Git 改动'}><Text style={{ color: colors.blue, fontSize: 13 }}>文件</Text></Pressable> : null}
          {showBattery || machine.mode === 'demo' ? (
            <View style={[styles.badges, compact && styles.compactBadges]}>
              {showBattery ? <BatteryBadge battery={battery} onPress={() => void host.refresh()} /> : null}
              {machine.mode === 'demo' ? <Text style={styles.demoBadge}>演示</Text> : null}
            </View>
          ) : null}
          {compact ? <Pressable onPress={menu.open} style={({ pressed }) => [styles.back, pressed && styles.pressed]} hitSlop={4}
            accessibilityRole="button" accessibilityLabel="更多：文件、搜索复制、折行、字号">
            <Text style={styles.moreText}>⋯</Text>
          </Pressable> : null}
        </View>
        {!keyboardVisible && target && siblings.length > 0 ? (
          <>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={[styles.chips, compact && styles.compactChips]}>
              {siblings.map((item) => {
                const selected = item.id === target.surfaceId;
                const itemActivity = activity[activityKey({ workspaceId: target.workspaceId, surfaceId: item.id })];
                const closable = canCloseTerminal(workspace, siblings.length);
                const busy = running !== null || Boolean(workspaceActionState.pending[target.workspaceId]);
                const close = () => {
                  if (!isOpen || !workspace || readOnly || busy) return;
                  void requestTerminalClose(machine, actions, workspace, item, confirmClose).then(() => {
                    // The last terminal took its workspace with it. Without a sidebar there
                    // is nothing left to show here, so return to the list instead of
                    // following some other terminal that cmux has focused.
                    if (!desktop && !sidebar && session.getState().target === null) backToWorkspaces();
                  }, error => setTargetError(describeError(error)));
                };
                return (
                  <View key={item.id} style={[styles.terminalChip, selected && styles.chipSelected, busy && !selected && styles.chipBusy]}>
                  <Pressable
                    onPress={() => {
                      actions.clearError();
                      session.setTarget({ workspaceId: target.workspaceId, surfaceId: item.id });
                    }}
                    onLongPress={close}
                    disabled={busy}
                    style={styles.terminalChipLabel}
                    accessibilityRole="tab"
                    accessibilityLabel={item.title}
                    accessibilityState={{ selected, disabled: busy }}
                    accessibilityValue={itemActivity?.status === 'running' ? { text: '正在运行' } : undefined}
                    accessibilityHint={closable ? '长按可以关闭这个终端' : undefined}
                  >
                    <TerminalActivityBadge activity={itemActivity} color={selected ? colors.green : colors.muted} />
                    <Text style={[styles.chipText, selected && styles.chipTextSelected]} numberOfLines={1}>
                      {item.title}
                    </Text>
                  </Pressable>
                  {closable ? <CloseButton label={`关闭终端 ${item.title}`} disabled={busy || !isOpen} onPress={close} /> : null}
                  </View>
                );
              })}
              <Pressable
                onPress={() => void actions.create(target.workspaceId)}
                disabled={running !== null || readOnly}
                style={({ pressed }) => [styles.chip, styles.newChip, pressed && styles.newChipPressed, running === 'close' && styles.chipBusy]}
                accessibilityRole="button"
                accessibilityLabel="新建终端"
                accessibilityState={{ disabled: running !== null || readOnly, busy: running === 'create' }}
              >
                <View style={styles.newChipIcon}>
                  {running === 'create' ? (
                    <ActivityIndicator size="small" color={colors.green} style={styles.newChipSpinner} />
                  ) : (
                    <Icon name="plus" size={12} color={colors.green} />
                  )}
                </View>
                <Text style={styles.newChipText}>新建</Text>
              </Pressable>
            </ScrollView>
            {actionError ? (
              <Text style={styles.actionError} numberOfLines={2}>
                {actionError}
              </Text>
            ) : null}
            {workspaceActionState.error?.workspaceId === target.workspaceId ? <Text style={styles.actionError}>{actionErrorText(workspaceActionState.error)}</Text> : null}
          </>
        ) : null}
      </View>
      {!compact ? <View style={[styles.presentation, side]} accessibilityRole="tablist">
        {presentationTabs}
        {chat ? <Text style={styles.chatHint} numberOfLines={1}>直接发送到当前终端</Text> : null}
      </View> : null}
      {banner ? <Text style={[styles.banner, side]}>{banner}</Text> : null}
      <View style={[styles.terminal, side]}>
        {chat ? <TerminalChatView store={conversation} session={session} connected={isOpen} readOnly={readOnly} onShowTerminal={() => setPrefs({ terminalPresentation: 'terminal' })} /> : <TerminalView
          ref={terminalView}
          compact={compact}
          active={terminalActive}
          readOnly={readOnly}
          key={`${machine.computer?.id ?? 'demo'}:${target?.workspaceId}:${target?.surfaceId}`}
          session={session}
          state={state}
          fontSize={fontSize}
          onFontSizeChange={(size) => setPrefs({ fontSize: size })}
          placeholder={placeholderFor(status, Boolean(target))}
          onTap={() => {
            if (!desktop) void inputRef.current?.blur();
            else if (!readOnly && window.getSelection()?.isCollapsed !== false) void inputRef.current?.focus();
          }}
        />}
      </View>
      <View style={[styles.bottom, side, { paddingBottom: keyboardVisible ? 0 : Math.max(insets.bottom - 10, 0) }]}>
        {readOnly ? <Text style={{ color: colors.yellow, padding: 12 }}>这个连接源只允许读取</Text> : null}
        {sharedFiles && target ? <SharedFilesBar store={sharedFiles} onShowAll={() => setFilesOpen(true)} /> : null}
        <InputBar key={`${machine.computer?.id ?? 'demo'}:${target?.workspaceId}:${target?.surfaceId}:${terminalPresentation}:${desktop ? desktopInputMode : inputMode}`} session={session} disabled={!target || readOnly} error={state.input.error} inputRef={inputRef}
          presentation={terminalPresentation} onSubmitLine={chat ? text => conversation.send(text) : undefined} />
      </View>
      {sharedFiles ? <SharedFilesSheet store={sharedFiles} visible={filesOpen} onClose={() => setFilesOpen(false)} /> : null}
      {projectOpen && target ? <ProjectBrowser key={`${machine.computer?.id}:${target.surfaceId}`} target={target} channel={channel} onClose={() => setProjectOpen(false)} /> : null}
      {compact ? <Sheet visible={menu.visible} title="终端" onClose={() => menu.close()} onClosed={menu.onClosed}>
        {target ? <SheetRow title={shared ? '分享目录里的文件' : '项目文件与 Git 改动'} detail={shared ? '点文件用本机应用打开' : '浏览目录，查看未提交的改动'} divided={false} onPress={() => menu.close(showFiles)} /> : null}
        {!chat ? <>
          <SheetRow icon="search" title="搜索 · 复制输出" divided={Boolean(target)} accessibilityLabel="搜索和复制终端输出" onPress={() => menu.close(() => terminalView.current?.openTools())} />
          <SheetRow title="自动折行" detail={terminalWrap ? '按手机宽度折行，续行与上一行的正文对齐' : '保留电脑上的原始列宽，左右滑动查看'}
            accessibilityLabel={`自动折行：${terminalWrap ? '开' : '关'}`} selected={terminalWrap} onPress={() => setPrefs({ terminalWrap: !terminalWrap })}
            trailing={<Switch value={terminalWrap} onValueChange={value => setPrefs({ terminalWrap: value })} trackColor={{ false: colors.divider, true: colors.green }} ios_backgroundColor={colors.divider} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" />} />
          <View style={styles.sizeRow}>
            <View style={styles.sizeText}>
              <Text style={styles.sizeTitle}>文字大小</Text>
              <Text style={styles.sizeDetail}>{fontSize} pt{columns ? ` · 每行 ${columns} 列` : ''} · 也可以双指缩放</Text>
            </View>
            <Pressable onPress={() => changeFontSize(-1)} disabled={fontSize <= FONT_SIZE_MIN} style={({ pressed }) => [styles.sizeButton, pressed && styles.pressed, fontSize <= FONT_SIZE_MIN && styles.chipBusy]}
              accessibilityRole="button" accessibilityLabel="缩小文字" accessibilityValue={{ text: `${fontSize} pt` }}><Text style={styles.sizeButtonText}>A−</Text></Pressable>
            <Pressable onPress={() => changeFontSize(1)} disabled={fontSize >= FONT_SIZE_MAX} style={({ pressed }) => [styles.sizeButton, pressed && styles.pressed, fontSize >= FONT_SIZE_MAX && styles.chipBusy]}
              accessibilityRole="button" accessibilityLabel="放大文字" accessibilityValue={{ text: `${fontSize} pt` }}><Text style={styles.sizeButtonText}>A+</Text></Pressable>
          </View>
        </> : null}
      </Sheet> : null}
    </KeyboardAvoidingView>
  );
}

function placeholderFor(status: ConnectionStatus, hasTarget: boolean): string | null {
  if (status.state === 'connecting' || status.state === 'idle') return '正在连接电脑…';
  if (status.state !== 'open') return null;
  return hasTarget ? '正在读取终端…' : '正在查找终端…';
}

const styles = StyleSheet.create({
  layout: { flex: 1, flexDirection: 'row', backgroundColor: colors.canvas },
  presentation: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 12, paddingVertical: 6, backgroundColor: colors.surfaceSunken },
  presentationTab: { borderRadius: 7, paddingHorizontal: 16, paddingVertical: 7 }, presentationSelected: { backgroundColor: colors.surfaceRaised },
  presentationText: { color: colors.muted, fontSize: 13 }, presentationTextSelected: { color: colors.green, fontWeight: '600' },
  chatHint: { flex: 1, textAlign: 'right', paddingRight: 8, color: colors.muted, fontSize: 11 },
  segment: { flexDirection: 'row', height: 30, padding: 2, borderRadius: 8, backgroundColor: colors.surface },
  segmentTab: { paddingHorizontal: 10, justifyContent: 'center', borderRadius: 6 },
  moreText: { color: colors.ink, fontSize: 20, lineHeight: 22, fontWeight: '700' },
  compactHeader: { paddingBottom: 6 },
  compactBadges: { marginRight: 0 },
  compactChips: { paddingTop: 4 },
  sizeRow: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 54, paddingHorizontal: 18, paddingVertical: 9, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.divider },
  sizeText: { flex: 1, gap: 2 },
  sizeTitle: { color: colors.ink, fontSize: 16 },
  sizeDetail: { color: colors.muted, fontSize: 12 },
  sizeButton: { width: 44, height: 36, borderRadius: 8, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surfaceRaised },
  sizeButtonText: { color: colors.ink, fontSize: 15, fontWeight: '600' },
  screen: { flex: 1, backgroundColor: colors.canvas },
  header: {
    backgroundColor: colors.surfaceSunken,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.divider,
    paddingBottom: 8,
  },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 6, paddingTop: 4 },
  desktopTitleRow: { paddingLeft: 14 },
  back: { width: 36, height: 36, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  pressed: { backgroundColor: colors.surface },
  titleText: { flex: 1, gap: 2 },
  title: { color: colors.ink, fontSize: 15, fontWeight: '600' },
  subtitleRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  dot: { width: 6, height: 6, borderRadius: 3 },
  subtitle: { flexShrink: 1, color: colors.muted, fontSize: 12 },
  badges: { flexDirection: 'row', alignItems: 'center', gap: 6, marginRight: 8 },
  demoBadge: {
    color: colors.canvas,
    backgroundColor: colors.yellow,
    fontSize: 11,
    fontWeight: '600',
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 4,
    overflow: 'hidden',
  },
  chips: { gap: 6, paddingHorizontal: 12, paddingTop: 8 },
  terminalChip: { maxWidth: 230, height: 30, flexDirection: 'row', alignItems: 'center', borderRadius: 8, backgroundColor: colors.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.divider },
  terminalChipLabel: { flexShrink: 1, height: 28, flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12 },
  chip: {
    maxWidth: 200,
    height: 30,
    paddingHorizontal: 12,
    justifyContent: 'center',
    borderRadius: 8,
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.divider,
  },
  chipSelected: { backgroundColor: colors.surfaceRaised, borderColor: colors.green },
  chipBusy: { opacity: 0.6 },
  chipText: { flexShrink: 1, color: colors.muted, fontSize: 13 },
  chipTextSelected: { color: colors.ink, fontWeight: '600' },
  newChip: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 10, borderColor: colors.green },
  newChipPressed: { backgroundColor: colors.surfaceRaised },
  newChipIcon: { width: 14, height: 14, alignItems: 'center', justifyContent: 'center' },
  newChipSpinner: { transform: [{ scale: 0.7 }] },
  newChipText: { color: colors.green, fontSize: 13, fontWeight: '600' },
  actionError: { color: colors.red, fontSize: 12, lineHeight: 16, paddingHorizontal: 12, paddingTop: 6 },
  banner: {
    color: colors.yellow,
    fontSize: 13,
    lineHeight: 18,
    paddingHorizontal: 14,
    paddingVertical: 8,
    backgroundColor: colors.surfaceRaised,
  },
  terminal: { flex: 1 },
  bottom: {
    backgroundColor: colors.surfaceSunken,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.divider,
  },
});
