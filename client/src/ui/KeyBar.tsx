import { useEffect, useRef } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Keys, type Key } from '../protocol/keys';
import type { TerminalSession } from '../session/terminalSession';
import { colors, fonts } from './theme';

type KeySpec = { label: string; key: Key; a11y: string; repeat?: boolean };

const KEYS: KeySpec[] = [
  { label: 'esc', key: Keys.escape, a11y: 'Esc' },
  { label: '^C', key: Keys.ctrlC, a11y: 'Ctrl C' },
  { label: 'tab', key: Keys.tab, a11y: 'Tab' },
  { label: '←', key: Keys.left, a11y: '左', repeat: true },
  { label: '↑', key: Keys.up, a11y: '上', repeat: true },
  { label: '↓', key: Keys.down, a11y: '下', repeat: true },
  { label: '→', key: Keys.right, a11y: '右', repeat: true },
  { label: '↵', key: Keys.enter, a11y: '回车' },
];

const REPEAT_DELAY_MS = 400;
const REPEAT_INTERVAL_MS = 90;

/** Keys a phone keyboard lacks. Also usable with the keyboard hidden: most TUI prompts need only these. */
export function KeyBar({ session }: { session: TerminalSession }) {
  return (
    <View style={styles.keyBar}>
      {KEYS.map((spec) => (
        <KeyButton key={spec.label} spec={spec} session={session} />
      ))}
    </View>
  );
}

/** Sends on touch-down. Arrow keys repeat while held, but never faster than the relay answers. */
function KeyButton({ spec, session }: { spec: KeySpec; session: TerminalSession }) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const stop = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };

  useEffect(() => stop, []);

  const tick = () => {
    if (session.pendingInput <= 1) session.sendKey(spec.key);
    timer.current = setTimeout(tick, REPEAT_INTERVAL_MS);
  };

  return (
    <Pressable
      onPressIn={() => {
        session.sendKey(spec.key);
        if (spec.repeat) timer.current = setTimeout(tick, REPEAT_DELAY_MS);
      }}
      onPressOut={stop}
      style={({ pressed }) => [styles.key, spec.key === Keys.enter && styles.keyEnter, pressed && styles.keyPressed]}
      accessibilityRole="button"
      accessibilityLabel={`发送 ${spec.a11y}`}
    >
      <Text style={[styles.keyText, /[a-z^]/i.test(spec.label) && styles.keyTextSmall]}>{spec.label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  keyBar: { flexDirection: 'row', gap: 5, paddingHorizontal: 8, paddingTop: 6, paddingBottom: 4 },
  key: {
    flex: 1,
    height: 34,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 6,
    backgroundColor: colors.surface,
  },
  keyEnter: { backgroundColor: colors.surfaceRaised },
  keyPressed: { backgroundColor: colors.divider },
  keyText: { color: colors.ink, fontFamily: fonts.mono, fontSize: 16 },
  keyTextSmall: { fontSize: 13 },
});
