import { act, useSyncExternalStore, type ReactNode } from 'react';
import type { PushFrame } from '../../protocol/frames';
import { TerminalSession, type RpcChannel } from '../../session/terminalSession';
import { readingAnchor } from '../../session/readingPosition';
import { TerminalView } from '../TerminalView';
import { RpcCallError } from '../../protocol/connection';
import { KeyBar } from '../KeyBar';

type NativeProps = { testID?: string; children?: ReactNode; data?: unknown[]; renderItem?: (args: { item: unknown; index: number }) => ReactNode; ListFooterComponent?: ReactNode; [key: string]: unknown };
const mockNative = new Map<string, NativeProps>();
const mockScrollToOffset = jest.fn();
const mockScrollTo = jest.fn();
let mockWrap = true;
let mockReadOnly = false;
let mockShowKeys = false;

jest.mock('react-native', () => {
  // A host adapter keeps the real TerminalView, session and history behavior
  // under test while exposing native layout/scroll callbacks to a DOM harness.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require('react') as typeof import('react');
  const host = (name: string) => React.forwardRef(function NativeTestHost(props: NativeProps, ref) {
    if (props.testID) mockNative.set(props.testID, props);
    if (typeof props.accessibilityLabel === 'string') mockNative.set(props.accessibilityLabel, props);
    React.useImperativeHandle(ref, () => ({ scrollToOffset: mockScrollToOffset, scrollTo: mockScrollTo }));
    const children = name === 'FlatList'
      ? [...(props.data ?? []).map((item, index) => React.createElement(React.Fragment, { key: index }, props.renderItem?.({ item, index }))), React.createElement(React.Fragment, { key: 'footer' }, props.ListFooterComponent)]
      : props.children;
    return React.createElement(name === 'Text' ? 'span' : 'div', { 'data-testid': props.testID, 'data-native': name }, children);
  });
  return { View: host('View'), Text: host('Text'), Pressable: host('Pressable'), ScrollView: host('ScrollView'), FlatList: host('FlatList'), Platform: { OS: 'ios' },
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1, absoluteFill: {} } };
});
jest.mock('react-native-gesture-handler', () => ({ usePinchGesture: () => ({}), useNativeGesture: () => ({}),
  GestureDetector: ({ children }: { children: ReactNode }) => children }));
jest.mock('../../state/prefs', () => ({ usePrefs: () => ({ terminalWrap: mockWrap, keyHaptics: false, extraKeyRow: true }), setPrefs: jest.fn(), clampFontSize: (value: number) => value }));
jest.mock('expo-haptics', () => ({}));
jest.mock('../../state/hooks', () => ({ useMachine: () => ({ computer: { id: 'test' } }) }));
jest.mock('../../input/keyboardProfiles', () => {
  const actual = jest.requireActual('../../input/keyboardProfiles');
  return { ...actual, useKeyboardProfiles: () => ({ loaded: true, profiles: actual.DEFAULT_KEYBOARD_PROFILES, defaults: {}, projects: {}, error: null }) };
});
jest.mock('../KeyboardProfileEditor', () => ({ KeyboardProfileEditor: () => null }));
jest.mock('../Sheet', () => ({ useSheet: () => ({ visible: false, open: jest.fn(), close: jest.fn(), onClosed: jest.fn() }) }));
jest.mock('../TerminalTools', () => ({ TerminalTools: () => null }));

