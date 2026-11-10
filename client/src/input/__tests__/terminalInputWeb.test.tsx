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
  expect(sent).toEqual(['hello', 'tab', 'up', 'alt-left', 'shift-tab', 'ctrl-c', 'ctrl-r', 'backspace', 'delete', 'escape', 'f5', 'enter']);
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
