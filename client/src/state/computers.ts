/**
 * One paired Mac. Secrets (tokens) live only in SecureStore; never log this.
 *
 * `broker` is always present: every pairing QR carries broker details. `lan`
 * is set when the QR also carried a LAN address and LAN registration
 * succeeded; the relay issues a separate token for it.
 */
export type ComputerCredentials = { deviceId: string; token: string };

export type StoredComputer = {
  /** Local id, stable across launches. */
  id: string;
  /** Shown in the UI; defaults to the relay id. */
  name: string;
  broker: { serverUrl: string; relayId: string } & ComputerCredentials;
  lan?: { url: string } & ComputerCredentials;
  /** ISO time. */
  pairedAt: string;
};

/** How to reach a computer: `auto` prefers LAN when it answers, else the broker. */
export type TransportPreference = 'auto' | 'broker' | 'lan';

export type ComputerList = {
  version: 2;
  selectedId: string | null;
  computers: StoredComputer[];
  /** Per computer id; missing means `auto`. */
  transport?: Record<string, TransportPreference>;
};

export const EMPTY_COMPUTER_LIST: ComputerList = { version: 2, selectedId: null, computers: [] };

export function selectedComputer(list: ComputerList): StoredComputer | null {
  return list.computers.find((c) => c.id === list.selectedId) ?? list.computers[0] ?? null;
}
