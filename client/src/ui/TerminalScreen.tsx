import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { TerminalInputHandle } from '../../modules/terminal-input';
import type { ConnectionStatus } from '../protocol/connection';
import { HostStatusStore } from '../session/hostStatus';
import { canCloseSurface, SurfaceActions } from '../session/surfaceActions';
import { pickDefaultTarget, type SurfaceInfo } from '../session/surfaces';
import { describeError } from '../session/terminalSession';
import { useConnectionStatus, useMachine, useStore } from '../state/hooks';
import { backToWorkspaces } from '../state/navigation';
import { setPrefs, usePrefs } from '../state/prefs';
import { BatteryBadge } from './BatteryBadge';
import { Icon } from './Icon';
import { InputBar } from './InputBar';
import { statusBanner, statusColor, statusLabel } from './status';
import { TerminalView } from './TerminalView';
import { colors } from './theme';
import { useKeyboardVisible } from './useKeyboardVisible';

/**
 * The terminal tab. Top to bottom: back to the list, the workspace and its
 * terminals (hidden while typing), the terminal, the key row, and the input
 * right above the keyboard. The tab bar is hidden here.
 *
 * In the chip row, "+" opens a new terminal in the workspace and a long press
 * closes one on the Mac. The title row shows the Mac's battery.
 */
export function TerminalScreen() {
  const insets = useSafeAreaInsets();
  const machine = useMachine();
  const { channel, session } = machine;
  const status = useConnectionStatus(channel);
  const state = useStore(session);
  const { workspaces, surfaces } = useStore(machine.workspaces);
  const { fontSize } = usePrefs();
  const inputRef = useRef<TerminalInputHandle>(null);
  const keyboardVisible = useKeyboardVisible();
  const [targetError, setTargetError] = useState<string | null>(null);
  const target = state.target;
  const isOpen = status.state === 'open';
  const actions = useMemo(() => new SurfaceActions(machine), [machine]);
  const { running, error: actionError } = useStore(actions);
  const host = useMemo(() => new HostStatusStore(channel), [channel]);
  const { battery } = useStore(host);

  // Battery: read on focus, then every minute until the tab loses focus.
  useFocusEffect(
    useCallback(() => {
      host.start();
      return () => host.stop();
    }, [host]),
  );

  // An action's error belongs to the workspace it was made in.
  const workspaceId = target?.workspaceId;
  useEffect(() => {
    actions.clearError();
  }, [actions, workspaceId]);

  // Opened from the tab bar before choosing a terminal: follow whatever cmux has focused.
  useEffect(() => {
    if (!isOpen || session.getState().target) return;
    let cancelled = false;
    pickDefaultTarget(channel)
      .then((picked) => {
        if (cancelled) return;
        if (picked) {
          setTargetError(null);
          session.setTarget(picked);
        } else {
          setTargetError('电脑上没有打开的终端');
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) setTargetError(describeError(error));
      });
    return () => {
      cancelled = true;
    };
  }, [isOpen, channel, session]);

  const workspace = workspaces.find((w) => w.id === target?.workspaceId);
  const siblings = target ? (surfaces[target.workspaceId] ?? []) : [];
  const surface = siblings.find((s) => s.id === target?.surfaceId);
  const banner = statusBanner(status) ?? state.subscriptionError ?? targetError;
  // The last reading stays in the store while disconnected; it is stale, so hide it.
  const showBattery = isOpen && battery !== null;
  const side = { paddingLeft: insets.left, paddingRight: insets.right };

  return (
    <KeyboardAvoidingView style={styles.screen} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
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
                const closable = canCloseSurface(siblings);
                return (
                  <Pressable
                    key={item.id}
                    onPress={() => {
                      actions.clearError();
                      session.setTarget({ workspaceId: target.workspaceId, surfaceId: item.id });
                    }}
                    onLongPress={() => {
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
                disabled={running !== null}
                style={({ pressed }) => [styles.chip, styles.newChip, pressed && styles.newChipPressed, running === 'close' && styles.chipBusy]}
                accessibilityRole="button"
                accessibilityLabel="新建终端"
                accessibilityState={{ disabled: running !== null, busy: running === 'create' }}
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
      {banner ? <Text style={[styles.banner, side]}>{banner}</Text> : null}
      <View style={[styles.terminal, side]}>
        <TerminalView
          session={session}
          state={state}
          fontSize={fontSize}
          onFontSizeChange={(size) => setPrefs({ fontSize: size })}
          placeholder={placeholderFor(status, Boolean(target))}
          onTap={() => void inputRef.current?.blur()}
        />
      </View>
      <View style={[styles.bottom, side, { paddingBottom: keyboardVisible ? 0 : Math.max(insets.bottom - 10, 0) }]}>
        <InputBar session={session} disabled={!target} error={state.input.error} inputRef={inputRef} />
      </View>
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