class Channel implements RpcChannel {
  isOpen = true;
  rows: string[] = [];
  listeners = new Set<(frame: PushFrame) => void>();
  rpc = jest.fn(async (method: string, _params?: Record<string, unknown>): Promise<unknown> => method === 'surface.history'
    ? { rows: Array.from({ length: 200 }, (_, index) => `older ${index}`), anchor_rows: this.rows, next_cursor: null } : {});
  async call<T>(method: string, params?: Record<string, unknown>): Promise<T> { return await this.rpc(method, params) as T; }
  onPush(listener: (frame: PushFrame) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  onStatus() { return () => {}; }
  push(frame: PushFrame) { for (const listener of this.listeners) listener(frame); }
}

let container: HTMLDivElement;
type TestRoot = { render(node: ReactNode): void; unmount(): void };
let root: TestRoot;
let createRoot: (container: Element) => TestRoot;
let dom: { window: Window & typeof globalThis };
let channel: Channel;
let session: TerminalSession;
beforeAll(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { JSDOM } = require('jsdom') as { JSDOM: new (html: string) => typeof dom };
  dom = new JSDOM('<!doctype html><html><body></body></html>');
  for (const name of ['window', 'document', 'navigator', 'HTMLElement']) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: (dom.window as unknown as Record<string, unknown>)[name] });
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  createRoot = (require('react-dom/client') as { createRoot: typeof createRoot }).createRoot;
});
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mockWrap = true; mockReadOnly = false; mockShowKeys = false; mockNative.clear(); mockScrollToOffset.mockClear(); mockScrollTo.mockClear();
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  channel = new Channel(); session = new TerminalSession(channel);
});
afterEach(async () => { await act(async () => root.unmount()); session.dispose(); container.remove(); });
afterAll(() => dom.window.close());
function Harness() {
  const state = useSyncExternalStore(session.subscribe, session.getState, session.getState);
  return <><TerminalView session={session} state={state} fontSize={13} onFontSizeChange={() => {}} placeholder={null} onTap={() => {}} readOnly={mockReadOnly} />{mockShowKeys ? <KeyBar session={session} /> : null}</>;
}
function callback(id: string, name: string, event: unknown) { (mockNative.get(id)?.[name] as (event: unknown) => void)(event); }
function scroll(offset: number, content = 2000) { return { nativeEvent: { contentOffset: { x: 0, y: offset }, contentSize: { width: 390, height: content }, layoutMeasurement: { width: 390, height: 480 } } }; }
async function mount(rows = Array.from({ length: 120 }, (_, index) => `line ${index}`)) {
  channel.rows = rows;
  await act(async () => {
    session.setTarget({ workspaceId: 'cmux-workspace', surfaceId: 'cmux-surface' });
    channel.push({ type: 'screen.full', surfaceId: 'cmux-surface', rev: 1, rows, cols: 120, rowsCount: rows.length, cursor: { x: 0, y: 0 } });
    root.render(<Harness />);
  });
  await act(async () => {
    callback('terminal-output', 'onLayout', { nativeEvent: { layout: { width: 390, height: 520 } } });
    callback('terminal-viewport', 'onLayout', { nativeEvent: { layout: { width: 390, height: 480 } } });
  });
}

it('leaves wrapped terminal output in a standalone vertical list, without an outer scroll or press responder', async () => {
  await mount();
  const list = container.querySelector('[data-testid="terminal-output-list"]')!;
  expect(list.parentElement?.closest('[data-native="ScrollView"]')).toBeNull();
  expect(list.parentElement?.closest('[data-native="Pressable"]')).toBeNull();
  expect(mockNative.get('terminal-output-list')?.style).toMatchObject({ flex: 1, minHeight: 0 });
});
it('constrains the raw-mode vertical list to the actual viewport height while keeping horizontal overflow', async () => {
  mockWrap = false; await mount(['x'.repeat(200), ...Array.from({ length: 120 }, (_, index) => String(index))]);
  expect(mockNative.get('terminal-raw-frame')?.style).toMatchObject({ height: 480 });
  const dimensions = mockNative.get('terminal-horizontal-scroll')?.contentContainerStyle as { height: number; width: number };
  expect(dimensions.height).toBe(480); expect(dimensions.width).toBeGreaterThan(390);
  expect(mockNative.get('terminal-output-list')?.inverted).toBe(true);
  await act(async () => callback('terminal-viewport', 'onLayout', { nativeEvent: { layout: { width: 390, height: 260 } } }));
  expect(mockNative.get('terminal-raw-frame')?.style).toMatchObject({ height: 260 });
});
it('requests history on the first drag reaching the old edge and keeps that output frozen during live updates', async () => {
  await mount();
  await act(async () => callback('terminal-output-list', 'onScroll', scroll(1400)));
  expect(channel.rpc).toHaveBeenCalledWith('surface.history', expect.objectContaining({ workspace_id: 'cmux-workspace', surface_id: 'cmux-surface' }));
  expect(session.getState().browse?.olderRows).toHaveLength(200);
  await act(async () => channel.push({ type: 'screen.diff', surfaceId: 'cmux-surface', rev: 2, ops: [{ op: 'row', y: 119, text: 'new live output' }] }));
  const lines = mockNative.get('terminal-output-list')?.data as { plain: string }[];
  expect(lines.some((line) => line.plain === 'older 0')).toBe(true);
  expect(lines.some((line) => line.plain === 'new live output')).toBe(false);
});

