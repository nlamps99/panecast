import * as Haptics from 'expo-haptics';
import { useEffect, useRef, useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { ctrl, Keys, symbolAction, withModifiers, type Key, type KeyAction } from '../protocol/keys';
import type { TerminalSession } from '../session/terminalSession';
import { usePrefs } from '../state/prefs';
import { useMachine } from '../state/hooks';
import { selectedKeyboardProfile, shortcutAction, shortcutsFor, useKeyboardProfiles } from '../input/keyboardProfiles';
import { KeyboardProfileEditor } from './KeyboardProfileEditor';
import { useSheet } from './Sheet';
import { colors, fonts } from './theme';

/** `action` gets whether the sticky Ctrl was on when the key went down. */
type KeySpec = {
  label: string;
  a11y: string;
  action: (withCtrl: boolean) => KeyAction;
  repeat?: boolean;
  /** A word label (PgUp, Home): smaller text in a wider key. */
  word?: boolean;
  accent?: boolean;
};

function namedKey(k: Key) {
  return (withCtrl: boolean): KeyAction => ({ kind: 'key', key: withCtrl ? withModifiers(k, ['ctrl']) : k });
}

/** Follows the Ctrl toggle. Symbols a phone keyboard hides on a second page, then paging keys. */
const EXTRA_ROW: KeySpec[] = [
  ...['/', '|', '~', '-', '_', '`'].map((s) => ({ label: s, a11y: s, action: (withCtrl: boolean) => symbolAction(s, withCtrl) })),
  { label: 'PgUp', a11y: '上一页', action: namedKey(Keys.pageUp), repeat: true, word: true },
  { label: 'PgDn', a11y: '下一页', action: namedKey(Keys.pageDown), repeat: true, word: true },
  { label: 'Home', a11y: '行首', action: namedKey(Keys.home), word: true },
  { label: 'End', a11y: '行尾', action: namedKey(Keys.end), word: true },
];

/**
 * Shown while Ctrl is on, above the other rows so they stay put. Letters a
 * phone keyboard cannot chord: readline editing (a e k u w), clear (l),
 * history search (r), EOF (d), suspend (z), tmux's prefix (b).
 */
const CTRL_LETTERS: KeySpec[] = ['a', 'b', 'd', 'e', 'k', 'l', 'r', 'u', 'w', 'z'].map((letter) => ({
  label: `^${letter.toUpperCase()}`,
  a11y: `Ctrl ${letter.toUpperCase()}`,
  action: (): KeyAction => ({ kind: 'key', key: ctrl(letter) }),
}));

const REPEAT_DELAY_MS = 400;
const REPEAT_INTERVAL_MS = 90;

/**
 * Keys a phone keyboard lacks. Also usable with the keyboard hidden: most TUI
 * prompts need only the first row. The optional second row adds a sticky
 * Ctrl: tap it, then any key (or one of the Ctrl letters that appear) to send
 * that key with Ctrl.
 */
export function KeyBar({ session, disabled = false }: { session: TerminalSession; disabled?: boolean }) {
  const { keyHaptics, extraKeyRow } = usePrefs();
  const machine = useMachine();
  const profiles = useKeyboardProfiles();
  const editor = useSheet();
  const computerId = machine.computer?.id ?? 'demo', workspaceId = session.getState().target?.workspaceId ?? null;
  const profile = selectedKeyboardProfile(profiles, computerId, workspaceId);
  const mainRow: KeySpec[] = shortcutsFor(profile).map((shortcut) => ({ ...shortcut, action: (withCtrl) => shortcutAction(shortcut, withCtrl) }));
  const [ctrlOn, setCtrlOn] = useState(false);
  const [shownExtraRow, setShownExtraRow] = useState(extraKeyRow);
  // Hiding the row hides the Ctrl toggle too; never leave Ctrl on out of sight.
  if (shownExtraRow !== extraKeyRow) {
    setShownExtraRow(extraKeyRow);
    if (!extraKeyRow) setCtrlOn(false);
  }

  const press = (spec: KeySpec): KeyAction => {
    if (keyHaptics) tapHaptic();
    const action = spec.action(ctrlOn);
    if (ctrlOn) setCtrlOn(false);
    send(session, action);
    return action;
  };

  const row = (specs: KeySpec[], fixed = false) =>
    specs.map((spec) => <KeyButton key={spec.label} spec={spec} ctrlOn={ctrlOn} session={session} onPress={press} disabled={disabled} fixed={fixed} />);

  return (
    <View style={styles.bar}>
      <Pressable onPress={editor.open} style={styles.profile} accessibilityRole="button" accessibilityLabel={`快捷键配置：${profile.name}，点按自定义`}><Text style={styles.profileText}>{profile.name} · 自定义按键 ›</Text></Pressable>
      {ctrlOn ? <View style={[styles.row, styles.rowDense]}>{row(CTRL_LETTERS)}</View> : null}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.scrollingKeys} keyboardShouldPersistTaps="always">{row(mainRow, true)}</ScrollView>
      {extraKeyRow ? (
        <View style={[styles.row, styles.rowDense]}>
          <Pressable
            disabled={disabled}
            onPressIn={() => {
              if (keyHaptics) tapHaptic();
              setCtrlOn((on) => !on);
            }}
            style={({ pressed }) => [styles.key, styles.keyWide, ctrlOn && styles.keyOn, pressed && !ctrlOn && styles.keyPressed]}
            accessibilityRole="togglebutton"
            accessibilityState={{ checked: ctrlOn }}
            accessibilityLabel="Ctrl"
            accessibilityHint="打开后，下一个按键会带上 Ctrl"
          >
            <Text style={[styles.keyText, styles.keyTextTiny, ctrlOn && styles.keyTextOn]}>ctrl</Text>
          </Pressable>
          {row(EXTRA_ROW)}
        </View>
      ) : null}
      <KeyboardProfileEditor visible={editor.visible} onClose={() => editor.close()} onClosed={editor.onClosed} computerId={computerId} workspaceId={workspaceId} />
    </View>
  );
}

