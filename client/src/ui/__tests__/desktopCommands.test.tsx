import { act, type ReactNode } from 'react';
import { TerminalSession, type RpcChannel } from '../../session/terminalSession';
import { WorkspaceStore } from '../../session/workspaceStore';
import type { Machine } from '../../state/appStore';

const mockNavigate = jest.fn();
const mockOpen = jest.fn();
const mockCloseWindow = jest.fn();
const mockSetPrefs = jest.fn();
const mockZoom = jest.fn();
let mockPinned: string[] = [];
let mockMenuListener: ((id: string) => void) | null = null;
jest.mock('react-native', () => ({ Platform: { OS: 'web' }, useWindowDimensions: () => ({ width: 1200, height: 800 }) }));
jest.mock('expo-router', () => ({ router: { navigate: (...args: unknown[]) => mockNavigate(...args) } }));
jest.mock('../../state/navigation', () => ({ openSurface: (...args: unknown[]) => mockOpen(...args) }));
jest.mock('../../state/sessionMemory', () => ({ sessionMemory: { computer: () => ({ pinned: mockPinned }) } }));
jest.mock('../../state/prefs', () => ({ DEFAULT_PREFS: { fontSize: 13 }, getPrefs: () => ({ fontSize: 13 }), clampFontSize: (size: number) => size,
  setPrefs: (...args: unknown[]) => mockSetPrefs(...args) }));
jest.mock('../terminalZoom', () => ({ zoomDesktopTerminal: (...args: unknown[]) => mockZoom(...args) }));
jest.mock('../../platform/desktop', () => ({
  desktopOnWindows: () => false,
  desktopBridge: () => ({ version: 1, closeWindow: () => mockCloseWindow(), onMenu: (listener: (id: string) => void) => { mockMenuListener = listener; return () => { mockMenuListener = null; }; } }),
}));
// eslint-disable-next-line import/first
import { onDesktopCommand, setSidebarHidden, setSidebarQuery, sidebarState, type DesktopCommand } from '../desktopShell';
// eslint-disable-next-line import/first
import { runDesktopCommand, useDesktopMenu, useDesktopShortcuts } from '../useDesktopShortcuts';

let machine: Machine;
const surface = (id: string, index: number) => ({ id, title: `terminal ${id}`, index, type: 'terminal' });
beforeEach(async () => {
  jest.clearAllMocks();
  mockPinned = []; setSidebarQuery(''); setSidebarHidden(false);
  const channel: RpcChannel = { isOpen: true, onPush: () => () => {}, onStatus: () => () => {}, async call<T>(method: string, params?: Record<string, unknown>): Promise<T> {
    if (method === 'workspace.list') return { workspaces: [{ id: 'a', title: 'alpha', index: 0 }, { id: 'b', title: 'beta', index: 1 }, { id: 'c', title: 'gamma', index: 2 }] } as T;
    if (method === 'surface.list') return { surfaces: params?.workspace_id === 'a' ? [surface('a1', 0), surface('a2', 1), surface('a3', 2)] : [surface(`${params?.workspace_id}1`, 0)] } as T;
    return {} as T;
  } };
  const session = new TerminalSession(channel), workspaces = new WorkspaceStore(channel);
  await workspaces.refresh();
  machine = { mode: 'live', computer: { id: 'mac' }, channel, session, workspaces } as unknown as Machine;
});
afterEach(() => { machine.session.dispose(); machine.workspaces.dispose(); });

describe('commands follow the sidebar', () => {
  it('walks workspaces in sidebar order: pinned first, then the computer’s order', () => {
    mockPinned = ['c'];
    machine.session.setTarget({ workspaceId: 'c', surfaceId: 'c1' });
    expect(runDesktopCommand(machine, { kind: 'workspace', step: 1 })).toBe(true);
    expect(mockOpen).toHaveBeenLastCalledWith(machine, 'a', 'a1');
    machine.session.setTarget({ workspaceId: 'c', surfaceId: 'c1' });
    runDesktopCommand(machine, { kind: 'workspace', step: -1 });
    expect(mockOpen).toHaveBeenLastCalledWith(machine, 'b', 'b1');
  });

  it('skips workspaces the sidebar filter hides', () => {
    setSidebarQuery('gam');
    machine.session.setTarget({ workspaceId: 'a', surfaceId: 'a1' });
    runDesktopCommand(machine, { kind: 'workspace', step: 1 });
    expect(mockOpen).toHaveBeenLastCalledWith(machine, 'c', 'c1');
  });

  it('numbers terminals as the sidebar and the tabs list them', () => {
    machine.session.setTarget({ workspaceId: 'a', surfaceId: 'a1' });
    runDesktopCommand(machine, { kind: 'terminal', index: 1 });
    expect(mockOpen).toHaveBeenLastCalledWith(machine, 'a', 'a2');
    runDesktopCommand(machine, { kind: 'terminal', index: -1 });
    expect(mockOpen).toHaveBeenLastCalledWith(machine, 'a', 'a3');
  });
});

