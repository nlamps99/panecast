import { Linking, Platform } from 'react-native';

import type { ConnectionStatus } from '../protocol/connection';
import { desktopBridge } from '../platform/desktop';
import { describeError, type RpcChannel } from './terminalSession';

/**
 * Files of a window someone shared with a key. The shared computer hands out
 * a short-lived download link; the guest's own apps (WPS, Preview, the
 * browser) open it, so Panecast has no viewer of its own.
 */
export type SharedFile = { path: string; name: string; size: number; mtimeMs: number };
export type SharedLink = { url: string; name: string; size: number; expiresAt: string };
export type SharedFilesState = {
  files: SharedFile[];
  /** Files changed since this screen first listed the folder. */
  changed: Record<string, true>;
  loaded: boolean;
  /** The shared computer's gateway does not know file listings yet. */
  unsupported: boolean;
  /** Path being prepared, and the last outcome to show. */
  busy: string | null;
  message: { text: string; error: boolean } | null;
};

const REFRESH_MS = 4000;
const LINK_TIMEOUT_MS = 180_000;

export function parseSharedFiles(value: unknown): SharedFile[] {
  const files = (value as { files?: unknown } | null)?.files;
  if (!Array.isArray(files)) throw new Error('文件列表格式不正确');
  return files.flatMap((item): SharedFile[] => {
    const v = item as Record<string, unknown>;
    if (typeof v.path !== 'string' || !v.path || typeof v.size !== 'number' || typeof v.mtime_ms !== 'number') return [];
    const name = typeof v.name === 'string' && v.name ? v.name : v.path.split('/').pop() ?? v.path;
    return [{ path: v.path, name, size: v.size, mtimeMs: v.mtime_ms }];
  }).slice(0, 500);
}

export function parseSharedLink(value: unknown): SharedLink {
  const v = (value ?? {}) as Record<string, unknown>;
  if (typeof v.url !== 'string' || !/^https:\/\//.test(v.url)) throw new Error('对方电脑返回的下载链接无效');
  return { url: v.url, name: typeof v.name === 'string' && v.name ? v.name : 'file', size: typeof v.size === 'number' ? v.size : 0,
    expiresAt: typeof v.expires_at === 'string' ? v.expires_at : '' };
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

/** Opens a link with the platform's own apps. Desktop downloads it and uses the default app. */
export async function openSharedLink(link: SharedLink, opened?: Window | null): Promise<string> {
  const desktop = desktopBridge();
  if (desktop?.openSharedFile) {
    const result = await desktop.openSharedFile(link.url, link.name);
    return result.opened ? `已打开：${result.path}` : `已下载到：${result.path}`;
  }
  if (Platform.OS === 'web') {
    // A window opened during the click is not blocked; one opened after the request would be.
    if (opened && !opened.closed) opened.location.href = link.url; else window.open(link.url, '_blank', 'noopener');
    return `已在浏览器打开 ${link.name}`;
  }
  await Linking.openURL(link.url);
  return `已打开 ${link.name}`;
}

export class SharedFilesStore {
  private state: SharedFilesState = { files: [], changed: {}, loaded: false, unsupported: false, busy: null, message: null };
  private listeners = new Set<() => void>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private unsubscribeStatus: (() => void) | null = null;
  private inFlight = false;
  private baseline: Map<string, number> | null = null;

  constructor(private readonly channel: RpcChannel) {}

  getState = (): SharedFilesState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  private set(patch: Partial<SharedFilesState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  start(): void {
    if (this.timer) return;
    this.unsubscribeStatus = this.channel.onStatus((status: ConnectionStatus) => { if (status.state === 'open') void this.refresh(); });
    this.timer = setInterval(() => void this.refresh(), REFRESH_MS);
    void this.refresh();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.unsubscribeStatus?.();
    this.unsubscribeStatus = null;
  }

  async refresh(): Promise<void> {
    if (this.inFlight || !this.channel.isOpen || this.state.unsupported) return;
    this.inFlight = true;
    try {
      const files = parseSharedFiles(await this.channel.call('share.files.list', {}, 15_000));
      const baseline = this.baseline ?? new Map(files.map((file) => [file.path, file.mtimeMs]));
      this.baseline = baseline;
      const changed: Record<string, true> = { ...this.state.changed };
      for (const file of files) if (baseline.get(file.path) !== file.mtimeMs) changed[file.path] = true;
      this.set({ files, changed, loaded: true });
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (code === 'forbidden' || code === 'method_not_found') this.set({ unsupported: true, loaded: true });
    } finally {
      this.inFlight = false;
    }
  }

  /** Asks the shared computer for a link, then opens it. `opened` is a browser window made during the click. */
  async open(file: SharedFile, opened?: Window | null): Promise<void> {
    if (this.state.busy) return;
    this.set({ busy: file.path, message: { text: `正在从对方电脑取回 ${file.name}（${formatSize(file.size)}）…`, error: false } });
    try {
      const link = parseSharedLink(await this.channel.call('share.file.link', { path: file.path }, LINK_TIMEOUT_MS));
      const text = await openSharedLink(link, opened);
      const changed = { ...this.state.changed };
      delete changed[file.path];
      this.set({ busy: null, changed, message: { text, error: false } });
    } catch (error) {
      opened?.close();
      this.set({ busy: null, message: { text: `没能打开 ${file.name}：${describeError(error)}`, error: true } });
    }
  }

  /** The link alone, to paste into a chat or a browser. */
  async link(file: SharedFile): Promise<SharedLink | null> {
    try {
      return parseSharedLink(await this.channel.call('share.file.link', { path: file.path }, LINK_TIMEOUT_MS));
    } catch (error) {
      this.set({ message: { text: `没能生成链接：${describeError(error)}`, error: true } });
      return null;
    }
  }

  say(text: string, error = false): void { this.set({ message: { text, error } }); }
  dismiss(): void { this.set({ message: null }); }
}
