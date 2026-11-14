import { useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { useConnectionStatus, useMachine, useStore } from '../state/hooks';
import { confirmClose } from '../platform/confirm';
import { desktopBridge } from '../platform/desktop';
import { requestTerminalClose, requestWorkspaceClose } from '../session/closeRequests';
import { SurfaceActions } from '../session/surfaceActions';
import { actionErrorText, workspaceActionsFor } from '../session/workspaceActions';
import { describeError } from '../session/terminalSession';
import { openSurface } from '../state/navigation';
import { sessionMemory, useSessionMemory } from '../state/sessionMemory';
import { ComputerSwitcher } from './ComputerSwitcher';
import { WindowChips } from './WindowChips';
import { colors } from './theme';
import { activityKey, compareActivity, type TerminalActivity } from '../session/terminalActivity';
import { TerminalActivityBadge, useTerminalActivity } from './TerminalActivityBadge';
import { DesktopCloseButton } from './DesktopCloseButton';

export function WorkspaceSidebar() {
  const machine = useMachine();
  const activity = useTerminalActivity(machine);
  const desktop = desktopBridge() !== null;
  const connected = useConnectionStatus(machine.channel).state === 'open';
  const terminalActions = useMemo(() => new SurfaceActions(machine), [machine]);
  const terminalActionState = useStore(terminalActions);
  const workspaceActionState = useStore(workspaceActionsFor(machine));
  const [closeError, setCloseError] = useState<string | null>(null);
  const { workspaces, surfaces, windows, selectedWindowId, error } = useStore(machine.workspaces);
  const { target } = useStore(machine.session);
  const { pendingByWorkspace } = useStore(machine.inbox);
  const id = machine.computer?.id ?? 'demo';
  const memory = useSessionMemory(id);
  const [query, setQuery] = useState('');
  const needle = query.trim().toLocaleLowerCase();
  const workspaceActivity = (id: string): TerminalActivity | undefined => (surfaces[id] ?? [])
    .map(surface => activity[activityKey({ workspaceId: id, surfaceId: surface.id })]).filter(Boolean).sort(compareActivity)[0];
  const visited = (id: string) => Math.max(0, ...memory.recent.filter(item => item.workspaceId === id).map(item => item.at));
  const shown = [...workspaces].filter((w) => !needle || w.title.toLocaleLowerCase().includes(needle) || (surfaces[w.id] ?? []).some((s) => s.title.toLocaleLowerCase().includes(needle)))
    .sort((a, b) => Number(workspaceActivity(b.id)?.status === 'running') - Number(workspaceActivity(a.id)?.status === 'running')
      || Number(memory.pinned.includes(b.id)) - Number(memory.pinned.includes(a.id))
      || compareActivity(workspaceActivity(a.id), workspaceActivity(b.id), machine.activity ? visited(a.id) : 0, machine.activity ? visited(b.id) : 0) || a.index - b.index);
  return <View style={styles.sidebar}>
    <View style={styles.controls}>
    <View style={styles.header}><Text style={styles.title}>工作区</Text><ComputerSwitcher /></View>
    <WindowChips windows={windows} selectedId={selectedWindowId} activity={activity} onSelect={(windowId) => void machine.workspaces.selectWindow(windowId)} />
    <TextInput style={styles.search} placeholder="筛选工作区或终端" placeholderTextColor={colors.muted} onChangeText={setQuery} autoCorrect={false} autoCapitalize="none" accessibilityLabel="筛选侧栏工作区" />
    {error ? <Text style={styles.error}>{error}</Text> : null}
    {closeError || terminalActionState.error || workspaceActionState.error ? <Text style={styles.error}>{closeError ?? terminalActionState.error ?? (workspaceActionState.error ? actionErrorText(workspaceActionState.error) : '')}</Text> : null}
    </View>
    <ScrollView style={styles.scroller} keyboardShouldPersistTaps="handled" contentContainerStyle={styles.list}>
      {shown.map((workspace) => <View key={workspace.id} style={styles.group}>
        <View style={styles.row}><Text numberOfLines={1} style={styles.workspace}>{workspace.title}</Text><Pressable onPress={() => sessionMemory.pin(id, workspace.id)} accessibilityRole="button" accessibilityLabel={`${memory.pinned.includes(workspace.id) ? '取消置顶' : '置顶'}${workspace.title}`} style={styles.pin}><Text style={styles.pinText}>{memory.pinned.includes(workspace.id) ? '★' : '☆'}</Text></Pressable>
          {desktop ? <DesktopCloseButton label={`关闭工作区 ${workspace.title}`} disabled={!connected || workspace.access === 'read' || Boolean(workspaceActionState.pending[workspace.id]) || terminalActionState.running !== null}
            onPress={() => { setCloseError(null); void requestWorkspaceClose(machine, workspace, confirmClose).catch(error => setCloseError(describeError(error))); }} /> : null}
        </View>
        {pendingByWorkspace[workspace.id] ? <Text style={styles.attention}>{pendingByWorkspace[workspace.id]} 项待处理</Text> : null}
        {[...(surfaces[workspace.id] ?? [])].sort((a, b) => compareActivity(activity[activityKey({ workspaceId: workspace.id, surfaceId: a.id })], activity[activityKey({ workspaceId: workspace.id, surfaceId: b.id })])).map((surface) => <View key={surface.id} style={[styles.surfaceRow, target?.surfaceId === surface.id && styles.selected]}>
          <Pressable onPress={() => openSurface(machine, workspace.id, surface.id)} style={[styles.surface, { flexDirection: 'row', alignItems: 'center', gap: 6 }]} accessibilityRole="button" accessibilityLabel={surface.title} accessibilityState={{ selected: target?.surfaceId === surface.id }}><TerminalActivityBadge activity={activity[activityKey({ workspaceId: workspace.id, surfaceId: surface.id })]} /><Text numberOfLines={2} style={[styles.surfaceText, { flex: 1 }]}>{surface.title}</Text></Pressable>
          {desktop ? <DesktopCloseButton label={`关闭终端 ${surface.title}`} disabled={!connected || workspace.access === 'read' || Boolean(workspaceActionState.pending[workspace.id]) || terminalActionState.running !== null}
            onPress={() => { setCloseError(null); void requestTerminalClose(machine, terminalActions, workspace, surface, confirmClose).catch(error => setCloseError(describeError(error))); }} /> : null}
        </View>)}
      </View>)}
      {!shown.length ? <Text style={styles.hint}>没有匹配的工作区</Text> : null}
    </ScrollView>
  </View>;
}
const styles = StyleSheet.create({ sidebar: { flex: 1, minHeight: 0, width: 270, backgroundColor: colors.surfaceSunken, borderRightWidth: StyleSheet.hairlineWidth, borderRightColor: colors.border, padding: 12, gap: 12 }, controls: { flexShrink: 0, gap: 12 }, scroller: { flex: 1, minHeight: 0 }, header: { gap: 8 }, title: { color: colors.ink, fontSize: 21, fontWeight: '600' }, search: { padding: 10, color: colors.ink, backgroundColor: colors.surface, borderRadius: 8 }, list: { gap: 14, paddingBottom: 20 }, group: { gap: 4 }, row: { flexDirection: 'row', alignItems: 'center' }, workspace: { flex: 1, color: colors.ink, fontSize: 14, fontWeight: '600' }, pin: { padding: 8 }, pinText: { color: colors.yellow, fontSize: 18 }, surfaceRow: { flexDirection: 'row', alignItems: 'center', borderRadius: 8 }, surface: { flex: 1, padding: 10, borderRadius: 8 }, selected: { backgroundColor: colors.surfaceRaised, borderLeftWidth: 2, borderLeftColor: colors.green }, surfaceText: { color: colors.inkDim, fontSize: 13 }, hint: { color: colors.muted, fontSize: 13 }, attention: { color: colors.yellow, fontSize: 11 }, error: { color: colors.red, fontSize: 12 } });
