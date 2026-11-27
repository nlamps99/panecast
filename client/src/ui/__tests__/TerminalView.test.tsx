import { act, useSyncExternalStore, type ReactNode } from 'react';
import type { PushFrame } from '../../protocol/frames';
import { TerminalSession, type RpcChannel } from '../../session/terminalSession';
import { readingAnchor } from '../../session/readingPosition';
import { TerminalView } from '../TerminalView';
import { RpcCallError } from '../../protocol/connection';
import { KeyBar } from '../KeyBar';
import { setPrefs } from '../../state/prefs';

type NativeProps = { testID?: string; children?: ReactNode; data?: unknown[]; renderItem?: (args: { item: unknown; index: number }) => ReactNode; ListFooterComponent?: ReactNode; [key: string]: unknown };
const mockNative = new Map<string, NativeProps>();
/** Every render of a terminal line's outer Text, with its props. */
const mockLineRenders: NativeProps[] = [];
const mockScrollToOffset = jest.fn();
const mockScrollTo = jest.fn();
let mockWrap = true;
let mockReadOnly = false;
let mockShowKeys = false;
let mockOS = 'ios';
let mockCompact = false;
let mockFontSize = 13;
let mockZoom: number | null = null;
type MockPan = { enabled?: boolean; onActivate?: () => void; onUpdate?: (event: { changeY: number }) => void; onDeactivate?: (event: { canceled: boolean; velocityY: number }) => void };
let mockPan: MockPan = {};
type MockPinch = { onActivate?: () => void; onDeactivate?: (event: { scale: number }) => void };
let mockPinch: MockPinch = {};
let mockPlaceholder: { text: string | null; action: { label: string; onPress: () => void } | null } = { text: null, action: null };

jest.mock('react-native', () => {
  // A host adapter keeps the real TerminalView, session and history behavior
  // under test while exposing native layout/scroll callbacks to a DOM harness.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require('react') as typeof import('react');
  const host = (name: string) => React.forwardRef(function NativeTestHost(props: NativeProps, ref) {
    if (props.testID) mockNative.set(props.testID, props);
    if (typeof props.accessibilityLabel === 'string') mockNative.set(props.accessibilityLabel, props);
    if (name === 'Text' && (props.dataSet as { terminalLine?: string } | undefined)?.terminalLine) mockLineRenders.push(props);
    const node = React.useRef<HTMLDivElement>(null);
    React.useImperativeHandle(ref, () => ({ scrollToOffset: mockScrollToOffset, scrollTo: mockScrollTo, getScrollableNode: () => node.current, focus: () => {} }));
    const children = name === 'FlatList'
      ? [...(props.data ?? []).map((item, index) => React.createElement(React.Fragment, { key: index }, props.renderItem?.({ item, index }))), React.createElement(React.Fragment, { key: 'footer' }, props.ListFooterComponent)]
      : props.children;
    return React.createElement(name === 'Text' ? 'span' : 'div', { ref: node, 'data-testid': props.testID, 'data-native': name }, children);
  });
  return { View: host('View'), Text: host('Text'), TextInput: host('TextInput'), Pressable: host('Pressable'), ScrollView: host('ScrollView'), FlatList: host('FlatList'), Platform: { get OS() { return mockOS; } },
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1, absoluteFill: {} } };
});
jest.mock('react-native-gesture-handler', () => ({ usePinchGesture: (config: MockPinch) => { mockPinch = config; return {}; }, useNativeGesture: () => ({}),
  usePanGesture: (config: MockPan) => { mockPan = config; return {}; }, useSimultaneousGestures: () => ({}),
  GestureDetector: ({ children }: { children: ReactNode }) => children }));
