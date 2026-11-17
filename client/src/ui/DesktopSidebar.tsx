import { router, usePathname } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { restartToUpdate, useDesktopUpdate } from '../platform/desktopUpdate';
import { useMachine, useStore } from '../state/hooks';
import { Icon, type IconName } from './Icon';
import { colors } from './theme';
import { WorkspaceSidebar } from './WorkspaceSidebar';

const PAGES: { path: string; label: string; icon: IconName; hint: string }[] = [
  { path: '/terminal', label: '终端', icon: 'terminal', hint: '⌘L' },
  { path: '/sources', label: '来源', icon: 'computer', hint: '' },
  { path: '/inbox', label: '收件箱', icon: 'inbox', hint: '' },
  { path: '/settings', label: '设置', icon: 'settings', hint: '⌘,' },
];

/**
 * The desktop window's left column on every page: computers, windows,
 * workspaces and terminals, then the other pages. It replaces the phone's
 * workspace list, back button and bottom tab bar.
 */
export function DesktopSidebar() {
  const pathname = usePathname();
  const { inbox } = useMachine();
  const { unread } = useStore(inbox);
  const update = useDesktopUpdate();
  return <View style={styles.column}>
    <WorkspaceSidebar />
    {update?.state === 'ready' ? <Pressable onPress={() => { void restartToUpdate(); }} style={({ pressed }) => [styles.update, pressed && styles.itemPressed]}
      accessibilityRole="button" accessibilityLabel={`新版本 ${update.version} 已安装，重启后使用`}>
      <Text style={styles.updateText} numberOfLines={1}>新版本 {update.version} 已就绪</Text>
      <Text style={styles.updateAction}>重启</Text>
    </Pressable> : null}
    <View style={styles.nav} accessibilityRole="tablist">
      {PAGES.map((page) => {
        const active = pathname === page.path;
        const badge = page.path === '/inbox' ? unread : 0;
        return <Pressable key={page.path} onPress={() => router.navigate(page.path as never)} style={({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) => [styles.item, (active || hovered) && styles.itemActive, pressed && styles.itemPressed]}
          accessibilityRole="tab" accessibilityState={{ selected: active }} accessibilityLabel={badge ? `${page.label}，${badge} 条未读` : page.label}>
          <Icon name={page.icon} size={16} color={active ? colors.green : colors.inkDim} />
          <Text style={[styles.label, active && styles.labelActive]}>{page.label}</Text>
          {badge ? <Text style={styles.badge}>{badge > 99 ? '99+' : badge}</Text> : null}
        </Pressable>;
      })}
    </View>
  </View>;
}

const styles = StyleSheet.create({
  column: { width: 270, flexShrink: 0, backgroundColor: colors.surfaceSunken, borderRightWidth: StyleSheet.hairlineWidth, borderRightColor: colors.border },
  nav: { flexDirection: 'row', flexWrap: 'wrap', gap: 4, padding: 8, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.divider },
  item: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 10, paddingVertical: 8, borderRadius: 8 },
  itemActive: { backgroundColor: colors.surfaceRaised },
  itemPressed: { opacity: 0.7 },
  label: { color: colors.inkDim, fontSize: 13 },
  labelActive: { color: colors.green, fontWeight: '600' },
  update: { flexDirection: 'row', alignItems: 'center', gap: 8, marginHorizontal: 8, marginBottom: 8, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8, backgroundColor: colors.surfaceRaised },
  updateText: { flex: 1, color: colors.ink, fontSize: 13 },
  updateAction: { color: colors.green, fontSize: 13, fontWeight: '600' },
  badge: { color: colors.canvas, backgroundColor: colors.red, borderRadius: 8, overflow: 'hidden', paddingHorizontal: 5, fontSize: 11, fontWeight: '700' },
});
