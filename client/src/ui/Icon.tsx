import { SymbolView } from 'expo-symbols';
import type { ComponentProps } from 'react';

type SymbolName = ComponentProps<typeof SymbolView>['name'];

/** SF Symbols on iOS, Material Symbols (bundled font, no Google Play services) on Android and the web. */
const ICONS = {
  workspaces: { ios: 'square.stack.3d.up.fill', android: 'stacks', web: 'stacks' },
  terminal: { ios: 'terminal.fill', android: 'terminal', web: 'terminal' },
  inbox: { ios: 'bell.fill', android: 'notifications', web: 'notifications' },
  settings: { ios: 'gearshape.fill', android: 'settings', web: 'settings' },
  back: { ios: 'chevron.left', android: 'arrow_back_ios_new', web: 'arrow_back_ios_new' },
  forward: { ios: 'chevron.right', android: 'chevron_right', web: 'chevron_right' },
  computer: { ios: 'desktopcomputer', android: 'desktop_mac', web: 'desktop_mac' },
  search: { ios: 'magnifyingglass', android: 'search', web: 'search' },
  plus: { ios: 'plus', android: 'add', web: 'add' },
  batteryFull: { ios: 'battery.100', android: 'battery_android_full', web: 'battery_android_full' },
  batteryHigh: { ios: 'battery.75', android: 'battery_android_5', web: 'battery_android_5' },
  batteryHalf: { ios: 'battery.50', android: 'battery_android_3', web: 'battery_android_3' },
  batteryLow: { ios: 'battery.25', android: 'battery_android_1', web: 'battery_android_1' },
  batteryCharging: { ios: 'battery.100.bolt', android: 'battery_android_bolt', web: 'battery_android_bolt' },
  add: { ios: 'plus', android: 'add', web: 'add' },
  check: { ios: 'checkmark', android: 'check', web: 'check' },
  close: { ios: 'xmark', android: 'close', web: 'close' },
  expand: { ios: 'chevron.down', android: 'expand_more', web: 'expand_more' },
  demo: { ios: 'play.rectangle', android: 'slideshow', web: 'slideshow' },
} as const satisfies Record<string, SymbolName>;

export type IconName = keyof typeof ICONS;

export function Icon({ name, size = 20, color }: { name: IconName; size?: number; color: string }) {
  return <SymbolView name={ICONS[name]} size={size} tintColor={color} weight="semibold" />;
}
