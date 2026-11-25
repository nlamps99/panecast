import { Tabs, router, usePathname } from 'expo-router';
import { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import { appStore } from '../../state/appStore';
import { rememberTab } from '../../state/navigation';
import { DesktopSidebar } from '../../ui/DesktopSidebar';
import { useDesktopShell } from '../../ui/desktopShell';
import { useDesktopShortcuts } from '../../ui/useDesktopShortcuts';

import { useMachine, useStore } from '../../state/hooks';
import { useLiveLinesPref } from '../../state/useLiveLinesPref';
import { TabBar } from '../../ui/TabBar';
import { colors } from '../../ui/theme';

/**
 * 工作区 · 终端 · 收件箱 · 设置, as in the native cmux Remote client. The
 * terminal hides the tab bar.
 *
 * Screens are declared in the order expo-router seeds the navigator with
 * (index first, then by file name); declaring them otherwise logs a
 * ROUTE_NAMES_CHANGED warning. The tab bar sets the order on screen.
 */
export default function TabsLayout() {
  const machine = useMachine();
  const { inbox, session, computer } = machine;
  const pathname = usePathname();
  const desktop = useDesktopShell();
  useEffect(() => {
    const restore = appStore.takeRestoredRoute(computer?.id ?? null);
    if (restore && pathname === '/') router.replace(restore);
    // The desktop sidebar already lists the workspaces; the window shows a terminal.
    else if (desktop && pathname === '/') router.replace('/terminal');
  }, [computer?.id, pathname, desktop]);
  // The terminal's back button returns to whichever tab opened it.
  useEffect(() => { rememberTab(pathname); }, [pathname]);
  const { unread } = useStore(inbox);
  // The layout lives as long as the connection, so the history-lines pref follows changes here.
  useLiveLinesPref(session);
  useDesktopShortcuts(machine, desktop);

  const tabs = (
    <Tabs
      backBehavior="firstRoute"
      screenOptions={{ headerShown: false, sceneStyle: { backgroundColor: colors.canvas } }}
      tabBar={(props) => (
        desktop ? null : <TabBar {...props} order={['index', 'sources', 'terminal', 'inbox', 'settings']} hiddenOn={['terminal']} badges={{ inbox: unread }} />
      )}
    >
      <Tabs.Screen name="index" options={{ title: '工作区' }} />
      <Tabs.Screen name="inbox" options={{ title: '收件箱' }} />
      <Tabs.Screen name="settings" options={{ title: '设置' }} />
      <Tabs.Screen name="sources" options={{ title: '来源' }} />
      <Tabs.Screen name="terminal" options={{ title: '终端' }} />
    </Tabs>
  );
  if (!desktop) return tabs;
  return <View style={styles.desktop}><DesktopSidebar /><View style={styles.content}>{tabs}</View></View>;
}

const styles = StyleSheet.create({
  desktop: { flex: 1, flexDirection: 'row', backgroundColor: colors.canvas },
  content: { flex: 1, minWidth: 0 },
});
