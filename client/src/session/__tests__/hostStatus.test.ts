import type { ConnectionStatus } from '../../protocol/connection';
import type { PushFrame } from '../../protocol/frames';
import { BATTERY_REFRESH_MS, HostStatusStore, parseHostBattery } from '../hostStatus';
import type { RpcChannel } from '../terminalSession';

class FakeChannel implements RpcChannel {
  isOpen = true;
  calls: string[] = [];
  result: unknown = { available: true, percent: 80, state: 'discharging', is_charging: false, power_source: 'Battery Power' };
  failure: Error | null = null;
  pending: Promise<void> | null = null;
  private status = new Set<(status: ConnectionStatus) => void>();

  async call<T>(method: string): Promise<T> {
    this.calls.push(method);
    if (this.pending) await this.pending;
    if (this.failure) throw this.failure;
    return this.result as T;
  }
  onPush(_listener: (frame: PushFrame) => void) {
    return () => {};
  }
  onStatus(listener: (status: ConnectionStatus) => void) {
    this.status.add(listener);
    return () => this.status.delete(listener);
  }
  emit(status: ConnectionStatus) {
    this.isOpen = status.state === 'open';
    for (const listener of this.status) listener(status);
  }
  get statusListeners() {
    return this.status.size;
  }
}

describe('parseHostBattery', () => {
  it('reads level and charging state', () => {
    expect(parseHostBattery({ available: true, percent: 42, state: 'discharging', is_charging: false })).toEqual({
      percent: 42,
      charging: false,
    });
    expect(parseHostBattery({ available: true, percent: 100, state: 'charged', is_charging: true })).toEqual({
      percent: 100,
      charging: true,
    });
    expect(parseHostBattery({ available: true, percent: 55, isCharging: true })).toEqual({ percent: 55, charging: true });
  });

  it('treats a missing charging flag as not charging and clamps the level', () => {
    expect(parseHostBattery({ available: true, percent: 130, is_charging: null })).toEqual({ percent: 100, charging: false });
    expect(parseHostBattery({ available: true, percent: -5 })).toEqual({ percent: 0, charging: false });
  });

  it('returns null for a Mac without a battery or a malformed result', () => {
    expect(parseHostBattery({ available: false, percent: null, power_source: 'AC Power' })).toBeNull();
    expect(parseHostBattery({ available: true, percent: null })).toBeNull();
    expect(parseHostBattery({ available: true, percent: '80' })).toBeNull();
    expect(parseHostBattery({})).toBeNull();
    expect(parseHostBattery(null)).toBeNull();
  });
});

describe('HostStatusStore', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('reads on start, then every minute until stopped', async () => {
    const channel = new FakeChannel();
    const store = new HostStatusStore(channel);
    store.start();
    await jest.advanceTimersByTimeAsync(0);
    expect(store.getState().battery).toEqual({ percent: 80, charging: false });
    expect(channel.calls).toEqual(['host.battery']);

    channel.result = { available: true, percent: 79, is_charging: false };
    await jest.advanceTimersByTimeAsync(BATTERY_REFRESH_MS);
    expect(store.getState().battery?.percent).toBe(79);
    expect(channel.calls).toHaveLength(2);

    store.stop();
    await jest.advanceTimersByTimeAsync(BATTERY_REFRESH_MS * 3);
    expect(channel.calls).toHaveLength(2);
    expect(channel.statusListeners).toBe(0);
  });

  it('starts once however often start is called', async () => {
    const channel = new FakeChannel();
    const store = new HostStatusStore(channel);
    store.start();
    store.start();
    await jest.advanceTimersByTimeAsync(BATTERY_REFRESH_MS);
    expect(channel.calls).toHaveLength(2);
    store.stop();
  });

  it('hides the badge when the call fails or the Mac has no battery', async () => {
    const channel = new FakeChannel();
    const store = new HostStatusStore(channel);
    await store.refresh();
    expect(store.getState().battery).not.toBeNull();

    channel.failure = new Error('method_not_found');
    await store.refresh();
    expect(store.getState().battery).toBeNull();

    channel.failure = null;
    channel.result = { available: false, percent: null, power_source: 'AC Power' };
    await store.refresh();
    expect(store.getState().battery).toBeNull();
  });

  it('skips reads while disconnected and reads again when the connection reopens', async () => {
    const channel = new FakeChannel();
    const store = new HostStatusStore(channel);
    store.start();
    await jest.advanceTimersByTimeAsync(0);
    channel.emit({ state: 'waiting', attempt: 1, retryAt: 0, reason: 'network' });
    await jest.advanceTimersByTimeAsync(BATTERY_REFRESH_MS);
    expect(channel.calls).toHaveLength(1);
    expect(store.getState().battery).not.toBeNull();

    channel.emit({ state: 'open' });
    await jest.advanceTimersByTimeAsync(0);
    expect(channel.calls).toHaveLength(2);
    store.stop();
  });

  it('does not overlap calls or notify when nothing changed', async () => {
    const channel = new FakeChannel();
    const store = new HostStatusStore(channel);
    let notified = 0;
    store.subscribe(() => notified++);
    let release!: () => void;
    channel.pending = new Promise((resolve) => (release = resolve));
    const first = store.refresh();
    void store.refresh();
    release();
    await first;
    expect(channel.calls).toHaveLength(1);
    expect(notified).toBe(1);

    channel.pending = null;
    await store.refresh();
    expect(notified).toBe(1);
  });
});
