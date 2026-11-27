import { act, type ReactNode } from 'react';
import { TerminalSession, type RpcChannel } from '../../session/terminalSession';
import { WorkspaceStore } from '../../session/workspaceStore';
import { WorkspaceSidebar } from '../WorkspaceSidebar';

let mockDesktop = true;
const mockDialog = jest.fn();
const mockOpen = jest.fn();
let mockMachine: { channel: RpcChannel; session: TerminalSession; workspaces: WorkspaceStore; computer: null; inbox: object };
jest.mock('react-native', () => {
  const React = jest.requireActual('react') as typeof import('react');
  const View = ({ children }: { children?: ReactNode }) => React.createElement('div', null, children);
  const Pressable = ({ children, onPress, disabled, accessibilityLabel }: { children?: ReactNode; onPress?: (event: unknown) => void; disabled?: boolean; accessibilityLabel?: string }) =>
    React.createElement('button', { onClick: onPress, disabled, 'aria-label': accessibilityLabel }, children);
  return { View, ScrollView: View, Text: View, TextInput: () => null, Pressable, Platform: { OS: 'web' }, Alert: {},
    StyleSheet: { create: (value: unknown) => value, hairlineWidth: 1 } };
});
jest.mock('../../platform/desktop', () => ({ desktopBridge: () => mockDesktop ? { version: 1, dialog: mockDialog } : null, desktopOnWindows: () => false }));
jest.mock('../../state/hooks', () => {
  const React = jest.requireActual('react') as typeof import('react');
  return { useMachine: () => mockMachine, useConnectionStatus: () => ({ state: mockMachine.channel.isOpen ? 'open' : 'idle' }),
    useStore: (store: { subscribe: (fn: () => void) => () => void; getState: () => unknown }) => React.useSyncExternalStore(store.subscribe, store.getState, store.getState) };
});
jest.mock('../../state/navigation', () => ({ openSurface: (...args: unknown[]) => mockOpen(...args) }));
jest.mock('../../state/sessionMemory', () => ({ useSessionMemory: () => ({ pinned: [] }), sessionMemory: { pin: jest.fn() } }));
jest.mock('../ComputerSwitcher', () => ({ ComputerSwitcher: () => null }));
jest.mock('../WindowChips', () => ({ WindowChips: () => null }));
jest.mock('../ConnectionNotice', () => ({ ConnectionNotice: () => null }));
jest.mock('../NameDialog', () => ({ NameDialog: () => null }));
jest.mock('../Icon', () => ({ Icon: () => '×' }));

let dom: { window: Window & typeof globalThis };
let container: HTMLDivElement;
type Root = { render(children: ReactNode): void; unmount(): void };
let root: Root;
let createRoot: (node: Element) => Root;
const calls: { method: string; params?: Record<string, unknown> }[] = [];
beforeAll(() => {
  const { JSDOM } = jest.requireActual('jsdom');
  dom = new JSDOM('<!doctype html><html><body></body></html>');
  for (const key of ['window', 'document', 'navigator', 'HTMLElement']) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: (dom.window as unknown as Record<string, unknown>)[key] });
  createRoot = jest.requireActual('react-dom/client').createRoot;
});
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mockDesktop = true; jest.clearAllMocks(); calls.length = 0; mockDialog.mockResolvedValue(0);
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); mockMachine?.session.dispose(); mockMachine?.workspaces.dispose(); container.remove(); });
afterAll(() => dom.window.close());
async function mount(count = 2, readOnly = false) {
  let surfaces = Array.from({ length: count }, (_, index) => ({ id: `s${index}`, title: `terminal ${index}`, index, type: 'terminal' }));
  let exists = true;
  const channel: RpcChannel = { isOpen: true, onPush: () => () => {}, onStatus: () => () => {}, async call<T>(method: string, params?: Record<string, unknown>): Promise<T> {
    calls.push({ method, params });
    if (method === 'workspace.list') return { workspaces: exists ? [{ id: 'w', title: 'project', index: 0, access: readOnly ? 'read' : 'control' }] : [] } as T;
    if (method === 'surface.list') return { surfaces } as T;
    if (method === 'surface.close') surfaces = surfaces.filter(s => s.id !== params?.surface_id);
    if (method === 'workspace.close') exists = false;
    return {} as T;
  } };
  const session = new TerminalSession(channel), workspaces = new WorkspaceStore(channel);
  await workspaces.refresh(); session.setTarget({ workspaceId: 'w', surfaceId: 's0' });
  const inboxState = { pendingByWorkspace: {} };
  mockMachine = { channel, session, workspaces, computer: null, inbox: { getState: () => inboxState, subscribe: () => () => {} } };
  await act(async () => root.render(<WorkspaceSidebar />));
}
const button = (label: string) => container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;

it('exposes close buttons and uses native confirmation without opening another terminal', async () => {
  await mount();
  await act(async () => button('关闭终端 terminal 0').click());
  expect(mockDialog).toHaveBeenCalledWith(expect.objectContaining({ cancelId: 0, title: '关闭终端？' }));
  expect(calls.some(call => call.method === 'surface.close')).toBe(false);
  mockDialog.mockResolvedValue(1);
  await act(async () => button('关闭终端 terminal 0').click());
  expect(calls.filter(call => call.method === 'surface.close')).toEqual([{ method: 'surface.close', params: { workspace_id: 'w', surface_id: 's0' } }]);
  expect(mockOpen).not.toHaveBeenCalled();
  expect(mockMachine.session.getState().target?.surfaceId).toBe('s1');
});
it('allows closing the last terminal only after its workspace warning', async () => {
  await mount(1); mockDialog.mockResolvedValue(1);
  await act(async () => button('关闭终端 terminal 0').click());
  expect(mockDialog).toHaveBeenCalledWith(expect.objectContaining({ title: '关闭最后一个终端？', message: expect.stringContaining('同时关闭这个工作区') }));
  expect(calls.some(call => call.method === 'workspace.close')).toBe(true);
  expect(mockMachine.session.getState().target).toBeNull();
});
it('disables terminal and workspace close actions for a read-only source', async () => {
  await mount(2, true);
  expect(button('关闭终端 terminal 0').disabled).toBe(true);
  expect(button('关闭工作区 project').disabled).toBe(true);
  await act(async () => button('关闭工作区 project').click());
  expect(mockDialog).not.toHaveBeenCalled();
});
