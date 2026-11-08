import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { TerminalInputHandle } from '../../modules/terminal-input';
import type { ConnectionStatus } from '../protocol/connection';
import { HostStatusStore } from '../session/hostStatus';
import { canCloseSurface, SurfaceActions } from '../session/surfaceActions';
import { pickDefaultTarget, type SurfaceInfo } from '../session/surfaces';
import { describeError } from '../session/terminalSession';
import { TerminalConversationStore } from '../session/terminalConversation';
import { useConnectionStatus, useMachine, useStore } from '../state/hooks';
import { backToWorkspaces } from '../state/navigation';
import { setPrefs, usePrefs } from '../state/prefs';
import { sessionMemory } from '../state/sessionMemory';
import { BatteryBadge } from './BatteryBadge';
import { Icon } from './Icon';
import { InputBar } from './InputBar';
import { ProjectBrowser } from './ProjectBrowser';
import { statusBanner, statusColor, statusLabel } from './status';
import { TerminalView } from './TerminalView';
import { TerminalChatView } from './TerminalChatView';
import { colors } from './theme';
import { useKeyboardVisible } from './useKeyboardVisible';
import { WorkspaceSidebar } from './WorkspaceSidebar';

/**
 * The terminal tab. Top to bottom: back to the list, the workspace and its
 * terminals (hidden while typing), the terminal, the key row, and the input
 * right above the keyboard. The tab bar is hidden here.
 *
 * In the chip row, "+" opens a new terminal in the workspace and a long press
 * closes one on the Mac. The title row shows the Mac's battery.
 */
export function TerminalScreen() {
  const { width, height } = useWindowDimensions();
  const { tabletSidebar } = usePrefs();
  const insets = useSafeAreaInsets();
  const split = tabletSidebar && width >= 850 && Math.min(width, height) >= 600;
  return <View style={styles.layout}>
    {split ? <View style={{ paddingTop: insets.top, paddingBottom: insets.bottom, backgroundColor: colors.surfaceSunken }}><WorkspaceSidebar /></View> : null}
    <TerminalPane />
  </View>;
}