describe('menu-bar commands', () => {
  it('closes the terminal on the terminal page, and hides the window with nothing to close', () => {
    const seen: DesktopCommand[] = [];
    const stop = onDesktopCommand((command) => seen.push(command));
    machine.session.setTarget({ workspaceId: 'a', surfaceId: 'a1' });
    runDesktopCommand(machine, { kind: 'close' }, { pathname: '/terminal', shell: true });
    expect(seen).toEqual([{ kind: 'close' }]);
    expect(mockCloseWindow).not.toHaveBeenCalled();
    runDesktopCommand(machine, { kind: 'close' }, { pathname: '/settings', shell: true });
    expect(mockCloseWindow).toHaveBeenCalledTimes(1);
    machine.session.setTarget(null);
    runDesktopCommand(machine, { kind: 'close' }, { pathname: '/terminal', shell: true });
    expect(mockCloseWindow).toHaveBeenCalledTimes(2);
    expect(seen).toHaveLength(1);
    stop();
  });

  it('asks the sidebar for a new workspace, or the workspace list without one', () => {
    const seen: DesktopCommand[] = [];
    const stop = onDesktopCommand((command) => seen.push(command));
    runDesktopCommand(machine, { kind: 'newWorkspace' }, { pathname: '/terminal', shell: true });
    expect(mockNavigate).not.toHaveBeenCalled();
    runDesktopCommand(machine, { kind: 'newWorkspace' }, { pathname: '/terminal', shell: false });
    expect(mockNavigate).toHaveBeenCalledWith('/');
    expect(seen).toEqual([{ kind: 'newWorkspace' }, { kind: 'newWorkspace' }]);
    stop();
  });

  it('shows and hides the sidebar', () => {
    runDesktopCommand(machine, { kind: 'sidebar' });
    expect(sidebarState().hidden).toBe(true);
    runDesktopCommand(machine, { kind: 'sidebar' });
    expect(sidebarState().hidden).toBe(false);
  });
});

describe('useDesktopShortcuts', () => {
  let dom: { window: Window & typeof globalThis };
  let container: HTMLDivElement;
  type Root = { render(children: ReactNode): void; unmount(): void };
  let root: Root;
  beforeAll(() => {
    const { JSDOM } = jest.requireActual('jsdom');
    dom = new JSDOM('<!doctype html><html><body></body></html>');
    for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'KeyboardEvent']) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: (dom.window as unknown as Record<string, unknown>)[key] });
  });
  afterAll(() => dom.window.close());
  beforeEach(async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div'); document.body.appendChild(container);
    root = jest.requireActual('react-dom/client').createRoot(container);
    function Shortcuts() { useDesktopShortcuts(machine, true, '/terminal'); useDesktopMenu(machine, '/terminal', true); return null; }
    await act(async () => root.render(<Shortcuts />));
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
  const press = (init: KeyboardEventInit) => {
    const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  };

  it('lets the keys the Mac menu shows go to the menu, which then runs them once', () => {
    expect(press({ key: '=', metaKey: true })).toBe(false);
    expect(mockZoom).not.toHaveBeenCalled();
    act(() => mockMenuListener!('zoom-in'));
    expect(mockZoom).toHaveBeenCalledTimes(1);
    expect(mockZoom).toHaveBeenCalledWith(1);
  });

  it('keeps the shortcuts that have no menu item', () => {
    machine.session.setTarget({ workspaceId: 'a', surfaceId: 'a1' });
    expect(press({ key: '2', code: 'Digit2', metaKey: true })).toBe(true);
    expect(mockOpen).toHaveBeenLastCalledWith(machine, 'a', 'a2');
  });

  it('ignores menu ids it does not know', () => {
    act(() => mockMenuListener!('check-update'));
    expect(mockZoom).not.toHaveBeenCalled();
    expect(mockNavigate).not.toHaveBeenCalled();
  });
});

describe('useDesktopMenu before pairing', () => {
  let dom: { window: Window & typeof globalThis };
  let container: HTMLDivElement;
  type Root = { render(children: ReactNode): void; unmount(): void };
  let root: Root;
  beforeAll(() => {
    const { JSDOM } = jest.requireActual('jsdom');
    dom = new JSDOM('<!doctype html><html><body></body></html>');
    for (const key of ['window', 'document', 'navigator', 'HTMLElement']) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: (dom.window as unknown as Record<string, unknown>)[key] });
  });
  afterAll(() => dom.window.close());

  it('still closes the window and toggles the sidebar with no computer; the rest do nothing', async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div'); document.body.appendChild(container);
    root = jest.requireActual('react-dom/client').createRoot(container);
    function Menu() { useDesktopMenu(null, '/pair', false); return null; }
    await act(async () => root.render(<Menu />));
    act(() => mockMenuListener!('close-terminal'));
    expect(mockCloseWindow).toHaveBeenCalledTimes(1);
    act(() => mockMenuListener!('toggle-sidebar'));
    expect(sidebarState().hidden).toBe(true);
    for (const id of ['settings', 'find', 'new-terminal', 'new-workspace', 'zoom-in']) act(() => mockMenuListener!(id));
    expect(mockNavigate).not.toHaveBeenCalled();
    expect(mockZoom).not.toHaveBeenCalled();
    await act(async () => root.unmount());
    expect(mockMenuListener).toBeNull();
    container.remove();
  });
});
