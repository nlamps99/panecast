import { act, type ReactNode } from 'react';
import type { ConnectionStatus } from '../../protocol/connection';
import { activityKey, type ActivityState } from '../../session/terminalActivity';
import { TerminalSession, type RpcChannel } from '../../session/terminalSession';
import { WorkspaceStore } from '../../session/workspaceStore';
import { emitDesktopCommand, setSidebarQuery } from '../desktopShell';
import { WorkspaceSidebar } from '../WorkspaceSidebar';

const mockDialog = jest.fn();
const mockOpen = jest.fn();
const mockSetPinned = jest.fn();
let mockStatus: ConnectionStatus = { state: 'open' };
let mockPinned: string[] = [];
let mockActionError: { code: string; message: string } | null = null;
type Machine = { channel: RpcChannel; session: TerminalSession; workspaces: WorkspaceStore; computer: { id: string }; inbox: object; activity: object };
let mockMachine: Machine;
type MockProps = { children?: ReactNode | ((state: object) => ReactNode); onPress?: () => void; disabled?: boolean; accessibilityLabel?: string; accessibilityRole?: string; onContextMenu?: unknown; visible?: boolean };
jest.mock('react-native', () => {
  const React = jest.requireActual('react') as typeof import('react');
  const render = (children: MockProps['children']) => (typeof children === 'function' ? children({ pressed: false, hovered: false }) : children) as ReactNode;
  const View = ({ children, onContextMenu, accessibilityRole }: MockProps) => React.createElement('div', { onContextMenu, role: accessibilityRole }, render(children));
  const Pressable = ({ children, onPress, disabled, accessibilityLabel, accessibilityRole, onContextMenu }: MockProps) =>
    React.createElement('button', { onClick: onPress, disabled, 'aria-label': accessibilityLabel, role: accessibilityRole, onContextMenu }, render(children));
  const Modal = ({ children, visible }: MockProps) => visible ? React.createElement('div', { role: 'dialog' }, render(children)) : null;
  return { View, ScrollView: View, Text: View, TextInput: () => null, Pressable, Modal, ActivityIndicator: () => null, Platform: { OS: 'web' }, Alert: {},
    useWindowDimensions: () => ({ width: 1200, height: 800 }), StyleSheet: { create: (value: unknown) => value, hairlineWidth: 1, absoluteFill: {} } };
});
jest.mock('../../platform/desktop', () => ({ desktopBridge: () => ({ version: 1, dialog: mockDialog }), desktopOnWindows: () => false }));
jest.mock('../../state/hooks', () => {
  const React = jest.requireActual('react') as typeof import('react');
  return { useMachine: () => mockMachine, useConnectionStatus: () => mockStatus,
    useStore: (store: { subscribe: (fn: () => void) => () => void; getState: () => unknown }) => React.useSyncExternalStore(store.subscribe, store.getState, store.getState) };
});
jest.mock('../../state/navigation', () => ({ openSurface: (...args: unknown[]) => mockOpen(...args) }));
jest.mock('../../state/sessionMemory', () => ({ useSessionMemory: () => ({ pinned: mockPinned }), sessionMemory: { pin: jest.fn(), setPinned: (...args: unknown[]) => mockSetPinned(...args) } }));
jest.mock('../ComputerSwitcher', () => ({ ComputerSwitcher: () => null }));
jest.mock('../ConnectionNotice', () => ({ ConnectionNotice: () => null }));
jest.mock('../WindowChips', () => ({ WindowChips: () => null }));
jest.mock('../Icon', () => ({ Icon: () => '+' }));
jest.mock('../NameDialog', () => {
  const React = jest.requireActual('react') as typeof import('react');
  return { NameDialog: ({ visible, title, initialValue, onSubmit }: { visible: boolean; title: string; initialValue?: string; onSubmit: (name: string) => void }) =>
    visible ? React.createElement('section', { 'aria-label': title, 'data-initial': initialValue }, React.createElement('button', { onClick: () => onSubmit('新名字') }, '确定')) : null };
});

let dom: { window: Window & typeof globalThis };
let container: HTMLDivElement;
type Root = { render(children: ReactNode): void; unmount(): void };
let root: Root;
const calls: { method: string; params?: Record<string, unknown> }[] = [];
let activity: ActivityState = {};
const activityListeners = new Set<() => void>();
const setActivity = (next: ActivityState) => { activity = next; for (const listener of activityListeners) listener(); };
beforeAll(() => {
  const { JSDOM } = jest.requireActual('jsdom');
  dom = new JSDOM('<!doctype html><html><body></body></html>');
  for (const key of ['window', 'document', 'navigator', 'HTMLElement']) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: (dom.window as unknown as Record<string, unknown>)[key] });
});
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  jest.clearAllMocks(); calls.length = 0; mockDialog.mockResolvedValue(1);
  mockStatus = { state: 'open' }; mockPinned = []; mockActionError = null; setSidebarQuery(''); activity = {};
  container = document.createElement('div'); document.body.appendChild(container);
  root = jest.requireActual('react-dom/client').createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); mockMachine?.session.dispose(); mockMachine?.workspaces.dispose(); container.remove(); });
