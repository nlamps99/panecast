import { act, type ReactNode, type RefObject } from 'react';

import type { TerminalInputHandle } from '../../../modules/terminal-input';
import { focusContext, keyFallback, refocusTerminalInput, terminalCursorAnchor, useTerminalKeyFallback, type FocusContext } from '../terminalFocus';
import { decisionKeys, questionKeyFocus } from '../questionKeys';

jest.mock('react-native', () => ({ Platform: { OS: 'web' } }));

const plain = { ctrlKey: false, altKey: false, shiftKey: false, metaKey: false };
const page: FocusContext = { idle: true, editable: false, insideTerminal: false, keyboardFocus: false, modalOpen: false, selection: false };

describe('keyFallback', () => {
  it('types text and presses named and Ctrl keys pressed on the page', () => {
    expect(keyFallback({ ...plain, key: 'a' }, page)).toBe('type');
    expect(keyFallback({ ...plain, key: '你' }, page)).toBe('type');
    expect(keyFallback({ ...plain, key: 'Dead', altKey: true }, page)).toBe('type');
    expect(keyFallback({ ...plain, key: 'Enter' }, page)).toBe('press');
    expect(keyFallback({ ...plain, key: 'Tab' }, page)).toBe('press');
    expect(keyFallback({ ...plain, key: 'F5' }, page)).toBe('press');
    expect(keyFallback({ ...plain, key: 'c', ctrlKey: true }, page)).toBe('press');
  });

  it('leaves fields, dialogs, Command shortcuts, modifiers and the input method alone', () => {
    expect(keyFallback({ ...plain, key: 'a' }, { ...page, idle: false, editable: true })).toBeNull();
    expect(keyFallback({ ...plain, key: 'a' }, { ...page, modalOpen: true })).toBeNull();
    expect(keyFallback({ ...plain, key: 'c', metaKey: true }, page)).toBeNull();
    expect(keyFallback({ ...plain, key: 'k', metaKey: true }, page)).toBeNull();
    // ⌘V pastes into the terminal input, even over a selection of terminal text.
    expect(keyFallback({ ...plain, key: 'v', metaKey: true }, page)).toBe('type');
    expect(keyFallback({ ...plain, key: 'v', metaKey: true }, { ...page, selection: true })).toBe('type');
    expect(keyFallback({ ...plain, key: 'v', metaKey: true, shiftKey: true }, page)).toBeNull();
    expect(keyFallback({ ...plain, key: 'Shift', shiftKey: true }, page)).toBeNull();
    expect(keyFallback({ ...plain, key: 'n', isComposing: true }, page)).toBeNull();
    expect(keyFallback({ ...plain, key: 'Process', keyCode: 229 }, page)).toBeNull();
  });

  it('keeps Enter, Space and Tab for a control reached with the keyboard', () => {
    const tabbed = { ...page, idle: false, insideTerminal: true, keyboardFocus: true };
    for (const key of ['Enter', ' ', 'Tab']) expect(keyFallback({ ...plain, key }, tabbed)).toBeNull();
    expect(keyFallback({ ...plain, key: 'a' }, tabbed)).toBe('type');
    expect(keyFallback({ ...plain, key: 'a' }, { ...tabbed, insideTerminal: false })).toBeNull();
    // A clicked button anywhere in the window gives the keys back to the terminal.
    expect(keyFallback({ ...plain, key: 'Enter' }, { ...tabbed, insideTerminal: false, keyboardFocus: false })).toBe('press');
  });

  it('with text selected, lets only typing through so copying and extending still work', () => {
    const selected = { ...page, selection: true };
    expect(keyFallback({ ...plain, key: 'a' }, selected)).toBe('type');
    expect(keyFallback({ ...plain, key: 'c', ctrlKey: true }, selected)).toBeNull();
    expect(keyFallback({ ...plain, key: 'ArrowLeft', shiftKey: true }, selected)).toBeNull();
    expect(keyFallback({ ...plain, key: 'Enter' }, selected)).toBeNull();
  });
});

describe('question card keys', () => {
  const decision = { options: [{ number: 1, label: 'Yes' }, { number: 2, label: 'No' }, { number: 3, label: 'Ask' }], selectedIndex: 0, multiSelect: false, multipleQuestions: false };
  it('moves to a numbered option, arrows, confirms and cancels', () => {
    expect(decisionKeys(decision, { ...plain, key: '3' })).toEqual([{ name: 'down' }, { name: 'down' }]);
    expect(decisionKeys({ ...decision, selectedIndex: 2 }, { ...plain, key: '1' })).toEqual([{ name: 'up' }, { name: 'up' }]);
    expect(decisionKeys(decision, { ...plain, key: '1' })).toEqual([]);
    expect(decisionKeys(decision, { ...plain, key: 'ArrowDown' })).toEqual([{ name: 'down' }]);
    expect(decisionKeys(decision, { ...plain, key: 'Enter' })).toEqual([{ name: 'enter' }]);
    expect(decisionKeys(decision, { ...plain, key: 'Escape' })).toEqual([{ name: 'escape' }]);
  });
  it('ignores keys the question does not take', () => {
    expect(decisionKeys(decision, { ...plain, key: '7' })).toBeNull();
    expect(decisionKeys(decision, { ...plain, key: ' ' })).toBeNull();
    expect(decisionKeys({ ...decision, multiSelect: true }, { ...plain, key: ' ' })).toEqual([{ name: 'space' }]);
    expect(decisionKeys({ ...decision, multipleQuestions: true }, { ...plain, key: 'Tab' })).toEqual([{ name: 'tab' }]);
    expect(decisionKeys(decision, { ...plain, key: 'Enter', metaKey: true })).toBeNull();
    expect(decisionKeys(decision, { ...plain, key: '2', isComposing: true })).toBeNull();
    expect(decisionKeys({ ...decision, selectedIndex: null }, { ...plain, key: '2' })).toBeNull();
  });
});

