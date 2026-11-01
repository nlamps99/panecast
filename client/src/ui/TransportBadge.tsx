import { useSyncExternalStore } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import type { StatusSource } from '../session/terminalSession';
import type { ActiveTransport, ComputerChannel } from '../state/connect';
import { useConnectionStatus } from '../state/hooks';
import { colors } from './theme';

type TransportSource = Pick<ComputerChannel, 'transport' | 'onTransport'>;

function hasTransport(channel: unknown): channel is TransportSource {
  return typeof channel === 'object' && channel !== null && 'transport' in channel && 'onTransport' in channel;
}

const NO_TRANSPORT = () => () => {};
const NONE = () => null;

/** The path a channel is using, or null for channels without one (the demo). */
export function useActiveTransport(channel: unknown): ActiveTransport | null {
  const source = hasTransport(channel) ? channel : null;
  const subscribe = source ? (listener: () => void) => source.onTransport(listener) : NO_TRANSPORT;
  const get = source ? () => source.transport : NONE;
  return useSyncExternalStore(subscribe, get, get);
}

export const LAN_HINT = '局域网链路不加密，只在可信网络下使用。';

const LABELS: Record<ActiveTransport, { text: string; a11y: string }> = {
  lan: { text: '局域网', a11y: '已通过局域网连接，链路未加密' },
  broker: { text: '服务器', a11y: '已通过服务器连接，链路已加密' },
};

/**
 * A small label for how the connection reaches the Mac: 局域网 (direct,
 * plain HTTP, drawn in the warning color) or 服务器 (TLS via the broker).
 * Shown only while connected, so it never names a path that carries nothing.
 * `showHint` adds the unencrypted-link note under the LAN label.
 */
export function TransportBadge({ channel, showHint = false }: { channel: StatusSource; showHint?: boolean }) {
  const transport = useActiveTransport(channel);
  const status = useConnectionStatus(channel);
  if (!transport || status.state !== 'open') return null;
  const lan = transport === 'lan';
  const label = LABELS[transport];
  return (
    <View style={styles.wrap}>
      <View
        style={[styles.badge, lan && styles.badgeLan]}
        accessible
        accessibilityLabel={label.a11y}
        testID="TransportBadge"
      >
        <Text style={[styles.text, lan && styles.textLan]}>{label.text}</Text>
      </View>
      {lan && showHint ? <Text style={styles.hint}>{LAN_HINT}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: 'flex-start', gap: 4 },
  badge: {
    borderRadius: 4,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.divider,
    backgroundColor: colors.surfaceSunken,
    paddingHorizontal: 5,
    paddingVertical: 1,
  },
  badgeLan: { borderColor: colors.yellow },
  text: { color: colors.muted, fontSize: 11 },
  textLan: { color: colors.yellow },
  hint: { color: colors.mutedDim, fontSize: 12 },
});
