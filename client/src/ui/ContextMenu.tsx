import { useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';

import { colors } from './theme';

export type ContextMenuItem =
  | { label: string; onPress: () => void; destructive?: boolean; disabled?: boolean }
  | 'separator';
export type MenuPoint = { x: number; y: number };
type OpenMenu = { point: MenuPoint; items: ContextMenuItem[] };

const WIDTH = 200;
const ITEM_HEIGHT = 28;
const SEPARATOR_HEIGHT = 9;
const PADDING = 4;
const MARGIN = 8;

/** Where a menu of this size opens so it stays inside the window, as the system's menus do. */
export function menuPosition(point: MenuPoint, items: readonly ContextMenuItem[], size: { width: number; height: number }) {
  const height = PADDING * 2 + items.reduce((sum, item) => sum + (item === 'separator' ? SEPARATOR_HEIGHT : ITEM_HEIGHT), 0);
  return {
    left: Math.max(MARGIN, Math.min(point.x, size.width - WIDTH - MARGIN)),
    top: Math.max(MARGIN, Math.min(point.y, size.height - height - MARGIN)),
  };
}

/** Drops separators at either end and doubled ones, left behind by hidden actions. */
function tidy(items: readonly ContextMenuItem[]): ContextMenuItem[] {
  return items.filter((item, index, all) => item !== 'separator'
    || (index > 0 && index < all.length - 1 && all[index - 1] !== 'separator' && all.slice(index + 1).some(next => next !== 'separator')));
}

/**
 * A right-click menu for the desktop window: `open` from an `onContextMenu`
 * event (see `contextMenuProps`), render `element` once. Nothing opens when
 * every action is hidden, for example on a read-only source.
 */
export function useContextMenu() {
  const [menu, setMenu] = useState<OpenMenu | null>(null);
  const open = (point: MenuPoint, items: readonly ContextMenuItem[]) => {
    const shown = tidy(items);
    if (shown.some(item => item !== 'separator')) setMenu({ point, items: shown });
  };
  const element = <ContextMenu menu={menu} onDismiss={() => setMenu(null)} />;
  return { open, element };
}

function ContextMenu({ menu, onDismiss }: { menu: OpenMenu | null; onDismiss: () => void }) {
  return menu ? <MenuCard menu={menu} onDismiss={onDismiss} /> : null;
}

function MenuCard({ menu, onDismiss }: { menu: OpenMenu; onDismiss: () => void }) {
  const place = menuPosition(menu.point, menu.items, useWindowDimensions());
  return (
    <Modal visible transparent animationType="none" onRequestClose={onDismiss}>
      <Pressable style={StyleSheet.absoluteFill} onPress={onDismiss} {...contextMenuProps(onDismiss)} accessibilityLabel="关闭菜单" />
      <View style={[styles.menu, place]} accessibilityRole="menu">
        {menu.items.map((item, index) => item === 'separator'
          ? <View key={`separator-${index}`} style={styles.separator} />
          : <Pressable key={item.label} disabled={item.disabled} accessibilityRole="menuitem" accessibilityLabel={item.label} accessibilityState={{ disabled: item.disabled }}
              onPress={() => { onDismiss(); item.onPress(); }}
              style={({ hovered }: { pressed: boolean; hovered?: boolean }) => [styles.item, hovered && !item.disabled && styles.itemHovered]}>
              {({ hovered }: { pressed: boolean; hovered?: boolean }) => <Text numberOfLines={1}
                style={[styles.label, item.destructive && styles.destructive, hovered && !item.disabled && styles.labelHovered, item.disabled && styles.disabled]}>{item.label}</Text>}
            </Pressable>)}
      </View>
    </Modal>
  );
}

type ContextMenuEvent = { preventDefault(): void; stopPropagation?(): void; clientX?: number; clientY?: number; nativeEvent?: { clientX?: number; clientY?: number } };

/**
 * `onContextMenu` for a pressable or view on the web, which React Native's
 * types do not know. Spread it onto the element: `{...contextMenuProps(open)}`.
 */
export function contextMenuProps(open: (point: MenuPoint) => void): object {
  return {
    onContextMenu: (event: ContextMenuEvent) => {
      event.preventDefault();
      event.stopPropagation?.();
      const source = event.clientX !== undefined ? event : event.nativeEvent ?? {};
      open({ x: source.clientX ?? 0, y: source.clientY ?? 0 });
    },
  };
}

const titled = new Map<string, (node: unknown) => void>();
/**
 * A ref that gives a web element a native tooltip (the `title` attribute,
 * which React Native Web does not pass through). Elsewhere it does nothing.
 */
export function hoverTitle(text: string): (node: unknown) => void {
  let ref = titled.get(text);
  if (!ref) {
    // Terminal titles change as programs run; keep the cache small.
    if (titled.size >= 500) titled.clear();
    ref = (node: unknown) => {
      const element = node as { setAttribute?: (name: string, value: string) => void } | null;
      if (element && typeof element.setAttribute === 'function') element.setAttribute('title', text);
    };
    titled.set(text, ref);
  }
  return ref;
}

const styles = StyleSheet.create({
  menu: {
    position: 'absolute',
    width: WIDTH,
    paddingVertical: PADDING,
    borderRadius: 8,
    backgroundColor: colors.surfaceRaised,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    shadowColor: '#000',
    shadowOpacity: 0.35,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
  },
  item: { height: ITEM_HEIGHT, justifyContent: 'center', marginHorizontal: PADDING, paddingHorizontal: 10, borderRadius: 5 },
  itemHovered: { backgroundColor: colors.blue },
  label: { color: colors.ink, fontSize: 13 },
  labelHovered: { color: colors.canvas },
  destructive: { color: colors.red },
  disabled: { color: colors.muted },
  separator: { height: StyleSheet.hairlineWidth, marginVertical: (SEPARATOR_HEIGHT - 1) / 2, marginHorizontal: 10, backgroundColor: colors.divider },
});
