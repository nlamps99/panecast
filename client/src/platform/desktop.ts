import type { SocketLike } from '../protocol/connection';

type SocketEvent = { id: string; type: 'open' | 'message' | 'error' | 'close'; data?: string; code?: number; reason?: string };
export type DesktopBridge = {
  version: number;
  getSecret(key: string): Promise<string | null>;
  setSecret(key: string, value: string): Promise<void>;
  deleteSecret(key: string): Promise<void>;
  request(id: string, url: string, options: { method: string; authorization?: string; body?: string }): Promise<{ status: number; body: string }>;
  abortRequest(id: string): void;
  connectSocket(id: string, url: string, protocols: string[], headers: Record<string, string>): Promise<void>;
  sendSocket(id: string, data: string): void;
  closeSocket(id: string): void;
  onSocket(listener: (event: SocketEvent) => void): () => void;
  dialog(options: { title: string; message?: string; buttons: string[]; cancelId: number }): Promise<number>;
  writeClipboard?(text: string): Promise<boolean>;
};
declare global { interface Window { panecastDesktop?: DesktopBridge } }
export function desktopBridge(): DesktopBridge | null {
  return typeof window !== 'undefined' && window.panecastDesktop?.version === 1 ? window.panecastDesktop : null;
}
/** The desktop app on Windows (WebView2); the Mac app runs in WKWebView. */
export function desktopOnWindows(): boolean {
  return desktopBridge() !== null && typeof navigator !== 'undefined' && /\bWindows\b/.test(navigator.userAgent);
}
let nextId = 0;
const uniqueId = () => `${Date.now()}-${++nextId}`;

/** HTTP uses the same authenticated native transport on mobile and desktop. */
export const serviceFetch: typeof fetch = async (input, init) => {
  const desktop = desktopBridge();
  if (!desktop) return fetch(input, init);
  const id = uniqueId();
  if (init?.signal?.aborted) throw new Error('请求已取消');
  const headers = new Headers(init?.headers);
  const abort = () => desktop.abortRequest(id);
  init?.signal?.addEventListener('abort', abort, { once: true });
  try {
    const result = await desktop.request(id, String(input), {
      method: init?.method ?? 'GET', authorization: headers.get('Authorization') ?? undefined,
      body: typeof init?.body === 'string' ? init.body : undefined,
    });
    if (init?.signal?.aborted) throw new Error('请求已取消');
    return new Response(result.status === 204 ? null : result.body, { status: result.status, headers: { 'Content-Type': 'application/json' } });
  } finally { init?.signal?.removeEventListener('abort', abort); }
};

export class DesktopSocket implements SocketLike {
  readyState = 0;
  onopen: SocketLike['onopen'] = null;
  onmessage: SocketLike['onmessage'] = null;
  onerror: SocketLike['onerror'] = null;
  onclose: SocketLike['onclose'] = null;
  private id = uniqueId();
  private unsubscribe: () => void;
  constructor(private bridge: DesktopBridge, url: string, protocols: string[], headers: Record<string, string>) {
    this.unsubscribe = bridge.onSocket((event) => {
      if (event.id !== this.id || this.readyState === 3) return;
      if (event.type === 'open') { this.readyState = 1; this.onopen?.({}); }
      else if (event.type === 'message') this.onmessage?.({ data: event.data });
      else if (event.type === 'error') this.onerror?.({});
      else this.finish(event.code, event.reason);
    });
    void bridge.connectSocket(this.id, url, protocols, headers).then(() => {
      // The view may have closed while the native socket was being created.
      if (this.readyState >= 2) bridge.closeSocket(this.id);
    }).catch(() => this.finish(1006, '连接失败'));
  }
  send(data: string) {
    if (this.readyState !== 1) throw new Error('连接已断开');
    this.bridge.sendSocket(this.id, data);
  }
  close() {
    if (this.readyState === 3) return;
    this.bridge.closeSocket(this.id);
    this.finish(1000, 'client stopped');
  }
  private finish(code?: number, reason?: string) {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.unsubscribe();
    this.onclose?.({ code, reason });
  }
}
