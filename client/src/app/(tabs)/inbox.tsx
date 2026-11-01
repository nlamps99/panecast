import { useRef, useState } from 'react';
import { Alert, FlatList, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import Swipeable, { type SwipeableMethods } from 'react-native-gesture-handler/ReanimatedSwipeable';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { inboxTarget } from '../../session/inboxRouting';
import type { InboxItem } from '../../session/inboxStore';
import { useMachine, useStore } from '../../state/hooks';
import { openSurface } from '../../state/navigation';
import { colors } from '../../ui/theme';

type Filter = 'all' | 'unread';

type OpenRow = { id: string; methods: SwipeableMethods };

/**
 * Notifications from cmux (a task finished, an agent waits for an answer).
 * Tapping one opens its terminal; swiping it left (or a long press) shows 删除.
 */
export default function InboxScreen() {
  const insets = useSafeAreaInsets();
  const machine = useMachine();
  const { items, unread } = useStore(machine.inbox);
  const { workspaces, surfaces } = useStore(machine.workspaces);
  const [filter, setFilter] = useState<Filter>('all');
  const openRow = useRef<OpenRow | null>(null);

  const shown = filter === 'unread' ? items.filter((item) => !item.read) : items;

  const open = (item: InboxItem) => {
    machine.inbox.markRead(item.id);
    const target = inboxTarget(item, surfaces);
    if (target) openSurface(machine, target.workspaceId, target.surfaceId);
  };

  const rowOpened = (id: string, methods: SwipeableMethods) => {
    if (openRow.current && openRow.current.id !== id) openRow.current.methods.close();
    openRow.current = { id, methods };
  };

  const closeOpenRow = () => {
    openRow.current?.methods.close();
    openRow.current = null;
  };

  const header = (
    <View style={styles.headerBlock}>
      <View style={styles.header}>
        <Text style={styles.title}>收件箱</Text>
        <View style={styles.actions}>
          {unread > 0 ? (
            <Pressable onPress={() => machine.inbox.markAllRead()} style={styles.action} accessibilityRole="button">
              <Text style={styles.actionText}>全部已读</Text>
            </Pressable>
          ) : null}
          {items.length > 0 ? (
            <Pressable
              onPress={() => confirmClear(() => machine.inbox.clear())}
              style={styles.action}
              accessibilityRole="button"
            >
              <Text style={[styles.actionText, styles.danger]}>清空</Text>
            </Pressable>
          ) : null}
        </View>
      </View>
      <View style={styles.filters} accessibilityRole="tablist">
        <FilterChip label={`全部 ${items.length}`} active={filter === 'all'} onPress={() => setFilter('all')} />
        <FilterChip label={`未读 ${unread}`} active={filter === 'unread'} onPress={() => setFilter('unread')} />
      </View>
      <Text style={styles.note}>
        cmux 发出的通知和等你回应的智能体会出现在这里，左滑可以删除。目前只在 App 打开并连着电脑时收到，后台推送之后再做。
      </Text>
    </View>
  );

  return (
    <FlatList
      style={styles.screen}
      contentContainerStyle={[
        styles.content,
        { paddingTop: insets.top + 12, paddingLeft: insets.left + 16, paddingRight: insets.right + 16 },
      ]}
      data={shown}
      extraData={workspaces}
      keyExtractor={(item) => item.id}
      ListHeaderComponent={header}
      ItemSeparatorComponent={Separator}
      ListEmptyComponent={
        <View style={styles.empty}>
          <Text style={styles.emptyTitle}>{filter === 'unread' && items.length > 0 ? '没有未读通知' : '还没有通知'}</Text>
        </View>
      }
      onScrollBeginDrag={closeOpenRow}
      renderItem={({ item }) => (
        <InboxRow
          item={item}
          workspaceTitle={workspaces.find((w) => w.id === item.workspaceId)?.title ?? null}
          onOpen={() => open(item)}
          onDelete={() => machine.inbox.remove(item.id)}
          onMarkRead={() => machine.inbox.markRead(item.id)}
          onSwipeOpen={rowOpened}
        />
      )}
    />
  );
}

function InboxRow({
  item,
  workspaceTitle,
  onOpen,
  onDelete,
  onMarkRead,
  onSwipeOpen,
}: {
  item: InboxItem;
  workspaceTitle: string | null;
  onOpen: () => void;
  onDelete: () => void;
  onMarkRead: () => void;
  onSwipeOpen: (id: string, methods: SwipeableMethods) => void;
}) {
  const swipeable = useRef<SwipeableMethods>(null);
  const subtitle = item.subtitle ?? workspaceTitle;
  const body = item.body && item.body !== item.title ? item.body : null;

  const accessibilityActions = [
    { name: 'delete', label: '删除' },
    ...(item.read ? [] : [{ name: 'markRead', label: '标为已读' }]),
  ];

  return (
    <Swipeable
      ref={swipeable}
      friction={1.5}
      rightThreshold={40}
      overshootRight={false}
      containerStyle={styles.rowContainer}
      onSwipeableWillOpen={() => {
        if (swipeable.current) onSwipeOpen(item.id, swipeable.current);
      }}
      renderRightActions={() => (
        <Pressable onPress={onDelete} style={styles.deleteAction} accessibilityRole="button" accessibilityLabel="删除这条通知">
          <Text style={styles.deleteText}>删除</Text>
        </Pressable>
      )}
    >
      <Pressable
        onPress={onOpen}
        onLongPress={() => swipeable.current?.openRight()}
        style={({ pressed }) => [styles.item, item.needsInput && styles.itemNeedsInput, pressed && styles.pressed]}
        accessibilityRole="button"
        accessibilityLabel={[item.read ? null : '未读', item.needsInput ? '待回应' : null, item.title, subtitle, body]
          .filter(Boolean)
          .join('，')}
        accessibilityActions={accessibilityActions}
        onAccessibilityAction={(event) => {
          if (event.nativeEvent.actionName === 'delete') onDelete();
          if (event.nativeEvent.actionName === 'markRead') onMarkRead();
        }}
      >
        <View style={[styles.unreadDot, item.needsInput && styles.unreadDotNeedsInput, item.read && styles.readDot]} />
        <View style={styles.itemText}>
          <View style={styles.itemTop}>
            {item.needsInput ? <Text style={styles.chip}>待回应</Text> : null}
            <Text style={[styles.itemTitle, item.read && styles.itemTitleRead]} numberOfLines={1}>
              {item.title}
            </Text>
            <Text style={styles.time}>{formatTime(item.at)}</Text>
          </View>
          {subtitle ? (
            <Text style={styles.itemSubtitle} numberOfLines={1}>
              {subtitle}
            </Text>
          ) : null}
          {body ? (
            <Text style={styles.itemBody} numberOfLines={3}>
              {body}
            </Text>
          ) : null}
        </View>
      </Pressable>
    </Swipeable>
  );
}

function FilterChip({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      style={[styles.filter, active && styles.filterActive]}
      accessibilityRole="tab"
      accessibilityState={{ selected: active }}
    >
      <Text style={[styles.filterText, active && styles.filterTextActive]}>{label}</Text>
    </Pressable>
  );
}

function Separator() {
  return <View style={styles.separator} />;
}

/** Native confirm sheet; the browser's `confirm` on the web, where `Alert` does nothing. */
function confirmClear(onConfirm: () => void) {
  if (Platform.OS === 'web') {
    if (globalThis.confirm?.('清空收件箱里的全部通知？')) onConfirm();
    return;
  }
  Alert.alert('清空收件箱？', '这台电脑的全部通知都会删除。', [
    { text: '取消', style: 'cancel' },
    { text: '清空', style: 'destructive', onPress: onConfirm },
  ]);
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
  content: { paddingBottom: 24 },
  headerBlock: { gap: 10, marginBottom: 10 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  title: { color: colors.ink, fontSize: 28, fontWeight: '700' },
  actions: { flexDirection: 'row', gap: 8 },
  action: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8, backgroundColor: colors.surface },
  actionText: { color: colors.blue, fontSize: 14 },
  danger: { color: colors.red },
  filters: { flexDirection: 'row', gap: 8 },
  filter: {
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.divider,
  },
  filterActive: { backgroundColor: colors.surfaceRaised, borderColor: colors.border },
  filterText: { color: colors.muted, fontSize: 13 },
  filterTextActive: { color: colors.ink, fontWeight: '600' },
  note: { color: colors.muted, fontSize: 12, lineHeight: 17 },
  empty: { alignItems: 'center', paddingVertical: 48 },
  emptyTitle: { color: colors.muted, fontSize: 15 },
  separator: { height: 10 },
  // Clips the 删除 panel to the card's corners.
  rowContainer: { borderRadius: 12 },
  deleteAction: { width: 88, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.red },
  deleteText: { color: colors.canvas, fontSize: 15, fontWeight: '700' },
  item: {
    flexDirection: 'row',
    gap: 10,
    padding: 14,
    borderRadius: 12,
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.divider,
  },
  itemNeedsInput: { borderLeftWidth: 3, borderLeftColor: colors.yellow, paddingLeft: 12 },
  pressed: { backgroundColor: colors.surfaceRaised },
  unreadDot: { width: 8, height: 8, borderRadius: 4, marginTop: 6, backgroundColor: colors.green },
  unreadDotNeedsInput: { backgroundColor: colors.yellow },
  readDot: { backgroundColor: 'transparent' },
  itemText: { flex: 1, gap: 3 },
  itemTop: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  chip: {
    overflow: 'hidden',
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 4,
    backgroundColor: colors.yellow,
    color: colors.canvas,
    fontSize: 11,
    fontWeight: '700',
  },
  itemTitle: { flex: 1, color: colors.ink, fontSize: 15, fontWeight: '600' },
  itemTitleRead: { color: colors.inkDim, fontWeight: '500' },
  time: { color: colors.muted, fontSize: 12 },
  itemSubtitle: { color: colors.blue, fontSize: 12 },
  itemBody: { color: colors.inkDim, fontSize: 13, lineHeight: 18 },
});
