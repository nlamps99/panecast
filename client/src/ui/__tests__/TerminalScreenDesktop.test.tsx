import { act, type ReactNode } from 'react';
import { TerminalSession, type RpcChannel } from '../../session/terminalSession';
import { WorkspaceStore } from '../../session/workspaceStore';
import { emitDesktopCommand } from '../desktopShell';
import { TerminalScreen } from '../TerminalScreen';

const mockDialog = jest.fn();
const mockCloseWindow = jest.fn();
const mockOpenTools = jest.fn();
const mockOpenOutput = jest.fn();
const mockViewProps = jest.fn();
let mockMachine: { channel: RpcChannel; session: TerminalSession; workspaces: WorkspaceStore; computer: null; mode: 'live' };
type MockProps = { children?: ReactNode | ((state: object) => ReactNode); onPress?: () => void; disabled?: boolean; accessibilityLabel?: string; accessibilityRole?: string; onContextMenu?: unknown; visible?: boolean };
jest.mock('react-native', () => {
  const React = jest.requireActual('react') as typeof import('react');
  const render = (children: MockProps['children']) => (typeof children === 'function' ? children({ pressed: false, hovered: false }) : children) as ReactNode;
  const View = ({ children, onContextMenu, accessibilityRole }: MockProps) => React.createElement('div', { onContextMenu, role: accessibilityRole }, render(children));
  const Pressable = ({ children, onPress, disabled, accessibilityLabel, accessibilityRole, onContextMenu }: MockProps) =>
    React.createElement('button', { onClick: onPress, disabled, 'aria-label': accessibilityLabel, role: accessibilityRole, onContextMenu }, render(children));
  const Modal = ({ children, visible }: MockProps) => visible ? React.createElement('div', { role: 'dialog' }, render(children)) : null;
  return { View, ScrollView: View, Text: View, KeyboardAvoidingView: View, ActivityIndicator: () => null, Pressable, Modal, Switch: () => null,
    Platform: { OS: 'web' }, Alert: {}, useWindowDimensions: () => ({ width: 1200, height: 800 }), StyleSheet: { create: (value: unknown) => value, hairlineWidth: 1, absoluteFill: {} } };
});
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
jest.mock('expo-router', () => {
  const React = jest.requireActual('react') as typeof import('react');
  return { useFocusEffect: (effect: () => void | (() => void)) => React.useEffect(effect, [effect]) };
});
jest.mock('../../platform/desktop', () => ({ desktopBridge: () => ({ version: 1, dialog: mockDialog, closeWindow: mockCloseWindow }), desktopOnWindows: () => false }));
jest.mock('../../state/hooks', () => {
  const React = jest.requireActual('react') as typeof import('react');
  return { useMachine: () => mockMachine, useConnectionStatus: () => ({ state: mockMachine.channel.isOpen ? 'open' : 'idle' }),
    useStore: (store: { subscribe: (fn: () => void) => () => void; getState: () => unknown }) => React.useSyncExternalStore(store.subscribe, store.getState, store.getState) };
});
jest.mock('../../state/navigation', () => ({ backToWorkspaces: jest.fn(), showWorkspaces: jest.fn() }));
jest.mock('../../state/prefs', () => ({ setPrefs: jest.fn(), clampFontSize: (size: number) => size, FONT_SIZE_MIN: 9, FONT_SIZE_MAX: 20,
  usePrefs: () => ({ fontSize: 13, inputMode: 'line', desktopInputMode: 'line', terminalPresentation: 'terminal', terminalWrap: true, desktopTerminalWrap: false, tabletSidebar: false }) }));
jest.mock('../../state/terminalPresentation', () => ({ useTerminalPresentation: () => ['terminal', jest.fn()] }));
jest.mock('../Sheet', () => ({ useSheet: () => ({ visible: false, open() {}, close() {}, onClosed() {} }), Sheet: () => null, SheetRow: () => null }));
jest.mock('../../state/sessionMemory', () => ({ sessionMemory: { computer: () => ({ recent: [] }), visit: jest.fn() } }));
jest.mock('../../session/hostStatus', () => ({ HostStatusStore: class {
  private state = { battery: null };
  getState = () => this.state; subscribe = () => () => {}; start() {} stop() {} refresh() {}
} }));
jest.mock('../../session/terminalConversation', () => ({ TerminalConversationStore: class { start() {} stop() {} dispose() {} } }));
jest.mock('../TerminalView', () => {
  const React = jest.requireActual('react') as typeof import('react');
  return {
    terminalColumns: () => 48,
    TerminalView: (props: { ref?: React.Ref<{ openTools: () => void; openOutput: () => void }> }) => { mockViewProps(props); React.useImperativeHandle(props.ref, () => ({ openTools: () => mockOpenTools(), openOutput: () => mockOpenOutput() })); return null; },
  };
});
jest.mock('../TerminalChatView', () => ({ TerminalChatView: () => null }));
jest.mock('../InputBar', () => ({ InputBar: () => null }));
jest.mock('../ProjectBrowser', () => ({ ProjectBrowser: () => 'PROJECT_BROWSER' }));
jest.mock('../SharedFiles', () => ({ SharedFilesBar: () => null, SharedFilesSheet: () => null }));
jest.mock('../BatteryBadge', () => ({ BatteryBadge: () => null }));
jest.mock('../WorkspaceSidebar', () => ({ WorkspaceSidebar: () => null }));
jest.mock('../useKeyboardVisible', () => ({ useKeyboardVisible: () => false }));
jest.mock('../Icon', () => ({ Icon: () => '·' }));
jest.mock('../NameDialog', () => ({ NameDialog: () => null }));

