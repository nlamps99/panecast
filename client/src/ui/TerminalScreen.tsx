import { useEffect, useRef, useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { TerminalInputHandle } from '../../modules/terminal-input';
import type { ConnectionStatus } from '../protocol/connection';
import { listSurfaces, pickDefaultTarget } from '../session/surfaces';
import { describeError, type RpcChannel, type TerminalSession } from '../session/terminalSession';
import { useConnectionStatus, useTerminalState, type StatusSource } from '../state/hooks';
import { setPrefs, usePrefs } from '../state/prefs';
import { InputBar } from './InputBar';
import { TerminalMenu } from './TerminalMenu';
import { TerminalView } from './TerminalView';
import { colors } from './theme';
import { useKeyboardVisible } from './useKeyboardVisible';

type Props = {
  channel: RpcChannel & StatusSource;
  session: TerminalSession;
  demo?: boolean;
  leaveLabel: string;
  onLeave: () => void;
  /** The broker rejected the token. */
  onRepair?: () => void;
};

/**
 * Layout, top to bottom: a one-line header (tap it to switch terminals or
 * change settings), an optional banner for connection problems, the
 * terminal, the key row, and the input right above the keyboard.
 */
export function TerminalScreen({ channel, session, demo = false, leaveLabel, onLeave, onRepair }: Props) {
  const insets = useSafeAreaInsets();
  const status = useConnectionStatus(channel);
  const state = useTerminalState(session)!;
  const { fontSize } = usePrefs();
  const inputRef = useRef<TerminalInputHandle>(null);
  const keyboardVisible = useKeyboardVisible();
  const [menuOpen, setMenuOpen] = useState(false);
  const [title, setTitle] = useState<string | null>(null);
  const [targetError, setTargetError] = useState<string | null>(null);
  const target = state.target;
  const isOpen = status.state === 'open';

  // First connection: follow whatever cmux has focused on the Mac.
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

  useEffect(() => {
    if (!isOpen || !target) return;
    let cancelled = false;
    listSurfaces(channel, target.workspaceId)
      .then((surfaces) => {
        if (!cancelled) setTitle(surfaces.find((s) => s.id === target.surfaceId)?.title ?? null);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [isOpen, channel, target]);

  const banner = bannerFor(status, state.subscriptionError ?? targetError);
  const placeholder = placeholderFor(status, Boolean(target));
  const side = { paddingLeft: insets.left, paddingRight: insets.right };

  return (
    <KeyboardAvoidingView style={styles.screen} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View style={[styles.header, side, { paddingTop: insets.top }]}>
        <Pressable
          onPress={() => setMenuOpen(true)}
          style={({ pressed }) => [styles.headerButton, pressed && styles.headerPressed]}
          accessibilityRole="button"
          accessibilityLabel="切换终端和设置"
        >
          <View style={[styles.dot, { backgroundColor: statusColor(status) }]} />
          <Text style={styles.title} numberOfLines={1}>
            {title ?? (demo ? '演示' : '终端')}
          </Text>
          <Text style={styles.chevron}>▾</Text>
        </Pressable>
        {status.state !== 'open' ? <Text style={styles.statusText}>{statusLabel(status)}</Text> : null}
        {demo ? <Text style={styles.demoBadge}>演示</Text> : null}
      </View>
      {banner ? (
        <Pressable style={[styles.banner, side]} onPress={status.state === 'auth_failed' ? onRepair : undefined}>
          <Text style={styles.bannerText}>{banner}</Text>
        </Pressable>
      ) : null}
      <View style={[styles.terminal, side]}>
        <TerminalView
          session={session}
          state={state}
          fontSize={fontSize}
          onFontSizeChange={(size) => setPrefs({ fontSize: size })}
          placeholder={placeholder}
          onTap={() => void inputRef.current?.blur()}
        />
      </View>
      <View style={[styles.bottom, side, { paddingBottom: keyboardVisible ? 0 : Math.max(insets.bottom - 10, 0) }]}>
        <InputBar session={session} disabled={!target} error={state.input.error} inputRef={inputRef} />
      </View>
      <TerminalMenu
        visible={menuOpen}
        channel={channel}
        current={target}
        leaveLabel={leaveLabel}
        onPick={(picked) => {
          setMenuOpen(false);
          setTitle(null);
          session.setTarget(picked);
        }}
        onLeave={() => {
          setMenuOpen(false);
          onLeave();
        }}
        onClose={() => setMenuOpen(false)}
      />
    </KeyboardAvoidingView>
  );
}

function statusColor(status: ConnectionStatus): string {
  switch (status.state) {
    case 'open':
      return colors.green;
    case 'connecting':
      return colors.yellow;
    case 'waiting':
      return colors.orange;
    case 'auth_failed':
      return colors.red;
    case 'idle':
      return colors.muted;
  }
}

function statusLabel(status: ConnectionStatus): string {
  switch (status.state) {
    case 'open':
      return '已连接';
    case 'connecting':
      return status.attempt > 0 ? '重连中…' : '连接中…';
    case 'waiting':
      return status.reason === 'relay_offline' ? '电脑离线' : '已断开';
    case 'auth_failed':
      return '配对失效';
    case 'idle':
      return '未连接';
  }
}

function bannerFor(status: ConnectionStatus, error: string | null): string | null {
  if (status.state === 'auth_failed') return '这台手机的配对已失效（可能在电脑上被撤销了）。点这里重新扫码配对。';
  if (status.state === 'waiting' && status.reason === 'relay_offline') {
    return '服务器连上了，但电脑上的 relay 不在线。请确认 Mac 上的 cmux-relay 正在运行。';
  }
  return error;
}

function placeholderFor(status: ConnectionStatus, hasTarget: boolean): string | null {
  if (status.state === 'connecting' || status.state === 'idle') return '正在连接电脑…';
  if (status.state !== 'open') return null;
  return hasTarget ? '正在读取终端…' : '正在查找终端…';
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.canvas },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 8,
    backgroundColor: colors.surfaceSunken,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.divider,
  },
  headerButton: {
    flexShrink: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    height: 40,
    paddingHorizontal: 8,
    borderRadius: 8,
  },
  headerPressed: { backgroundColor: colors.surface },
  dot: { width: 8, height: 8, borderRadius: 4 },
  title: { flexShrink: 1, color: colors.ink, fontSize: 15, fontWeight: '600' },
  chevron: { color: colors.muted, fontSize: 11 },
  statusText: { color: colors.muted, fontSize: 12 },
  demoBadge: {
    marginLeft: 'auto',
    marginRight: 6,
    color: colors.canvas,
    backgroundColor: colors.yellow,
    fontSize: 11,
    fontWeight: '600',
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 4,
    overflow: 'hidden',
  },
  banner: { backgroundColor: colors.surfaceRaised, paddingHorizontal: 14, paddingVertical: 8 },
  bannerText: { color: colors.yellow, fontSize: 13, lineHeight: 18 },
  terminal: { flex: 1 },
  bottom: {
    backgroundColor: colors.surfaceSunken,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.divider,
  },
});
