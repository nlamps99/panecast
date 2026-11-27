import { act, type ReactNode } from 'react';

import { setPrefs } from '../../../state/prefs';
import { showDesktopFontSize } from '../../terminalZoom';
import { TerminalSection } from '../TerminalSection';

type StepperProps = { label: string; a11y: string; disabled?: boolean; onPress(): void };
const mockSteppers = new Map<string, StepperProps>();
let mockPrefs = { fontSize: 13, desktopFontZoom: null as number | null, historyLines: 120, keyHaptics: true, extraKeyRow: false, terminalWrap: true, tabletSidebar: true };

jest.mock('react-native', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require('react') as typeof import('react');
  const host = (tag: string) => function NativeTestHost({ children }: { children?: ReactNode }) { return React.createElement(tag, null, children); };
  return { View: host('div'), Text: host('span'), Switch: () => null, useWindowDimensions: () => ({ width: 1200, height: 800 }), Platform: { OS: 'web' } };
});
jest.mock('../Section', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require('react') as typeof import('react');
  return {
    Section: ({ footnote, children }: { footnote?: string; children?: ReactNode }) => React.createElement('section', { 'data-footnote': footnote }, children),
    Stepper: (props: StepperProps) => { mockSteppers.set(props.label, props); return null; },
    settingsStyles: {},
  };
});
jest.mock('../../theme', () => ({ colors: {} }));
jest.mock('../../../state/prefs', () => {
  const actual = jest.requireActual('../../../state/prefs');
  return { ...actual, usePrefs: () => mockPrefs, getPrefs: () => mockPrefs, setPrefs: jest.fn() };
});

let dom: { window: Window & typeof globalThis };
let container: HTMLDivElement;
type Root = { render(node: ReactNode): void; unmount(): void };
let root: Root;
beforeAll(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { JSDOM } = require('jsdom') as { JSDOM: new (html: string) => typeof dom };
  dom = new JSDOM('<!doctype html><html><body></body></html>');
  for (const name of ['window', 'document', 'navigator']) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: (dom.window as unknown as Record<string, unknown>)[name] });
});
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mockPrefs = { ...mockPrefs, fontSize: 13, desktopFontZoom: null };
  mockSteppers.clear(); (setPrefs as jest.Mock).mockClear();
  container = document.createElement('div'); document.body.appendChild(container);
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  root = (require('react-dom/client') as { createRoot(element: Element): Root }).createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); delete (window as { panecastDesktop?: unknown }).panecastDesktop; showDesktopFontSize(null); });
afterAll(() => dom.window.close());

it('changes the size the desktop terminal shows, which may be fitted below the preference', async () => {
  (window as { panecastDesktop?: unknown }).panecastDesktop = { version: 1 };
  showDesktopFontSize(10);
  await act(async () => root.render(<TerminalSection />));
  expect(container.textContent).toContain('10 pt');
  expect(container.querySelector('section')?.getAttribute('data-footnote')).toContain('恢复为适应窗口');
  await act(async () => mockSteppers.get('A+')!.onPress());
  expect(setPrefs).toHaveBeenLastCalledWith({ desktopFontZoom: 11 });
  mockPrefs = { ...mockPrefs, desktopFontZoom: 15 };
  await act(async () => root.render(<TerminalSection />));
  expect(container.textContent).toContain('15 pt');
  // Steps from the explicit size, even when the terminal last showed another one.
  await act(async () => mockSteppers.get('A−')!.onPress());
  expect(setPrefs).toHaveBeenLastCalledWith({ desktopFontZoom: 14 });
});

it('changes the font-size preference on phones', async () => {
  await act(async () => root.render(<TerminalSection />));
  expect(container.textContent).toContain('13 pt');
  await act(async () => mockSteppers.get('A+')!.onPress());
  expect(setPrefs).toHaveBeenLastCalledWith({ fontSize: 14 });
});
