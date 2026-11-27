import { act, type ReactNode } from 'react';

import type { TerminalSession } from '../../session/terminalSession';
import type { TerminalDecision } from '../../session/terminalPrompt';
import { EMPTY_SCREEN } from '../../protocol/screen';
import { TerminalDecisionCard } from '../TerminalDecisionCard';

jest.mock('react-native', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require('react') as typeof import('react');
  const View = ({ children }: { children?: ReactNode }) => React.createElement('div', null, children);
  const Pressable = ({ children, onPress }: { children?: ReactNode; onPress?: () => void }) => React.createElement('button', { onClick: onPress }, children);
  return { View, ScrollView: View, Text: View, Pressable, Platform: { OS: 'web' }, StyleSheet: { create: (styles: unknown) => styles } };
});

let dom: { window: Window & typeof globalThis };
type Root = { render(children: ReactNode): void; unmount(): void };
let root: Root, container: HTMLDivElement;
beforeAll(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { JSDOM } = require('jsdom') as { JSDOM: new (html: string) => typeof dom };
  dom = new JSDOM('<!doctype html><html><body><div id="panecast-terminal"><textarea id="message"></textarea></div><input id="filter"></body></html>');
  for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'KeyboardEvent']) {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: (dom.window as unknown as Record<string, unknown>)[name] });
  }
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => dom.window.close());
beforeEach(() => {
  container = document.createElement('div'); document.body.appendChild(container);
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  root = (require('react-dom/client') as { createRoot: (element: Element) => Root }).createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

const decision: TerminalDecision = { id: 'q', title: 'Proceed?', text: '', options: [{ number: 1, label: 'Yes' }, { number: 2, label: 'No' }], selectedIndex: 0, multiSelect: false, multipleQuestions: false };

async function show(enabled = true) {
  const sendPromptKeys = jest.fn(async () => ({ status: 'sent' as const, message: '' }));
  const session = { sendPromptKeys } as unknown as TerminalSession;
  await act(async () => root.render(<TerminalDecisionCard decision={decision} screen={EMPTY_SCREEN} session={session} enabled={enabled} onShowTerminal={() => {}} />));
  return sendPromptKeys;
}
async function press(key: string, target: EventTarget) {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  await act(async () => { target.dispatchEvent(event); });
  return event;
}

it('answers with the keyboard from an empty message box', async () => {
  const sendPromptKeys = await show();
  const message = document.getElementById('message') as HTMLTextAreaElement;
  message.focus();
  expect((await press('2', message)).defaultPrevented).toBe(true);
  expect((await press('Enter', message)).defaultPrevented).toBe(true);
  expect((await press('Escape', message)).defaultPrevented).toBe(true);
  expect(sendPromptKeys.mock.calls.map((call) => (call as unknown[])[0])).toEqual([[{ name: 'down' }], [{ name: 'enter' }], [{ name: 'escape' }]]);
});

it('leaves the keys to a message being written, other fields and a disabled card', async () => {
  let sendPromptKeys = await show();
  const message = document.getElementById('message') as HTMLTextAreaElement;
  message.value = '1 more thing'; message.focus();
  expect((await press('Enter', message)).defaultPrevented).toBe(false);
  message.value = '';
  const filter = document.getElementById('filter')!;
  filter.focus();
  expect((await press('2', filter)).defaultPrevented).toBe(false);
  expect(sendPromptKeys).not.toHaveBeenCalled();
  sendPromptKeys = await show(false);
  message.focus();
  expect((await press('2', message)).defaultPrevented).toBe(false);
  expect(sendPromptKeys).not.toHaveBeenCalled();
});

it('takes no keys while the terminal tab is hidden behind another page', async () => {
  const sendPromptKeys = await show();
  const terminal = document.getElementById('panecast-terminal')!;
  Object.defineProperty(terminal, 'checkVisibility', { value: () => false, configurable: true });
  try {
    (document.activeElement as HTMLElement | null)?.blur();
    for (const key of ['Enter', 'Escape', '2', 'ArrowDown']) expect((await press(key, document.body)).defaultPrevented).toBe(false);
    expect(sendPromptKeys).not.toHaveBeenCalled();
  } finally { Reflect.deleteProperty(terminal, 'checkVisibility'); }
});