function TerminalPane() {
  const insets = useSafeAreaInsets();
  const machine = useMachine();
  const { channel, session } = machine;
  const status = useConnectionStatus(channel);
  const state = useStore(session);
  const { workspaces, surfaces, known } = useStore(machine.workspaces);
  const { fontSize, inputMode, terminalPresentation } = usePrefs();
  const chat = terminalPresentation === 'chat';
  const conversation = useMemo(() => new TerminalConversationStore(channel, session), [channel, session]);
  const inputRef = useRef<TerminalInputHandle>(null);
  const keyboardVisible = useKeyboardVisible();
  const [targetError, setTargetError] = useState<string | null>(null);
  const [projectOpen, setProjectOpen] = useState(false);
  const [terminalActive, setTerminalActive] = useState(false);
  const target = state.target;
  const isOpen = status.state === 'open';
  const actions = useMemo(() => new SurfaceActions(machine), [machine]);
  const { running, error: actionError } = useStore(actions);
  const host = useMemo(() => new HostStatusStore(channel), [channel]);
  const { battery } = useStore(host);
  useEffect(() => () => conversation.dispose(), [conversation]);
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
  const siblings = target ? (surfaces[target.workspaceId] ?? known.surfaces[target.workspaceId] ?? []) : [];
  const surface = siblings.find((s) => s.id === target?.surfaceId);
  const banner = statusBanner(status) ?? state.subscriptionError ?? targetError;
  // The last reading stays in the store while disconnected; it is stale, so hide it.
  const showBattery = isOpen && battery !== null;
  const side = { paddingLeft: insets.left, paddingRight: insets.right };

  return (
    // Android too: edge-to-edge (forced from API 35) stops adjustResize from shrinking the window.
    <KeyboardAvoidingView style={styles.screen} behavior="padding">
      <View style={[styles.header, side, { paddingTop: insets.top }]}>
        <View style={styles.titleRow}>
          <Pressable
            onPress={backToWorkspaces}
            style={({ pressed }) => [styles.back, pressed && styles.pressed]}
            hitSlop={6}
            accessibilityRole="button"
            accessibilityLabel="返回工作区"
          >
            <Icon name="back" size={17} color={colors.ink} />
          </Pressable>
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
          {target ? <Pressable onPress={() => setProjectOpen(true)} style={styles.back} accessibilityRole="button" accessibilityLabel="查看项目文件与 Git 改动"><Text style={{ color: colors.blue, fontSize: 13 }}>文件</Text></Pressable> : null}
          {showBattery || machine.mode === 'demo' ? (
            <View style={styles.badges}>
              {showBattery ? <BatteryBadge battery={battery} onPress={() => void host.refresh()} /> : null}
              {machine.mode === 'demo' ? <Text style={styles.demoBadge}>演示</Text> : null}
            </View>
          ) : null}
        </View>
        {!keyboardVisible && target && siblings.length > 0 ? (
          <>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
              {siblings.map((item) => {
                const selected = item.id === target.surfaceId;
                const closable = !readOnly && canCloseSurface(siblings);
                return (
                  <Pressable
                    key={item.id}
                    onPress={() => {
                      actions.clearError();
                      session.setTarget({ workspaceId: target.workspaceId, surfaceId: item.id });
                    }}
                    onLongPress={() => {
                      if (readOnly) return;
                      if (!closable) actions.refuseLastClose();
                      else confirmClose(item, () => void actions.close(target.workspaceId, item.id));
                    }}
                    disabled={running !== null}
                    style={[styles.chip, selected && styles.chipSelected, running !== null && !selected && styles.chipBusy]}
                    accessibilityRole="tab"
                    accessibilityState={{ selected, disabled: running !== null }}
                    accessibilityHint={closable ? '长按可以关闭这个终端' : undefined}
                  >
                    <Text style={[styles.chipText, selected && styles.chipTextSelected]} numberOfLines={1}>
                      {item.title}
                    </Text>
                  </Pressable>
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
          </>
        ) : null}
      </View>
      <View style={[styles.presentation, side]} accessibilityRole="tablist">
        {(['chat', 'terminal'] as const).map(mode => <Pressable key={mode} onPress={() => setPrefs({ terminalPresentation: mode })}
          style={[styles.presentationTab, mode === terminalPresentation && styles.presentationSelected]} accessibilityRole="tab" accessibilityState={{ selected: mode === terminalPresentation }}
          accessibilityLabel={mode === 'chat' ? '对话模式' : '终端模式'}>
          <Text style={[styles.presentationText, mode === terminalPresentation && styles.presentationTextSelected]}>{mode === 'chat' ? '对话' : '终端'}</Text>
        </Pressable>)}
        {chat ? <Text style={styles.chatHint} numberOfLines={1}>直接发送到当前终端</Text> : null}
      </View>
      {banner ? <Text style={[styles.banner, side]}>{banner}</Text> : null}
      <View style={[styles.terminal, side]}>
        {chat ? <TerminalChatView store={conversation} session={session} connected={isOpen} onShowTerminal={() => setPrefs({ terminalPresentation: 'terminal' })} /> : <TerminalView
          active={terminalActive}
          readOnly={readOnly}
          key={`${machine.computer?.id ?? 'demo'}:${target?.workspaceId}:${target?.surfaceId}`}
          session={session}
          state={state}
          fontSize={fontSize}
          onFontSizeChange={(size) => setPrefs({ fontSize: size })}
          placeholder={placeholderFor(status, Boolean(target))}
          onTap={() => void inputRef.current?.blur()}
        />}
      </View>
      <View style={[styles.bottom, side, { paddingBottom: keyboardVisible ? 0 : Math.max(insets.bottom - 10, 0) }]}>
        {readOnly ? <Text style={{ color: colors.yellow, padding: 12 }}>这个连接源只允许读取</Text> : null}
        <InputBar key={`${machine.computer?.id ?? 'demo'}:${target?.workspaceId}:${target?.surfaceId}:${terminalPresentation}:${inputMode}`} session={session} disabled={!target || readOnly} error={state.input.error} inputRef={inputRef}
          presentation={terminalPresentation} onSubmitLine={chat ? text => conversation.send(text) : undefined} />
      </View>
      {projectOpen && target ? <ProjectBrowser key={`${machine.computer?.id}:${target.surfaceId}`} target={target} channel={channel} onClose={() => setProjectOpen(false)} /> : null}
    </KeyboardAvoidingView>
  );
}

/** Asks before closing a terminal; it closes in cmux on the Mac, not just on the phone. */
function confirmClose(surface: SurfaceInfo, onConfirm: () => void): void {
  const message = `「${surface.title}」会在电脑上的 cmux 里关闭，里面正在运行的程序也会结束。`;
  if (Platform.OS === 'web') {
    // react-native-web's Alert.alert does nothing.
    if (window.confirm(`关闭终端？\n\n${message}`)) onConfirm();
    return;
  }
  Alert.alert(
    '关闭终端？',
    message,
    [
      { text: '取消', style: 'cancel' },
      { text: '关闭', style: 'destructive', onPress: onConfirm },
    ],
    { cancelable: true },
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
  screen: { flex: 1, backgroundColor: colors.canvas },
  header: {
    backgroundColor: colors.surfaceSunken,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.divider,
    paddingBottom: 8,
  },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 6, paddingTop: 4 },
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
  chipText: { color: colors.muted, fontSize: 13 },
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
