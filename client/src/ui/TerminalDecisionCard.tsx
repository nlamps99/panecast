import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { TerminalDecision } from '../session/terminalPrompt';
import type { TerminalSession } from '../session/terminalSession';
import type { ScreenState } from '../protocol/screen';
import type { Key } from '../protocol/keys';
import { colors } from './theme';

export function TerminalDecisionCard({ decision, screen, session, enabled, onShowTerminal }: {
  decision: TerminalDecision; screen: ScreenState; session: TerminalSession; enabled: boolean; onShowTerminal(): void;
}) {
  const [message, setMessage] = useState<string | null>(null);
  const send = async (keys: Key[]) => {
    if (!enabled) return;
    const receipt = await session.sendPromptKeys(keys, screen);
    setMessage(receipt.status === 'sent' ? null : receipt.message);
  };
  const button = (label: string, key: string) => <Pressable key={key} disabled={!enabled} style={[styles.button, !enabled && styles.disabled]}
    accessibilityRole="button" accessibilityLabel={label} onPress={() => void send([{ name: key }])}><Text style={styles.link}>{label}</Text></Pressable>;
  return <View style={styles.card} testID="terminal-decision">
    <Text style={styles.heading}>等待你的回答</Text>
    <Text style={styles.title} numberOfLines={3}>{decision.title}</Text>
    <ScrollView style={styles.options} keyboardShouldPersistTaps="handled">
      {decision.options.map((option, index) => <Pressable key={option.number} disabled={!enabled || decision.selectedIndex === null}
        style={[styles.option, index === decision.selectedIndex && styles.selected]}
        accessibilityRole="button" accessibilityState={{ selected: index === decision.selectedIndex }} accessibilityLabel={`选择 ${option.label}`}
        onPress={() => {
          if (decision.selectedIndex === null || index === decision.selectedIndex) return;
          const delta = index - decision.selectedIndex;
          void send(Array.from({ length: Math.abs(delta) }, () => ({ name: delta > 0 ? 'down' : 'up' })));
        }}><Text style={styles.optionText}>{index === decision.selectedIndex ? '●' : '○'} {option.label}</Text></Pressable>)}
    </ScrollView>
    <View style={styles.row}>
      {button('上一项', 'up')}{button('下一项', 'down')}
      {decision.multiSelect ? button('勾选当前项', 'space') : null}
      {decision.multipleQuestions ? button('下一题', 'tab') : null}
      {button('确认当前选择', 'enter')}{button('取消', 'escape')}
    </View>
    {message ? <Text style={styles.error}>{message}</Text> : null}
    <Pressable onPress={onShowTerminal} accessibilityRole="button"><Text style={styles.link}>查看完整终端 →</Text></Pressable>
  </View>;
}
const styles = StyleSheet.create({
  card: { marginHorizontal: 10, marginVertical: 6, padding: 12, gap: 7, borderRadius: 12, backgroundColor: colors.surfaceRaised },
  heading: { color: colors.yellow, fontSize: 12, fontWeight: '600' }, title: { color: colors.ink, fontSize: 14, lineHeight: 20 },
  options: { maxHeight: 150 }, option: { paddingVertical: 9, paddingHorizontal: 8, borderRadius: 7 }, selected: { backgroundColor: colors.surface },
  optionText: { color: colors.ink, fontSize: 13, lineHeight: 20 }, row: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  button: { paddingVertical: 8, paddingHorizontal: 10, borderRadius: 7, backgroundColor: colors.surface }, link: { color: colors.green, fontSize: 12 },
  disabled: { opacity: 0.4 }, error: { color: colors.red, fontSize: 12, lineHeight: 18 },
});
