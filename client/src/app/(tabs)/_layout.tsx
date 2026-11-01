import { Tabs } from 'expo-router';

import { useMachine, useStore } from '../../state/hooks';
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
  const { inbox } = useMachine();
  const { unread } = useStore(inbox);

  return (
    <Tabs
      backBehavior="firstRoute"
      screenOptions={{ headerShown: false, sceneStyle: { backgroundColor: colors.canvas } }}
      tabBar={(props) => (
        <TabBar {...props} order={['index', 'terminal', 'inbox', 'settings']} hiddenOn={['terminal']} badges={{ inbox: unread }} />
      )}
    >
      <Tabs.Screen name="index" options={{ title: '工作区' }} />
      <Tabs.Screen name="inbox" options={{ title: '收件箱' }} />
      <Tabs.Screen name="settings" options={{ title: '设置' }} />
      <Tabs.Screen name="terminal" options={{ title: '终端' }} />
    </Tabs>
  );
}
