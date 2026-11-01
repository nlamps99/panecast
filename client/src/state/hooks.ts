import { useSyncExternalStore } from 'react';

import type { ConnectionStatus } from '../protocol/connection';
import type { TerminalSession, TerminalState } from '../session/terminalSession';
import { appStore, type AppStoreState } from './appStore';

/** Anything with a connection status: `RelayConnection`, or the demo channel. */
export type StatusSource = {
  readonly status: ConnectionStatus;
  onStatus(listener: (status: ConnectionStatus) => void): () => void;
};

export function useAppState(): AppStoreState {
  return useSyncExternalStore(appStore.subscribe, appStore.getState, appStore.getState);
}

const IDLE: ConnectionStatus = { state: 'idle' };
const noop = () => () => {};

export function useConnectionStatus(source: StatusSource | null): ConnectionStatus {
  const subscribe = source ? (listener: () => void) => source.onStatus(listener) : noop;
  const get = () => source?.status ?? IDLE;
  return useSyncExternalStore(subscribe, get, get);
}

export function useTerminalState(session: TerminalSession | null): TerminalState | null {
  const subscribe = session ? session.subscribe : noop;
  const get = () => session?.getState() ?? null;
  return useSyncExternalStore(subscribe, get, get);
}
