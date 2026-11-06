import { act, createRef, type ReactNode } from 'react';

import TerminalInputView from '../../../modules/terminal-input/src/TerminalInputView.web';
import type { TerminalInputHandle, TerminalInputProps } from '../../../modules/terminal-input';

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
