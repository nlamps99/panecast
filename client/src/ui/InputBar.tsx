import { useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { TerminalInputView, type TerminalInputHandle, type TerminalInputKey } from '../../modules/terminal-input';
import { translateCommitted } from '../input/translate';
import { Keys } from '../protocol/keys';
import type { TerminalSession } from '../session/terminalSession';
import { setPrefs, usePrefs } from '../state/prefs';
import { KeyBar } from './KeyBar';
import { colors, fonts } from './theme';

const INPUT_FONT_SIZE = 15;
/** One line of GeistMono at 15 pt plus the native view's 8 pt top and bottom inset. */
const INPUT_MIN_HEIGHT = 36;
const INPUT_MAX_LINES = 4;
const INPUT_LINE_HEIGHT = Math.round(INPUT_FONT_SIZE * 1.3);
const INPUT_MAX_HEIGHT = INPUT_LINE_HEIGHT * INPUT_MAX_LINES + 16;

type Props = {
  session: TerminalSession;
  disabled: boolean;
  /** A send failure from the session. */
  error: string | null;
  inputRef: React.RefObject<TerminalInputHandle | null>;
};

/**
 * The bottom of the terminal screen: a row of keys a phone keyboard lacks,
 * then the input. The input sits directly above the keyboard, the way chat
 * apps do; the keys are one row up and also work with the keyboard hidden,
 * which covers most TUI prompts (arrows, Enter, Esc).
 *
 * Command mode (`line`): edit a line, send it with Return or ↑.
 * Live mode: every committed character goes to the terminal as it is typed.
 * In both, text the input method is still composing is never sent.
 */
export function InputBar({ session, disabled, error, inputRef }: Props) {
  const { inputMode: mode } = usePrefs();
  const [hint, setHint] = useState<string | null>(null);
  const [hasText, setHasText] = useState(false);
  const [inputHeight, setInputHeight] = useState(INPUT_MIN_HEIGHT);
  const draft = useRef({ text: '', composing: false });

  const submit = (text: string) => {
    if (draft.current.composing) {
      setHint('输入法还在选字，先选好再发送');
      return;
    }
    setHint(null);
    session.submitLine(text.replace(/[\r\n]+$/, ''));
    draft.current = { text: '', composing: false };
    setHasText(false);
    void inputRef.current?.clear();
  };

  const sendCommitted = (text: string) => {
    for (const action of translateCommitted(text)) {
      if (action.kind === 'text') session.sendText(action.text);
      else session.sendKey(action.key);
    }
  };

  const sendKeyAction = (key: TerminalInputKey) => {
    session.sendKey(key === 'enter' ? Keys.enter : Keys.backspace);
  };

  const switchMode = (next: 'line' | 'live') => {
    if (next === mode) return;
    setHint(null);
    setHasText(false);
    draft.current = { text: '', composing: false };
    setInputHeight(INPUT_MIN_HEIGHT);
    setPrefs({ inputMode: next });
  };

  const message = hint ?? error;
  const maxHeight = mode === 'line' ? INPUT_MAX_HEIGHT : INPUT_MIN_HEIGHT;

  return (
    <View>
      {message ? <Text style={[styles.message, !hint && styles.messageError]}>{message}</Text> : null}
      <KeyBar session={session} />
      <View style={styles.row}>
        <View style={styles.segment} accessibilityRole="tablist">
          {(['line', 'live'] as const).map((item) => (
            <Pressable
              key={item}
              onPress={() => switchMode(item)}
              style={[styles.segmentItem, mode === item && styles.segmentItemActive]}
              accessibilityRole="tab"
              accessibilityState={{ selected: mode === item }}
              accessibilityLabel={item === 'line' ? '命令输入：整行发送' : '逐字输入：打一个字发一个字'}
            >
              <Text style={[styles.segmentText, mode === item && styles.segmentTextActive]}>
                {item === 'line' ? '命令' : '逐字'}
              </Text>
            </Pressable>
          ))}
        </View>
        <View style={styles.inputBox}>
          <TerminalInputView
            ref={inputRef}
            mode={mode}
            editable={!disabled}
            placeholder={mode === 'live' ? '打字直接发到终端' : '输入命令'}
            placeholderColor={colors.muted}
            textColor={colors.ink}
            caretColor={colors.green}
            fontFamily={fonts.mono}
            fontSize={INPUT_FONT_SIZE}
            style={{ height: Math.min(maxHeight, Math.max(INPUT_MIN_HEIGHT, inputHeight)) }}
            onContentSizeChange={setInputHeight}
            onChangeState={(state) => {
              draft.current = state;
              const nextHasText = state.text.length > 0;
              if (nextHasText !== hasText) setHasText(nextHasText);
              if (hint && !state.composing) setHint(null);
            }}
            onSubmit={submit}
            onCommitText={sendCommitted}
            onKeyAction={sendKeyAction}
          />
        </View>
        {mode === 'line' ? (
          <Pressable
            onPress={() => submit(draft.current.text)}
            disabled={disabled}
            style={({ pressed }) => [styles.send, !hasText && styles.sendEmpty, pressed && styles.sendPressed]}
            accessibilityRole="button"
            accessibilityLabel={hasText ? '发送命令' : '发送回车'}
            hitSlop={6}
          >
            <Text style={[styles.sendText, !hasText && styles.sendTextEmpty]}>发送</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  message: { color: colors.yellow, fontSize: 12, paddingHorizontal: 14, paddingTop: 4 },
  messageError: { color: colors.red },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 8,
    paddingHorizontal: 8,
    paddingTop: 2,
    paddingBottom: 6,
  },
  segment: {
    flexDirection: 'row',
    height: 36,
    padding: 3,
    borderRadius: 8,
    backgroundColor: colors.surface,
  },
  segmentItem: { paddingHorizontal: 8, justifyContent: 'center', borderRadius: 6 },
  segmentItemActive: { backgroundColor: colors.surfaceRaised },
  segmentText: { color: colors.muted, fontSize: 13 },
  segmentTextActive: { color: colors.green, fontWeight: '600' },
  inputBox: {
    flex: 1,
    paddingHorizontal: 10,
    borderRadius: 8,
    backgroundColor: colors.surfaceSunken,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.divider,
  },
  send: {
    height: 36,
    paddingHorizontal: 12,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.green,
  },
  sendEmpty: { backgroundColor: colors.surface },
  sendPressed: { opacity: 0.7 },
  sendText: { color: colors.canvas, fontSize: 14, fontWeight: '600' },
  sendTextEmpty: { color: colors.muted },
});