jest.mock('../../state/prefs', () => ({ usePrefs: () => ({ terminalWrap: mockWrap, keyHaptics: false, extraKeyRow: true, desktopFontZoom: mockZoom }), setPrefs: jest.fn(), clampFontSize: (value: number) => value }));
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
/** Keys that reached the terminal, through batched `surface.input` or single `surface.send_key`. */
const sentKeys = (channel: Channel) => channel.rpc.mock.calls.flatMap(([method, params]) => method === 'surface.send_key' ? [params?.key]
  : method === 'surface.input' ? ((params?.items ?? []) as { key?: string }[]).filter((item) => item.key).map((item) => item.key) : []);

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
  mockOS = 'ios'; mockCompact = false; mockWrap = true; mockReadOnly = false; mockShowKeys = false; mockNative.clear(); mockScrollToOffset.mockClear(); mockScrollTo.mockClear();
  mockPan = {}; mockPlaceholder = { text: null, action: null }; mockLineRenders.length = 0; mockFontSize = 13; mockZoom = null;
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  channel = new Channel(); session = new TerminalSession(channel);
});
afterEach(async () => { await act(async () => root.unmount()); session.dispose(); container.remove(); });
afterAll(() => dom.window.close());
function Harness() {
  const state = useSyncExternalStore(session.subscribe, session.getState, session.getState);
  return <><TerminalView session={session} state={state} fontSize={mockFontSize} onFontSizeChange={() => {}} placeholder={mockPlaceholder.text} placeholderAction={mockPlaceholder.action} onTap={() => {}} readOnly={mockReadOnly} compact={mockCompact} />{mockShowKeys ? <KeyBar session={session} /> : null}</>;
}
function callback(id: string, name: string, event: unknown) { (mockNative.get(id)?.[name] as (event: unknown) => void)(event); }
function scroll(offset: number, content = 2000) { return { nativeEvent: { contentOffset: { x: 0, y: offset }, contentSize: { width: 390, height: content }, layoutMeasurement: { width: 390, height: 480 } } }; }
async function mount(rows = Array.from({ length: 120 }, (_, index) => `line ${index}`), cursor = { x: 0, y: 0 }) {
  channel.rows = rows;
  await act(async () => {
    session.setTarget({ workspaceId: 'cmux-workspace', surfaceId: 'cmux-surface' });
    channel.push({ type: 'screen.full', surfaceId: 'cmux-surface', rev: 1, rows, cols: 120, rowsCount: rows.length, cursor });
    root.render(<Harness />);
  });
  await act(async () => {
    callback('terminal-output', 'onLayout', { nativeEvent: { layout: { width: 390, height: 520 } } });
    callback('terminal-viewport', 'onLayout', { nativeEvent: { layout: { width: 390, height: 480 } } });
  });
}