it.each([false, true])('shows Ctrl + Up after browsing history and sends it once (sticky Ctrl=%s)', async (stickyCtrl) => {
  mockShowKeys = true;
  await mount();
  await act(async () => callback('terminal-output-list', 'onScroll', scroll(1400)));
  expect(session.getState().browse).not.toBeNull();
  mockScrollToOffset.mockClear();
  if (stickyCtrl) await act(async () => callback('Ctrl', 'onPressIn', undefined));
  await act(async () => {
    callback('发送 Ctrl 上箭头', 'onPressIn', undefined);
    callback('发送 Ctrl 上箭头', 'onPressOut', undefined);
    callback('发送 Ctrl 上箭头', 'onPress', undefined);
  });
  expect(channel.rpc.mock.calls.filter(([method]) => method === 'surface.send_key').map(([, params]) => params?.key)).toEqual(['ctrl-up']);
  expect(session.getState().browse).toBeNull();
  expect(mockScrollToOffset).toHaveBeenCalledWith({ offset: 0, animated: false });
  // The previous offset can be delivered before native applies the jump.
  await act(async () => callback('terminal-output-list', 'onScroll', scroll(1400)));
  expect(session.getState().browse).toBeNull();
  await act(async () => channel.push({ type: 'screen.full', surfaceId: 'cmux-surface', rev: 2, rows: ['previous input selected'], cols: 120, rowsCount: 1, cursor: { x: 0, y: 0 } }));
  expect((mockNative.get('terminal-output-list')?.data as { plain: string }[])[0].plain).toBe('previous input selected');
});

