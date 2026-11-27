import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { useConnectionStatus, useMachine, useStore } from '../state/hooks';
import { confirmClose } from '../platform/confirm';
import { desktopBridge } from '../platform/desktop';
import { requestTerminalClose, requestWorkspaceClose } from '../session/closeRequests';
import { canCloseTerminal, canManage, windowLabel, type WorkspaceInfo } from '../session/surfaces';
import { SurfaceActions } from '../session/surfaceActions';
import { actionErrorText, workspaceActionsFor } from '../session/workspaceActions';
import { describeError } from '../session/terminalSession';
import { openSurface } from '../state/navigation';
import { sessionMemory, useSessionMemory } from '../state/sessionMemory';
import { ComputerSwitcher } from './ComputerSwitcher';
import { ConnectionNotice } from './ConnectionNotice';
import { contextMenuProps, hoverTitle, useContextMenu } from './ContextMenu';
import { onDesktopCommand, setSidebarQuery, shortcutLabel, useSidebarState } from './desktopShell';
import { terminalMenuItems, workspaceMenuItems } from './desktopMenus';
import { Icon } from './Icon';
import { NameDialog } from './NameDialog';
import { sidebarEmptyText, sidebarWorkspaces } from './sidebarModel';
import { WindowChips } from './WindowChips';
import { colors } from './theme';
import { activityKey } from '../session/terminalActivity';
import { TerminalActivityBadge, useTerminalActivity } from './TerminalActivityBadge';
import { useTerminalRename } from './useTerminalRename';
import { CloseButton } from './CloseButton';

/** The name prompt, remounted (`key`) per opening; `open` false while it fades out. */
type Dialog = { key: number; open: boolean } & ({ kind: 'create' } | { kind: 'rename'; workspace: WorkspaceInfo });

/**
 * Workspaces and their terminals beside the terminal: the desktop window's
 * left column, and the iPad's. Rows keep their place: pinned first, then the
 * computer's own order; a running terminal only shows its spinner.
 *
 * On the desktop the header adds 新建工作区 (⌘N), and a right click on a
 * workspace or a terminal opens its menu (rename, pin, new terminal, close).
 */