/** Waits past the pause that ends a wheel gesture. */
async function wheelEnd() { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 200)); }); }
async function wheel(deltaY: number, options = {}) {
  const event = new dom.window.WheelEvent('wheel', { deltaY, bubbles: true, cancelable: true, ...options });
  await act(async () => { container.querySelector('[data-testid="terminal-output-list"]')!.dispatchEvent(event); });
  return event;
}
it('loads short-screen history on a desktop wheel gesture, with natural direction and no drag callback', async () => {
  mockOS = 'web'; await mount(['short screen']);
  expect((await wheel(-80)).defaultPrevented).toBe(true);
  expect(session.getState().browse?.olderRows).toHaveLength(200);
  await wheel(-80);
  expect(mockScrollToOffset).toHaveBeenLastCalledWith({ offset: 80, animated: false });
  await act(async () => channel.push({ type: 'screen.full', surfaceId: 'cmux-surface', rev: 2, rows: ['new output'], cols: 80, rowsCount: 1, cursor: { x: 0, y: 0 } }));
  expect(session.getState().browse?.frozenRows).toEqual(['short screen']);
  // Back at the bottom: live again once the gesture ends there.
  await wheel(1000); expect(session.getState().browse).not.toBeNull();
  await wheelEnd(); expect(session.getState().browse).toBeNull();
});
it('normalizes line wheels and leaves horizontal scrolling and pinch zoom to WebKit', async () => {
  mockOS = 'web'; await mount();
  await wheel(-3, { deltaMode: 1 });
  expect(mockScrollToOffset).toHaveBeenLastCalledWith({ offset: 51, animated: false });
  mockScrollToOffset.mockClear();
  expect((await wheel(-1, { deltaX: 20 })).defaultPrevented).toBe(false);
  expect((await wheel(-1, { ctrlKey: true })).defaultPrevented).toBe(false);
  expect(mockScrollToOffset).not.toHaveBeenCalled();
});

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
  expect(sentKeys(channel)).toEqual(['ctrl-up']);
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
  expect(sentKeys(channel)).toEqual(['ctrl-up']);
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
    return { rows: page === 1 ? Array.from({ length: 500 }, (_, i) => `old ${i}`) : ['old'], anchor_rows: channel.rows, next_cursor: page === 1 ? 'expired' : null };
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
  await act(async () => callback('terminal-output-list', 'onScrollEndDrag', scroll(0)));
  expect(session.getState().browse).toBeNull();
});
it('floats phone history status over the terminal only while browsing', async () => {
  mockCompact = true;
  await mount();
  expect(container.textContent).not.toContain('搜索 · 复制输出');
  expect(container.textContent).not.toContain('向上滑动查看历史');
  expect(container.querySelector('[data-testid="terminal-history-status"]')).toBeNull();
  await act(async () => callback('terminal-output-list', 'onScroll', scroll(100)));
  const status = container.querySelector('[data-testid="terminal-history-status"]');
  expect(status?.textContent).toContain('行历史');
  expect(status?.closest('[data-testid="terminal-floating-status"]')).not.toBeNull();
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
/** A Claude-like session record: item N is "reply number N"; the live screen shows the newest ones. */
const recordItem = (n: number) => ({ id: `item-${n}`, type: 'agentMessage', text: `reply number ${n} with some words`, sequence: n });
const recordPage = (from: number, to: number, cursor: string | null) => ({ available: true, provider: 'claude', conversation_id: 'c', generation: 'g', revision: `r${to}`,
  active: false, items: Array.from({ length: to - from }, (_, i) => recordItem(from + i)), next_cursor: cursor });
const recordScreen = (from: number, to: number) => [...Array.from({ length: to - from }, (_, i) => `⏺ reply number ${from + i} with some words`), '❯ ', '  ? for shortcuts'];
const plainRows = (rows: readonly string[]) => rows.map((row) => row.replace(/\u001b\[[0-9;]*m/g, ''));
const scrolls = () => channel.rpc.mock.calls.filter(([method]) => method === 'terminal.scroll').map(([, params]) => params?.delta_lines);
function serveRecord() {
  channel.rpc.mockImplementation(async (method, params) => {
    if (method === 'terminal.replay') return application;
    if (method === 'terminal.conversation') return params?.cursor === 'older' ? recordPage(0, 80, null) : recordPage(80, 160, 'older');
    return {};
  });
}

it.each([true, false])('reads a full-screen program\'s history from its session record without ever scrolling it (wrapped=%s)', async (wrap) => {
  mockWrap = wrap;
  serveRecord();
  await mount(recordScreen(150, 160));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  // The newest page is read ahead while the live screen is shown.
  expect(channel.rpc.mock.calls.filter(([method]) => method === 'terminal.conversation')).toHaveLength(1);
  await act(async () => {
    callback('terminal-output-list', 'onScrollBeginDrag', scroll(60, 803));
    callback('terminal-output-list', 'onMomentumScrollBegin', undefined);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  const browse = session.getState().browse!;
  expect(browse.kind).toBe('application');
  const older = plainRows(browse.olderRows).filter(Boolean);
  // Items 150-159 are on the live screen; the record continues right above them, down to item 0.
  expect(older.at(-1)).toBe('⏺ reply number 149 with some words');
  expect(older.some((row) => row.includes('reply number 150'))).toBe(false);
  expect(older[0]).toBe('⏺ reply number 0 with some words');
  expect(older).toHaveLength(150);
  expect(browse.exhausted).toBe(true);
  expect(container.querySelector('[data-testid="terminal-history-status"]')?.textContent).toContain('会话记录');
  // Back at the bottom: live again, and the program was never touched.
  await act(async () => callback('terminal-output-list', 'onScroll', scroll(0, 8000)));
  await act(async () => callback('terminal-output-list', 'onMomentumScrollEnd', scroll(0, 8000)));
  expect(session.getState().browse).toBeNull();
  expect(scrolls()).toEqual([]);
});

it('expands a shortened tool output when its "点按展开" line is tapped', async () => {
  const tool = { id: 'tool', type: 'toolExecution', tool: 'Bash', command: 'ls', aggregatedOutput: Array.from({ length: 20 }, (_, i) => `file ${i}`).join('\n'), sequence: 120 };
  channel.rpc.mockImplementation(async (method) => {
    if (method === 'terminal.replay') return application;
    if (method === 'terminal.conversation') { const page = recordPage(80, 160, null); return { ...page, items: [...page.items.slice(0, 40), tool, ...page.items.slice(40)] }; }
    return {};
  });
  await mount(recordScreen(150, 160));
  await act(async () => { callback('terminal-output-list', 'onScrollBeginDrag', scroll(60, 803)); await new Promise((resolve) => setTimeout(resolve, 0)); });
  const list = () => mockNative.get('terminal-output-list') as { data: { plain: string }[]; renderItem: (info: { item: unknown; index: number }) => { props: { onPress: () => void } } };
  const index = list().data.findIndex((line) => line.plain.includes('点按展开'));
  expect(index).toBeGreaterThanOrEqual(0);
  await act(async () => list().renderItem({ item: list().data[index], index }).props.onPress());
  expect(list().data.some((line) => line.plain.includes('点按展开'))).toBe(false);
  expect(list().data.some((line) => line.plain.trim() === 'file 19')).toBe(true);
  expect(scrolls()).toEqual([]);
});

it('passes the wheel straight to a full-screen program that has no session record', async () => {
  mockOS = 'web';
  channel.rpc.mockImplementation(async (method) => method === 'terminal.replay' ? application : method === 'terminal.conversation' ? { available: false, provider: 'terminal' } : {});
  await mount(Array.from({ length: 47 }, (_, i) => `vim ${i}`));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  expect(session.getState().applicationScroll?.record).toBe(false);
  await wheel(-80); await wheel(-80);
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 100)); });
  // 17-px rows: one unit per 51 px of wheel travel, the remainder carried over.
  expect(scrolls()).toEqual([1, 2]);
  expect(session.getState().browse).toBeNull();
  expect(container.querySelector('[data-testid="terminal-application-scroll"]')?.textContent).toContain('滚轮直接滚动程序');
});

it('retries a failed record read on the next wheel gesture, not on every event', async () => {
  mockOS = 'web';
  serveRecord();
  await mount(recordScreen(150, 160));
  await session.inspectScrollMode();
  await wheel(-40);
  expect(session.getState().browse?.kind).toBe('application');
  const fail = () => (session as unknown as { update(patch: object): void }).update({ browse: { ...session.getState().browse!, loading: false, error: '暂时读不到会话记录' } });
  const retry = jest.spyOn(session, 'loadOlder');
  // The read fails while the same gesture continues: no retry yet.
  await act(async () => fail());
  await wheel(-40);
  expect(retry.mock.calls.filter(([options]) => options?.retry)).toHaveLength(0);
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 200)); });
  await wheel(-40);
  expect(retry.mock.calls.filter(([options]) => options?.retry)).toHaveLength(1);
  retry.mockRestore();
});

