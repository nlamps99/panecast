import { act, type ReactNode } from 'react';
import { TerminalSession, type RpcChannel } from '../../session/terminalSession';
import { WorkspaceStore } from '../../session/workspaceStore';
import { sessionMemory } from '../../state/sessionMemory';
import WorkspacesScreen from '../../app/(tabs)/index';

const mockConfirm = jest.fn();
let mockStatus: { state: string; attempt?: number; retryAt?: number; reason?: string } = { state: 'open' };
const inboxState = { unreadByWorkspace: {}, pendingByWorkspace: {} };
let mockMachine: { channel: RpcChannel; session: TerminalSession; workspaces: WorkspaceStore; computer: null; inbox: object };
type SwipeProps = { children?: ReactNode; renderRightActions?: () => ReactNode; onSwipeableWillOpen?: () => void; onSwipeableWillClose?: () => void };
jest.mock('react-native', () => {
  const React = jest.requireActual('react') as typeof import('react');
  const View = ({ children, accessibilityElementsHidden }: { children?: ReactNode; accessibilityElementsHidden?: boolean }) =>
    React.createElement('div', accessibilityElementsHidden ? { 'aria-hidden': 'true' } : null, children);
  const Pressable = ({ children, onPress, disabled, accessibilityLabel, style }: { children?: ReactNode; onPress?: (event: unknown) => void; disabled?: boolean; accessibilityLabel?: string; style?: unknown }) => {
    if (typeof style === 'function') style({ pressed: false });
    return React.createElement('button', { onClick: () => onPress?.({ stopPropagation() {} }), disabled, 'aria-label': accessibilityLabel }, children);
  };
  return { View, ScrollView: View, Text: View, TextInput: () => null, Pressable, ActivityIndicator: () => null, RefreshControl: () => null,
    Platform: { OS: 'ios' }, Alert: {}, useWindowDimensions: () => ({ width: 393, height: 852 }),
    StyleSheet: { create: (value: unknown) => value, hairlineWidth: 1 } };
});
// The swipeable shows its actions and its child; a test button stands for the swipe itself.
jest.mock('react-native-gesture-handler/ReanimatedSwipeable', () => {
  const React = jest.requireActual('react') as typeof import('react');
  const Swipeable = React.forwardRef(({ children, renderRightActions, onSwipeableWillOpen, onSwipeableWillClose }: SwipeProps, ref) => {
    React.useImperativeHandle(ref, () => ({ close: () => onSwipeableWillClose?.() }));
    return React.createElement('div', null,
      React.createElement('button', { 'aria-label': 'swipe', onClick: () => onSwipeableWillOpen?.() }),
      renderRightActions?.(), children);
  });
  Swipeable.displayName = 'Swipeable';
  return { __esModule: true, default: Swipeable };
});
jest.mock('@react-native-async-storage/async-storage', () => ({ __esModule: true, default: { getItem: async () => null, setItem: async () => {} } }));
jest.mock('expo-router', () => ({ useFocusEffect: () => {} }));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, left: 0, right: 0, bottom: 0 }) }));
jest.mock('../../platform/desktop', () => ({ desktopBridge: () => null }));
jest.mock('../../platform/confirm', () => ({ confirmClose: (...args: unknown[]) => mockConfirm(...args) }));
jest.mock('../../state/hooks', () => {
  const React = jest.requireActual('react') as typeof import('react');
  return { useMachine: () => mockMachine, useConnectionStatus: () => mockStatus,
    useStore: (store: { subscribe: (fn: () => void) => () => void; getState: () => unknown }) => React.useSyncExternalStore(store.subscribe, store.getState, store.getState) };
});
jest.mock('../../state/navigation', () => ({ openSurface: jest.fn(), openRecentSurface: jest.fn() }));
jest.mock('../ComputerSwitcher', () => ({ ComputerSwitcher: () => null }));
jest.mock('../WindowChips', () => ({ WindowChips: () => null }));
jest.mock('../NameDialog', () => ({ NameDialog: () => null }));
jest.mock('../WorkspaceMenu', () => ({ WorkspaceMenu: () => null }));
jest.mock('../TerminalActivityBadge', () => ({ TerminalActivityBadge: () => null, useTerminalActivity: () => ({}) }));
jest.mock('../Icon', () => ({ Icon: () => null }));
jest.mock('../../state/appStore', () => ({ appStore: { wake: jest.fn() } }));
jest.mock('../SignedOutNotice', () => ({ SignedOutNotice: () => null }));
jest.mock('../StatusBarScrim', () => ({ StatusBarScrim: () => null }));

