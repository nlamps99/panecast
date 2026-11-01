import { useSyncExternalStore } from 'react';

import type { ConnectionStatus } from '../protocol/connection';
import type { StatusSource } from '../session/terminalSession';
import { appStore, type AppStoreState, type Machine } from './appStore';

export function useAppState(): AppStoreState {
  return useSyncExternalStore(appStore.subscribe, appStore.getState, appStore.getState);
}

/** The connected Mac (or demo). Only call under the tabs, which exist only while one is ready. */
export function useMachine(): Machine {
  const { machine } = useAppState();
  if (!machine) throw new Error('useMachine used without a machine');
  return machine;
}

type Store<T> = { getState(): T; subscribe(listener: () => void): () => void };

/** Reads one of the session stores (`TerminalSession`, `WorkspaceStore`, `InboxStore`). */
export function useStore<T>(store: Store<T>): T {
  return useSyncExternalStore(store.subscribe, store.getState, store.getState);
}

export function useConnectionStatus(source: StatusSource): ConnectionStatus {
  const subscribe = (listener: () => void) => source.onStatus(listener);
  const get = () => source.status;
  return useSyncExternalStore(subscribe, get, get);
}