describe('in a page', () => {
  let dom: { window: Window & typeof globalThis };
  type Root = { render(children: ReactNode): void; unmount(): void };
  let createRoot: (container: Element) => Root;
  beforeAll(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { JSDOM } = require('jsdom') as { JSDOM: new (html: string) => typeof dom };
    dom = new JSDOM('<!doctype html><html><body><div id="panecast-terminal"><button id="tool">搜索</button><textarea id="input"></textarea></div><input id="filter"></body></html>');
    for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'KeyboardEvent']) {
      Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: (dom.window as unknown as Record<string, unknown>)[name] });
    }
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    createRoot = (require('react-dom/client') as { createRoot: typeof createRoot }).createRoot;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });
  afterAll(() => dom.window.close());
  const element = (id: string) => document.getElementById(id) as HTMLElement;
  const handle = (): TerminalInputHandle & { pressed: string[] } => {
    const pressed: string[] = [];
    return {
      pressed,
      focus: async () => element('input').focus(),
      blur: async () => {}, clear: async () => {}, insertText: async () => {},
      getState: async () => ({ text: '', composing: false, selectionStart: 0, selectionEnd: 0 }), applyEdit: async () => false,
      pressKey: (event) => { element('input').focus(); pressed.push(event.key); return true; },
    };
  };

  it('reads where focus is', () => {
    element('tool').focus();
    expect(focusContext(document)).toMatchObject({ idle: false, editable: false, insideTerminal: true, modalOpen: false });
    element('filter').focus();
    expect(focusContext(document)).toMatchObject({ editable: true, insideTerminal: false });
    element('filter').blur();
    expect(focusContext(document).idle).toBe(true);
  });

  it('brings typing on the page back to the terminal input, and not from another field', async () => {
    const input = handle();
    const ref = { current: input } as RefObject<TerminalInputHandle | null>;
    function Harness() { useTerminalKeyFallback(ref, true); return null; }
    const container = document.createElement('div'); document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => root.render(<Harness />));
    const press = (key: string, target: EventTarget = document.body, options = {}) => {
      const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options });
      target.dispatchEvent(event);
      return event;
    };
    (document.activeElement as HTMLElement | null)?.blur();
    expect(press('x').defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(element('input'));
    element('input').blur();
    expect(press('Enter').defaultPrevented).toBe(true);
    expect(input.pressed).toEqual(['Enter']);
    element('filter').focus();
    expect(press('Enter', element('filter')).defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(element('filter'));
    element('filter').blur();
    expect(press('k', document.body, { metaKey: true }).defaultPrevented).toBe(false);
    expect(input.pressed).toEqual(['Enter']);
    await act(async () => root.unmount());
    container.remove();
  });

  it('refocuses after a click elsewhere, but not away from a field or an open dialog', () => {
    const input = handle();
    // jsdom counts every focus as :focus-visible; a clicked button is not.
    const tool = element('tool'), matches = tool.matches.bind(tool);
    tool.matches = ((selector: string) => selector !== ':focus-visible' && matches(selector)) as typeof tool.matches;
    tool.focus();
    refocusTerminalInput(input);
    expect(document.activeElement).toBe(element('input'));
    element('filter').focus();
    refocusTerminalInput(input);
    expect(document.activeElement).toBe(element('filter'));
    element('filter').blur();
    const dialog = document.createElement('div'); dialog.setAttribute('aria-modal', 'true'); document.body.appendChild(dialog);
    refocusTerminalInput(input);
    expect(document.activeElement).not.toBe(element('input'));
    dialog.remove();
    // Hidden behind another page.
    const terminal = element('panecast-terminal');
    Object.defineProperty(terminal, 'checkVisibility', { value: () => false, configurable: true });
    refocusTerminalInput(input);
    expect(document.activeElement).not.toBe(element('input'));
    Reflect.deleteProperty(terminal, 'checkVisibility');
  });

  it('answers the question card only from the page or an empty terminal input', () => {
    (document.activeElement as HTMLElement | null)?.blur();
    expect(questionKeyFocus(document)).toBe(true);
    const textarea = element('input') as HTMLTextAreaElement;
    textarea.focus();
    expect(questionKeyFocus(document)).toBe(true);
    textarea.value = '正在写的消息';
    expect(questionKeyFocus(document)).toBe(false);
    textarea.value = '';
    element('filter').focus();
    expect(questionKeyFocus(document)).toBe(false);
    element('filter').blur();
    // Hidden behind another page: the page owns its keys.
    Object.defineProperty(element('panecast-terminal'), 'checkVisibility', { value: () => false, configurable: true });
    expect(questionKeyFocus(document)).toBe(false);
    Reflect.deleteProperty(element('panecast-terminal'), 'checkVisibility');
  });

  it('finds the cursor cell for the input method, and nothing without one', () => {
    expect(terminalCursorAnchor('black')).toBeNull();
    const cell = document.createElement('span'); cell.setAttribute('data-terminal-cursor', '1');
    cell.getBoundingClientRect = () => ({ left: 40, top: 100, width: 8, height: 17, right: 48, bottom: 117, x: 40, y: 100, toJSON() {} }) as DOMRect;
    element('panecast-terminal').appendChild(cell);
    expect(terminalCursorAnchor('black')).toEqual({ left: 40, top: 100, height: 17, background: 'black' });
    cell.remove();
  });
});

