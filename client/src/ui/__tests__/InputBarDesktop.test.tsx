import { act, createRef, type ReactNode } from 'react';
import type { TerminalInputHandle } from '../../../modules/terminal-input';
import type { TerminalSession } from '../../session/terminalSession';
import { getPrefs, setPrefs, usePrefs } from '../../state/prefs';
import { InputBar } from '../InputBar';

let mockDesktop = true;
let mockComputerId = 0;
const mockChannel = {
  status: { state: 'open' } as { state: string }, listeners: new Set<() => void>(),
  get isOpen() { return this.status.state === 'open'; },
  onStatus(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; },
  set(state: string) { this.status = { state }; for (const listener of this.listeners) listener(); },
};
jest.mock('react-native', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require('react') as typeof import('react');
  const View = ({ children }: { children?: ReactNode }) => React.createElement('div', null, children);
  const Text = ({ children }: { children?: ReactNode }) => React.createElement('span', null, children);
  const Pressable = ({ children, onPress, disabled }: { children?: ReactNode; onPress?: () => void; disabled?: boolean }) => React.createElement('button', { onClick: onPress, disabled }, children);
  return { View, Text, Pressable, Platform: { OS: 'web' }, ActionSheetIOS: {}, ActivityIndicator: () => null,
    StyleSheet: { create: (styles: unknown) => styles, flatten: (style: unknown) => style, hairlineWidth: 1 } };
});
jest.mock('expo-symbols', () => ({ SymbolView: () => null }));
jest.mock('../../../modules/terminal-input', () => ({
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  TerminalInputView: require('../../../modules/terminal-input/src/TerminalInputView.web').default,
}));
jest.mock('../../platform/desktop', () => ({ desktopBridge: () => mockDesktop ? { version: 1 } : null, desktopOnWindows: () => false }));
jest.mock('../../platform/alert', () => ({ Alert: {} }));
jest.mock('../../input/attachImage', () => ({}));
jest.mock('../../state/hooks', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { useSyncExternalStore } = require('react') as typeof import('react');
  return {
    useMachine: () => ({ channel: mockChannel, computer: { id: `input-test-${mockComputerId}` } }),
    useConnectionStatus: (source: typeof mockChannel) => useSyncExternalStore((listener: () => void) => source.onStatus(listener), () => source.status, () => source.status),
  };
});
jest.mock('../KeyBar', () => ({ KeyBar: () => 'PHONE_KEYS', useKeyboardProfileEditor: () => ({ button: 'PHONE_PROFILE', editor: null }) }));
let mockKeyboard = false;
jest.mock('../useKeyboardVisible', () => ({ useKeyboardVisible: () => mockKeyboard }));
let mockInsert: ((text: string) => void) | null = null;
jest.mock('../InputLibrarySheet', () => ({ InputLibrarySheet: ({ onInsert }: { onInsert: (text: string) => void }) => { mockInsert = onInsert; return null; } }));
jest.mock('../ExpandedComposer', () => ({ ExpandedComposer: () => null }));
jest.mock('../Sheet', () => ({ useSheet: () => ({ visible: false, open: jest.fn(), close: (then?: () => void) => then?.(), onClosed: jest.fn() }) }));

