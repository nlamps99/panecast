import { useEffect, useRef, useState } from 'react';
import { router } from 'expo-router';
import { FlatList, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { Alert } from '../../platform/alert';
import Swipeable, { type SwipeableMethods } from 'react-native-gesture-handler/ReanimatedSwipeable';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { inboxTarget } from '../../session/inboxRouting';
import { isPending, type InboxItem } from '../../session/inboxStore';
import { notifications } from '../../notifications/instance';
import { useMachine, useStore } from '../../state/hooks';
import { openSurface } from '../../state/navigation';
import { colors } from '../../ui/theme';

type Filter = 'all' | 'unread' | 'pending' | 'resolved';

type OpenRow = { id: string; methods: SwipeableMethods };

/**
 * Notifications from cmux (a task finished, an agent waits for an answer).
 * Tapping one opens its terminal; swiping it left (or a long press) shows 删除.
 */
export default function InboxScreen() {
  const insets = useSafeAreaInsets();
  const machine = useMachine();
  const { items, unread, pending, sync } = useStore(machine.inbox);
  const { workspaces, surfaces } = useStore(machine.workspaces);
  const [filter, setFilter] = useState<Filter>('all');
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(timer); }, []);
  const openRow = useRef<OpenRow | null>(null);

  const shown = items.filter((item) => filter === 'unread' ? !item.read : filter === 'pending' ? isPending(item) : filter === 'resolved' ? Boolean(item.resolvedAt) : true);

  const run = async (action: () => Promise<void>) => {
    setError(null);
    try { await action(); } catch (failure) { setError(failure instanceof Error ? failure.message : '操作失败，请重试'); }
  };
  const remove = (item: InboxItem) => void run(async () => { await notifications.cancelReminder(item.reminderId); machine.inbox.remove(item.id); });
  const resolve = (item: InboxItem) => void run(async () => { await notifications.cancelReminder(item.reminderId); machine.inbox.resolve(item.id, !item.resolvedAt); });
  const snooze = (item: InboxItem) => void run(async () => {
    const id = await notifications.remindLater(item, machine.computer?.id ?? 'demo');
    machine.inbox.snooze(item.id, Date.now() + 15 * 60_000, id);
  });

  const open = (item: InboxItem) => {
    if (item.sourceId && item.threadId) {
      machine.inbox.markRead(item.id);
      router.navigate({ pathname: '/sources', params: { sourceId: item.sourceId, threadId: item.threadId } });
      return;
    }
    const target = inboxTarget(item, surfaces);
    if (target) { machine.inbox.markRead(item.id); openSurface(machine, target.workspaceId, target.surfaceId); }
    else setError('暂时找不到对应终端，可能已经关闭或还没连接。通知已保留。');
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
              onPress={() => confirmClear(() => void run(async () => {
                await Promise.all(items.map((item) => notifications.cancelReminder(item.reminderId)));
                machine.inbox.clear();
              }))}
              style={styles.action}
              accessibilityRole="button"
            >
              <Text style={[styles.actionText, styles.danger]}>清空</Text>
            </Pressable>
          ) : null}
        </View>
      </View>
      <View style={styles.filters} accessibilityRole="tablist">
        <FilterChip label={`待处理 ${pending}`} active={filter === 'pending'} onPress={() => setFilter('pending')} />
        <FilterChip label={`全部 ${items.length}`} active={filter === 'all'} onPress={() => setFilter('all')} />
        <FilterChip label={`未读 ${unread}`} active={filter === 'unread'} onPress={() => setFilter('unread')} />
        <FilterChip label="已处理" active={filter === 'resolved'} onPress={() => setFilter('resolved')} />
      </View>
      <Text style={styles.note}>
        点按返回对应终端，处理完后标记「已处理」。也可以稍后提醒；阅读通知不会改变处理状态。
      </Text>
      {error ? <Text style={[styles.note, styles.danger]}>{error}</Text> : null}
      {sync ? <Pressable onPress={() => void machine.inbox.sync()} disabled={sync.status === 'syncing'} accessibilityRole="button"><Text style={[styles.note, (sync.status === 'error' || sync.gap) && styles.danger]}>
        {sync.status === 'syncing' ? '正在补齐离线通知…' : sync.message ?? (sync.status === 'ready' ? '离线通知已同步 · 点按刷新' : '点按同步离线通知')}
      </Text></Pressable> : null}
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
          <Text style={styles.emptyTitle}>{filter === 'pending' ? '没有待处理事项' : filter === 'resolved' ? '还没有已处理事项' : filter === 'unread' && items.length > 0 ? '没有未读通知' : '还没有通知'}</Text>
        </View>
      }
      onScrollBeginDrag={closeOpenRow}
      renderItem={({ item }) => (
        <InboxRow
          item={item}
          now={now}
          workspaceTitle={workspaces.find((w) => w.id === item.workspaceId)?.title ?? null}
          onOpen={() => open(item)}
          onDelete={() => remove(item)}
          onResolve={() => resolve(item)}
          onSnooze={() => snooze(item)}
          onMarkRead={() => machine.inbox.markRead(item.id)}
          onSwipeOpen={rowOpened}
        />
      )}
    />
  );
}

function InboxRow({
  item,
  now,
  workspaceTitle,
  onOpen,
  onDelete,
  onMarkRead,
  onResolve,
  onSnooze,
  onSwipeOpen,
}: {
  item: InboxItem;
  now: number;
  workspaceTitle: string | null;
  onOpen: () => void;
  onDelete: () => void;
  onMarkRead: () => void;
  onResolve: () => void;
  onSnooze: () => void;
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
        style={({ pressed }) => [styles.item, isPending(item) && styles.itemNeedsInput, pressed && styles.pressed]}
        accessibilityRole="button"
        accessibilityLabel={[item.read ? null : '未读', item.resolvedAt ? '已处理' : item.needsInput ? '待回应' : null, item.title, subtitle, body]
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
            {item.resolvedAt ? <Text style={styles.handled}>已处理</Text> : item.needsInput ? <Text style={styles.chip}>待回应</Text> : null}
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
          {item.snoozedUntil && item.snoozedUntil > now ? <Text style={styles.note}>{formatTime(item.snoozedUntil)} 再提醒</Text> : null}
          {item.needsInput ? <View style={styles.rowActions}>
            <Pressable style={styles.action} onPress={(event) => { event.stopPropagation(); onResolve(); }} accessibilityRole="button"><Text style={styles.actionText}>{item.resolvedAt ? '重新打开' : '标为已处理'}</Text></Pressable>
            {!item.resolvedAt ? <Pressable style={styles.action} onPress={(event) => { event.stopPropagation(); onSnooze(); }} accessibilityRole="button"><Text style={styles.actionText}>15 分钟后提醒</Text></Pressable> : null}
          </View> : null}
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
  filters: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  rowActions: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 8 },
  handled: { color: colors.green, fontSize: 11 },
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