let dom: { window: Window & typeof globalThis };
let container: HTMLDivElement;
type Root = { render(children: ReactNode): void; unmount(): void };
let root: Root;
const calls: { method: string; params?: Record<string, unknown> }[] = [];
beforeAll(() => {
  const { JSDOM } = jest.requireActual('jsdom');
  dom = new JSDOM('<!doctype html><html><body></body></html>');
  for (const key of ['window', 'document', 'navigator', 'HTMLElement']) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: (dom.window as unknown as Record<string, unknown>)[key] });
});
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  jest.clearAllMocks(); calls.length = 0; mockDialog.mockResolvedValue(1);
  container = document.createElement('div'); document.body.appendChild(container);
  root = jest.requireActual('react-dom/client').createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); mockMachine?.session.dispose(); mockMachine?.workspaces.dispose(); container.remove(); });
afterAll(() => dom.window.close());

async function mount(access = 'control') {
  let surfaces = [0, 1].map((index) => ({ id: `s${index}`, title: `terminal ${index}`, index, type: 'terminal' }));
  const channel: RpcChannel = { isOpen: true, onPush: () => () => {}, onStatus: () => () => {}, async call<T>(method: string, params?: Record<string, unknown>): Promise<T> {
    calls.push({ method, params });
    if (method === 'workspace.list') return { workspaces: [{ id: 'w', title: 'project', index: 0, access }] } as T;
    if (method === 'surface.list') return { surfaces } as T;
    if (method === 'surface.close') surfaces = surfaces.filter(s => s.id !== params?.surface_id);
    return {} as T;
  } };
  const session = new TerminalSession(channel), workspaces = new WorkspaceStore(channel);
  await workspaces.refresh(); session.setTarget({ workspaceId: 'w', surfaceId: 's0' });
  mockMachine = { channel, session, workspaces, computer: null, mode: 'live' };
  await act(async () => root.render(<TerminalScreen />));
}
const button = (label: string) => container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);

it('puts the tabs, the mode switch and the tools in one header row', async () => {
  await mount();
  for (const label of ['terminal 0', 'terminal 1', '新建终端', '对话模式', '终端模式', '切换为自动折行', '在终端输出中搜索', '复制终端输出', '查看项目文件与 Git 改动']) expect(button(label)).not.toBeNull();
  // The sidebar names the workspace and has the pages; no back button, title or hint rows here.
  expect(button('返回')).toBeNull();
  expect(container.textContent).not.toContain('project');
  expect(container.textContent).not.toContain('直接发送到当前终端');
  expect(mockViewProps).toHaveBeenLastCalledWith(expect.objectContaining({ toolsInHeader: true }));

  await act(async () => button('在终端输出中搜索')!.click());
  expect(mockOpenTools).toHaveBeenCalledTimes(1);
  await act(async () => button('复制终端输出')!.click());
  expect(mockOpenOutput).toHaveBeenCalledTimes(1);
  await act(async () => button('切换为自动折行')!.click());
  const { setPrefs } = jest.requireMock('../../state/prefs') as { setPrefs: jest.Mock };
  expect(setPrefs).toHaveBeenLastCalledWith({ desktopTerminalWrap: true });
});

it('closes a terminal from its tab’s right-click menu after confirmation', async () => {
  await mount();
  await act(async () => { button('terminal 1')!.parentElement!.dispatchEvent(new dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 })); });
  const items = [...container.querySelectorAll('[role="dialog"] button[role="menuitem"]')].map((item) => item.getAttribute('aria-label'));
  expect(items).toEqual(['重命名…', '恢复默认名称', '新建终端', '关闭终端…']);
  await act(async () => (container.querySelector('[role="dialog"] button[aria-label="关闭终端…"]') as HTMLButtonElement).click());
  expect(mockDialog).toHaveBeenCalledWith(expect.objectContaining({ title: '关闭终端？' }));
  expect(calls.filter((call) => call.method === 'surface.close')).toEqual([{ method: 'surface.close', params: { workspace_id: 'w', surface_id: 's1' } }]);
});

it('closes the terminal on screen with ⌘W, once confirmed', async () => {
  await mount();
  mockDialog.mockResolvedValueOnce(0);
  await act(async () => emitDesktopCommand({ kind: 'close' }));
  expect(calls.some((call) => call.method === 'surface.close')).toBe(false);
  await act(async () => emitDesktopCommand({ kind: 'close' }));
  expect(calls.filter((call) => call.method === 'surface.close')).toEqual([{ method: 'surface.close', params: { workspace_id: 'w', surface_id: 's0' } }]);
  expect(mockCloseWindow).not.toHaveBeenCalled();
});

it('hides the window on ⌘W when the terminal cannot be closed here', async () => {
  await mount('read');
  await act(async () => emitDesktopCommand({ kind: 'close' }));
  expect(mockDialog).not.toHaveBeenCalled();
  expect(mockCloseWindow).toHaveBeenCalledTimes(1);
});

it('hides the window on ⌘W while offline instead of doing nothing', async () => {
  await mount();
  (mockMachine.channel as { isOpen: boolean }).isOpen = false;
  await act(async () => emitDesktopCommand({ kind: 'close' }));
  expect(mockDialog).not.toHaveBeenCalled();
  expect(mockCloseWindow).toHaveBeenCalledTimes(1);
});
