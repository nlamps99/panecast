import type { ConnectionStatus } from '../../protocol/connection';
import type { PushFrame } from '../../protocol/frames';
import { formatSize, parseSharedFiles, parseSharedLink, SharedFilesStore } from '../sharedFiles';
import type { RpcChannel } from '../terminalSession';

class FakeChannel implements RpcChannel {
  isOpen = true;
  calls: { method: string; params?: Record<string, unknown> }[] = [];
  files: unknown[] = [];
  linkResult: unknown = { url: 'https://files.example/v1/o/x/a.pdf?t=y', name: 'a.pdf', size: 10, expires_at: '2026-11-17T00:00:00Z' };
  failure: (Error & { code?: string }) | null = null;
  async call<T>(method: string, params?: Record<string, unknown>): Promise<T> {
    this.calls.push({ method, params });
    if (this.failure) throw this.failure;
    if (method === 'share.files.list') return { files: this.files } as T;
    return this.linkResult as T;
  }
  onPush(_listener: (frame: PushFrame) => void) { return () => {}; }
  onStatus(_listener: (status: ConnectionStatus) => void) { return () => {}; }
}

const file = (path: string, mtime: number) => ({ path, name: path.split('/').pop(), size: 2048, mtime_ms: mtime });

afterEach(() => { delete (window as { panecastDesktop?: unknown }).panecastDesktop; });

describe('shared files', () => {
  it('parses listings and links defensively', () => {
    expect(parseSharedFiles({ files: [file('a/b.pdf', 1), { path: 3 }, { path: 'c.txt', size: 1, mtime_ms: 2 }] }))
      .toEqual([{ path: 'a/b.pdf', name: 'b.pdf', size: 2048, mtimeMs: 1 }, { path: 'c.txt', name: 'c.txt', size: 1, mtimeMs: 2 }]);
    expect(() => parseSharedFiles({})).toThrow();
    expect(() => parseSharedLink({ url: 'http://x' })).toThrow('下载链接无效');
    expect(parseSharedLink({ url: 'https://x/y', name: 'n', size: 3, expires_at: 'e' })).toEqual({ url: 'https://x/y', name: 'n', size: 3, expiresAt: 'e' });
    expect(formatSize(500)).toBe('500 B');
    expect(formatSize(2048)).toBe('2 KB');
    expect(formatSize(3.5 * 1024 * 1024)).toBe('3.5 MB');
  });

  it('marks files that change after the first listing', async () => {
    const channel = new FakeChannel();
    channel.files = [file('论文.docx', 100), file('notes.md', 50)];
    const store = new SharedFilesStore(channel);
    await store.refresh();
    expect(store.getState().changed).toEqual({});
    channel.files = [file('论文.docx', 200), file('notes.md', 50), file('fig.png', 300)];
    await store.refresh();
    expect(store.getState().changed).toEqual({ '论文.docx': true, 'fig.png': true });
  });

  it('opens a file through the desktop app and clears its mark', async () => {
    const opened: [string, string][] = [];
    (window as unknown as { panecastDesktop: unknown }).panecastDesktop = {
      version: 1, openSharedFile: async (url: string, name: string) => { opened.push([url, name]); return { path: '/Users/me/Downloads/Panecast/a.pdf', opened: true }; },
    };
    const channel = new FakeChannel();
    const store = new SharedFilesStore(channel);
    channel.files = [file('a.pdf', 1)];
    await store.refresh();
    channel.files = [file('a.pdf', 2)];
    await store.refresh();
    await store.open({ path: 'a.pdf', name: 'a.pdf', size: 10, mtimeMs: 2 });
    expect(channel.calls.at(-1)).toEqual({ method: 'share.file.link', params: { path: 'a.pdf' } });
    expect(opened).toEqual([['https://files.example/v1/o/x/a.pdf?t=y', 'a.pdf']]);
    expect(store.getState()).toMatchObject({ busy: null, changed: {}, message: { text: '已打开：/Users/me/Downloads/Panecast/a.pdf', error: false } });
  });

  it('explains failures and stops polling an old gateway', async () => {
    const channel = new FakeChannel();
    const store = new SharedFilesStore(channel);
    channel.failure = Object.assign(new Error('文件超过 50 MB'), { code: 'too_large' });
    await store.open({ path: 'big.pdf', name: 'big.pdf', size: 1, mtimeMs: 1 });
    expect(store.getState().message?.error).toBe(true);
    expect(store.getState().busy).toBeNull();
    channel.failure = Object.assign(new Error('分享窗口只能操作被分享的这一个终端'), { code: 'forbidden' });
    await store.refresh();
    expect(store.getState().unsupported).toBe(true);
    const before = channel.calls.length;
    await store.refresh();
    expect(channel.calls.length).toBe(before);
  });
});
