import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { InboxItem } from '../../session/inboxStore';
import { useMachine, useStore } from '../../state/hooks';
import { openSurface } from '../../state/navigation';
import { colors } from '../../ui/theme';

/** Notifications from cmux (a task finished, an agent waits for an answer). Tapping one opens its terminal. */
export default function InboxScreen() {
  const insets = useSafeAreaInsets();
  const machine = useMachine();
  const { items, unread } = useStore(machine.inbox);
  const { workspaces, surfaces } = useStore(machine.workspaces);

  const open = (item: InboxItem) => {
    machine.inbox.markRead(item.id);
    if (!item.workspaceId) return;
    const surfaceId =
      item.surfaceId ?? (surfaces[item.workspaceId] ?? []).find((s) => s.focused)?.id ?? surfaces[item.workspaceId]?.[0]?.id;
    if (surfaceId) openSurface(machine, item.workspaceId, surfaceId);
  };

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={[styles.content, { paddingTop: insets.top + 12, paddingLeft: insets.left + 16, paddingRight: insets.right + 16 }]}
    >
      <View style={styles.header}>
        <Text style={styles.title}>收件箱</Text>
        {unread > 0 ? (
          <Pressable onPress={() => machine.inbox.markAllRead()} style={styles.markAll} accessibilityRole="button">
            <Text style={styles.markAllText}>全部已读</Text>
          </Pressable>
        ) : null}
      </View>
      <Text style={styles.note}>cmux 发出的通知会出现在这里。目前只在 App 打开并连着电脑时收到，后台推送之后再做。</Text>

      {items.length === 0 ? (
        <View style={styles.empty}>
          <Text style={styles.emptyTitle}>还没有通知</Text>
        </View>
      ) : null}

      {items.map((item) => {
        const workspace = workspaces.find((w) => w.id === item.workspaceId);
        return (
          <Pressable
            key={item.id}
            onPress={() => open(item)}
            style={({ pressed }) => [styles.item, pressed && styles.pressed]}
            accessibilityRole="button"
          >
            <View style={[styles.unreadDot, item.read && styles.readDot]} />
            <View style={styles.itemText}>
              <View style={styles.itemTop}>
                <Text style={styles.itemTitle} numberOfLines={1}>
                  {item.title}
                </Text>
                <Text style={styles.time}>{formatTime(item.at)}</Text>
              </View>
              {item.subtitle || workspace ? (
                <Text style={styles.itemSubtitle} numberOfLines={1}>
                  {item.subtitle ?? workspace?.title}
                </Text>
              ) : null}
              {item.body ? (
                <Text style={styles.itemBody} numberOfLines={3}>
                  {item.body}
                </Text>
              ) : null}
            </View>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

function formatTime(at: number): string {
  const date = new Date(at);
  const now = new Date();
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  if (date.toDateString() === now.toDateString()) return `${hh}:${mm}`;
  return `${date.getMonth() + 1}月${date.getDate()}日 ${hh}:${mm}`;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.canvas },
  content: { paddingBottom: 24, gap: 10 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  title: { color: colors.ink, fontSize: 28, fontWeight: '700' },
  markAll: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8, backgroundColor: colors.surface },
  markAllText: { color: colors.blue, fontSize: 14 },
  note: { color: colors.muted, fontSize: 12, lineHeight: 17, marginBottom: 4 },
  empty: { alignItems: 'center', paddingVertical: 48 },
  emptyTitle: { color: colors.muted, fontSize: 15 },
  item: {
    flexDirection: 'row',
    gap: 10,
    padding: 14,
    borderRadius: 12,
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.divider,
  },
  pressed: { backgroundColor: colors.surfaceRaised },
  unreadDot: { width: 8, height: 8, borderRadius: 4, marginTop: 6, backgroundColor: colors.green },
  readDot: { backgroundColor: 'transparent' },
  itemText: { flex: 1, gap: 3 },
  itemTop: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  itemTitle: { flex: 1, color: colors.ink, fontSize: 15, fontWeight: '600' },
  time: { color: colors.muted, fontSize: 12 },
  itemSubtitle: { color: colors.blue, fontSize: 12 },
  itemBody: { color: colors.inkDim, fontSize: 13, lineHeight: 18 },
});
