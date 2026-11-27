import { act, createRef, type ReactNode } from 'react';

import TerminalInputView from '../../../modules/terminal-input/src/TerminalInputView.web';
import type { TerminalInputHandle, TerminalInputProps } from '../../../modules/terminal-input';
import { terminalHardwareKey } from '../hardwareKeys';
import { encodeKey } from '../../protocol/keys';

jest.mock('react-native', () => ({ StyleSheet: { flatten: (style: unknown) => style } }));

let container: HTMLDivElement;
type TestRoot = { render(children: ReactNode): void; unmount(): void };
let root: TestRoot;
let dom: { window: Window & typeof globalThis };
let createRoot: (container: Element) => TestRoot;
beforeAll(() => {
  // Expo's preset defines its own window, so install the DOM after that setup.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { JSDOM } = require('jsdom') as { JSDOM: new (html: string) => typeof dom };
  dom = new JSDOM('<!doctype html><html><body></body></html>');
  for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLTextAreaElement', 'KeyboardEvent', 'CompositionEvent']) {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: (dom.window as unknown as Record<string, unknown>)[name] });
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  createRoot = (require('react-dom/client') as { createRoot: typeof createRoot }).createRoot;
});
afterAll(() => { dom.window.close(); });
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

async function render(props: Partial<TerminalInputProps> = {}) {
  const ref = createRef<TerminalInputHandle>();
  await act(async () => root.render(<TerminalInputView ref={ref} mode="line" {...props} />));
  return { handle: ref.current!, textarea: container.querySelector('textarea')! };
}

it('loads a multiline draft without sending and lets Return insert a newline in the expanded editor', async () => {
  const onSubmit = jest.fn(), onCommitText = jest.fn();
  const { handle, textarea } = await render({ initialText: '第一行\nsecond', submitOnEnter: false, onSubmit, onCommitText });
  expect((await handle.getState()).text).toBe('第一行\nsecond');
  const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
  await act(async () => { textarea.dispatchEvent(enter); });
  expect(enter.defaultPrevented).toBe(false);
  expect(onSubmit).not.toHaveBeenCalled(); expect(onCommitText).not.toHaveBeenCalled();
});
it('keeps the compact editor Return shortcut, but never submits during IME composition', async () => {
  const onSubmit = jest.fn(); const { handle, textarea } = await render({ initialText: '你好', onSubmit });
  await act(async () => { textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
  expect(onSubmit).toHaveBeenLastCalledWith('你好'); onSubmit.mockClear();
  await act(async () => { textarea.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })); });
  expect((await handle.getState()).composing).toBe(true);
  await act(async () => { textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true })); });
  expect(onSubmit).not.toHaveBeenCalled();
  expect(await handle.applyEdit('你好', 'should not overwrite', 0, 0)).toBe(false);
});
it('applies an indentation edit atomically and refuses to overwrite a newer edit', async () => {
  const { handle } = await render({ initialText: 'line', submitOnEnter: false });
  await act(async () => { expect(await handle.applyEdit('line', '  line', 2, 6)).toBe(true); });
  expect(await handle.getState()).toMatchObject({ text: '  line', selectionStart: 2, selectionEnd: 6 });
  await act(async () => { expect(await handle.applyEdit('line', '', 0, 0)).toBe(false); });
  expect((await handle.getState()).text).toBe('  line');
});

it('maps physical terminal keys once, preserving order and modifiers without moving local focus', async () => {
  const sent: string[] = [];
  const { textarea } = await render({ mode: 'live', onKeyAction: key => sent.push(`duplicate:${key}`),
    onCommitText: text => sent.push(text), onHardwareKey: event => {
      const key = terminalHardwareKey(event);
      if (!key) return false;
      sent.push(encodeKey(key)); return true;
    } });
  textarea.focus();
  textarea.value = 'hello';
  await act(async () => { textarea.dispatchEvent(new dom.window.Event('input', { bubbles: true })); });
  for (const options of [{ key: 'Tab' }, { key: 'ArrowUp' }, { key: 'ArrowLeft', altKey: true },
    { key: 'Tab', shiftKey: true }, { key: 'c', ctrlKey: true }, { key: 'r', ctrlKey: true },
    { key: 'Backspace' }, { key: 'Delete' }, { key: 'Escape' }, { key: 'F5' }, { key: 'Enter' }]) {
    const event = new KeyboardEvent('keydown', { ...options, bubbles: true, cancelable: true });
    await act(async () => { textarea.dispatchEvent(event); });
    expect(event.defaultPrevented).toBe(true);
  }
  // ⌥← moves a word back, as Terminal.app sends it (Esc-b).
  expect(sent).toEqual(['hello', 'tab', 'up', 'alt-b', 'shift-tab', 'ctrl-c', 'ctrl-r', 'backspace', 'delete', 'escape', 'f5', 'enter']);
  expect(document.activeElement).toBe(textarea);
});

it('commits Chinese text once and leaves candidate navigation and confirmation to the input method', async () => {
  const onCommitText = jest.fn(), onHardwareKey = jest.fn(() => true), onKeyAction = jest.fn();
  const { textarea } = await render({ mode: 'live', onCommitText, onHardwareKey, onKeyAction });
  await act(async () => {
    textarea.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    textarea.value = 'ni'; textarea.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    for (const key of ['ArrowDown', 'Enter']) textarea.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  });
  expect(onCommitText).not.toHaveBeenCalled(); expect(onHardwareKey).not.toHaveBeenCalled();
  await act(async () => {
    textarea.value = '你好';
    textarea.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
    textarea.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });
  expect(onCommitText.mock.calls).toEqual([['你好']]); expect(onKeyAction).not.toHaveBeenCalled();
  expect(textarea.value).toBe('');
});