it('ends record browsing when an explicit key is sent, without scrolling the program', async () => {
  serveRecord();
  await mount(recordScreen(150, 160));
  await act(async () => callback('terminal-output-list', 'onScrollBeginDrag', scroll(60, 803)));
  expect(session.getState().browse?.kind).toBe('application');
  await act(async () => session.sendKey({ name: 'up' }));
  expect(session.getState().browse).toBeNull();
  expect(scrolls()).toEqual([]);
  expect(sentKeys(channel)).toHaveLength(1);
});

it('lets a read-only viewer read the record but never scroll a program', async () => {
  mockReadOnly = true; mockOS = 'web';
  serveRecord();
  await mount(recordScreen(150, 160));
  await act(async () => callback('terminal-output-list', 'onScrollBeginDrag', scroll(60, 803)));
  expect(session.getState().browse?.kind).toBe('application');
  await act(async () => session.resumeLive());
  channel.rpc.mockImplementation(async (method) => method === 'terminal.replay' ? application : method === 'terminal.conversation' ? { available: false } : {});
  (session as unknown as { recordHead: unknown }).recordHead = null;
  await act(async () => { await session.prepareRecord(true); });
  await wheel(-200);
  expect(container.querySelector('[data-testid="terminal-application-older"]')).toBeNull();
  expect(scrolls()).toEqual([]);
});

async function programOnPhone(rows: string[]) {
  mockCompact = true;
  channel.rpc.mockImplementation(async (method) => method === 'terminal.replay' ? application : method === 'terminal.conversation' ? { available: false, provider: 'terminal' } : {});
  await mount(rows);
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  expect(session.getState().applicationScroll?.record).toBe(false);
}
async function drag(...changes: number[]) {
  await act(async () => { mockPan.onActivate?.(); for (const changeY of changes) mockPan.onUpdate?.({ changeY }); });
  await act(async () => { mockPan.onDeactivate?.({ canceled: false, velocityY: 0 }); await new Promise((resolve) => setTimeout(resolve, 150)); });
}

