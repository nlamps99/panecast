import { router, usePathname } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, { FadeInUp, FadeOutUp } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { inboxTarget, shouldAnnounce } from '../session/inboxRouting';
import type { InboxItem } from '../session/inboxStore';
import type { Machine } from '../state/appStore';
import { useAppState, useStore } from '../state/hooks';
import { openSurface } from '../state/navigation';
import { colors } from './theme';
import { notifications } from '../notifications/instance';
import { notificationGroup } from '../notifications/preferences';

const SHOW_MS = 4_000;

type Shown = { id: string; machine: Machine; seq: number };

/**
 * A short banner at the top of the screen when an inbox item arrives and the
 * user is not on that item's terminal (nor on the inbox). Tapping it opens
 * the terminal. Mount it once inside the root layout, after the navigator: it
 * positions itself absolutely over the screens and lets touches through
 * around the banner. Renders nothing without a connected computer.
 */
export function InboxToast() {
  const { machine } = useAppState();
  return machine ? <MachineToast machine={machine} /> : null;
}

function MachineToast({ machine }: { machine: Machine }) {
  const insets = useSafeAreaInsets();
  const pathname = usePathname();
  const pathnameRef = useRef(pathname);
  const seq = useRef(0);
  const groups = useRef(new Map<string, number>());
  const [shown, setShown] = useState<Shown | null>(null);
  const { items } = useStore(machine.inbox);
  const { workspaces, surfaces } = useStore(machine.workspaces);

  useEffect(() => {
    pathnameRef.current = pathname;
  }, [pathname]);

  useEffect(
    () =>
      machine.inbox.onNew((item) => {
        const computerId = machine.computer?.id ?? null;
        if (!notifications.allowsItem(item, computerId)) return;
        const seconds = computerId ? notifications.rules(computerId).getState().preferences.dedupe_seconds : 0;
        const key = notificationGroup(item), now = Date.now();
        for (const [group, at] of groups.current) if (now - at > 3600_000) groups.current.delete(group);
        if (seconds && now - (groups.current.get(key) ?? -Infinity) < seconds * 1000) return;
        groups.current.set(key, now);
        if (!shouldAnnounce(item, pathnameRef.current, machine.session.getState().target)) return;
        seq.current += 1;
        setShown({ id: item.id, machine, seq: seq.current });
        AccessibilityInfo.announceForAccessibility(`新通知：${item.title}`);
      }),
    [machine],
  );

  useEffect(() => {
    if (!shown) return;
    const timer = setTimeout(() => setShown((current) => (current === shown ? null : current)), SHOW_MS);
    return () => clearTimeout(timer);
  }, [shown]);

  // Hide once the item is read (or deleted) elsewhere, or when the user switches computer.
  const item = shown && shown.machine === machine ? items.find((i) => i.id === shown.id) : undefined;
  const visible = item !== undefined && !item.read && pathname !== '/inbox';

  const open = (target: InboxItem) => {
    setShown(null);
    machine.inbox.markRead(target.id);
    if (target.sourceId && target.threadId) { router.navigate({ pathname: '/sources', params: { sourceId: target.sourceId, threadId: target.threadId } }); return; }
    const surface = inboxTarget(target, surfaces);
    if (surface) openSurface(machine, surface.workspaceId, surface.surfaceId);
    else router.navigate('/inbox');
  };

  const subtitle = item ? (item.subtitle ?? workspaces.find((w) => w.id === item.workspaceId)?.title ?? null) : null;

  return (
    <View style={[styles.host, { top: insets.top + 6, left: insets.left + 12, right: insets.right + 12 }]}>
      {visible && shown ? (
        <Animated.View key={shown.seq} entering={FadeInUp.duration(180)} exiting={FadeOutUp.duration(160)}>
          <Pressable
            onPress={() => open(item)}
            style={({ pressed }) => [styles.card, item.needsInput && styles.cardNeedsInput, pressed && styles.pressed]}
            accessibilityRole="button"
            accessibilityHint="打开对应的终端"
          >
            <View style={styles.top}>
              {item.needsInput ? <Text style={styles.chip}>待回应</Text> : null}
              <Text style={styles.title} numberOfLines={1}>
                {item.title}
              </Text>
            </View>
            {subtitle ? (
              <Text style={styles.subtitle} numberOfLines={1}>
                {subtitle}
              </Text>
            ) : null}
            {item.body ? (
              <Text style={styles.body} numberOfLines={2}>
                {item.body}
              </Text>
            ) : null}
          </Pressable>
        </Animated.View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  host: { position: 'absolute', zIndex: 100, pointerEvents: 'box-none' },
  card: {
    gap: 3,
    paddingHorizontal: 14,
    paddingVertical: 11,
    borderRadius: 12,
    backgroundColor: colors.surfaceRaised,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    borderLeftWidth: 3,
    borderLeftColor: colors.green,
    shadowColor: '#000',
    shadowOpacity: 0.35,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 8,
  },
  cardNeedsInput: { borderLeftColor: colors.yellow },
  pressed: { backgroundColor: colors.surface },
  top: { flexDirection: 'row', alignItems: 'center', gap: 6 },
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
  title: { flex: 1, color: colors.ink, fontSize: 14, fontWeight: '600' },
  subtitle: { color: colors.blue, fontSize: 12 },
  body: { color: colors.inkDim, fontSize: 13, lineHeight: 18 },
});
