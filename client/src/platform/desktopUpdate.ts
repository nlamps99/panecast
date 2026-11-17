import { useSyncExternalStore } from 'react';

import { desktopBridge, type DesktopBridge } from './desktop';

/**
 * The Mac app's self-update, as the native updater reports it: it checks a
 * few seconds after launch and every few hours, downloads and installs a new
 * version in place, and the new version runs after a restart.
 */
export type UpdateStatus =
  | { current: string; state: 'idle' | 'checking' }
  | { current: string; state: 'latest'; checkedAt: number }
  | { current: string; state: 'downloading'; version: string; downloaded: number; total: number | null }
  | { current: string; state: 'ready'; version: string; notes: string | null }
  | { current: string; state: 'failed'; message: string };

const text = (value: unknown) => (typeof value === 'string' ? value : null);
const count = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null);

/** The native status (`update_status`, `panecast-update`); null for anything malformed. */
export function parseUpdateStatus(value: unknown): UpdateStatus | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  const current = text(record.current);
  if (!current) return null;
  switch (record.state) {
    case 'idle': case 'checking': return { current, state: record.state };
    case 'latest': return { current, state: 'latest', checkedAt: count(record.checked_at) ?? 0 };
    case 'downloading': {
      const version = text(record.version);
      return version ? { current, state: 'downloading', version, downloaded: count(record.downloaded) ?? 0, total: count(record.total) } : null;
    }
    case 'ready': {
      const version = text(record.version);
      return version ? { current, state: 'ready', version, notes: text(record.notes) } : null;
    }
    case 'failed': return { current, state: 'failed', message: text(record.message) ?? '检查更新失败' };
    default: return null;
  }
}

/** One line for the settings row. */
export function updateLabel(status: UpdateStatus, now = Date.now()): string {
  switch (status.state) {
    case 'idle': return '会自动检查并安装新版本';
    case 'checking': return '正在检查更新…';
    case 'latest': {
      const minutes = Math.max(0, Math.floor((now / 1000 - status.checkedAt) / 60));
      return `已是最新版本 · ${minutes < 1 ? '刚刚' : minutes < 60 ? `${minutes} 分钟前` : `${Math.round(minutes / 60)} 小时前`}检查`;
    }
    case 'downloading':
      return `正在下载 ${status.version}${status.total ? `（${Math.min(100, Math.floor((status.downloaded / status.total) * 100))}%）` : ''}…`;
    case 'ready': return `${status.version} 已安装，重启后生效`;
    case 'failed': return status.message;
  }
}

type Updater = Required<Pick<DesktopBridge, 'updateStatus' | 'checkForUpdate' | 'restartToUpdate' | 'onUpdate'>>;

function updater(): Updater | null {
  const bridge = desktopBridge();
  return bridge?.updateStatus && bridge.checkForUpdate && bridge.restartToUpdate && bridge.onUpdate ? (bridge as Updater) : null;
}

let latest: UpdateStatus | null = null;
let started = false;
const listeners = new Set<() => void>();
const publish = (value: unknown) => {
  const status = parseUpdateStatus(value);
  if (!status) return;
  latest = status;
  for (const listener of listeners) listener();
};

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  const native = updater();
  if (native && !started) {
    started = true;
    native.onUpdate(publish);
    // Systems without self-update reject; the section then stays hidden.
    void native.updateStatus().then(publish, () => {});
  }
  return () => { listeners.delete(listener); };
}

/** The current update status; null where the app does not update itself. */
export function useDesktopUpdate(): UpdateStatus | null {
  return useSyncExternalStore(subscribe, () => latest, () => null);
}

/** Checks now; the result arrives through `useDesktopUpdate` as well. */
export async function checkForUpdate(): Promise<UpdateStatus | null> {
  const native = updater();
  if (!native) return null;
  const status = parseUpdateStatus(await native.checkForUpdate());
  if (status) publish(status);
  return status;
}

export function restartToUpdate(): Promise<void> {
  return updater()?.restartToUpdate() ?? Promise.resolve();
}

/** Test hook: forget the shared status. */
export function resetDesktopUpdateForTests(): void {
  latest = null; started = false; listeners.clear();
}
