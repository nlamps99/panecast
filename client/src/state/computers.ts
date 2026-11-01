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

/** Two records for the same relay on the same broker are the same computer. */
export function sameRelay(a: StoredComputer, b: StoredComputer): boolean {
  return a.broker.relayId === b.broker.relayId && a.broker.serverUrl === b.broker.serverUrl;
}

/**
 * Adds a freshly registered computer and selects it. Re-pairing a relay that
 * is already in the list replaces its credentials in place and keeps its id,
 * name and transport preference, so a rename survives a re-pair.
 */
export function upsertComputer(list: ComputerList, registered: StoredComputer): { list: ComputerList; computer: StoredComputer } {
  const existing = list.computers.find((c) => sameRelay(c, registered));
  const computer = existing ? { ...registered, id: existing.id, name: existing.name } : registered;
  const computers = existing
    ? list.computers.filter((c) => c.id === existing.id || !sameRelay(c, registered)).map((c) => (c.id === existing.id ? computer : c))
    : [...list.computers, computer];
  return { list: { ...list, selectedId: computer.id, computers }, computer };
}

/**
 * Forgets a computer and its transport preference. If it was the selected
 * one, the first remaining computer (or none) becomes selected.
 */
export function removeComputer(list: ComputerList, computerId: string): ComputerList {
  const computers = list.computers.filter((c) => c.id !== computerId);
  if (computers.length === list.computers.length) return list;
  const selectedId = list.selectedId !== null && computers.some((c) => c.id === list.selectedId) ? list.selectedId : (computers[0]?.id ?? null);
  const transport = list.transport ? Object.fromEntries(Object.entries(list.transport).filter(([id]) => id !== computerId)) : undefined;
  return { ...list, selectedId, computers, transport };
}

/** The name a rename would store: trimmed, and the relay id when left blank. */
export function normalizeComputerName(computer: StoredComputer, name: string): string {
  return name.trim() || computer.broker.relayId;
}

export function renameComputer(list: ComputerList, computerId: string, name: string): ComputerList {
  return {
    ...list,
    computers: list.computers.map((c) => (c.id === computerId ? { ...c, name: normalizeComputerName(c, name) } : c)),
  };
}

/** The broker host shown under a computer's name. */
export function computerAddress(computer: StoredComputer): string {
  return computer.broker.serverUrl.replace(/^https?:\/\//, '');
}
