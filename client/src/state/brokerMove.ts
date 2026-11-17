import { serviceFetch } from '../platform/desktop';
import type { ComputerList } from './computers';

/**
 * A broker that moved to a new address keeps answering at the old one by
 * forwarding, and reports the new address as `server_url` in `/v1/health`.
 * Its devices, accounts and share keys moved with it, so a computer only
 * needs its stored address changed; credentials stay as they are.
 */
const trim = (url: string) => url.replace(/\/+$/, '');

type Health = { ok?: unknown; server_url?: unknown };

/** The address `serverUrl` says to use instead, once that address confirms it; null when nothing moved. */
export async function movedBroker(serverUrl: string, fetchImpl: typeof fetch = serviceFetch): Promise<string | null> {
  const health = async (base: string): Promise<Health | null> => {
    const response = await fetchImpl(`${trim(base)}/v1/health`);
    return response.ok ? ((await response.json()) as Health) : null;
  };
  try {
    const current = await health(serverUrl);
    const next = typeof current?.server_url === 'string' ? trim(current.server_url) : null;
    if (!next || next === trim(serverUrl) || !/^https:\/\/[^/@\s]+(\/[^\s]*)?$/.test(next)) return null;
    // The new address must answer for itself, so a typo or a stale setting never strands a computer.
    const confirmed = await health(next);
    return confirmed?.ok === true && typeof confirmed.server_url === 'string' && trim(confirmed.server_url) === next ? next : null;
  } catch {
    return null;
  }
}

/** Points every computer stored with `from` at `to`; the same list when none was. */
export function moveComputers(list: ComputerList, from: string, to: string): ComputerList {
  let changed = false;
  const computers = list.computers.map((computer) => {
    if (trim(computer.broker.serverUrl) !== trim(from)) return computer;
    changed = true;
    return { ...computer, broker: { ...computer.broker, serverUrl: to } };
  });
  return changed ? { ...list, computers } : list;
}