it('scrolls a full-screen program without a session record when the phone terminal is dragged', async () => {
  await programOnPhone(Array.from({ length: 20 }, (_, i) => `htop ${i}`));
  expect(mockPan.enabled).toBe(true);
  // Finger down reveals older output: 17-px rows, one unit per 51 px, one unit per request.
  await drag(30, 30, 50);
  expect(scrolls()).toEqual([1, 1]);
  await drag(-60);
  expect(scrolls()).toEqual([1, 1, -1]);
  expect(session.getState().browse).toBeNull();
  // The ↑↓ buttons float on the phone too, without the desktop's wheel sentence.
  const rail = container.querySelector('[data-testid="terminal-application-scroll"]');
  expect(rail?.closest('[data-testid="terminal-floating-status"]')).toBeNull();
  expect(container.textContent).not.toContain('滚轮直接滚动程序');
  await act(async () => (mockNative.get('terminal-application-older')?.onPress as () => void)());
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 100)); });
  expect(scrolls()).toEqual([1, 1, -1, 3]);
});

it('lets a wrapped program screen taller than the phone scroll locally before scrolling the program', async () => {
  await programOnPhone(Array.from({ length: 47 }, (_, i) => `vim ${i}`));
  // 47 rows × 17 px against a 480-px viewport: about 319 px of local range.
  await act(async () => callback('terminal-output-list', 'onScroll', scroll(150, 47 * 17)));
  await drag(60, 60);
  expect(scrolls()).toEqual([]);
  await act(async () => callback('terminal-output-list', 'onScroll', scroll(47 * 17 - 480, 47 * 17)));
  await drag(60);
  expect(scrolls()).toEqual([1]);
});

it('never scrolls a program from a read-only phone, and says so when dragged', async () => {
  mockReadOnly = true;
  await programOnPhone(Array.from({ length: 20 }, (_, i) => `htop ${i}`));
  expect(mockPan.enabled).toBe(false);
  expect(container.querySelector('[data-testid="terminal-application-older"]')).toBeNull();
  await act(async () => callback('terminal-output-list', 'onScrollBeginDrag', scroll(0, 340)));
  expect(container.querySelector('[data-testid="terminal-program-notice"]')?.textContent).toContain('只读');
  expect(scrolls()).toEqual([]);
});

it('keeps phone drags local for ordinary shells', async () => {
  mockCompact = true;
  await mount();
  expect(mockPan.enabled).toBe(false);
});

it('shows a retry button under the placeholder of an empty terminal', async () => {
  const retry = jest.fn();
  mockPlaceholder = { text: '打不开这个终端：超时', action: { label: '重试', onPress: retry } };
  channel.rows = [];
  await act(async () => { session.setTarget({ workspaceId: 'cmux-workspace', surfaceId: 'cmux-surface' }); root.render(<Harness />); });
  await act(async () => callback('terminal-output', 'onLayout', { nativeEvent: { layout: { width: 390, height: 520 } } }));
  expect(container.querySelector('[data-testid="terminal-placeholder"]')?.textContent).toContain('打不开这个终端');
  await act(async () => (mockNative.get('terminal-placeholder-action')?.onPress as () => void)());
  expect(retry).toHaveBeenCalledTimes(1);
});

type ListProps = { data: PositionedLineLike[]; renderItem: (info: { item: unknown; index: number }) => { props: Record<string, unknown> }; keyExtractor: (item: unknown, index: number) => string };
type PositionedLineLike = { plain: string; rowFromBottom: number; segmentFromBottom: number };
const outputList = () => mockNative.get('terminal-output-list') as unknown as ListProps;
const lineProps = (index: number) => outputList().renderItem({ item: outputList().data[index], index }).props;
const pause = (ms: number) => act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });

it('keeps runs of spaces and the text cursor on web terminal lines', async () => {
  mockOS = 'web'; await mount(['  indented    two columns', '│ box │', '$ ']);
  const line = mockLineRenders.at(-1)!;
  // react-native-web's one-line Text is `white-space: nowrap`, which collapses spaces and adds "…".
  expect(line.style).toMatchObject({ whiteSpace: 'pre', textOverflow: 'clip' });
  // `onPress` would give the line a pointing hand; a click handler keeps the text cursor and selection.
  expect(line.onPress).toBeUndefined();
  expect(line.onClick).toEqual(expect.any(Function));
  expect(line.selectable).toBe(true);
});
it('leaves phone terminal lines as they were', async () => {
  await mount(['  indented']);
  const line = mockLineRenders.at(-1)!;
  expect(line.style).not.toHaveProperty('whiteSpace');
  expect(line.onPress).toEqual(expect.any(Function));
});

it('redraws only the line a screen diff changed, keyed by its place from the bottom', async () => {
  await mount();
  mockLineRenders.length = 0;
  await act(async () => channel.push({ type: 'screen.diff', surfaceId: 'cmux-surface', rev: 2, ops: [{ op: 'row', y: 100, text: 'changed' }] }));
  expect(outputList().data[19].plain).toBe('changed');
  expect(mockLineRenders).toHaveLength(1);
  expect(outputList().keyExtractor(outputList().data[19], 19)).toBe('19:0');
});

