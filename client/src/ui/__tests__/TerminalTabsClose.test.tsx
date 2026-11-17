import { act, type ReactNode } from 'react';
import { TerminalSession, type RpcChannel } from '../../session/terminalSession';
import { WorkspaceStore } from '../../session/workspaceStore';
import { TerminalScreen } from '../TerminalScreen';

type AlertButton = { text: string; style?: string; onPress?: () => void };
const mockAlert = jest.fn<void, [string, string, AlertButton[]]>();
const mockBack = jest.fn();
let mockMachine: { channel: RpcChannel; session: TerminalSession; workspaces: WorkspaceStore; computer: null; mode: 'live' };
jest.mock('react-native', () => {
  const React = jest.requireActual('react') as typeof import('react');
  const View = ({ children }: { children?: ReactNode }) => React.createElement('div', null, children);
  const Pressable = ({ children, onPress, disabled, accessibilityLabel }: { children?: ReactNode; onPress?: (event: unknown) => void; disabled?: boolean; accessibilityLabel?: string }) =>
    React.createElement('button', { onClick: () => onPress?.({ stopPropagation() {} }), disabled, 'aria-label': accessibilityLabel }, typeof children === 'function' ? null : children);
  return { View, ScrollView: View, Text: View, KeyboardAvoidingView: View, ActivityIndicator: () => null, Pressable, Switch: () => null,
    Platform: { OS: 'ios' }, Alert: { alert: (...args: unknown[]) => mockAlert(...(args as [string, string, AlertButton[]])) },
    useWindowDimensions: () => ({ width: 390, height: 844 }), StyleSheet: { create: (value: unknown) => value, hairlineWidth: 1 } };
});
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
jest.mock('expo-router', () => {
  const React = jest.requireActual('react') as typeof import('react');
  return { useFocusEffect: (effect: () => void | (() => void)) => React.useEffect(effect, [effect]) };
});
jest.mock('../../platform/desktop', () => ({ desktopBridge: () => null }));
jest.mock('../../state/hooks', () => {
  const React = jest.requireActual('react') as typeof import('react');
  return { useMachine: () => mockMachine, useConnectionStatus: () => ({ state: mockMachine.channel.isOpen ? 'open' : 'idle' }),
    useStore: (store: { subscribe: (fn: () => void) => () => void; getState: () => unknown }) => React.useSyncExternalStore(store.subscribe, store.getState, store.getState) };
});
jest.mock('../../state/navigation', () => ({ backToWorkspaces: () => mockBack() }));
jest.mock('../../state/prefs', () => ({ setPrefs: jest.fn(), clampFontSize: (size: number) => size, FONT_SIZE_MIN: 9, FONT_SIZE_MAX: 20,
  usePrefs: () => ({ fontSize: 13, inputMode: 'line', desktopInputMode: 'line', terminalPresentation: 'terminal', terminalWrap: true, tabletSidebar: false }) }));
jest.mock('../Sheet', () => {
  const React = jest.requireActual('react') as typeof import('react');
  return {
    useSheet: () => {
      const [visible, setVisible] = React.useState(false);
      return { visible, open: () => setVisible(true), close: (then?: () => void) => { setVisible(false); then?.(); }, onClosed: () => {} };
    },
    Sheet: ({ visible, children }: { visible: boolean; children?: ReactNode }) => visible ? React.createElement('section', null, children) : null,
    SheetRow: ({ title, onPress, accessibilityLabel }: { title: string; onPress: () => void; accessibilityLabel?: string }) =>
      React.createElement('button', { onClick: onPress, 'aria-label': accessibilityLabel ?? title }, title),
  };
});
jest.mock('../../state/sessionMemory', () => ({ sessionMemory: { computer: () => ({ recent: [] }), visit: jest.fn() } }));
jest.mock('../../session/hostStatus', () => ({ HostStatusStore: class {
  private state = { battery: null };
  getState = () => this.state; subscribe = () => () => {}; start() {} stop() {} refresh() {}
} }));
jest.mock('../../session/terminalConversation', () => ({ TerminalConversationStore: class { start() {} stop() {} dispose() {} } }));
const mockOpenTools = jest.fn();
jest.mock('../TerminalView', () => {
  const React = jest.requireActual('react') as typeof import('react');
  return {
    terminalColumns: () => 48,
    TerminalView: ({ ref }: { ref?: React.Ref<{ openTools: () => void }> }) => { React.useImperativeHandle(ref, () => ({ openTools: () => mockOpenTools() })); return null; },
  };
});
jest.mock('../TerminalChatView', () => ({ TerminalChatView: () => null }));
jest.mock('../InputBar', () => ({ InputBar: () => null }));
jest.mock('../ProjectBrowser', () => ({ ProjectBrowser: () => 'PROJECT_BROWSER' }));
jest.mock('../SharedFiles', () => ({ SharedFilesBar: () => null, SharedFilesSheet: () => null }));
jest.mock('../BatteryBadge', () => ({ BatteryBadge: () => null }));
jest.mock('../WorkspaceSidebar', () => ({ WorkspaceSidebar: () => null }));
jest.mock('../useKeyboardVisible', () => ({ useKeyboardVisible: () => false }));
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
  jest.clearAllMocks(); calls.length = 0;
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
  mockMachine = { channel, session, workspaces, computer: null, mode: 'live' };
  await act(async () => root.render(<TerminalScreen />));
}
const button = (label: string) => container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
/** Presses the alert button with this text, as the user would on the phone. */
async function answer(text: string) {
  const buttons = mockAlert.mock.calls.at(-1)![2];
  await act(async () => buttons.find(b => b.text === text)!.onPress!());
}

