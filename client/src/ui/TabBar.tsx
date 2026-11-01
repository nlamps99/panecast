import type { BottomTabBarProps } from 'expo-router/tabs';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Icon, type IconName } from './Icon';
import { colors } from './theme';

type Props = BottomTabBarProps & {
  /** Route names in display order. */
  order: readonly string[];
  /** Hidden on these routes (the terminal needs the whole height). */
  hiddenOn: readonly string[];
  badges: Readonly<Record<string, number>>;
};

const ICONS: Record<string, IconName> = {
  index: 'workspaces',
  terminal: 'terminal',
  inbox: 'inbox',
  settings: 'settings',
};

/** A floating tab bar in the style of the native cmux Remote client. */
export function TabBar({ state, descriptors, navigateToTab, order, hiddenOn, badges }: Props) {
  const insets = useSafeAreaInsets();
  const focused = state.routes[state.index];
  if (hiddenOn.includes(focused.name)) return null;

  return (
    <View style={[styles.wrapper, { paddingBottom: Math.max(insets.bottom - 6, 8) }]}>
      <View style={styles.bar}>
        {[...state.routes].sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name)).map((route) => {
          const { options } = descriptors[route.key];
          const label = typeof options.title === 'string' ? options.title : route.name;
          const active = route.key === focused.key;
          const tint = active ? colors.green : colors.muted;
          const badge = badges[route.name] ?? 0;
          return (
            <Pressable
              key={route.key}
              onPress={() => navigateToTab(route.key)}
              style={[styles.item, active && styles.itemActive]}
              accessibilityRole="tab"
              accessibilityState={{ selected: active }}
              accessibilityLabel={badge > 0 ? `${label}，${badge} 条未读` : label}
            >
              <Icon name={ICONS[route.name] ?? 'workspaces'} size={19} color={tint} />
              <Text style={[styles.label, { color: tint }]}>{label}</Text>
              {badge > 0 ? (
                <View style={styles.badge}>
                  <Text style={styles.badgeText}>{badge > 99 ? '99+' : badge}</Text>
                </View>
              ) : null}
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: { paddingHorizontal: 16, paddingTop: 6, backgroundColor: colors.canvas },
  bar: {
    flexDirection: 'row',
    gap: 6,
    padding: 5,
    borderRadius: 14,
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.divider,
  },
  item: { flex: 1, height: 52, alignItems: 'center', justifyContent: 'center', gap: 3, borderRadius: 10 },
  itemActive: { backgroundColor: colors.surfaceRaised },
  label: { fontSize: 11, fontWeight: '600' },
  badge: {
    position: 'absolute',
    top: 4,
    right: '22%',
    minWidth: 18,
    height: 18,
    paddingHorizontal: 5,
    borderRadius: 9,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.red,
  },
  badgeText: { color: colors.canvas, fontSize: 10, fontWeight: '700' },
});