let dom: { window: Window & typeof globalThis };
let container: HTMLDivElement;
type Root = { render(children: ReactNode): void; unmount(): void };
let root: Root;
let createRoot: (container: Element) => Root;
const inputRef = createRef<TerminalInputHandle>();
let mockSessionState = { target: { workspaceId: 'workspace', surfaceId: 'surface' }, input: { busy: false, error: null as string | null } };
const sessionListeners = new Set<() => void>();
const session = {
  getState: () => mockSessionState,
  subscribe: (listener: () => void) => { sessionListeners.add(listener); return () => { sessionListeners.delete(listener); }; },
  isConnected: true, sendText: jest.fn(), sendKey: jest.fn(),
  submitLine: jest.fn(async () => ({ status: 'sent', message: null })),
  pasteText: jest.fn(async () => ({ status: 'sent', message: '已送达终端' })),
} as unknown as TerminalSession;
function setInput(input: { busy: boolean; error: string | null }) {
  mockSessionState = { ...mockSessionState, input };
  for (const listener of sessionListeners) listener();
}
function Harness({ chat = false }: { chat?: boolean }) {
  const { desktopInputMode, inputMode } = usePrefs();
  return <InputBar key={`${chat}:${mockDesktop ? desktopInputMode : inputMode}`} session={session} disabled={false} error={null} inputRef={inputRef} presentation={chat ? 'chat' : 'terminal'} />;
}
beforeAll(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { JSDOM } = require('jsdom') as { JSDOM: new (html: string) => typeof dom };
  dom = new JSDOM('<!doctype html><html><body></body></html>');
  for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLTextAreaElement', 'KeyboardEvent']) {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: (dom.window as unknown as Record<string, unknown>)[name] });
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  createRoot = (require('react-dom/client') as { createRoot: typeof createRoot }).createRoot;
});
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mockDesktop = true; mockComputerId++; jest.clearAllMocks(); mockChannel.set('open'); setInput({ busy: false, error: null });
  setPrefs({ inputMode: 'line', desktopInputMode: 'live' });
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
afterAll(() => dom.window.close());
async function key(key: string, options = {}) {
  const event = new KeyboardEvent('keydown', { key, ...options, bubbles: true, cancelable: true });
  await act(async () => { container.querySelector('textarea')!.dispatchEvent(event); });
  return event;
}
async function text(value: string) {
  const textarea = container.querySelector('textarea')!;
  await act(async () => { textarea.value = value; textarea.dispatchEvent(new dom.window.Event('input', { bubbles: true })); });
}
async function click(label: string) {
  const button = Array.from(container.querySelectorAll('button')).find(button => button.textContent === label)!;
  await act(async () => button.click());
}

it('opens desktop terminals in direct input and sends physical keys without phone buttons', async () => {
  await act(async () => root.render(<Harness />));
  expect(container.textContent).not.toContain('PHONE_KEYS');
  expect(container.querySelector('textarea')!.disabled).toBe(false);
  await text('pwd');
  expect(session.sendText).toHaveBeenCalledWith('pwd');
  expect((await key('Tab')).defaultPrevented).toBe(true);
  await key('c', { ctrlKey: true }); await key('Enter');
  expect(session.sendKey).toHaveBeenNthCalledWith(1, { name: 'tab' });
  expect(session.sendKey).toHaveBeenNthCalledWith(2, { name: 'c', modifiers: ['ctrl'] });
  expect(session.sendKey).toHaveBeenNthCalledWith(3, { name: 'enter' });
  expect(session.submitLine).not.toHaveBeenCalled();
});

it('leaves Command-W and Command-Q to the Mac window menu while terminal input is focused', async () => {
  await act(async () => root.render(<Harness />));
  expect((await key('w', { metaKey: true })).defaultPrevented).toBe(false);
  expect((await key('q', { metaKey: true })).defaultPrevented).toBe(false);
  expect(session.sendKey).not.toHaveBeenCalled();
});

it('preserves a command draft across direct-input switches and keeps chat editing local', async () => {
  await act(async () => root.render(<Harness />));
  await click('编辑命令'); await text('未发送的命令');
  expect(session.sendText).not.toHaveBeenCalled();
  await click('直接输入'); await click('编辑命令');
  expect(container.querySelector('textarea')!.value).toBe('未发送的命令');
  expect(session.sendText).not.toHaveBeenCalled();
  await act(async () => root.render(<Harness chat />));
  expect(container.textContent).not.toContain('PHONE_KEYS');
  expect((await key('ArrowUp')).defaultPrevented).toBe(false);
  expect((await key('Enter', { shiftKey: true })).defaultPrevented).toBe(false);
  expect(session.sendKey).not.toHaveBeenCalled();
  await key('Enter');
  expect(session.submitLine).toHaveBeenCalledWith('未发送的命令');
});

it('retains the phone key row and command mode outside the desktop client', async () => {
  mockDesktop = false;
  await act(async () => root.render(<Harness />));
  expect(container.textContent).toContain('PHONE_KEYS');
  await text('手机草稿');
  expect(session.sendText).not.toHaveBeenCalled();
  await key('Enter');
  expect(session.submitLine).toHaveBeenCalledWith('手机草稿');
});

it('puts the key profile in the shortcut row and hides that row while the phone keyboard is up', async () => {
  mockDesktop = false;
  await act(async () => root.render(<Harness />));
  expect(container.textContent).toContain('常用输入 · 最近输入');
  expect(container.textContent).toContain('PHONE_PROFILE');
  mockKeyboard = true;
  try {
    await act(async () => root.render(<Harness key="typing" />));
    expect(container.textContent).not.toContain('常用输入');
    expect(container.textContent).not.toContain('PHONE_PROFILE');
    expect(container.textContent).toContain('PHONE_KEYS');
  } finally { mockKeyboard = false; }
});

