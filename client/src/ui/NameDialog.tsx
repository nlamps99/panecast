import { useRef, useState, type ReactNode, type Ref } from 'react';
import { Modal, Pressable, StyleSheet, Text, TextInput, View, type TextInputInstance } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { colors } from './theme';

// RN's iOS Modal defaults to portrait only, which would rotate a landscape phone.
const ORIENTATIONS = ['portrait', 'portrait-upside-down', 'landscape'] as const;

type DialogModalProps = {
  visible: boolean;
  /** `top` keeps a text field clear of the keyboard; `bottom` is an action sheet. */
  placement: 'top' | 'bottom';
  /** Backdrop tap and the Android back button. */
  onDismiss: () => void;
  onShow?: () => void;
  children: ReactNode;
};

/**
 * A dimmed, fading modal holding one card. Cross-platform: `Alert.prompt` and
 * `ActionSheetIOS` are iOS-only, and `Alert` does nothing on the web.
 */
export function DialogModal({ visible, placement, onDismiss, onShow, children }: DialogModalProps) {
  const insets = useSafeAreaInsets();
  const place =
    placement === 'top'
      ? { justifyContent: 'flex-start' as const, paddingTop: insets.top + 48 }
      : { justifyContent: 'flex-end' as const, paddingBottom: insets.bottom + 8 };
  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onDismiss}
      onShow={onShow}
      supportedOrientations={[...ORIENTATIONS]}
    >
      <View style={[styles.frame, place, { paddingLeft: insets.left + 16, paddingRight: insets.right + 16 }]}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onDismiss} accessibilityRole="button" accessibilityLabel="取消" />
        <View style={styles.content}>{children}</View>
      </View>
    </Modal>
  );
}

export type NameFormProps = {
  title: string;
  message?: string;
  initialValue?: string;
  placeholder?: string;
  confirmLabel: string;
  onCancel: () => void;
  /** Receives the trimmed name, never empty. */
  onSubmit: (name: string) => void;
  inputRef?: Ref<TextInputInstance>;
};

/**
 * A card asking for a name. The field is uncontrolled (`defaultValue`, never
 * `value`): writing the value back while an input method is composing breaks
 * Chinese input apart. Mount it with a fresh `key` per prompt to reset it.
 */
export function NameForm({ title, message, initialValue = '', placeholder, confirmLabel, onCancel, onSubmit, inputRef }: NameFormProps) {
  const text = useRef(initialValue);
  const [empty, setEmpty] = useState(initialValue.trim() === '');
  const submit = () => {
    const name = text.current.trim();
    if (name) onSubmit(name);
  };
  return (
    <View style={styles.card}>
      <Text style={styles.title}>{title}</Text>
      {message ? <Text style={styles.message}>{message}</Text> : null}
      <TextInput
        ref={inputRef}
        defaultValue={initialValue}
        onChangeText={(value) => {
          text.current = value;
          setEmpty(value.trim() === '');
        }}
        onSubmitEditing={submit}
        placeholder={placeholder}
        placeholderTextColor={colors.muted}
        autoFocus
        selectTextOnFocus={initialValue !== ''}
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="done"
        enablesReturnKeyAutomatically
        clearButtonMode="while-editing"
        style={styles.input}
        accessibilityLabel={title}
      />
      <View style={styles.buttons}>
        <Pressable onPress={onCancel} style={({ pressed }) => [styles.button, pressed && styles.pressed]} accessibilityRole="button">
          <Text style={styles.cancelText}>取消</Text>
        </Pressable>
        <Pressable
          onPress={submit}
          disabled={empty}
          style={({ pressed }) => [styles.button, styles.confirm, pressed && styles.pressed, empty && styles.disabled]}
          accessibilityRole="button"
          accessibilityState={{ disabled: empty }}
        >
          <Text style={styles.confirmText}>{confirmLabel}</Text>
        </Pressable>
      </View>
    </View>
  );
}

/**
 * A modal that asks for a name. Render it with a new `key` each time it opens
 * so the field starts from `initialValue`.
 */
export function NameDialog({ visible, ...form }: NameFormProps & { visible: boolean }) {
  const input = useRef<TextInputInstance>(null);
  return (
    // `autoFocus` alone does not always raise the keyboard inside a modal that is still presenting.
    <DialogModal visible={visible} placement="top" onDismiss={form.onCancel} onShow={() => input.current?.focus()}>
      <NameForm {...form} inputRef={input} />
    </DialogModal>
  );
}

const styles = StyleSheet.create({
  frame: { flex: 1, backgroundColor: 'rgba(0, 0, 0, 0.55)' },
  content: { width: '100%', maxWidth: 420, alignSelf: 'center' },
  card: {
    gap: 12,
    padding: 16,
    borderRadius: 14,
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.divider,
  },
  title: { color: colors.ink, fontSize: 17, fontWeight: '600' },
  message: { color: colors.inkDim, fontSize: 13, lineHeight: 18 },
  input: {
    height: 44,
    paddingHorizontal: 12,
    borderRadius: 10,
    color: colors.ink,
    fontSize: 16,
    backgroundColor: colors.surfaceSunken,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.divider,
  },
  buttons: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8 },
  button: { minWidth: 72, height: 40, paddingHorizontal: 14, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  confirm: { backgroundColor: colors.green },
  pressed: { opacity: 0.7 },
  disabled: { opacity: 0.4 },
  cancelText: { color: colors.inkDim, fontSize: 15 },
  confirmText: { color: colors.canvas, fontSize: 15, fontWeight: '600' },
});
