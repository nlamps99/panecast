import type { ConnectionStatus } from '../protocol/connection';
import type { RpcChannel } from './terminalSession';

/** The Mac's battery, from the relay's `host.battery` (it runs `pmset -g batt`). */
export type HostBattery = { percent: number; charging: boolean };

export type HostStatusState = {
  /** Null until read, when the call fails, or when the Mac has no battery. */
  battery: HostBattery | null;
};

/** Refresh period while the terminal tab is focused. */
export const BATTERY_REFRESH_MS = 60_000;
const BATTERY_TIMEOUT_MS = 10_000;

/**
 * Parses a `host.battery` result:
 * `{ available, percent, state, is_charging, power_source }` (see
 * `relay/Sources/RelayServer/HostServices.swift`). The relay counts
 * "charged" as charging, i.e. plugged in. Returns null for a Mac without a
 * battery or a malformed result.
 */
export function parseHostBattery(value: unknown): HostBattery | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.available !== true) return null;
  const percent = record.percent;
  if (typeof percent !== 'number' || !Number.isFinite(percent)) return null;
  const charging = record.is_charging ?? record.isCharging;
  return { percent: Math.round(Math.min(100, Math.max(0, percent))), charging: charging === true };
}

/**
 * Polls the Mac's battery while started: once on `start()`, every
 * `BATTERY_REFRESH_MS`, and whenever the connection reopens. The terminal
 * screen starts it on focus and stops it on blur.
 */
export class HostStatusStore {
  private state: HostStatusState = { battery: null };
  private listeners = new Set<() => void>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private unsubscribeStatus: (() => void) | null = null;
  private inFlight = false;

  constructor(private readonly channel: RpcChannel) {}

  getState = (): HostStatusState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  start(): void {
    if (this.timer) return;
    this.unsubscribeStatus = this.channel.onStatus((status: ConnectionStatus) => {
      if (status.state === 'open') void this.refresh();
    });
    this.timer = setInterval(() => void this.refresh(), BATTERY_REFRESH_MS);
    void this.refresh();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.unsubscribeStatus?.();
    this.unsubscribeStatus = null;
  }

  /** Skipped while disconnected (the last reading stays) or while a call is in flight. */
  async refresh(): Promise<void> {
    if (this.inFlight || !this.channel.isOpen) return;
    this.inFlight = true;
    let battery: HostBattery | null;
    try {
      battery = parseHostBattery(await this.channel.call('host.battery', {}, BATTERY_TIMEOUT_MS));
    } catch {
      battery = null;
    } finally {
      this.inFlight = false;
    }
    const current = this.state.battery;
    if (current?.percent === battery?.percent && current?.charging === battery?.charging) return;
    this.state = { battery };
    for (const listener of this.listeners) listener();
  }
}
