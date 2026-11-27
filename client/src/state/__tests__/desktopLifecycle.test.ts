import { watchDesktopLifecycle, type WakeReason } from '../desktopLifecycle';

class Events {
  listeners = new Map<string, Set<(event: unknown) => void>>();
  visibilityState = 'visible';
  addEventListener(type: string, listener: (event: unknown) => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(listener);
  }
  removeEventListener(type: string, listener: (event: unknown) => void) {
    this.listeners.get(type)?.delete(listener);
  }
  fire(type: string) {
    for (const listener of this.listeners.get(type) ?? []) listener({});
  }
  count() {
    return [...this.listeners.values()].reduce((sum, set) => sum + set.size, 0);
  }
}

function setup() {
  const win = new Events(), doc = new Events();
  const wakes: WakeReason[] = [], hidden: boolean[] = [];
  let clock = 1_000_000;
  const stop = watchDesktopLifecycle({
    onWake: (reason) => wakes.push(reason), onHidden: (value) => hidden.push(value),
    window: win, document: doc, tickMs: 10_000, gapMs: 30_000, minIntervalMs: 1_500, now: () => clock,
  });
  return { win, doc, wakes, hidden, stop, advance: (ms: number) => { clock += ms; } };
}

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

it('wakes when the window is shown or focused again and when the network returns, once per burst', () => {
  const h = setup();
  h.doc.visibilityState = 'hidden';
  h.doc.fire('visibilitychange');
  expect(h.hidden).toEqual([true]);
  expect(h.wakes).toEqual([]);
  h.advance(60_000);
  h.doc.visibilityState = 'visible';
  h.doc.fire('visibilitychange');
  h.win.fire('focus');
  expect(h.hidden).toEqual([true, false]);
  expect(h.wakes).toEqual(['visible']);
  h.advance(2_000);
  h.win.fire('online');
  expect(h.wakes).toEqual(['visible', 'online']);
  h.stop();
});

it('notices that the process did not run for a while (the Mac slept) and wakes even right after a focus', () => {
  const h = setup();
  h.advance(10_000);
  jest.advanceTimersByTime(10_000);
  expect(h.wakes).toEqual([]);
  // The interval fires late: the clock jumped while the timer was frozen.
  h.win.fire('focus');
  h.advance(10_000 + 45_000);
  jest.advanceTimersByTime(10_000);
  expect(h.wakes).toEqual(['focus', 'resume']);
  h.stop();
});

it('removes every listener and the timer when stopped', () => {
  const h = setup();
  expect(h.win.count() + h.doc.count()).toBeGreaterThan(0);
  h.stop();
  expect(h.win.count() + h.doc.count()).toBe(0);
  h.advance(120_000);
  jest.advanceTimersByTime(120_000);
  expect(h.wakes).toEqual([]);
});