/** Sends on touch-down. Keys marked `repeat` repeat while held, but never faster than the relay answers. */
function KeyButton({
  spec,
  ctrlOn,
  session,
  onPress,
  disabled,
  fixed,
}: {
  spec: KeySpec;
  ctrlOn: boolean;
  session: TerminalSession;
  onPress: (spec: KeySpec) => KeyAction;
  disabled: boolean;
  fixed: boolean;
}) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const repeated = useRef(false);

  const stop = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };

  useEffect(() => stop, []);
  useEffect(() => { if (disabled) stop(); }, [disabled]);

  // Repeats the action chosen on touch-down, so a held Ctrl-← keeps its Ctrl.
  const tick = (action: KeyAction) => {
    if (!session.isConnected) { stop(); return; }
    if (session.pendingInput <= 1) send(session, action);
    timer.current = setTimeout(() => tick(action), REPEAT_INTERVAL_MS);
  };

  // ^C and the Ctrl letters already say Ctrl.
  const a11y = ctrlOn && !spec.a11y.startsWith('Ctrl') ? `Ctrl ${spec.a11y}` : spec.a11y;
  return (
    <Pressable
      disabled={disabled}
      onPressIn={() => {
        repeated.current = false;
        // Scrollable profiles send on release, so swiping across Ctrl-C or
        // Enter never accidentally sends that key. Holding still repeats.
        if (fixed) {
          if (spec.repeat) timer.current = setTimeout(() => {
            repeated.current = true;
            const action = onPress(spec);
            timer.current = setTimeout(() => tick(action), REPEAT_INTERVAL_MS);
          }, REPEAT_DELAY_MS);
          return;
        }
        const action = onPress(spec);
        if (spec.repeat) timer.current = setTimeout(() => tick(action), REPEAT_DELAY_MS);
      }}
      onPressOut={stop}
      onPress={() => { if (fixed && !repeated.current) onPress(spec); }}
      style={({ pressed }) => [styles.key, spec.word && styles.keyWide, fixed && styles.fixedKey, fixed && spec.word && styles.fixedWideKey, spec.accent && styles.keyAccent, pressed && styles.keyPressed]}
      accessibilityRole="button"
      accessibilityLabel={`发送 ${a11y}`}
    >
      <Text style={[styles.keyText, spec.word ? styles.keyTextTiny : /[a-z^]/i.test(spec.label) && styles.keyTextSmall]}>
        {spec.label}
      </Text>
    </Pressable>
  );
}

function send(session: TerminalSession, action: KeyAction): void {
  if (action.kind === 'text') session.sendText(action.text);
  else session.sendKey(action.key);
}

/** A light tick, like the system keyboard's. None on web. */
function tapHaptic(): void {
  if (Platform.OS === 'web') return;
  const done =
    Platform.OS === 'android'
      ? Haptics.performAndroidHapticsAsync(Haptics.AndroidHaptics.Keyboard_Tap)
      : Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  done.catch(() => {});
}

const styles = StyleSheet.create({
  profile: { alignSelf: 'flex-end', paddingVertical: 2 },
  profileText: { color: colors.muted, fontSize: 11 },
  scrollingKeys: { gap: 5, flexGrow: 1 },
  fixedKey: { flexGrow: 1, flexShrink: 0, flexBasis: 34, minWidth: 34 },
  fixedWideKey: { flexBasis: 45, minWidth: 45 },
  bar: { paddingHorizontal: 8, paddingTop: 6, paddingBottom: 4, gap: 5 },
  row: { flexDirection: 'row', gap: 5 },
  /** The 11-key rows fit a 375 pt phone with a little less gap. */
  rowDense: { gap: 4 },
  key: {
    flex: 1,
    height: 34,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 6,
    backgroundColor: colors.surface,
  },
  keyWide: { flex: 1.4 },
  keyAccent: { backgroundColor: colors.surfaceRaised },
  keyOn: { backgroundColor: colors.green },
  keyPressed: { backgroundColor: colors.divider },
  keyText: { color: colors.ink, fontFamily: fonts.mono, fontSize: 16 },
  keyTextSmall: { fontSize: 13 },
  keyTextTiny: { fontSize: 11 },
  keyTextOn: { color: colors.canvas },
});