it('keeps the phone command input editable while a line is on its way, then clears only what was sent', async () => {
  mockDesktop = false;
  let deliver!: (receipt: { status: 'sent'; message: string }) => void;
  (session.submitLine as jest.Mock).mockImplementationOnce(() => new Promise(resolve => { deliver = resolve; }));
  await act(async () => root.render(<Harness />));
  await text('ls -la');
  await key('Enter');
  const textarea = container.querySelector('textarea')!;
  expect(textarea.disabled).toBe(false);
  expect(container.textContent).toContain('正在发送…');
  await key('Enter');
  expect(session.submitLine).toHaveBeenCalledTimes(1);
  await text('ls -la && pwd');
  await act(async () => deliver({ status: 'sent', message: '已送达终端' }));
  expect(textarea.value).toBe(' && pwd');
  expect(container.textContent).toContain('已送达终端');
});

it('cuts the sent line only after pinyin typed during the send is chosen, so it is not sent twice', async () => {
  mockDesktop = false;
  let deliver!: (receipt: { status: 'sent'; message: string }) => void;
  (session.submitLine as jest.Mock).mockImplementationOnce(() => new Promise(resolve => { deliver = resolve; }));
  await act(async () => root.render(<Harness />));
  await text('git status');
  await key('Enter');
  const textarea = container.querySelector('textarea')!;
  const composition = (type: string) => act(async () => { textarea.dispatchEvent(new dom.window.CompositionEvent(type, { bubbles: true })); });
  await composition('compositionstart');
  await text('git statusnihao');
  await act(async () => deliver({ status: 'sent', message: '已送达终端' }));
  expect(textarea.value).toBe('git statusnihao');
  textarea.value = 'git status你好';
  await composition('compositionend');
  expect(textarea.value).toBe('你好');
  await key('Enter');
  expect((session.submitLine as jest.Mock).mock.calls.at(-1)).toEqual(['你好']);
});

it('labels an empty phone command line as Enter and leaves out the shortcut row on a short screen', async () => {
  mockDesktop = false;
  await act(async () => root.render(<Harness />));
  expect(Array.from(container.querySelectorAll('button')).some(button => button.textContent === '回车')).toBe(true);
  await text('pwd');
  expect(Array.from(container.querySelectorAll('button')).some(button => button.textContent === '发送')).toBe(true);
  await act(async () => root.render(<InputBar session={session} disabled={false} error={null} inputRef={inputRef} compactHeight />));
  expect(container.textContent).not.toContain('常用输入');
  expect(container.textContent).toContain('PHONE_KEYS');
});

it('follows the connection: offline after a drop, back to normal after the reconnect', async () => {
  mockDesktop = false;
  await act(async () => root.render(<Harness />));
  expect(container.textContent).not.toContain('离线');
  await act(async () => mockChannel.set('waiting'));
  expect(container.textContent).toContain('离线 · 可以继续写草稿');
  await act(async () => mockChannel.set('open'));
  expect(container.textContent).not.toContain('离线');
});

it('pastes multi-line text and Shift+Enter whole, with typed keys as the fallback', async () => {
  await act(async () => root.render(<Harness />));
  await text('echo one\necho two');
  expect(session.sendText).not.toHaveBeenCalled();
  expect(session.pasteText).toHaveBeenCalledWith('echo one\necho two', [
    { kind: 'text', text: 'echo one' }, { kind: 'key', key: { name: 'enter' } }, { kind: 'text', text: 'echo two' }]);
  expect((await key('Enter', { shiftKey: true })).defaultPrevented).toBe(true);
  expect(session.pasteText).toHaveBeenLastCalledWith('\n', [{ kind: 'key', key: { name: 'enter', modifiers: ['shift'] } }]);
  expect(session.sendKey).not.toHaveBeenCalled();
});

it('keeps a phone keyboard Return committed as a line break an Enter key', async () => {
  mockDesktop = false;
  setPrefs({ inputMode: 'live' });
  await act(async () => root.render(<Harness />));
  await text('ls\n');
  expect(session.pasteText).not.toHaveBeenCalled();
  expect(session.sendText).toHaveBeenCalledWith('ls');
  expect(session.sendKey).toHaveBeenCalledWith({ name: 'enter' });
});

