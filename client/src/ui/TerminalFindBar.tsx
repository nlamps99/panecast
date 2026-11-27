import { useEffect, useRef } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View, type TextInputInstance, type TextInputKeyPressEvent } from 'react-native';

import { colors } from './theme';

type Props = {
  /** Shown when the bar opens. The field is not controlled afterwards, so an input method composes undisturbed. */
  query: string;
  onChangeQuery(query: string): void;
  /** Matching rows, and the current one counted from the oldest (-1 for none). */
  total: number;
  current: number;
  /** 1: the next older match (up), -1: the next newer one (down). */
  onStep(step: 1 | -1): void;
  onClose(): void;
  /** Bumped by ⌘F while the bar is open: focus the field and select its text. */
  focusRequest: number;
};

/** On the web the event is the DOM key event's wrapper. */
type KeyPress = { nativeEvent: { key: string; shiftKey?: boolean; isComposing?: boolean; keyCode?: number }; preventDefault?(): void };

/**
 * The desktop's find bar over the top of the terminal (⌘F). Matches are
 * marked in the terminal itself, starting from the newest; Enter goes to
 * the next older one, Shift+Enter back to newer, Esc closes.
 */
export function TerminalFindBar({ query, onChangeQuery, total, current, onStep, onClose, focusRequest }: Props) {
  const input = useRef<TextInputInstance>(null);
  useEffect(() => {
    input.current?.focus();
    (input.current as unknown as { select?: () => void } | null)?.select?.();
  }, [focusRequest]);
  const onKeyPress = (event: TextInputKeyPressEvent) => {
    const key = event as unknown as KeyPress;
    // Enter while an input method is composing picks its candidate.
    if (key.nativeEvent.isComposing || key.nativeEvent.keyCode === 229) return;
    if (key.nativeEvent.key === 'Escape') { key.preventDefault?.(); onClose(); }
    else if (key.nativeEvent.key === 'Enter') { key.preventDefault?.(); onStep(key.nativeEvent.shiftKey ? -1 : 1); }
  };
  return (
    <View testID="terminal-find-bar" style={s.bar}>
      <TextInput ref={input} testID="terminal-find-input" style={s.input} defaultValue={query} onChangeText={onChangeQuery} onKeyPress={onKeyPress}
        placeholder="搜索已加载的输出" placeholderTextColor={colors.muted} autoCapitalize="none" autoCorrect={false} spellCheck={false} selectTextOnFocus
        accessibilityLabel="搜索终端输出" accessibilityHint="回车查找更早的一处，Shift 加回车查找更新的一处，Esc 关闭" />
      <Text testID="terminal-find-count" style={s.count} accessibilityLiveRegion="polite">{total ? `${current + 1}/${total}` : query.trim() ? '无结果' : ''}</Text>
      <FindButton label="↑" description="上一处匹配（更早）" disabled={!total} onPress={() => onStep(1)} />
      <FindButton label="↓" description="下一处匹配（更新）" disabled={!total} onPress={() => onStep(-1)} />
      <FindButton label="✕" description="关闭搜索" onPress={onClose} />
    </View>
  );
}

function FindButton({ label, description, disabled = false, onPress }: { label: string; description: string; disabled?: boolean; onPress(): void }) {
  return (
    <Pressable onPress={onPress} disabled={disabled} hitSlop={4} style={({ pressed }) => [s.button, pressed && s.pressed, disabled && s.disabled]}
      accessibilityRole="button" accessibilityLabel={description} accessibilityState={{ disabled }}>
      <Text style={s.buttonText}>{label}</Text>
    </Pressable>
  );
}

const s = StyleSheet.create({
  bar: {
    position: 'absolute',
    top: 6,
    right: 12,
    width: 340,
    maxWidth: '90%',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    paddingLeft: 8,
    paddingRight: 4,
    paddingVertical: 4,
    borderRadius: 8,
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  input: { flex: 1, minWidth: 0, height: 28, paddingHorizontal: 6, borderRadius: 5, color: colors.ink, backgroundColor: colors.surfaceSunken, fontSize: 13 },
  count: { minWidth: 52, paddingHorizontal: 6, textAlign: 'center', color: colors.muted, fontSize: 12 },
  button: { width: 28, height: 28, borderRadius: 5, alignItems: 'center', justifyContent: 'center' },
  pressed: { backgroundColor: colors.surfaceRaised },
  disabled: { opacity: 0.4 },
  buttonText: { color: colors.ink, fontSize: 14 },
});
