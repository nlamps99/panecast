import { useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { TerminalInputView, type TerminalInputHandle, type TerminalInputKey } from '../../modules/terminal-input';
import { translateCommitted } from '../input/translate';
import { Keys, type Key } from '../protocol/keys';
import type { TerminalSession } from '../session/terminalSession';
import { colors, fonts } from './theme';

type Mode = 'line' | 'live';

type Props = {
  session: TerminalSession;
  disabled: boolean;
  /** Shown under the input, e.g. a send failure. */
  error: string | null;
  inputRef: React.RefObject<TerminalInputHandle | null>;
};

/**
 * Command mode (`line`): type a whole line and send it with Enter.
 * Live mode: every committed character goes to the terminal as it is typed.
 * In both, text the input method is still composing is never sent.
 */
export function InputBar({ session, disabled, error, inputRef }: Props) {
  const [mode, setMode] = useState<Mode>('line');
  const [hint, setHint] = useState<string | null>(null);
  const draft = useRef({ text: '', composing: false });

  const submit = (text: string) => {
    if (draft.current.composing) {
      setHint('输入法还在选字，先选好再发送');
      return;
    }
    setHint(null);
    session.submitLine(text.replace(/[\r\n]+$/, ''));
    draft.current = { text: '', composing: false };
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

  const toggleMode = () => {
    setHint(null);
    draft.current = { text: '', composing: false };
    setMode((current) => (current === 'line' ? 'live' : 'line'));
  };

  const message = hint ?? error;

  return (
    <View style={styles.wrapper}>
      <View style={styles.row}>
        <Pressable
          onPress={toggleMode}
          style={[styles.mode, mode === 'live' && styles.modeLive]}
          accessibilityRole="button"
          accessibilityLabel={mode === 'live' ? '切换到命令输入' : '切换到逐字输入'}
        >
          <Text style={[styles.modeText, mode === 'live' && styles.modeTextLive]}>{mode === 'live' ? '逐字' : '命令'}</Text>
        </Pressable>
        <Text style={styles.prompt}>$</Text>
        <TerminalInputView
          ref={inputRef}
          mode={mode}
          editable={!disabled}
          placeholder={mode === 'live' ? '打字直接发到终端' : '输入命令，回车发送'}
          placeholderColor={colors.muted}
          textColor={colors.ink}
          caretColor={colors.green}
          fontFamily={fonts.mono}
          fontSize={15}
          style={styles.input}
          onChangeState={(state) => {
            draft.current = state;
            if (hint && !state.composing) setHint(null);
          }}
          onSubmit={submit}
          onCommitText={sendCommitted}
          onKeyAction={sendKeyAction}
        />
        {mode === 'line' ? (
          <Pressable
            onPress={() => submit(draft.current.text)}
            disabled={disabled}
            style={({ pressed }) => [styles.send, (pressed || disabled) && styles.sendDim]}
            accessibilityRole="button"
            accessibilityLabel="发送"
          >
            <Text style={styles.sendText}>发送</Text>
          </Pressable>
        ) : null}
      </View>
      {message ? <Text style={[styles.message, !hint && styles.messageError]}>{message}</Text> : null}
    </View>
  );
}

type KeyBarProps = {
  session: TerminalSession;
  onHideKeyboard: () => void;
};

const KEYS: { label: string; key: Key; a11y: string }[] = [
  { label: 'esc', key: Keys.escape, a11y: 'Esc' },
  { label: 'tab', key: Keys.tab, a11y: 'Tab' },
  { label: '^C', key: Keys.ctrlC, a11y: 'Ctrl C' },
  { label: '←', key: Keys.left, a11y: '左' },
  { label: '↑', key: Keys.up, a11y: '上' },
  { label: '↓', key: Keys.down, a11y: '下' },
  { label: '→', key: Keys.right, a11y: '右' },
];

/** Keys a phone keyboard does not have. */
export function KeyBar({ session, onHideKeyboard }: KeyBarProps) {
  return (
    <View style={styles.keyBar}>
      {KEYS.map(({ label, key, a11y }) => (
        <Pressable
          key={label}
          onPress={() => session.sendKey(key)}
          style={({ pressed }) => [styles.key, pressed && styles.keyPressed]}
          accessibilityRole="button"
          accessibilityLabel={`发送 ${a11y}`}
        >
          <Text style={styles.keyText}>{label}</Text>
        </Pressable>
      ))}
      <Pressable
        onPress={onHideKeyboard}
        style={({ pressed }) => [styles.key, styles.keyNarrow, pressed && styles.keyPressed]}
        accessibilityRole="button"
        accessibilityLabel="收起键盘"
      >
        <Text style={styles.keyText}>⌄</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: { paddingHorizontal: 10, paddingTop: 6, gap: 4 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: colors.surfaceSunken,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.divider,
    paddingLeft: 6,
    paddingRight: 6,
    height: 44,
  },
  mode: {
    paddingHorizontal: 8,
    height: 28,
    justifyContent: 'center',
    borderRadius: 6,
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.divider,
  },
  modeLive: { backgroundColor: colors.green },
  modeText: { color: colors.green, fontSize: 12, fontWeight: '600' },
  modeTextLive: { color: colors.canvas },
  prompt: { color: colors.green, fontFamily: fonts.mono, fontSize: 15 },
  input: { flex: 1, height: 40 },
  send: { paddingHorizontal: 12, height: 32, justifyContent: 'center', borderRadius: 6, backgroundColor: colors.green },
  sendDim: { opacity: 0.6 },
  sendText: { color: colors.canvas, fontSize: 14, fontWeight: '600' },
  message: { color: colors.yellow, fontSize: 12, paddingHorizontal: 4 },
  messageError: { color: colors.red },
  keyBar: { flexDirection: 'row', gap: 6, paddingHorizontal: 10, paddingVertical: 6 },
  key: {
    flex: 1,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 6,
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.divider,
  },
  keyNarrow: { flex: 0.8 },
  keyPressed: { backgroundColor: colors.surfaceRaised },
  keyText: { color: colors.ink, fontFamily: fonts.mono, fontSize: 14 },
});