it('sends the Mac line-editing shortcuts in direct input', async () => {
  await act(async () => root.render(<Harness />));
  await key('ArrowLeft', { metaKey: true }); await key('Backspace', { altKey: true }); await key('ArrowRight', { altKey: true });
  expect((session.sendKey as jest.Mock).mock.calls).toEqual([[{ name: 'a', modifiers: ['ctrl'] }], [{ name: 'w', modifiers: ['ctrl'] }], [{ name: 'f', modifiers: ['alt'] }]]);
});

it('sends Esc and Ctrl+C from an empty command line and the chat box, but edits a draft normally', async () => {
  await act(async () => root.render(<Harness />));
  await click('编辑命令');
  expect((await key('Escape')).defaultPrevented).toBe(true);
  expect((await key('c', { ctrlKey: true })).defaultPrevented).toBe(true);
  expect((session.sendKey as jest.Mock).mock.calls).toEqual([[{ name: 'escape' }], [{ name: 'c', modifiers: ['ctrl'] }]]);
  await text('draft');
  expect((await key('Escape')).defaultPrevented).toBe(false);
  expect((await key('c', { metaKey: true })).defaultPrevented).toBe(false);
  expect(session.sendKey).toHaveBeenCalledTimes(2);
  await act(async () => root.render(<Harness chat />));
  await text('');
  expect((await key('Escape')).defaultPrevented).toBe(true);
  expect(session.sendKey).toHaveBeenLastCalledWith({ name: 'escape' });
});

it('keeps the field focusable but read-only while offline, without letting Tab leave the terminal', async () => {
  await act(async () => root.render(<Harness />));
  await act(async () => mockChannel.set('waiting'));
  const textarea = container.querySelector('textarea')!;
  expect(textarea.disabled).toBe(false);
  expect(textarea.readOnly).toBe(true);
  expect((await key('Tab')).defaultPrevented).toBe(true);
  expect(session.sendKey).not.toHaveBeenCalled();
  expect(container.textContent).toContain('还没有连上电脑');
  await act(async () => mockChannel.set('open'));
  expect(textarea.readOnly).toBe(false);
});

it('says a send is taking long instead of going quiet', async () => {
  await act(async () => root.render(<Harness />));
  expect(container.textContent).not.toContain('发送中…');
  await act(async () => setInput({ busy: true, error: null }));
  expect(container.textContent).toContain('发送中…');
  await act(async () => setInput({ busy: false, error: '输入没有确认送达：电脑没有响应' }));
  expect(container.textContent).not.toContain('发送中…');
});

it('opens a snippet in the command line to edit, then goes back to direct input once it is sent, keeping the saved mode', async () => {
  await act(async () => root.render(<Harness />));
  await act(async () => mockInsert!('git status'));
  expect(session.sendText).not.toHaveBeenCalled();
  const field = () => container.querySelector('textarea')!;
  expect(field().value).toBe('git status');
  expect(container.textContent).toContain('直接输入');
  expect(getPrefs().desktopInputMode).toBe('live');
  await text('git status -s');
  await key('Enter');
  expect(session.submitLine).toHaveBeenCalledWith('git status -s');
  // Back in direct input: typing goes straight to the terminal again.
  expect(container.textContent).toContain('编辑命令');
  await text('q');
  expect(session.sendText).toHaveBeenCalledWith('q');
  expect(getPrefs().desktopInputMode).toBe('live');
});

it('dismisses a snippet with Esc on its emptied line or the mode switch, without sending Escape', async () => {
  await act(async () => root.render(<Harness />));
  await act(async () => mockInsert!('rm -rf build'));
  await text('');
  expect((await key('Escape')).defaultPrevented).toBe(true);
  expect(session.sendKey).not.toHaveBeenCalled();
  expect(container.textContent).toContain('编辑命令');
  await act(async () => mockInsert!('npm test'));
  await click('直接输入');
  expect(container.textContent).toContain('编辑命令');
  expect(getPrefs().desktopInputMode).toBe('live');
  expect(session.submitLine).not.toHaveBeenCalled();
});

it('keeps a phone snippet in the command line the same way', async () => {
  mockDesktop = false;
  setPrefs({ inputMode: 'live' });
  await act(async () => root.render(<Harness />));
  await act(async () => mockInsert!('ls -la'));
  expect(container.querySelector('textarea')!.value).toBe('ls -la');
  await key('Enter');
  expect(session.submitLine).toHaveBeenCalledWith('ls -la');
  expect(getPrefs().inputMode).toBe('live');
  await text('x');
  expect(session.sendText).toHaveBeenCalledWith('x');
});