afterAll(() => dom.window.close());

async function mount({ access = 'control', load = true }: { access?: string; load?: boolean } = {}) {
  let workspaces = [{ id: 'w1', title: 'first', index: 0, access }, { id: 'w2', title: 'second', index: 1, access }];
  const surfaces: Record<string, { id: string; title: string; index: number; type: string }[]> = {
    w1: [{ id: 's1', title: 'shell', index: 0, type: 'terminal' }],
    w2: [{ id: 's2', title: 'build', index: 0, type: 'terminal' }, { id: 's3', title: 'logs', index: 1, type: 'terminal' }],
  };
  const channel: RpcChannel = { isOpen: true, onPush: () => () => {}, onStatus: () => () => {}, async call<T>(method: string, params?: Record<string, unknown>): Promise<T> {
    calls.push({ method, params });
    if (method === 'workspace.list') return { workspaces } as T;
    if (method === 'surface.list') return { surfaces: surfaces[String(params?.workspace_id)] ?? [] } as T;
    if (method === 'surface.action') {
      if (mockActionError) { const { RpcCallError } = jest.requireActual('../../protocol/connection'); throw new RpcCallError(mockActionError.code, mockActionError.message); }
      const list = Object.values(surfaces).flat().find((item) => item.id === params?.surface_id)!;
      list.title = params?.action === 'rename' ? String(params.title) : 'default';
    }
    if (method === 'workspace.create') { workspaces = [...workspaces, { id: 'w3', title: String(params?.title), index: 2, access }]; surfaces.w3 = [{ id: 's9', title: 'new', index: 0, type: 'terminal' }]; }
    return {} as T;
  } };
  const session = new TerminalSession(channel), workspaceStore = new WorkspaceStore(channel);
  if (load) await workspaceStore.refresh();
  const inboxState = { pendingByWorkspace: {} };
  mockMachine = { channel, session, workspaces: workspaceStore, computer: { id: 'mac' }, inbox: { getState: () => inboxState, subscribe: () => () => {} },
    activity: { getState: () => activity, subscribe: (listener: () => void) => { activityListeners.add(listener); return () => activityListeners.delete(listener); } } };
  await act(async () => root.render(<WorkspaceSidebar />));
}
const button = (label: string) => container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
const rightClick = async (element: Element) => act(async () => { element.dispatchEvent(new dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 50 })); });
const menuItems = () => [...container.querySelectorAll('[role="dialog"] button[role="menuitem"]')].map((item) => item.getAttribute('aria-label'));
const terminalOrder = () => [...container.querySelectorAll('button[aria-label]')].map((item) => item.getAttribute('aria-label')).filter((label) => ['shell', 'build', 'logs'].includes(label ?? ''));

it('keeps its rows in place while terminals start and stop running', async () => {
  await mount();
  expect(terminalOrder()).toEqual(['shell', 'build', 'logs']);
  await act(async () => setActivity({ [activityKey({ workspaceId: 'w2', surfaceId: 's3' })]: { status: 'running', at: Date.now() } as never }));
  expect(terminalOrder()).toEqual(['shell', 'build', 'logs']);
});

it('renames a workspace from its right-click menu', async () => {
  await mount();
  await rightClick(button('置顶first')!.parentElement!);
  expect(menuItems()).toEqual(['重命名…', '置顶', '关闭工作区…']);
  await act(async () => (container.querySelector('button[aria-label="重命名…"]') as HTMLButtonElement).click());
  const dialog = container.querySelector('section[aria-label="重命名工作区"]')!;
  expect(dialog.getAttribute('data-initial')).toBe('first');
  await act(async () => (dialog.querySelector('button') as HTMLButtonElement).click());
  expect(calls).toContainEqual({ method: 'workspace.rename', params: { workspace_id: 'w1', title: '新名字' } });
});

it('pins and closes from the menu, closing only after the usual confirmation', async () => {
  await mount();
  await rightClick(button('置顶second')!.parentElement!);
  await act(async () => (container.querySelector('button[aria-label="置顶"]') as HTMLButtonElement).click());
  expect(mockSetPinned).toHaveBeenCalledWith('mac', 'w2', true);
  await rightClick(button('置顶second')!.parentElement!);
  await act(async () => (container.querySelector('button[aria-label="关闭工作区…"]') as HTMLButtonElement).click());
  expect(mockDialog).toHaveBeenCalledWith(expect.objectContaining({ title: '关闭「second」？' }));
  expect(calls).toContainEqual({ method: 'workspace.close', params: { workspace_id: 'w2' } });
});

