import { act, type ReactNode } from 'react';
import { STALE_AFTER_MS, useOfflineFor } from '../terminalPlaceholder';

jest.mock('../../platform/desktop', () => ({ desktopBridge: () => null }));

let dom: { window: Window & typeof globalThis };
let container: HTMLDivElement;
type Root = { render(children: ReactNode): void; unmount(): void };
let root: Root;
let seen: boolean[] = [];
function Probe({ open }: { open: boolean }) {
  seen.push(useOfflineFor(open));
  return null;
}
beforeAll(() => {
  const { JSDOM } = jest.requireActual('jsdom');
  dom = new JSDOM('<!doctype html><html><body></body></html>');
  for (const key of ['window', 'document', 'navigator', 'HTMLElement']) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: (dom.window as unknown as Record<string, unknown>)[key] });
});
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  jest.useFakeTimers();
  seen = [];
  container = document.createElement('div'); document.body.appendChild(container);
  root = jest.requireActual('react-dom/client').createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); jest.useRealTimers(); });
afterAll(() => dom.window.close());

const render = (open: boolean) => act(async () => root.render(<Probe open={open} />));
const latest = () => seen[seen.length - 1];

it('settles only after the connection has been down for a while, and clears the moment it opens', async () => {
  await render(true);
  expect(latest()).toBe(false);
  await render(false);
  await act(async () => { jest.advanceTimersByTime(STALE_AFTER_MS - 1); });
  expect(latest()).toBe(false);
  // A blip: back before the delay, nothing ever settled.
  await render(true);
  await act(async () => { jest.advanceTimersByTime(STALE_AFTER_MS * 2); });
  expect(seen).not.toContain(true);
  await render(false);
  await act(async () => { jest.advanceTimersByTime(STALE_AFTER_MS); });
  expect(latest()).toBe(true);
  await render(true);
  expect(latest()).toBe(false);
});
