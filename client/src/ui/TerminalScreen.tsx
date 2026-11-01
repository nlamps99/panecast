import { useEffect, useRef, useState } from 'react';
import { KeyboardAvoidingView, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { TerminalInputHandle } from '../../modules/terminal-input';
import type { ConnectionStatus } from '../protocol/connection';
import { pickDefaultTarget } from '../session/surfaces';
import { describeError } from '../session/terminalSession';
import { useConnectionStatus, useMachine, useStore } from '../state/hooks';
import { backToWorkspaces } from '../state/navigation';
import { setPrefs, usePrefs } from '../state/prefs';
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
          {machine.mode === 'demo' ? <Text style={styles.demoBadge}>演示</Text> : null}
        </View>
        {!keyboardVisible && siblings.length > 1 ? (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
            {siblings.map((item) => {
              const selected = item.id === target?.surfaceId;
              return (
                <Pressable
                  key={item.id}
                  onPress={() => target && session.setTarget({ workspaceId: target.workspaceId, surfaceId: item.id })}
                  style={[styles.chip, selected && styles.chipSelected]}
                  accessibilityRole="tab"
                  accessibilityState={{ selected }}
                >
                  <Text style={[styles.chipText, selected && styles.chipTextSelected]} numberOfLines={1}>
                    {item.title}
                  </Text>
                </Pressable>
              );
            })}
          </ScrollView>
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
  demoBadge: {
    marginRight: 8,
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
  chipText: { color: colors.muted, fontSize: 13 },
  chipTextSelected: { color: colors.ink, fontWeight: '600' },
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