it('opens a terminal menu with rename, new and close', async () => {
  await mount();
  await rightClick(button('logs')!.parentElement!);
  expect(menuItems()).toEqual(['重命名…', '恢复默认名称', '新建终端', '关闭终端…']);
  await act(async () => (container.querySelector('button[aria-label="新建终端"]') as HTMLButtonElement).click());
  expect(calls).toContainEqual({ method: 'surface.create', params: { workspace_id: 'w2', type: 'terminal', focus: true } });
});

it('offers a read-only source only what it allows', async () => {
  await mount({ access: 'read' });
  await rightClick(button('置顶first')!.parentElement!);
  expect(menuItems()).toEqual(['置顶']);
  await act(async () => (container.querySelector('button[aria-label="置顶"]') as HTMLButtonElement).click());
  await rightClick(button('shell')!.parentElement!);
  expect(container.querySelector('[role="dialog"]')).toBeNull();
});

it('creates a workspace from ⌘N and opens its terminal', async () => {
  await mount();
  await act(async () => emitDesktopCommand({ kind: 'newWorkspace' }));
  const dialog = container.querySelector('section[aria-label="新建工作区"]')!;
  await act(async () => (dialog.querySelector('button') as HTMLButtonElement).click());
  expect(calls).toContainEqual({ method: 'workspace.create', params: { title: '新名字' } });
  expect(mockOpen).toHaveBeenCalledWith(mockMachine, 'w3', 's9');
});

it('has a 新建工作区 button, unavailable while disconnected', async () => {
  mockStatus = { state: 'waiting', attempt: 1, retryAt: 0, reason: 'network' };
  await mount();
  expect(button('新建工作区')!.disabled).toBe(true);
  await act(async () => emitDesktopCommand({ kind: 'newWorkspace' }));
  expect(container.querySelector('section[aria-label="新建工作区"]')).toBeNull();
});

it('says it is loading or not connected instead of "no match"', async () => {
  mockStatus = { state: 'connecting', attempt: 0 };
  await mount({ load: false });
  expect(container.textContent).toContain('正在加载…');
  expect(container.textContent).not.toContain('没有匹配的工作区');
  await act(async () => root.unmount());
  root = jest.requireActual('react-dom/client').createRoot(container);
  mockStatus = { state: 'waiting', attempt: 2, retryAt: 0, reason: 'relay_offline' };
  await act(async () => root.render(<WorkspaceSidebar />));
  expect(container.textContent).toContain('未连接');
});

it('renames a terminal and shows the new name from the refreshed list', async () => {
  await mount();
  await rightClick(button('logs')!.parentElement!);
  await act(async () => (container.querySelector('button[aria-label="重命名…"]') as HTMLButtonElement).click());
  const dialog = container.querySelector('section[aria-label="重命名终端"]')!;
  expect(dialog.getAttribute('data-initial')).toBe('logs');
  await act(async () => (dialog.querySelector('button') as HTMLButtonElement).click());
  expect(calls).toContainEqual({ method: 'surface.action', params: { workspace_id: 'w2', surface_id: 's3', action: 'rename', title: '新名字' } });
  expect(button('新名字')).not.toBeNull();
  await rightClick(button('新名字')!.parentElement!);
  await act(async () => (container.querySelector('button[aria-label="恢复默认名称"]') as HTMLButtonElement).click());
  expect(calls).toContainEqual({ method: 'surface.action', params: { workspace_id: 'w2', surface_id: 's3', action: 'clear_name' } });
  expect(button('default')).not.toBeNull();
});

it('says a terminal cannot be renamed where the source does not support it, without retrying', async () => {
  mockActionError = { code: 'method_not_found', message: '统一网关不支持这个操作' };
  await mount();
  await rightClick(button('shell')!.parentElement!);
  await act(async () => (container.querySelector('button[aria-label="重命名…"]') as HTMLButtonElement).click());
  await act(async () => (container.querySelector('section[aria-label="重命名终端"] button') as HTMLButtonElement).click());
  expect(calls.filter((call) => call.method === 'surface.action')).toHaveLength(1);
  expect(mockDialog).toHaveBeenCalledWith(expect.objectContaining({ title: '这个终端不支持重命名' }));
});

it('offers no rename in a shared window', async () => {
  await mount({ access: 'shared' });
  await rightClick(button('logs')!.parentElement!);
  expect(menuItems()).toEqual(['新建终端', '关闭终端…']);
});
