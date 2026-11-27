import { act, type ReactNode } from 'react';
import type { ConnectionStatus } from '../../protocol/connection';
import { ConnectionNotice } from '../ConnectionNotice';

const mockReconnect = jest.fn();
const mockNavigate = jest.fn();
let mockStatus: ConnectionStatus = { state: 'open' };
let mockMachine: { mode: 'relay' | 'demo'; computer: object | null; channel: object } | null = null;
jest.mock('react-native', () => {
  const React = jest.requireActual('react') as typeof import('react');
  const View = ({ children }: { children?: ReactNode }) => React.createElement('div', null, children);
  const Pressable = ({ children, onPress, accessibilityLabel }: { children?: ReactNode; onPress?: () => void; accessibilityLabel?: string }) =>
    React.createElement('button', { onClick: onPress, 'aria-label': accessibilityLabel }, children);
  return { View, Text: View, Pressable, Platform: { OS: 'web' }, StyleSheet: { create: (value: unknown) => value } };
});
jest.mock('expo-router', () => ({ router: { navigate: (...args: unknown[]) => mockNavigate(...args) } }));
jest.mock('../../platform/desktop', () => ({ desktopBridge: () => ({ version: 1 }) }));
jest.mock('../../state/appStore', () => ({ appStore: { reconnect: () => mockReconnect() } }));
jest.mock('../../state/hooks', () => ({ useAppState: () => ({ machine: mockMachine }), useConnectionStatus: () => mockStatus }));

let dom: { window: Window & typeof globalThis };
let container: HTMLDivElement;
type Root = { render(children: ReactNode): void; unmount(): void };
let root: Root;
beforeAll(() => {
  const { JSDOM } = jest.requireActual('jsdom');
  dom = new JSDOM('<!doctype html><html><body></body></html>');
  for (const key of ['window', 'document', 'navigator', 'HTMLElement']) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: (dom.window as unknown as Record<string, unknown>)[key] });
});
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  jest.clearAllMocks();
  mockMachine = { mode: 'relay', computer: { id: 'mac' }, channel: {} };
  container = document.createElement('div'); document.body.appendChild(container);
  root = jest.requireActual('react-dom/client').createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
afterAll(() => dom.window.close());

async function show(status: ConnectionStatus) {
  mockStatus = status;
  await act(async () => root.render(<ConnectionNotice />));
}
const button = () => container.querySelector('button');

it('says nothing while connected, during a first attempt, or in the demo', async () => {
  await show({ state: 'open' });
  expect(container.textContent).toBe('');
  await show({ state: 'connecting', attempt: 0 });
  expect(container.textContent).toBe('');
  mockMachine = { mode: 'demo', computer: null, channel: {} };
  await show({ state: 'waiting', attempt: 1, retryAt: 0, reason: 'network' });
  expect(container.textContent).toBe('');
});

it('offers 重新连接 when this computer\'s gateway is down, and keeps it up between retries', async () => {
  await show({ state: 'waiting', attempt: 1, retryAt: 0, reason: 'relay_offline', local: true });
  expect(container.textContent).toContain('本机的 Panecast 网关没有响应');
  expect(container.textContent).not.toContain('手机');
  await show({ state: 'connecting', attempt: 1, local: true });
  expect(button()?.getAttribute('aria-label')).toBe('重新连接');
  await act(async () => button()!.click());
  expect(mockReconnect).toHaveBeenCalledTimes(1);
});

it('sends a rejected pairing to 设置', async () => {
  await show({ state: 'auth_failed' });
  expect(container.textContent).toContain('重新配对');
  expect(button()?.getAttribute('aria-label')).toBe('去设置');
  await act(async () => button()!.click());
  expect(mockNavigate).toHaveBeenCalledWith('/settings');
  expect(mockReconnect).not.toHaveBeenCalled();
});
