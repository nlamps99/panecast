import { useSyncExternalStore } from 'react';

import type { ConnectionStatus, RelayConnection } from '../protocol/connection';
import type { TerminalSession, TerminalState } from '../session/terminalSession';
import { appStore, type AppStoreState } from './appStore';

export function useAppState(): AppStoreState {
  return useSyncExternalStore(appStore.subscribe, appStore.getState, appStore.getState);
}

const IDLE: ConnectionStatus = { state: 'idle' };
const noop = () => () => {};

export function useConnectionStatus(connection: RelayConnection | null): ConnectionStatus {
  const subscribe = connection ? (listener: () => void) => connection.onStatus(listener) : noop;
  const get = () => connection?.status ?? IDLE;
  return useSyncExternalStore(subscribe, get, get);
}

export function useTerminalState(session: TerminalSession | null): TerminalState | null {
  const subscribe = session ? session.subscribe : noop;
  const get = () => session?.getState() ?? null;
  return useSyncExternalStore(subscribe, get, get);
}