it('reveals the prompt when Ctrl + Up is tapped from the top of a live application screen', async () => {
  mockShowKeys = true;
  channel.rpc.mockImplementation(async (method) => method === 'terminal.replay'
    ? { render_grid: { active_screen: 'alternate', columns: 156, rows: 47, modes: [{ ansi: false, code: 1000, on: true }] } } : {});
  await mount();
  await act(async () => callback('terminal-output-list', 'onScroll', scroll(1400)));
  expect(session.getState().browse).toBeNull();
  mockScrollToOffset.mockClear();
  await act(async () => callback('发送 Ctrl 上箭头', 'onPress', undefined));
  expect(mockScrollToOffset).toHaveBeenCalledWith({ offset: 0, animated: false });
  expect(channel.rpc.mock.calls.filter(([method]) => method === 'surface.send_key').map(([, params]) => params?.key)).toEqual(['ctrl-up']);
});
it('loads scrollback for a short visible cmux screen even before a positive scroll offset is possible', async () => {
  await mount(['short screen', '$']);
  await act(async () => callback('terminal-output-list', 'onScrollBeginDrag', scroll(0, 34)));
  await act(async () => callback('terminal-output-list', 'onScroll', scroll(0, 3400)));
  expect(session.getState().browse?.olderRows).toHaveLength(200);
  expect((mockNative.get('terminal-output-list')?.data as unknown[]).length).toBeGreaterThan(200);
});
it('ignores the temporary zero offset emitted while native layout restores an older reading position', async () => {
  const rows = Array.from({ length: 120 }, (_, index) => `line ${index}`);
  session.dispose();
  session = new TerminalSession(channel, { readingForTarget: () => ({ anchor: readingAnchor(rows, 60), rowFromBottom: 59, segmentFromBottom: 0, horizontalColumns: 0 }) });
  await mount(rows);
  expect(mockScrollToOffset).toHaveBeenCalledWith(expect.objectContaining({ offset: expect.any(Number), animated: false }));
  await act(async () => callback('terminal-output-list', 'onScroll', scroll(0)));
  expect(session.getState().browse).not.toBeNull();
  await act(async () => callback('terminal-output-list', 'onScrollBeginDrag', scroll(1000)));
  await act(async () => callback('terminal-output-list', 'onScroll', scroll(1000)));
  expect(session.getState().browse).not.toBeNull();
});
it('does not fight the current drag when dismissing the keyboard changes the viewport height', async () => {
  mockWrap = false; await mount();
  await act(async () => callback('terminal-output-list', 'onScrollBeginDrag', scroll(0)));
  await act(async () => callback('terminal-output-list', 'onScroll', scroll(400)));
  mockScrollToOffset.mockClear();
  await act(async () => callback('terminal-viewport', 'onLayout', { nativeEvent: { layout: { width: 390, height: 650 } } }));
  expect(mockScrollToOffset).not.toHaveBeenCalled();
  await act(async () => callback('terminal-output-list', 'onScroll', scroll(700)));
  expect(session.getState().browse).not.toBeNull();
});
it('prepares consecutive history pages before scrolling instead of waiting at each boundary', async () => {
  let page = 0;
  channel.rpc.mockImplementation(async (method) => method === 'surface.history'
    ? (++page === 1 ? { rows: ['older 1'], anchor_rows: channel.rows, next_cursor: 'next-page' } : { rows: ['older 0'], next_cursor: null }) : {});
  await mount();
  expect(channel.rpc.mock.calls.filter(([method]) => method === 'surface.history')).toHaveLength(2);
  await act(async () => callback('terminal-output-list', 'onScroll', scroll(1400)));
  await act(async () => callback('terminal-output-list', 'onEndReached', { distanceFromEnd: 0 }));
  expect(session.getState().browse).toMatchObject({ olderRows: ['older 0', 'older 1'], exhausted: true });
  expect(channel.rpc).toHaveBeenLastCalledWith('surface.history', expect.objectContaining({ cursor: 'next-page' }));
});
it('coalesces scroll and boundary callbacks while a history page is in flight', async () => {
  let resolve!: (page: object) => void;
  channel.rpc.mockImplementation(async (method) => method === 'surface.history' ? new Promise((done) => { resolve = done; }) : {});
  await mount();
  await act(async () => {
    callback('terminal-output-list', 'onScroll', scroll(1400));
    callback('terminal-output-list', 'onEndReached', { distanceFromEnd: 0 });
    callback('terminal-output-list', 'onScroll', scroll(1450));
  });
  expect(channel.rpc.mock.calls.filter(([method]) => method === 'surface.history')).toHaveLength(1);
  await act(async () => resolve({ rows: ['old'], anchor_rows: channel.rows, next_cursor: null }));
});
it('keeps history retry visible outside the horizontal content and replaces expired cursors', async () => {
  mockWrap = false;
  let page = 0;
  channel.rpc.mockImplementation(async (method) => {
    if (method !== 'surface.history') return {};
    if (++page === 2) throw new RpcCallError('history_unavailable', '历史快照已过期');
    return { rows: page === 1 ? Array.from({ length: 500 }, (_, i) => `old ${i}`) : ['old'], anchor_rows: channel.rows, next_cursor: page === 1 ? 'expired' : 'fresh' };
  });
  await mount();
  await act(async () => callback('terminal-output-list', 'onScroll', scroll(1400)));
  await act(async () => callback('terminal-output-list', 'onEndReached', { distanceFromEnd: 0 }));
  const retry = container.querySelector('[data-testid="terminal-history-retry"]')!;
  expect(retry).not.toBeNull(); expect(retry.closest('[data-native="ScrollView"]')).toBeNull();
  await act(async () => callback('terminal-history-retry', 'onPress', undefined));
  expect(channel.rpc.mock.calls.filter(([method]) => method === 'surface.history').at(-1)?.[1]?.cursor).toBeUndefined();
  expect(session.getState().browse?.error).toBeNull();
  await act(async () => callback('terminal-output-list', 'onScroll', scroll(0)));
  expect(session.getState().browse?.olderRows).toEqual(['old']);
  await act(async () => callback('terminal-output-list', 'onScrollBeginDrag', scroll(100)));
  await act(async () => callback('terminal-output-list', 'onScroll', scroll(0)));
  expect(session.getState().browse).toBeNull();
});
it('distinguishes a server with no scrollback without requiring repeated manual loads', async () => {
  mockWrap = false;
  channel.rpc.mockImplementation(async (method) => method === 'surface.history' ? { rows: [], anchor_rows: channel.rows, next_cursor: null } : {});
  await mount();
  await act(async () => callback('terminal-output-list', 'onScroll', scroll(100)));
  expect(container.querySelector('[data-testid="terminal-history-status"]')?.textContent).toContain('未提供更早历史');
  expect(session.getState().browse?.exhausted).toBe(true);
});

