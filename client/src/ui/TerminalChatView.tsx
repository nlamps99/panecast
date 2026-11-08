import { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';

import { agentTimeline, type AgentTimelineRow } from '../session/agentTimeline';
import type { TerminalConversationStore } from '../session/terminalConversation';
import type { TerminalSession } from '../session/terminalSession';
import { terminalPrompt } from '../session/terminalPrompt';
import { useStore } from '../state/hooks';
import { plainTerminalRows } from '../terminal/textTools';
import { AgentMessage, AgentToolsSummary } from './AgentConversationItem';
import { colors, fonts } from './theme';
const EMPTY: ReadonlySet<string> = new Set();

export function TerminalChatView({ store, session, connected, onShowTerminal }: {
  store: TerminalConversationStore; session: TerminalSession; connected: boolean; onShowTerminal(): void;
}) {
  const state = useStore(store);
  const terminal = useStore(session);
  const list = useRef<FlatList<AgentTimelineRow>>(null);
  const identity = `${state.target?.workspaceId}:${state.target?.surfaceId}:${state.conversationId}:${state.generation}`;
  const [expansion, setExpansion] = useState<{ identity: string; keys: ReadonlySet<string> }>({ identity, keys: EMPTY });
  const [position, setPosition] = useState({ identity, away: false });
  const expanded = expansion.identity === identity ? expansion.keys : EMPTY;
  const away = position.identity === identity && position.away;
  const rows = useMemo(() => agentTimeline([{ id: identity, status: 'completed', items: state.items }], expanded).reverse(), [state.items, identity, expanded]);
  const prompt = state.available ? terminalPrompt(plainTerminalRows(terminal.screen.rows)) : null;
  const lastSubmission = state.submissions.at(-1)?.id;
  useEffect(() => { if (lastSubmission) list.current?.scrollToOffset({ offset: 0, animated: true }); }, [lastSubmission]);

  return <View style={styles.container} testID="terminal-chat">
    {state.error ? <View style={styles.notice}><Text style={styles.error}>{state.error}</Text><Pressable onPress={() => void store.refresh()} accessibilityRole="button"><Text style={styles.link}>重试读取</Text></Pressable></View> : null}
    {prompt ? <View style={styles.prompt} accessibilityLiveRegion="polite">
      <Text style={styles.promptTitle}>终端等待选择</Text><Text selectable numberOfLines={6} style={styles.code}>{prompt}</Text>
      <Pressable onPress={onShowTerminal} accessibilityRole="button"><Text style={styles.link}>打开终端进行选择 →</Text></Pressable>
    </View> : null}
    <FlatList
      key={identity} ref={list} testID="terminal-chat-messages" style={styles.list} contentContainerStyle={styles.content}
      data={rows} keyExtractor={row => row.key} inverted
      maintainVisibleContentPosition={{ minIndexForVisible: 0, autoscrollToTopThreshold: 60 }}
      initialNumToRender={12} maxToRenderPerBatch={10} windowSize={7}
      keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag"
      onScroll={event => { const next = event.nativeEvent.contentOffset.y > 250; if (next !== away) setPosition({ identity, away: next }); }} scrollEventThrottle={100}
      onEndReached={() => { if (!state.historyError) void store.loadOlder(); }} onEndReachedThreshold={2}
      renderItem={({ item: row }) => row.kind === 'item' ? <AgentMessage item={row.item} agentLabel={state.name} bubble /> : row.kind === 'tools' ? <AgentToolsSummary group={row} onToggle={() => setExpansion(current => {
        const next = new Set(current.identity === identity ? current.keys : EMPTY); if (next.has(row.key)) next.delete(row.key); else next.add(row.key); return { identity, keys: next };
      })} /> : null}
      ListHeaderComponent={<View style={styles.latest}>
        {state.submissions.map(submission => <View key={submission.id} style={styles.submission}>
          <AgentMessage item={{ id: submission.id, type: 'userMessage', content: [{ type: 'text', text: submission.text }] }} bubble />
          <Text style={[styles.receipt, submission.status === 'not_sent' && styles.error]}>{submission.status === 'sending' ? '正在发送…' : submission.status === 'sent' ? '已发送到终端' : submission.status === 'unknown' ? '发送未确认，请先查看终端；草稿已保留' : submission.message ?? '未发送，草稿已保留'}</Text>
        </View>)}
        {state.available === false && !state.blocked ? <View style={styles.output}>
          <Text style={styles.meta}>终端输出</Text><Text selectable style={styles.code}>{state.output || '等待终端输出…'}</Text>
        </View> : null}
        {state.active && connected ? <View style={styles.activity}><ActivityIndicator size="small" color={colors.green} /><Text style={styles.meta}>正在处理…</Text></View> : null}
      </View>}
      ListFooterComponent={<View style={styles.boundary}>
        {state.loading || state.loadingOlder ? <ActivityIndicator color={colors.green} /> : null}
        {state.historyError ? <><Text style={styles.error}>{state.historyError}</Text><Pressable onPress={() => void store.loadOlder()} disabled={!connected || state.loadingOlder} accessibilityRole="button"><Text style={styles.link}>重试读取历史</Text></Pressable></> : null}
        {state.available === false && !state.error ? <Text style={styles.meta}>当前终端没有可读取的对话记录，显示终端画面。</Text> : state.items.length && !state.cursor && !state.loadingOlder ? <Text style={styles.meta}>已到对话开头</Text> : null}
      </View>}
      ListEmptyComponent={state.available === true && !state.loading ? <Text style={styles.empty}>发送消息，继续当前终端里的对话。</Text> : undefined}
    />
    {away ? <Pressable onPress={() => list.current?.scrollToOffset({ offset: 0, animated: true })} style={styles.jump} accessibilityRole="button"><Text style={styles.link}>回到最新 ↓</Text></Pressable> : null}
  </View>;
}

const styles = StyleSheet.create({
  container: { flex: 1 }, list: { flex: 1 }, content: { padding: 12, gap: 12 }, latest: { gap: 12 },
  meta: { color: colors.inkDim, fontSize: 12, lineHeight: 18 }, code: { color: colors.ink, fontFamily: fonts.mono, fontSize: 12, lineHeight: 19 },
  link: { color: colors.green, fontSize: 13, paddingVertical: 6 }, error: { color: colors.red, fontSize: 12, lineHeight: 18 },
  notice: { padding: 12, backgroundColor: colors.surface },
  prompt: { padding: 12, backgroundColor: colors.surfaceRaised, gap: 6, maxHeight: 210 }, promptTitle: { color: colors.yellow, fontSize: 13, fontWeight: '600' },
  submission: { gap: 4 }, receipt: { color: colors.inkDim, fontSize: 11, alignSelf: 'flex-end', marginRight: 8 },
  output: { padding: 12, backgroundColor: colors.surface, borderRadius: 12, gap: 8 },
  activity: { flexDirection: 'row', gap: 8, alignItems: 'center', paddingVertical: 8 }, boundary: { gap: 8, alignItems: 'center', paddingVertical: 12 },
  empty: { color: colors.muted, fontSize: 13, textAlign: 'center', padding: 24 },
  jump: { position: 'absolute', bottom: 12, right: 12, backgroundColor: colors.surfaceRaised, borderRadius: 20, paddingHorizontal: 14, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border },
});