let dom: { window: Window & typeof globalThis };
let container: HTMLDivElement;
type Root = { render(children: ReactNode): void; unmount(): void };
let root: Root;
beforeAll(async () => {
  const { JSDOM } = jest.requireActual('jsdom');
  dom = new JSDOM('<!doctype html><html><body></body></html>');
  for (const key of ['window', 'document', 'navigator', 'HTMLElement']) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: (dom.window as unknown as Record<string, unknown>)[key] });
  await sessionMemory.load();
});
beforeEach(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div'); document.body.appendChild(container);
  root = jest.requireActual('react-dom/client').createRoot(container);
  const channel: RpcChannel = { isOpen: true, onPush: () => () => {}, onStatus: () => () => {}, async call<T>(method: string): Promise<T> {
    if (method === 'workspace.list') return { workspaces: [{ id: 'w1', title: 'panecast', index: 0, access: 'control' }, { id: 'w2', title: 'notes', index: 1, access: 'control' }] } as T;
    if (method === 'surface.list') return { surfaces: [{ id: 's', title: 'zsh', index: 0, type: 'terminal' }] } as T;
    return {} as T;
  } };
  const session = new TerminalSession(channel), workspaces = new WorkspaceStore(channel);
  await workspaces.refresh();
  mockMachine = { channel, session, workspaces, computer: null, inbox: { getState: () => inboxState, subscribe: () => () => {} } };
  await act(async () => root.render(<WorkspacesScreen />));
});
afterEach(async () => { mockStatus = { state: 'open' }; await act(async () => root.unmount()); mockMachine.session.dispose(); mockMachine.workspaces.dispose(); container.remove(); sessionMemory.setPinned('demo', 'w2', false); });
afterAll(() => dom.window.close());

const labels = () => [...container.querySelectorAll('button')].filter((b) => !b.closest('[aria-hidden="true"]')).map((b) => b.getAttribute('aria-label') ?? '');
const press = async (label: string) => {
  const target = [...container.querySelectorAll('button')].find((b) => !b.closest('[aria-hidden="true"]') && b.getAttribute('aria-label') === label);
  if (!target) throw new Error(`no button ${label} in ${labels().join(' | ')}`);
  await act(async () => target.click());
};
const swipe = async (title: string) => {
  const swipes = [...container.querySelectorAll('button[aria-label="swipe"]')] as HTMLButtonElement[];
  const index = labels().filter((l) => l === 'swipe' || l.startsWith('panecast，') || l.startsWith('notes，')).findIndex((l) => l.startsWith(`${title}，`)) / 2;
  await act(async () => swipes[Math.floor(index)].click());
};

it('keeps 置顶 and 关闭 behind the swipe on a phone', () => {
  expect(labels()).not.toContain('置顶 notes');
  expect(labels()).not.toContain('关闭工作区 notes');
});

it('pins from the swipe, moving the card first, and unpins again', async () => {
  await swipe('notes');
  await press('置顶 notes');
  expect(sessionMemory.computer('demo').pinned).toEqual(['w2']);
  const cards = labels().filter((l) => /^(panecast|notes)，/.test(l));
  expect(cards[0]).toMatch(/^notes，.*已置顶/);
  expect(labels()).not.toContain('取消置顶 notes');
  await swipe('notes');
  await press('取消置顶 notes');
  expect(sessionMemory.computer('demo').pinned).toEqual([]);
});

it('asks before closing from the swipe', async () => {
  mockConfirm.mockResolvedValue(false);
  await swipe('notes');
  await press('关闭工作区 notes');
  expect(mockConfirm).toHaveBeenCalled();
});

it('offers a retry when the connection drops', async () => {
  expect(labels()).not.toContain('立即重新连接');
  mockStatus = { state: 'waiting', attempt: 1, retryAt: 0, reason: 'network' };
  await act(async () => root.render(<WorkspacesScreen />));
  await press('立即重新连接');
  expect(jest.requireMock('../../state/appStore').appStore.wake).toHaveBeenCalled();
  // A retry in progress keeps the same card instead of flickering away.
  mockStatus = { state: 'connecting', attempt: 2 };
  await act(async () => root.render(<WorkspacesScreen />));
  expect(labels()).toContain('立即重新连接');
});