it('draws the cursor on a blank last row instead of trimming that row', async () => {
  await mount(['$ cat', 'typed', ''], { x: 0, y: 2 });
  expect(outputList().data[0]).toMatchObject({ plain: '', rowFromBottom: 0 });
  expect(lineProps(0).cursor).toBe(0);
});

it('draws a newly opened terminal at the last measured width, without flashing the placeholder', async () => {
  await mount();
  mockPlaceholder = { text: '正在打开终端…', action: null };
  // Switching terminals mounts a new view; nothing has measured it yet.
  await act(async () => root.render(<Harness key="next" />));
  expect(outputList().data.length).toBeGreaterThan(0);
  expect(container.querySelector('[data-testid="terminal-placeholder"]')).toBeNull();
});

describe('desktop text size', () => {
  const grid = (columns: number) => ({ render_grid: { active_screen: 'primary', columns, rows: 40 } });
  const drawnSize = () => (mockLineRenders.at(-1)?.style as { fontSize: number }).fontSize;
  beforeEach(() => { (window as { panecastDesktop?: unknown }).panecastDesktop = { version: 1 }; });
  afterEach(() => { delete (window as { panecastDesktop?: unknown }).panecastDesktop; });

  it('fits the computer\'s columns into the window until a size is chosen, and fits again after ⌘0', async () => {
    channel.rpc.mockImplementation(async (method) => method === 'terminal.replay' ? grid(60) : {});
    await mount(['x'.repeat(60), '$ ']);
    await pause(0);
    // 60 columns in 390 points: 10 pt, under the 13 pt preference.
    expect(drawnSize()).toBe(10);
    expect((mockNative.get('terminal-horizontal-scroll')?.contentContainerStyle as { width: number }).width).toBe(390);
    // ⌘= / ⌘- fixed a size: it wins over the fit, and the wider terminal scrolls sideways.
    mockZoom = 12;
    await act(async () => root.render(<Harness />));
    expect(drawnSize()).toBe(12);
    expect((mockNative.get('terminal-horizontal-scroll')?.contentContainerStyle as { width: number }).width).toBeGreaterThan(390);
    mockZoom = null;
    await act(async () => root.render(<Harness />));
    expect(drawnSize()).toBe(10);
  });

  it('fits a terminal opened again from its last column count, before the computer answers', async () => {
    channel.rpc.mockImplementation(async (method) => method === 'terminal.replay' ? grid(60) : {});
    await mount(['x'.repeat(60), '$ ']);
    await pause(0);
    channel.rpc.mockImplementation(async (method) => method === 'terminal.replay' ? new Promise(() => {}) : {});
    await act(async () => { session.setTarget({ workspaceId: 'cmux-workspace', surfaceId: 'other' }); root.render(<Harness key="other" />); });
    await act(async () => {
      session.setTarget({ workspaceId: 'cmux-workspace', surfaceId: 'cmux-surface' });
      channel.push({ type: 'screen.full', surfaceId: 'cmux-surface', rev: 5, rows: ['x'.repeat(60), '$ '], cols: 60, rowsCount: 2, cursor: { x: 0, y: 0 } });
      root.render(<Harness key="again" />);
    });
    expect(session.getState().terminalColumns ?? null).toBeNull();
    expect(drawnSize()).toBe(10);
  });

  it('pinches the size it shows into the desktop zoom, not the phone preference', async () => {
    channel.rpc.mockImplementation(async (method) => method === 'terminal.replay' ? grid(60) : {});
    await mount(['x'.repeat(60), '$ ']);
    await pause(0);
    (setPrefs as jest.Mock).mockClear();
    await act(async () => { mockPinch.onActivate?.(); mockPinch.onDeactivate?.({ scale: 1.2 }); });
    expect(setPrefs).toHaveBeenCalledWith({ desktopFontZoom: 12 });
  });

  it('never changes the size on phones', async () => {
    delete (window as { panecastDesktop?: unknown }).panecastDesktop;
    mockZoom = 18;
    channel.rpc.mockImplementation(async (method) => method === 'terminal.replay' ? grid(200) : {});
    await mount(['x'.repeat(200)]);
    await pause(0);
    expect(drawnSize()).toBe(13);
  });
});

