import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { useMachine, useStore } from '../state/hooks';
import { openSurface } from '../state/navigation';
import { sessionMemory, useSessionMemory } from '../state/sessionMemory';
import { ComputerSwitcher } from './ComputerSwitcher';
import { WindowChips } from './WindowChips';
import { colors } from './theme';

export function WorkspaceSidebar() {
  const machine = useMachine();
  const { workspaces, surfaces, windows, selectedWindowId, error } = useStore(machine.workspaces);
  const { target } = useStore(machine.session);
  const { pendingByWorkspace } = useStore(machine.inbox);
  const id = machine.computer?.id ?? 'demo';
  const memory = useSessionMemory(id);
  const [query, setQuery] = useState('');
  const needle = query.trim().toLocaleLowerCase();
  const shown = [...workspaces].filter((w) => !needle || w.title.toLocaleLowerCase().includes(needle) || (surfaces[w.id] ?? []).some((s) => s.title.toLocaleLowerCase().includes(needle)))
    .sort((a, b) => Number(memory.pinned.includes(b.id)) - Number(memory.pinned.includes(a.id)) || a.index - b.index);
  return <View style={styles.sidebar}>
    <View style={styles.controls}>
    <View style={styles.header}><Text style={styles.title}>工作区</Text><ComputerSwitcher /></View>
    <WindowChips windows={windows} selectedId={selectedWindowId} onSelect={(windowId) => void machine.workspaces.selectWindow(windowId)} />
    <TextInput style={styles.search} placeholder="筛选工作区或终端" placeholderTextColor={colors.muted} onChangeText={setQuery} autoCorrect={false} autoCapitalize="none" accessibilityLabel="筛选侧栏工作区" />
    {error ? <Text style={styles.error}>{error}</Text> : null}
    </View>
    <ScrollView style={styles.scroller} keyboardShouldPersistTaps="handled" contentContainerStyle={styles.list}>
      {shown.map((workspace) => <View key={workspace.id} style={styles.group}>
        <View style={styles.row}><Text numberOfLines={1} style={styles.workspace}>{workspace.title}</Text><Pressable onPress={() => sessionMemory.pin(id, workspace.id)} accessibilityRole="button" accessibilityLabel={`${memory.pinned.includes(workspace.id) ? '取消置顶' : '置顶'}${workspace.title}`} style={styles.pin}><Text style={styles.pinText}>{memory.pinned.includes(workspace.id) ? '★' : '☆'}</Text></Pressable></View>
        {pendingByWorkspace[workspace.id] ? <Text style={styles.attention}>{pendingByWorkspace[workspace.id]} 项待处理</Text> : null}
        {(surfaces[workspace.id] ?? []).map((surface) => <Pressable key={surface.id} onPress={() => openSurface(machine, workspace.id, surface.id)} style={[styles.surface, target?.surfaceId === surface.id && styles.selected]} accessibilityRole="button" accessibilityState={{ selected: target?.surfaceId === surface.id }}><Text numberOfLines={2} style={styles.surfaceText}>{surface.title}</Text></Pressable>)}
      </View>)}
      {!shown.length ? <Text style={styles.hint}>没有匹配的工作区</Text> : null}
    </ScrollView>
  </View>;
}
const styles = StyleSheet.create({ sidebar: { flex: 1, minHeight: 0, width: 270, backgroundColor: colors.surfaceSunken, borderRightWidth: StyleSheet.hairlineWidth, borderRightColor: colors.border, padding: 12, gap: 12 }, controls: { flexShrink: 0, gap: 12 }, scroller: { flex: 1, minHeight: 0 }, header: { gap: 8 }, title: { color: colors.ink, fontSize: 21, fontWeight: '600' }, search: { padding: 10, color: colors.ink, backgroundColor: colors.surface, borderRadius: 8 }, list: { gap: 14, paddingBottom: 20 }, group: { gap: 4 }, row: { flexDirection: 'row', alignItems: 'center' }, workspace: { flex: 1, color: colors.ink, fontSize: 14, fontWeight: '600' }, pin: { padding: 8 }, pinText: { color: colors.yellow, fontSize: 18 }, surface: { padding: 10, borderRadius: 8 }, selected: { backgroundColor: colors.surfaceRaised, borderLeftWidth: 2, borderLeftColor: colors.green }, surfaceText: { color: colors.inkDim, fontSize: 13 }, hint: { color: colors.muted, fontSize: 13 }, attention: { color: colors.yellow, fontSize: 11 }, error: { color: colors.red, fontSize: 12 } });
