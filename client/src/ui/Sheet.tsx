import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Animated, Keyboard, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Icon, type IconName } from './Icon';
import { colors } from './theme';

/** If iOS never reports the dismissal, run the pending action anyway after this long. */
const DISMISS_FALLBACK_MS = 700;
const SLIDE_PX = 48;

/**
 * Open/close state for a `Sheet`. `close(then)` runs `then` once the sheet is
 * gone: iOS cannot present another screen (the pairing modal) or survive its
 * presenter unmounting (removing the last computer) while a modal is still
 * on screen.
 */
export function useSheet() {
  const [visible, setVisible] = useState(false);
  const pending = useRef<(() => void) | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flush = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const action = pending.current;
    pending.current = null;
    action?.();
  };

  const open = () => setVisible(true);

  const close = (then?: () => void) => {
    Keyboard.dismiss();
    setVisible(false);
    if (!then) return;
    pending.current = then;
    if (timer.current) clearTimeout(timer.current);
    // Only iOS reports the end of the dismissal (`onDismiss`); elsewhere the modal is gone on the next frame.
    timer.current = setTimeout(flush, Platform.OS === 'ios' ? DISMISS_FALLBACK_MS : 0);
  };

  return { visible, open, close, onClosed: flush };
}

type SheetProps = {
  visible: boolean;
  title: string;
  /** Backdrop tap, Android back, the close button. */
  onClose: () => void;
  /** After the sheet has left the screen (iOS only; see `useSheet`). */
  onClosed?: () => void;
  children: ReactNode;
};

/** A bottom sheet over the current screen. */
export function Sheet({ visible, title, onClose, onClosed, children }: SheetProps) {
  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
      onDismiss={onClosed}
      statusBarTranslucent
      navigationBarTranslucent
      supportedOrientations={['portrait', 'portrait-upside-down', 'landscape']}
    >
      <Pressable style={styles.backdrop} onPress={onClose} accessibilityRole="button" accessibilityLabel="关闭" />
      <KeyboardAvoidingView style={styles.frame} behavior="padding" pointerEvents="box-none">
        <SheetPanel title={title} onClose={onClose}>
          {children}
        </SheetPanel>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function SheetPanel({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const insets = useSafeAreaInsets();
  const [offset] = useState(() => new Animated.Value(SLIDE_PX));

  // Mounted on every open: the modal unmounts its children once closed.
  useEffect(() => {
    Animated.timing(offset, { toValue: 0, duration: 220, useNativeDriver: Platform.OS !== 'web' }).start();
  }, [offset]);

  return (
    <Animated.View
      style={[
        styles.panel,
        { paddingBottom: Math.max(insets.bottom, 12), marginTop: insets.top + 40, transform: [{ translateY: offset }] },
      ]}
    >
      <View style={styles.grabber} />
      <View style={styles.header}>
        <Text style={styles.title} accessibilityRole="header" numberOfLines={1}>
          {title}
        </Text>
        <Pressable onPress={onClose} hitSlop={10} style={styles.close} accessibilityRole="button" accessibilityLabel="关闭">
          <Icon name="close" size={13} color={colors.inkDim} />
        </Pressable>
      </View>
      <ScrollView style={styles.body} keyboardShouldPersistTaps="handled" bounces={false}>
        {children}
      </ScrollView>
    </Animated.View>
  );
}

type SheetRowProps = {
  icon?: IconName;
  iconColor?: string;
  title: string;
  titleColor?: string;
  detail?: string;
  detailColor?: string;
  /** Right side: a status dot, a checkmark… */
  trailing?: ReactNode;
  divided?: boolean;
  disabled?: boolean;
  accessibilityLabel?: string;
  selected?: boolean;
  onPress: () => void;
};

/** One tappable line of a sheet. */
export function SheetRow({
  icon,
  iconColor = colors.inkDim,
  title,
  titleColor = colors.ink,
  detail,
  detailColor = colors.muted,
  trailing,
  divided = true,
  disabled,
  accessibilityLabel,
  selected,
  onPress,
}: SheetRowProps) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [styles.row, divided && styles.divided, pressed && styles.pressed, disabled && styles.dim]}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ selected, disabled }}
    >
      {icon ? <Icon name={icon} size={18} color={iconColor} /> : null}
      <View style={styles.rowText}>
        <Text style={[styles.rowTitle, { color: titleColor }]} numberOfLines={1}>
          {title}
        </Text>
        {detail ? (
          <Text style={[styles.rowDetail, { color: detailColor }]} numberOfLines={1}>
            {detail}
          </Text>
        ) : null}
      </View>
      {trailing}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  backdrop: { ...StyleSheet.absoluteFill, backgroundColor: 'rgba(0, 0, 0, 0.45)' },
  frame: { flex: 1, justifyContent: 'flex-end' },
  panel: {
    flexShrink: 1,
    backgroundColor: colors.surface,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: 0,
    borderColor: colors.divider,
  },
  grabber: { alignSelf: 'center', width: 36, height: 5, borderRadius: 3, marginTop: 8, backgroundColor: colors.mutedDim },
  header: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingLeft: 18, paddingRight: 14, paddingTop: 8, paddingBottom: 6 },
  title: { flex: 1, color: colors.ink, fontSize: 17, fontWeight: '600' },
  close: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surfaceRaised,
  },
  body: { flexGrow: 0 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 54, paddingHorizontal: 18, paddingVertical: 9 },
  divided: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.divider },
  pressed: { backgroundColor: colors.surfaceRaised },
  dim: { opacity: 0.5 },
  rowText: { flex: 1, gap: 2 },
  rowTitle: { fontSize: 16 },
  rowDetail: { fontSize: 12 },
});
