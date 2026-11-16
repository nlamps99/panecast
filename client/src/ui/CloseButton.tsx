import { Pressable, StyleSheet } from 'react-native';
import { Icon } from './Icon';
import { colors } from './theme';

/** A small × that closes something on the computer; the caller asks for confirmation. */
export function CloseButton({ label, disabled = false, onPress }: { label: string; disabled?: boolean; onPress(): void }) {
  return <Pressable onPress={event => { event.stopPropagation(); onPress(); }} disabled={disabled}
    // 28 points is enough for a pointer; fingers get a larger touch area.
    hitSlop={6}
    accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled }}
    style={({ pressed }) => [styles.button, pressed && styles.pressed, disabled && styles.disabled]}>
    <Icon name="close" size={13} color={colors.muted} />
  </Pressable>;
}
const styles = StyleSheet.create({ button: { width: 28, height: 28, alignItems: 'center', justifyContent: 'center', borderRadius: 6, flexShrink: 0 },
  pressed: { backgroundColor: colors.divider }, disabled: { opacity: 0.35 } });
