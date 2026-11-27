import { router } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { CloseReason, ConnectionStatus } from '../protocol/connection';
import { appStore } from '../state/appStore';
import { useAppState, useConnectionStatus } from '../state/hooks';
import { connectionAction, isGuest, statusBanner, statusLabel } from './status';
import { colors } from './theme';

/**
 * Under the computer's name in the sidebar while it is not connected: what
 * is wrong, and 「重新连接」 (or 「去设置」 when the pairing has to be fixed),
 * so reconnecting is not buried in 设置 › 连接诊断. Nothing while connected,
 * in the demo, or during a first connection attempt.
 */
export function ConnectionNotice() {
  const { machine } = useAppState();
  const status = useSteadyStatus(useConnectionStatus(machine?.channel ?? null));
  // `idle` only passes by while the connection restarts.
  if (!machine || machine.mode === 'demo' || status.state === 'idle') return null;
  const action = connectionAction(status);
  if (!action) return null;
  const guest = isGuest(machine);
  const text = statusBanner(status, guest) ?? statusLabel(status, guest);
  const label = action === 'reconnect' ? '重新连接' : '去设置';
  return <View style={styles.box} accessibilityRole="alert">
    <Text style={styles.text}>{text}</Text>
    <Pressable onPress={() => (action === 'reconnect' ? appStore.reconnect() : router.navigate('/settings'))}
      style={({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) => [styles.button, (pressed || hovered) && styles.buttonActive]}
      accessibilityRole="button" accessibilityLabel={label}>
      <Text style={styles.buttonText}>{label}</Text>
    </Pressable>
  </View>;
}

/** Between retries the status is briefly `connecting`; keep the last failure on screen so the notice does not flicker. */
function useSteadyStatus(status: ConnectionStatus): ConnectionStatus {
  const [last, setLast] = useState<{ reason: CloseReason; local: boolean } | null>(null);
  const local = status.state === 'waiting' && status.local === true;
  if (status.state === 'waiting' && (status.reason !== last?.reason || local !== last?.local)) setLast({ reason: status.reason, local });
  if ((status.state === 'open' || status.state === 'auth_failed') && last !== null) setLast(null);
  if (status.state === 'connecting' && status.attempt > 0 && last) return { state: 'waiting', attempt: status.attempt, retryAt: 0, reason: last.reason, ...(last.local ? { local: true } : {}) };
  return status;
}

const styles = StyleSheet.create({
  box: { gap: 8, padding: 10, borderRadius: 8, backgroundColor: colors.surface, borderLeftWidth: 3, borderLeftColor: colors.orange },
  text: { color: colors.inkDim, fontSize: 12, lineHeight: 17 },
  button: { alignSelf: 'flex-start', paddingHorizontal: 12, paddingVertical: 6, borderRadius: 6, backgroundColor: colors.surfaceRaised },
  buttonActive: { backgroundColor: colors.divider },
  buttonText: { color: colors.green, fontSize: 13, fontWeight: '600' },
});