it('keeps Command copy/paste and Option text input local, and lets Shift+Enter edit a draft', async () => {
  const remote = jest.fn(), onKeyAction = jest.fn();
  const onHardwareKey: NonNullable<TerminalInputProps['onHardwareKey']> = event => {
    const key = terminalHardwareKey(event); if (!key) return false; remote(key); return true;
  };
  const { textarea } = await render({ mode: 'live', onHardwareKey, onKeyAction });
  for (const options of [{ key: 'c', metaKey: true }, { key: 'v', metaKey: true }, { key: 'Enter', metaKey: true },
    { key: 'Dead', altKey: true }, { key: 'å', altKey: true }, { key: 'a' }]) {
    const event = new KeyboardEvent('keydown', { ...options, bubbles: true, cancelable: true });
    await act(async () => { textarea.dispatchEvent(event); });
    expect(event.defaultPrevented).toBe(false);
  }
  expect(remote).not.toHaveBeenCalled(); expect(onKeyAction).not.toHaveBeenCalled();
  const onSubmit = jest.fn();
  await act(async () => root.render(<TerminalInputView mode="line" onSubmit={onSubmit} onHardwareKey={onHardwareKey} />));
  for (const options of [{ key: 'ArrowUp' }, { key: 'Tab' }, { key: 'Enter', shiftKey: true }]) {
    const event = new KeyboardEvent('keydown', { ...options, bubbles: true, cancelable: true });
    await act(async () => { textarea.dispatchEvent(event); });
    expect(event.defaultPrevented).toBe(false);
  }
  expect(remote).not.toHaveBeenCalled(); expect(onSubmit).not.toHaveBeenCalled();
});

it('stays focused and read-only when it stops being editable, and takes keys again once it is', async () => {
  const onHardwareKey = jest.fn(() => true), onCommitText = jest.fn();
  const { textarea } = await render({ mode: 'live', editable: false, onHardwareKey, onCommitText });
  textarea.focus();
  expect(textarea.disabled).toBe(false);
  expect(textarea.readOnly).toBe(true);
  expect(document.activeElement).toBe(textarea);
  const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
  await act(async () => { textarea.dispatchEvent(tab); });
  // Asked anyway, so a terminal key does not move focus away while offline.
  expect(onHardwareKey).toHaveBeenCalledTimes(1);
  expect(tab.defaultPrevented).toBe(true);
  await act(async () => root.render(<TerminalInputView mode="live" editable onHardwareKey={onHardwareKey} onCommitText={onCommitText} />));
  expect(textarea.readOnly).toBe(false);
  expect(document.activeElement).toBe(textarea);
});

it('presses a key handed over from elsewhere as if typed in the field, focusing it', async () => {
  const onSubmit = jest.fn(), onKeyAction = jest.fn();
  const { handle, textarea } = await render({ initialText: 'ls', onSubmit, onKeyAction });
  const outside = document.createElement('button'); document.body.appendChild(outside); outside.focus();
  let used = false;
  await act(async () => { used = handle.pressKey!({ key: 'Enter', ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, altGraphKey: false }); });
  expect(used).toBe(true);
  expect(document.activeElement).toBe(textarea);
  expect(onSubmit).toHaveBeenCalledWith('ls');
  expect(handle.pressKey!({ key: 'ArrowLeft', ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, altGraphKey: false })).toBe(false);
  outside.remove();
});

it('composes at the terminal cursor and goes back to its place afterwards', async () => {
  const imeAnchor = jest.fn(() => ({ left: 300, top: 120, height: 17, background: 'rgb(1, 2, 3)' }));
  const onCommitText = jest.fn();
  const { textarea } = await render({ mode: 'live', imeAnchor, onCommitText, fontSize: 15 });
  textarea.getBoundingClientRect = () => ({ left: 20, top: 700, width: 600, height: 36, right: 620, bottom: 736, x: 20, y: 700, toJSON() {} }) as DOMRect;
  const canvas = dom.window.HTMLCanvasElement.prototype as unknown as { getContext: () => unknown };
  canvas.getContext = () => ({ font: '', measureText: (text: string) => ({ width: text.length * 13 }) });
  await act(async () => { textarea.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })); });
  // The cursor cell's top left, in the terminal's text size, one line shown.
  expect(textarea.style.transform).toBe('translate(280px, -580px)');
  expect(textarea.style.fontSize).toBe('13px');
  expect(textarea.style.clipPath).toBe('inset(0px 0px 19px 0px)');
  expect(textarea.style.backgroundColor).toBe('rgb(1, 2, 3)');
  await act(async () => { textarea.value = 'nihao'; textarea.dispatchEvent(new dom.window.Event('input', { bubbles: true })); });
  expect(textarea.style.width).toBe('77px');
  expect(onCommitText).not.toHaveBeenCalled();
  await act(async () => {
    textarea.value = '你好';
    textarea.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
  });
  expect(onCommitText).toHaveBeenCalledWith('你好');
  expect(textarea.style.transform).toBe('');
  expect(textarea.style.width).toBe('');
  expect(textarea.style.fontSize).toBe('15px');
  // Back to the field's own transparent background, not the browser's default.
  expect(textarea.style.backgroundColor).toBe('transparent');
});

it('stays put for line input and when no cursor is shown', async () => {
  const { textarea } = await render({ mode: 'live', imeAnchor: () => null });
  await act(async () => { textarea.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })); });
  expect(textarea.style.transform).toBe('');
  const line = await render({ mode: 'line', imeAnchor: () => ({ left: 1, top: 1, height: 10, background: 'red' }) });
  await act(async () => { line.textarea.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })); });
  expect(line.textarea.style.transform).toBe('');
});
