import { Redirect, router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Alert, KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { TerminalInputHandle } from '../../modules/terminal-input';
import type { ConnectionStatus } from '../protocol/connection';
import { listSurfaces, pickDefaultTarget } from '../session/surfaces';
import { describeError } from '../session/terminalSession';
import { appStore } from '../state/appStore';
import { useAppState, useConnectionStatus, useTerminalState } from '../state/hooks';
import { InputBar, KeyBar } from '../ui/InputBar';
import { SurfacePicker } from '../ui/SurfacePicker';
import { TerminalView } from '../ui/TerminalView';
import { colors } from '../ui/theme';
import { useKeyboardVisible } from '../ui/useKeyboardVisible';

export default function TerminalScreen() {
  const insets = useSafeAreaInsets();
  const { phase, connection, session } = useAppState();
  const status = useConnectionStatus(connection);
  const state = useTerminalState(session);
  const inputRef = useRef<TerminalInputHandle>(null);
  const keyboardVisible = useKeyboardVisible();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [title, setTitle] = useState<string | null>(null);
  const [targetError, setTargetError] = useState<string | null>(null);
  const target = state?.target ?? null;
  const isOpen = status.state === 'open';

  // First connection: follow whatever cmux has focused on the Mac.
  useEffect(() => {
    if (!isOpen || !connection || !session || session.getState().target) return;
    let cancelled = false;
    pickDefaultTarget(connection)
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
  }, [isOpen, connection, session]);

  useEffect(() => {
    if (!isOpen || !connection || !target) return;
    let cancelled = false;
    listSurfaces(connection, target.workspaceId)
      .then((surfaces) => {
        if (!cancelled) setTitle(surfaces.find((s) => s.id === target.surfaceId)?.title ?? null);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [isOpen, connection, target]);

  if (phase === 'unpaired') return <Redirect href="/pair" />;
  if (!connection || !session || !state) return <View style={styles.screen} />;

  const unpair = () => {
    Alert.alert('取消配对', '这台手机会忘记这台电脑，之后需要重新扫码。', [
      { text: '取消', style: 'cancel' },
      {
        text: '取消配对',
        style: 'destructive',
        onPress: () => {
          setPickerOpen(false);
          void appStore.unpair().then(() => router.replace('/pair'));
        },
      },
    ]);
  };

  const banner = bannerFor(status, state.subscriptionError ?? targetError);

  return (
    <KeyboardAvoidingView style={styles.screen} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View style={[styles.header, { paddingTop: insets.top }]}>
        <View style={styles.headerText}>
          <Text style={styles.title} numberOfLines={1}>
            {title ?? '终端'}
          </Text>
          <StatusLine status={status} />
        </View>
        <Pressable onPress={() => setPickerOpen(true)} style={styles.headerButton} hitSlop={8} accessibilityRole="button">
          <Text style={styles.headerButtonText}>切换</Text>
        </Pressable>
      </View>
      {banner ? (
        <Pressable
          style={styles.banner}
          onPress={status.state === 'auth_failed' ? () => void appStore.unpair().then(() => router.replace('/pair')) : undefined}
        >
          <Text style={styles.bannerText}>{banner}</Text>
        </Pressable>
      ) : null}
      <TerminalView session={session} state={state} />
      <View style={{ paddingBottom: keyboardVisible ? 2 : Math.max(insets.bottom - 8, 4) }}>
        <InputBar session={session} disabled={!target} error={state.input.error} inputRef={inputRef} />
        <KeyBar session={session} onHideKeyboard={() => void inputRef.current?.blur()} />
      </View>
      <SurfacePicker
        visible={pickerOpen}
        channel={connection}
        current={target}
        onPick={(picked) => {
          setPickerOpen(false);
          setTitle(null);
          session.setTarget(picked);
        }}
        onUnpair={unpair}
        onClose={() => setPickerOpen(false)}
      />
    </KeyboardAvoidingView>
  );
}

function StatusLine({ status }: { status: ConnectionStatus }) {
  const [label, color] = describeStatus(status);
  return (
    <View style={styles.status}>
      <View style={[styles.dot, { backgroundColor: color }]} />
      <Text style={styles.statusText}>{label}</Text>
    </View>
  );
}

function describeStatus(status: ConnectionStatus): [string, string] {
  switch (status.state) {
    case 'open':
      return ['已连接', colors.green];
    case 'connecting':
      return [status.attempt > 0 ? '正在重连…' : '正在连接…', colors.yellow];
    case 'waiting':
      return [status.reason === 'relay_offline' ? '电脑离线，稍后重试' : '连接断开，稍后重试', colors.orange];
    case 'auth_failed':
      return ['配对已失效', colors.red];
    case 'idle':
      return ['未连接', colors.muted];
  }
}

function bannerFor(status: ConnectionStatus, error: string | null): string | null {
  if (status.state === 'auth_failed') return '这台手机的配对已失效（可能在电脑上被撤销了）。点这里重新扫码配对。';
  if (status.state === 'waiting' && status.reason === 'relay_offline') {
    return '服务器连上了，但电脑上的 relay 没有在线。请确认 Mac 上的 cmux-relay 正在运行。';
  }
  return error;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.canvas },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingBottom: 8,
    gap: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.divider,
    backgroundColor: colors.surfaceSunken,
  },
  headerText: { flex: 1, gap: 2, paddingTop: 6 },
  title: { color: colors.ink, fontSize: 16, fontWeight: '600' },
  status: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  dot: { width: 7, height: 7, borderRadius: 4 },
  statusText: { color: colors.muted, fontSize: 12 },
  headerButton: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 6,
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.divider,
  },
  headerButtonText: { color: colors.ink, fontSize: 14 },
  banner: { backgroundColor: colors.surfaceRaised, paddingHorizontal: 14, paddingVertical: 8 },
  bannerText: { color: colors.yellow, fontSize: 13, lineHeight: 18 },
});