it('keeps loaded history when a drag overshoots the bottom and turns back', async () => {
  await mount();
  await act(async () => callback('terminal-output-list', 'onScrollBeginDrag', scroll(400)));
  await act(async () => callback('terminal-output-list', 'onScroll', scroll(1400)));
  expect(session.getState().browse?.olderRows).toHaveLength(200);
  // Past the bottom (the rubber band) and back up, in the same drag.
  await act(async () => callback('terminal-output-list', 'onScroll', scroll(-30)));
  await act(async () => callback('terminal-output-list', 'onScroll', scroll(300)));
  await act(async () => callback('terminal-output-list', 'onScrollEndDrag', scroll(300)));
  expect(session.getState().browse?.olderRows).toHaveLength(200);
  // A drag that ends at the bottom returns to the live screen.
  await act(async () => callback('terminal-output-list', 'onScrollBeginDrag', scroll(300)));
  await act(async () => callback('terminal-output-list', 'onScroll', scroll(0)));
  expect(session.getState().browse).not.toBeNull();
  await act(async () => callback('terminal-output-list', 'onScrollEndDrag', scroll(0)));
  expect(session.getState().browse).toBeNull();
});
it('keeps loaded history when the wheel overshoots the bottom and turns back', async () => {
  mockOS = 'web'; await mount();
  await wheel(-400);
  expect(session.getState().browse?.olderRows).toHaveLength(200);
  await wheel(2000); await wheel(-100); await wheelEnd();
  expect(session.getState().browse?.olderRows).toHaveLength(200);
  await wheel(500); await wheelEnd();
  expect(session.getState().browse).toBeNull();
});

it('cancels only the vertical wheel it scrolls, and keeps the inverted list from blocking sideways scrolling', async () => {
  mockOS = 'web'; mockWrap = false; await mount(['x'.repeat(300), ...Array.from({ length: 120 }, (_, index) => `line ${index}`)]);
  const node = container.querySelector('[data-testid="terminal-output-list"]')!;
  // Stands in for react-native-web's inverted-list handler, which cancels every wheel event.
  const listOwn = jest.fn((event: Event) => event.preventDefault());
  node.addEventListener('wheel', listOwn);
  const line = node.querySelector('span')!;
  const sideways = new dom.window.WheelEvent('wheel', { deltaX: 40, deltaY: 3, bubbles: true, cancelable: true });
  const shifted = new dom.window.WheelEvent('wheel', { deltaY: 40, shiftKey: true, bubbles: true, cancelable: true });
  await act(async () => { line.dispatchEvent(sideways); line.dispatchEvent(shifted); });
  expect(sideways.defaultPrevented).toBe(false); expect(shifted.defaultPrevented).toBe(false);
  expect(listOwn).not.toHaveBeenCalled();
  expect(mockScrollToOffset).not.toHaveBeenCalledWith(expect.objectContaining({ offset: expect.any(Number) }));
  const vertical = new dom.window.WheelEvent('wheel', { deltaY: -40, bubbles: true, cancelable: true });
  await act(async () => { line.dispatchEvent(vertical); });
  expect(vertical.defaultPrevented).toBe(true);
  expect(listOwn).not.toHaveBeenCalled();
  expect(mockScrollToOffset).toHaveBeenLastCalledWith({ offset: 40, animated: false });
});

it('checks the scroll method again when a full-screen program starts or quits', async () => {
  let program = false;
  channel.rpc.mockImplementation(async (method) => method === 'terminal.replay' ? (program ? application : {}) : method === 'terminal.conversation' ? { available: false } : {});
  const shell = Array.from({ length: 47 }, (_, i) => `$ shell output ${i}`);
  await mount(shell);
  await pause(0);
  expect(session.getState().applicationScroll ?? null).toBeNull();
  program = true;
  await act(async () => channel.push({ type: 'screen.full', surfaceId: 'cmux-surface', rev: 2, rows: Array.from({ length: 47 }, (_, i) => `~ vim buffer ${i}`), cols: 120, rowsCount: 47, cursor: { x: 0, y: 0 } }));
  await pause(400);
  expect(session.getState().applicationScroll).toMatchObject({ columns: 156, rows: 47 });
  program = false;
  await act(async () => channel.push({ type: 'screen.full', surfaceId: 'cmux-surface', rev: 3, rows: shell, cols: 120, rowsCount: 47, cursor: { x: 0, y: 0 } }));
  await pause(900);
  expect(session.getState().applicationScroll ?? null).toBeNull();
});
it('leaves scrolling output alone instead of asking the computer again', async () => {
  const shell = Array.from({ length: 47 }, (_, i) => `$ shell output ${i}`);
  await mount(shell);
  await pause(0);
  const replays = () => channel.rpc.mock.calls.filter(([method]) => method === 'terminal.replay').length;
  const before = replays();
  await act(async () => channel.push({ type: 'screen.full', surfaceId: 'cmux-surface', rev: 2, rows: [...shell.slice(3), 'a', 'b', 'c'], cols: 120, rowsCount: 47, cursor: { x: 0, y: 0 } }));
  await pause(400);
  expect(replays()).toBe(before);
});