export function WorkspaceSidebar() {
  const machine = useMachine();
  const activity = useTerminalActivity(machine);
  const status = useConnectionStatus(machine.channel);
  const connected = status.state === 'open';
  const desktop = desktopBridge() !== null;
  const terminalActions = useMemo(() => new SurfaceActions(machine), [machine]);
  const terminalActionState = useStore(terminalActions);
  const workspaceActions = workspaceActionsFor(machine);
  const workspaceActionState = useStore(workspaceActions);
  const [closeError, setCloseError] = useState<string | null>(null);
  const { workspaces, surfaces, windows, selectedWindowId, loaded, error } = useStore(machine.workspaces);
  const { target } = useStore(machine.session);
  const { pendingByWorkspace } = useStore(machine.inbox);
  const id = machine.computer?.id ?? 'demo';
  const memory = useSessionMemory(id);
  const { query } = useSidebarState();
  const shown = sidebarWorkspaces(workspaces, surfaces, memory.pinned, query);
  const empty = sidebarEmptyText({ status, loaded, total: workspaces.length, shown: shown.length });
  const menu = useContextMenu();
  const terminalRename = useTerminalRename(machine);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const selectedWindow = windows.length > 1 ? windows.find((w) => w.id === selectedWindowId) : undefined;
  const canCreate = connected && !workspaceActionState.creating && canManage(windows.find((w) => w.id === selectedWindowId));
  const busy = (workspaceId: string) => Boolean(workspaceActionState.pending[workspaceId]) || terminalActionState.running !== null;
  const showError = (message: string) => setCloseError(message);

  const openCreate = () => setDialog((d) => ({ key: (d?.key ?? 0) + 1, open: true, kind: 'create' }));
  const openRename = (workspace: WorkspaceInfo) => setDialog((d) => ({ key: (d?.key ?? 0) + 1, open: true, kind: 'rename', workspace }));
  const dismissDialog = () => setDialog((d) => (d ? { ...d, open: false } : d));
  // ⌘N and 文件 › 新建工作区.
  useEffect(() => onDesktopCommand((command) => {
    if (command.kind === 'newWorkspace' && canCreate) setDialog((d) => ({ key: (d?.key ?? 0) + 1, open: true, kind: 'create' }));
  }), [canCreate]);
  // The desktop opens the new workspace's terminal, as cmux does on the Mac.
  const create = async (title: string) => {
    const before = new Set(machine.workspaces.getState().workspaces.map((w) => w.id));
    if (!await workspaceActions.create(title)) return;
    const state = machine.workspaces.getState();
    const added = state.workspaces.filter((w) => !before.has(w.id));
    const created = added.find((w) => w.title === title) ?? (added.length === 1 ? added[0] : undefined);
    const first = created ? (state.surfaces[created.id] ?? [])[0] : undefined;
    if (created && first) openSurface(machine, created.id, first.id);
  };

  const newLabel = `新建工作区（${shortcutLabel('N')}）`;
  return <View style={styles.sidebar}>
    <View style={styles.controls}>
    <View style={styles.header}>
      <View style={styles.titleRow}>
        <Text style={[styles.title, desktop && styles.desktopTitle]}>工作区</Text>
        {desktop ? <Pressable ref={hoverTitle(newLabel)} onPress={openCreate} disabled={!canCreate} accessibilityRole="button" accessibilityLabel="新建工作区"
          accessibilityState={{ disabled: !canCreate, busy: workspaceActionState.creating }}
          style={({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) => [styles.add, (hovered || pressed) && canCreate && styles.hovered, !canCreate && !workspaceActionState.creating && styles.dimmed]}>
          {workspaceActionState.creating ? <ActivityIndicator size="small" color={colors.green} /> : <Icon name="add" size={16} color={colors.green} />}
        </Pressable> : null}
      </View>
      <ComputerSwitcher />
      <ConnectionNotice />
    </View>
    <WindowChips windows={windows} selectedId={selectedWindowId} activity={activity} onSelect={(windowId) => void machine.workspaces.selectWindow(windowId)} />
    <TextInput style={styles.search} placeholder="筛选工作区或终端" placeholderTextColor={colors.muted} defaultValue={query} onChangeText={setSidebarQuery} autoCorrect={false} autoCapitalize="none" accessibilityLabel="筛选侧栏工作区" />
    {error ? <Text style={styles.error}>{error}</Text> : null}
    {closeError || terminalActionState.error || workspaceActionState.error ? <Text style={styles.error}>{closeError ?? terminalActionState.error ?? (workspaceActionState.error ? actionErrorText(workspaceActionState.error) : '')}</Text> : null}
    </View>
    <ScrollView style={styles.scroller} keyboardShouldPersistTaps="handled" contentContainerStyle={styles.list}>
      {shown.map((workspace) => {
        const pinned = memory.pinned.includes(workspace.id);
        const list = surfaces[workspace.id] ?? [];
        const common = { deps: machine, workspace, connected, busy: busy(workspace.id), onError: showError };
        const workspaceMenu = desktop ? contextMenuProps((point) => {
          setCloseError(null);
          menu.open(point, workspaceMenuItems({ ...common, computerId: id, pinned, onRename: () => openRename(workspace) }));
        }) : {};
        return <View key={workspace.id} style={styles.group}>
          <View style={styles.row} {...workspaceMenu}>
            <Text ref={desktop ? hoverTitle(workspace.title) : undefined} numberOfLines={1} style={styles.workspace}>{workspace.title}</Text>
            <Pressable ref={hoverTitle(pinned ? '取消置顶' : '置顶')} onPress={() => sessionMemory.pin(id, workspace.id)} accessibilityRole="button" accessibilityLabel={`${pinned ? '取消置顶' : '置顶'}${workspace.title}`} style={styles.pin}><Text style={styles.pinText}>{pinned ? '★' : '☆'}</Text></Pressable>
            <CloseButton label={`关闭工作区 ${workspace.title}`} disabled={!connected || !canManage(workspace) || busy(workspace.id)}
              onPress={() => { setCloseError(null); void requestWorkspaceClose(machine, workspace, confirmClose).catch(error => setCloseError(describeError(error))); }} />
          </View>
          {pendingByWorkspace[workspace.id] ? <Text style={styles.attention}>{pendingByWorkspace[workspace.id]} 项待处理</Text> : null}
          {list.map((surface) => {
            const selected = target?.surfaceId === surface.id;
            const terminalMenu = desktop ? contextMenuProps((point) => {
              setCloseError(null);
              menu.open(point, terminalMenuItems({ ...common, actions: terminalActions, rename: terminalRename, surface, count: list.length }));
            }) : {};
            return <View key={surface.id} style={[styles.surfaceRow, selected && styles.selected]} {...terminalMenu}>
              <Pressable ref={desktop ? hoverTitle(surface.title) : undefined} onPress={() => openSurface(machine, workspace.id, surface.id)}
                style={({ hovered }: { pressed: boolean; hovered?: boolean }) => [styles.surface, hovered && !selected && styles.hovered]}
                accessibilityRole="button" accessibilityLabel={surface.title} accessibilityState={{ selected }}>
                <TerminalActivityBadge activity={activity[activityKey({ workspaceId: workspace.id, surfaceId: surface.id })]} />
                <Text numberOfLines={2} style={styles.surfaceText}>{surface.title}</Text>
              </Pressable>
              <CloseButton label={`关闭终端 ${surface.title}`} disabled={!connected || !canCloseTerminal(workspace, list.length) || busy(workspace.id)}
                onPress={() => { setCloseError(null); void requestTerminalClose(machine, terminalActions, workspace, surface, confirmClose).catch(error => setCloseError(describeError(error))); }} />
            </View>;
          })}
        </View>;
      })}
      {empty ? <Text style={styles.hint}>{empty}</Text> : null}
    </ScrollView>
    {menu.element}
    {terminalRename.element}
    {dialog ? <NameDialog
      key={dialog.key}
      visible={dialog.open}
      {...(dialog.kind === 'create'
        ? { title: '新建工作区', message: selectedWindow ? `会建在${windowLabel(selectedWindow)}里。` : undefined, confirmLabel: '新建' }
        : { title: '重命名工作区', initialValue: dialog.workspace.title, confirmLabel: '重命名' })}
      placeholder="工作区名称"
      onCancel={dismissDialog}
      onSubmit={(title) => {
        dismissDialog();
        if (dialog.kind === 'create') void create(title);
        else void workspaceActions.rename(dialog.workspace.id, title);
      }}
    /> : null}
  </View>;
}
const styles = StyleSheet.create({ sidebar: { flex: 1, minHeight: 0, width: 270, backgroundColor: colors.surfaceSunken, borderRightWidth: StyleSheet.hairlineWidth, borderRightColor: colors.border, padding: 12, gap: 12 }, controls: { flexShrink: 0, gap: 12 }, scroller: { flex: 1, minHeight: 0 }, header: { gap: 8 },
  titleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }, title: { color: colors.ink, fontSize: 21, fontWeight: '600' }, desktopTitle: { fontSize: 15 },
  add: { width: 28, height: 28, borderRadius: 6, alignItems: 'center', justifyContent: 'center' }, hovered: { backgroundColor: colors.surfaceRaised }, dimmed: { opacity: 0.4 },
  search: { padding: 10, color: colors.ink, backgroundColor: colors.surface, borderRadius: 8 }, list: { gap: 14, paddingBottom: 20 }, group: { gap: 4 }, row: { flexDirection: 'row', alignItems: 'center' }, workspace: { flex: 1, color: colors.ink, fontSize: 14, fontWeight: '600' }, pin: { padding: 8 }, pinText: { color: colors.yellow, fontSize: 18 }, surfaceRow: { flexDirection: 'row', alignItems: 'center', borderRadius: 8 },
  surface: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 6, padding: 10, borderRadius: 8 }, selected: { backgroundColor: colors.surfaceRaised, borderLeftWidth: 2, borderLeftColor: colors.green }, surfaceText: { flex: 1, color: colors.inkDim, fontSize: 13 }, hint: { color: colors.muted, fontSize: 13 }, attention: { color: colors.yellow, fontSize: 11 }, error: { color: colors.red, fontSize: 12 } });
