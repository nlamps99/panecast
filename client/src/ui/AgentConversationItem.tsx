import { memo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { AgentToolGroup } from '../session/agentTimeline';
import { itemText, type AgentItem } from '../session/sourceStore';
import { colors, fonts } from './theme';

const RUNNING = new Set(['inProgress', 'in_progress', 'running']);
const FAILED = new Set(['failed', 'error']);

export const AgentToolsSummary = memo(function AgentToolsSummary({ group, onToggle }: { group: AgentToolGroup; onToggle(): void }) {
  const counts = new Map<string, number>();
  let failed = 0, running = 0;
  for (const item of group.items) {
    const label = item.type === 'commandExecution' ? '命令' : item.type === 'fileChange' ? '文件修改' : '外部工具';
    counts.set(label, (counts.get(label) ?? 0) + 1);
    if (FAILED.has(item.status ?? '')) failed++;
    if (RUNNING.has(item.status ?? '')) running++;
  }
  const title = `工具调用 · ${group.items.length} 项`;
  const status = [running > 0 ? `${running} 项进行中` : '', failed > 0 ? `${failed} 项失败` : ''].filter(Boolean).join(' · ');
  return <Pressable
    testID={`codex-tools-${group.key}`} onPress={onToggle}
    accessibilityRole="button" accessibilityLabel={`${group.expanded ? '收起' : '展开'}${title}${status ? `，${status}` : ''}`}
    accessibilityState={{ expanded: group.expanded }}
    style={({ pressed }) => [styles.tools, pressed && styles.pressed]}
  >
    <View style={styles.summaryRow}>
      <Text style={styles.summaryTitle}>{title}</Text>
      <Text style={styles.toggle}>{group.expanded ? '收起 ▴' : '展开 ▾'}</Text>
    </View>
    <View style={styles.summaryDetails}>
      <Text style={styles.meta}>{[...counts].map(([label, count]) => `${label} ${count}`).join(' · ')}</Text>
      {status ? <Text style={[styles.meta, failed > 0 ? styles.failed : styles.running]}>{status}</Text> : null}
    </View>
  </Pressable>;
});

export const AgentMessage = memo(function AgentMessage({ item }: { item: AgentItem }) {
  const [expanded, setExpanded] = useState(false);
  const content = itemText(item);
  if (!content) return null;
  const code = ['commandExecution', 'fileChange'].includes(item.type);
  const limit = code ? 1200 : 4000;
  const label = item.type === 'userMessage' ? '你' : item.type === 'agentMessage' ? 'Codex' : item.type === 'fileChange' ? '文件修改' : item.type === 'commandExecution' ? '命令' : item.type === 'mcpToolCall' ? '外部工具' : '计划';
  return <View style={[styles.message, item.type === 'userMessage' && styles.userMessage]}>
    <View style={styles.summaryRow}>
      <Text style={styles.meta}>{label}</Text>
      {FAILED.has(item.status ?? '') ? <Text style={[styles.meta, styles.failed]}>失败</Text> : RUNNING.has(item.status ?? '') ? <Text style={[styles.meta, styles.running]}>进行中</Text> : null}
    </View>
    <Text testID={`codex-item-${item.id}`} selectable style={[styles.messageText, code && styles.code]}>{expanded ? content : content.slice(0, limit)}</Text>
    {content.length > limit ? <Pressable onPress={() => setExpanded(!expanded)} style={styles.contentToggle} accessibilityRole="button" accessibilityState={{ expanded }}><Text style={styles.toggle}>{expanded ? '收起内容' : '展开内容'}</Text></Pressable> : null}
    {item.truncated ? <Text style={styles.meta}>内容过长，已保留片段；完整记录可在电脑查看。</Text> : null}
  </View>;
});

const styles = StyleSheet.create({
  tools: { paddingVertical: 12, paddingHorizontal: 14, borderRadius: 12, backgroundColor: colors.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border, gap: 6 },
  pressed: { opacity: 0.7 },
  summaryRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  summaryTitle: { flex: 1, color: colors.inkDim, fontSize: 13, fontWeight: '500' },
  summaryDetails: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 },
  meta: { color: colors.inkDim, fontSize: 12, lineHeight: 18 },
  toggle: { color: colors.green, fontSize: 12 },
  failed: { color: colors.red }, running: { color: colors.yellow },
  message: { padding: 12, backgroundColor: colors.surface, borderRadius: 12, gap: 8 }, userMessage: { backgroundColor: colors.surfaceRaised },
  messageText: { color: colors.ink, fontSize: 14, lineHeight: 22 }, code: { color: colors.ink, fontFamily: fonts.mono, fontSize: 12, lineHeight: 19 },
  contentToggle: { alignSelf: 'flex-start', paddingVertical: 10, paddingHorizontal: 12, borderRadius: 8, backgroundColor: colors.surfaceRaised },
});