it('remembers the reading place when web scrolling stops, as drag-end events never fire there', async () => {
  mockOS = 'web';
  const saveReading = jest.fn();
  session.dispose(); session = new TerminalSession(channel, { saveReading });
  await mount();
  await act(async () => callback('terminal-output-list', 'onScroll', scroll(400)));
  expect(session.getState().browse).not.toBeNull();
  await pause(200);
  saveReading.mockClear();
  await act(async () => callback('terminal-output-list', 'onScroll', scroll(510)));
  expect(saveReading).not.toHaveBeenCalled();
  await pause(200);
  expect(saveReading).toHaveBeenCalledTimes(1);
  expect(saveReading).toHaveBeenLastCalledWith(expect.objectContaining({ surfaceId: 'cmux-surface' }), expect.objectContaining({ rowFromBottom: 30 }));
});

it('searches from a find bar over the desktop terminal, marking and revealing each match', async () => {
  mockOS = 'web';
  await mount();
  expect(mockNative.get('搜索和复制终端输出')).toBeUndefined();
  await act(async () => (mockNative.get('在终端输出中搜索')?.onPress as () => void)());
  expect(container.querySelector('[data-testid="terminal-find-bar"]')).not.toBeNull();
  expect(session.getState().browse).not.toBeNull();
  mockScrollToOffset.mockClear();
  const input = () => mockNative.get('terminal-find-input')!;
  await act(async () => (input().onChangeText as (text: string) => void)('LINE 5'));
  // "line 5" and "line 50"–"line 59", case-insensitive; the newest is selected first.
  const count = () => container.querySelector('[data-testid="terminal-find-count"]')?.textContent;
  expect(count()).toBe('11/11');
  const newest = outputList().data.findIndex((line) => line.plain === 'line 59');
  expect(lineProps(newest)).toMatchObject({ findNeedle: 'line 5', findCurrent: true });
  expect(lineProps(newest + 1)).toMatchObject({ findNeedle: 'line 5', findCurrent: false });
  expect(lineProps(0).findNeedle).toBeUndefined();
  // Line 59 sits 60 lines up: scrolled to the middle of the terminal.
  expect(mockScrollToOffset).toHaveBeenLastCalledWith({ offset: 60 * 17 - (480 - 17) / 2, animated: false });
  const key = (name: string, shiftKey = false) => act(async () => (input().onKeyPress as (event: unknown) => void)({ nativeEvent: { key: name, shiftKey }, preventDefault() {} }));
  await key('Enter');
  expect(count()).toBe('10/11');
  expect(lineProps(newest + 1).findCurrent).toBe(true);
  await key('Enter', true);
  expect(count()).toBe('11/11');
  await key('Escape');
  expect(container.querySelector('[data-testid="terminal-find-bar"]')).toBeNull();
  expect(lineProps(newest).findNeedle).toBeUndefined();
  // The match is further up: closing keeps it in view.
  expect(session.getState().browse).not.toBeNull();
});
it('keeps the search sheet on phones', async () => {
  mockCompact = true; await mount();
  expect(mockNative.get('在终端输出中搜索')).toBeUndefined();
  expect(container.querySelector('[data-testid="terminal-find-bar"]')).toBeNull();
});

it('follows the list to its new node when wrapping is switched', async () => {
  mockOS = 'web'; await mount();
  mockWrap = false;
  await act(async () => root.render(<Harness />));
  const node = container.querySelector('[data-testid="terminal-output-list"]')!;
  expect(node.closest('[data-native="ScrollView"]')).not.toBeNull();
  mockScrollToOffset.mockClear();
  const event = new dom.window.WheelEvent('wheel', { deltaY: -40, bubbles: true, cancelable: true });
  await act(async () => { node.querySelector('span')!.dispatchEvent(event); });
  expect(event.defaultPrevented).toBe(true);
  expect(mockScrollToOffset).toHaveBeenLastCalledWith({ offset: 40, animated: false });
});
