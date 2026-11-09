import * as Clipboard from '../platform/clipboard';
import * as Linking from 'expo-linking';
import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import type { TerminalSession, TerminalState } from '../session/terminalSession';
import { matchingRows, plainTerminalRows, terminalLinks } from '../terminal/textTools';
import { Sheet } from './Sheet';
import { colors, fonts } from './theme';

const PAGE = 150;
export function TerminalTools({ visible, onClose, state, session }: { visible: boolean; onClose(): void; state: TerminalState; session: TerminalSession }) {
  const [query, setQuery] = useState('');
  const [match, setMatch] = useState(0);
  const [page, setPage] = useState(0);
  const [message, setMessage] = useState('');
  const rows = useMemo(() => plainTerminalRows([...(state.browse?.olderRows ?? []), ...(state.browse?.frozenRows ?? state.screen.rows)]), [state.browse?.olderRows, state.browse?.frozenRows, state.screen.rows]);
  const hits = useMemo(() => matchingRows(rows, query), [rows, query]);
  const current = Math.min(match, Math.max(0, hits.length - 1));
  const search = Boolean(query.trim());
  const start = search && hits.length ? Math.max(0, hits[current] - 8) : Math.max(0, rows.length - PAGE * (page + 1));
  const end = search && hits.length ? Math.min(rows.length, hits[current] + 15) : Math.max(start, rows.length - PAGE * page);
  const displayed = rows.slice(start, end).join('\n');
  const links = useMemo(() => terminalLinks(displayed), [displayed]);
  const copy = async (text: string) => {
    try { setMessage(await Clipboard.setStringAsync(text) ? '已复制' : '复制失败，请长按文字选择复制'); }
    catch { setMessage('复制失败，请长按文字选择复制'); }
  };
  return <Sheet visible={visible} title="搜索与复制输出" onClose={onClose}>
    <View style={s.body}>
      <TextInput style={s.search} defaultValue={query} onChangeText={(text) => { setQuery(text); setMatch(0); }} placeholder="搜索已加载的历史输出" placeholderTextColor={colors.muted} autoCapitalize="none" autoCorrect={false} accessibilityLabel="搜索终端输出" />
      <View style={s.row}>
        {search ? <>
          <Text style={s.note}>{hits.length ? `${current + 1} / ${hits.length} 处匹配` : '没有匹配结果'}</Text>
          <Button label="上一处" disabled={!hits.length} onPress={() => setMatch((current - 1 + hits.length) % hits.length)} />
          <Button label="下一处" disabled={!hits.length} onPress={() => setMatch((current + 1) % hits.length)} />
        </> : <>
          <Button label="较早输出" disabled={start === 0} onPress={() => setPage(page + 1)} />
          <Button label="较新输出" disabled={page === 0} onPress={() => setPage(page - 1)} />
        </>}
        <Button label={state.browse?.loading ? '正在加载…' : state.browse?.restartRequired ? '重新加载历史' : '加载更早历史'} disabled={state.browse?.loading || state.browse?.exhausted} onPress={() => void session.loadOlder({ retry: true })} />
      </View>
      <View style={s.row}><Button label="复制这一段" onPress={() => void copy(displayed)} /><Button label="复制全部已加载输出" onPress={() => void copy(rows.join('\n'))} /></View>
      <Text style={s.note}>{message || `已加载 ${rows.length} 行，显示第 ${rows.length ? start + 1 : 0}–${end} 行。长按文字可跨行选择。`}</Text>
      {state.browse?.error ? <Text style={s.error}>{state.browse.error}</Text> : null}
      <Text selectable style={s.output}>{rows.slice(start, end).map((line, index) => <Text key={start + index} style={search && hits.includes(start + index) ? s.hit : undefined}>{line}{start + index < end - 1 ? '\n' : ''}</Text>)}</Text>
      {links.map((url) => <Pressable key={url} onPress={() => void Linking.openURL(url).catch(() => setMessage('无法打开这个链接'))} accessibilityRole="link"><Text style={s.link}>{url}</Text></Pressable>)}
    </View>
  </Sheet>;
}
function Button({ label, disabled, onPress }: { label: string; disabled?: boolean; onPress(): void }) {
  return <Pressable disabled={disabled} onPress={onPress} style={[s.button, disabled && s.disabled]} accessibilityRole="button"><Text style={s.label}>{label}</Text></Pressable>;
}
const s = StyleSheet.create({
  body: { padding: 14, gap: 12 }, row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignItems: 'center' }, search: { color: colors.ink, backgroundColor: colors.surfaceSunken, padding: 12, borderRadius: 8 },
  note: { color: colors.muted, fontSize: 12 }, output: { color: colors.ink, fontFamily: fonts.mono, fontSize: 12, lineHeight: 18 }, hit: { backgroundColor: colors.surfaceRaised, color: colors.yellow },
  button: { padding: 8, borderRadius: 6, backgroundColor: colors.surfaceRaised }, disabled: { opacity: 0.4 }, label: { color: colors.ink, fontSize: 12 }, link: { color: colors.blue, fontSize: 13 }, error: { color: colors.red, fontSize: 12 },
});