it('shows a close button on each terminal tab on the phone and closes after confirmation', async () => {
  await mount();
  await act(async () => button('关闭终端 terminal 0')!.click());
  expect(mockAlert).toHaveBeenCalledWith('关闭终端？', expect.stringContaining('terminal 0'), expect.any(Array), expect.anything());
  await answer('关闭');
  expect(calls.filter(call => call.method === 'surface.close')).toEqual([{ method: 'surface.close', params: { workspace_id: 'w', surface_id: 's0' } }]);
  expect(mockMachine.session.getState().target?.surfaceId).toBe('s1');
  expect(mockBack).not.toHaveBeenCalled();
});

it('keeps everything when the confirmation is cancelled', async () => {
  await mount();
  await act(async () => button('关闭终端 terminal 1')!.click());
  await answer('取消');
  expect(calls.some(call => call.method === 'surface.close' || call.method === 'workspace.close')).toBe(false);
  expect(mockMachine.session.getState().target?.surfaceId).toBe('s0');
});

it('closes the workspace with its last terminal and returns to the list', async () => {
  await mount(1);
  await act(async () => button('关闭终端 terminal 0')!.click());
  expect(mockAlert).toHaveBeenCalledWith('关闭最后一个终端？', expect.stringContaining('同时关闭这个工作区'), expect.any(Array), expect.anything());
  await answer('关闭');
  expect(calls.some(call => call.method === 'workspace.close')).toBe(true);
  expect(calls.some(call => call.method === 'surface.close')).toBe(false);
  expect(mockMachine.session.getState().target).toBeNull();
  expect(mockBack).toHaveBeenCalledTimes(1);
});

it('offers no close button for a read-only source', async () => {
  await mount(2, true);
  expect(button('关闭终端 terminal 0')).toBeNull();
});

it('keeps the phone header to the title row and the terminal tabs', async () => {
  await mount();
  // The chat/terminal switch sits in the title row; files and display options are in the menu.
  expect(button('对话模式')).not.toBeNull();
  expect(button('终端模式')).not.toBeNull();
  expect(button('查看项目文件与 Git 改动')).toBeNull();
  expect(container.textContent).not.toContain('直接发送到当前终端');

  await act(async () => button('更多：文件、搜索复制、折行、字号')!.click());
  expect(container.textContent).toContain('13 pt · 每行 48 列');
  await act(async () => button('放大文字')!.click());
  const { setPrefs } = jest.requireMock('../../state/prefs') as { setPrefs: jest.Mock };
  expect(setPrefs).toHaveBeenLastCalledWith({ fontSize: 14 });
  await act(async () => button('自动折行：开')!.click());
  expect(setPrefs).toHaveBeenLastCalledWith({ terminalWrap: false });

  await act(async () => button('搜索和复制终端输出')!.click());
  expect(mockOpenTools).toHaveBeenCalledTimes(1);

  await act(async () => button('更多：文件、搜索复制、折行、字号')!.click());
  await act(async () => button('项目文件与 Git 改动')!.click());
  expect(container.textContent).toContain('PROJECT_BROWSER');
});