const application = { render_grid: { active_screen: 'alternate', columns: 156, rows: 47,
  modes: [{ ansi: false, code: 1000, on: true }] } };
const applicationRows = (start: number) => Array.from({ length: 47 }, (_, i) => `history ${start + i}`);

it.each([true, false])('appends application captures without replacing visible cells or stopping native momentum (wrapped=%s)', async (wrap) => {
  mockWrap = wrap;
  let acknowledge!: () => void;
  channel.rpc.mockImplementation(async (method) => {
    if (method === 'terminal.replay') return application;
    if (method === 'terminal.scroll') return new Promise<void>((resolve) => { acknowledge = resolve; });
    return {};
  });
  await mount(applicationRows(1000));
  const shown = () => (mockNative.get('terminal-output-list')?.data as { plain: string }[]).map(line => line.plain);
  const original = shown();
  expect(session.getState().browse).toBeNull();
  await act(async () => {
    callback('terminal-output-list', 'onScrollBeginDrag', scroll(60, 803));
    callback('terminal-output-list', 'onMomentumScrollBegin', undefined);
  });
  expect(session.getState().browse?.kind).toBe('application');
  mockScrollToOffset.mockClear();
  await act(async () => {
    channel.push({ type: 'screen.full', surfaceId: 'cmux-surface', rev: 2, rows: applicationRows(993), cols: 156, rowsCount: 47, cursor: { x: 0, y: 46 } });
    acknowledge();
  });
  expect(shown().slice(0, original.length)).toEqual(original);
  expect(shown()).toHaveLength(original.length + 7);
  expect(mockScrollToOffset).not.toHaveBeenCalled();
  // Filling the runway must continue after layout, even when native hasn't
  // produced another scroll/boundary event yet.
  await act(async () => {
    (mockNative.get('terminal-output-list')?.onContentSizeChange as (w: number, h: number) => void)(390, shown().length * 17 + 4);
  });
  expect(channel.rpc.mock.calls.filter(([method]) => method === 'terminal.scroll')).toHaveLength(2);
  await act(async () => {
    channel.push({ type: 'screen.full', surfaceId: 'cmux-surface', rev: 3, rows: applicationRows(986), cols: 156, rowsCount: 47, cursor: { x: 0, y: 46 } });
    acknowledge();
  });
  expect(shown().slice(0, original.length)).toEqual(original);
  expect(shown()).toHaveLength(original.length + 14);
  expect(mockScrollToOffset).not.toHaveBeenCalled();
  // Reverse through the loaded region without moving the remote program.
  await act(async () => callback('terminal-output-list', 'onScroll', scroll(0, 8000)));
  expect(channel.rpc.mock.calls.filter(([method]) => method === 'terminal.scroll')).toHaveLength(2);
  expect(channel.rpc.mock.calls.some(([method]) => method === 'surface.history')).toBe(false);
});

it('drops application prefetch and restores its viewport when an explicit key is sent', async () => {
  channel.rpc.mockImplementation(async (method, params) => {
    if (method === 'terminal.replay') return application;
    if (method === 'terminal.scroll' && Number(params?.delta_lines) > 0) return new Promise(() => {});
    return {};
  });
  await mount(applicationRows(1000));
  await act(async () => callback('terminal-output-list', 'onScrollBeginDrag', scroll(60, 803)));
  await act(async () => session.sendKey({ name: 'up' }));
  expect(session.getState().browse).toBeNull();
  expect(channel.rpc.mock.calls.filter(([method]) => method === 'terminal.scroll').map(([, params]) => params?.delta_lines)).toEqual([7, -7]);
  expect(channel.rpc.mock.calls.filter(([method]) => method === 'surface.send_key')).toHaveLength(1);
});

it('does not prefetch or send application scroll input for a read-only source', async () => {
  mockReadOnly = true;
  channel.rpc.mockImplementation(async (method) => method === 'terminal.replay' ? application : {});
  await mount();
  expect(session.getState().browse).toBeNull();
  await act(async () => callback('terminal-output-list', 'onScrollBeginDrag', scroll(1520)));
  await act(async () => callback('terminal-output-list', 'onScroll', scroll(1600)));
  expect(container.querySelector('[data-testid="terminal-application-older"]')).toBeNull();
  expect(channel.rpc.mock.calls.some(([method]) => method === 'terminal.scroll')).toBe(false);
});
