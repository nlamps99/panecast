import { spawn } from 'node:child_process';
import net from 'node:net';
import { WebSocket } from 'ws';
import { RpcError } from '../tmux.mjs';

const MAX_BYTES = 32 * 1024 * 1024;

/** One connection, with bounded messages and no retry of uncertain mutations. */
export class RpcPeer {
  constructor(options) {
    this.options = options;
    this.pending = new Map();
    this.nextId = 0;
    this.listeners = new Set();
    this.closed = false;
  }

  onMessage(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }

  async connect() {
    if (this.closed) throw new RpcError('offline', '连接已关闭，请刷新连接源');
    if (this.connecting) return this.connecting;
    this.connecting = this.open().catch((error) => {
      // A failed initialize must not leave a permanently rejected connection
      // cached as open. Source monitors may establish a new connection later.
      this.fail(error);
      throw error;
    });
    return this.connecting;
  }

  async open() {
    const o = this.options;
    if (o.command) {
      const child = spawn(o.command, o.args, { env: { ...process.env, ...o.env }, stdio: ['pipe', 'pipe', 'pipe'] });
      this.child = child;
      this.send = (message) => child.stdin.write(JSON.stringify(message) + '\n');
      let buffer = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        buffer += chunk;
        if (Buffer.byteLength(buffer) > MAX_BYTES) { this.fail(new RpcError('too_large', '来源返回的数据过大')); return; }
        let newline;
        while ((newline = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1); if (line.trim()) this.receive(line); }
      });
      // Never echo upstream stderr: it can contain local paths or credentials.
      child.stderr.resume();
      child.stdin.on('error', () => {});
      child.on('error', () => this.fail(new RpcError('offline', '无法启动 Codex，请检查安装和来源配置')));
      child.on('exit', () => this.fail(new RpcError('offline', 'Codex 服务已断开')));
    } else {
      await new Promise((resolve, reject) => {
        const ws = new WebSocket(o.socketPath ? 'ws://localhost/rpc' : o.url, o.protocols ?? [], {
          ...(o.socketPath ? { createConnection: () => net.connect(o.socketPath) } : {}),
          ...(o.token ? { headers: { Authorization: `Bearer ${o.token}` } } : {}),
          maxPayload: MAX_BYTES, handshakeTimeout: 5000,
        });
        this.ws = ws;
        this.send = (message) => { if (ws.readyState !== WebSocket.OPEN) throw new RpcError('offline', '来源已断开'); ws.send(JSON.stringify(message)); };
        ws.on('message', (message) => this.receive(message.toString()));
        ws.once('open', () => { if (o.hello) this.send(o.hello); resolve(); });
        ws.on('error', () => { const error = new RpcError('offline', '无法连接来源，请检查地址和授权'); reject(error); this.fail(error); });
        ws.on('close', () => { const error = new RpcError('offline', '来源已断开'); reject(error); this.fail(error); });
      });
    }
    if (o.codex) {
      await this.request('initialize', { clientInfo: { name: 'panecast', title: 'Panecast', version: '0.1.0' } });
      this.send({ method: 'initialized', params: {} });
    }
  }

  async call(method, params = {}) { await this.connect(); return this.request(method, params); }

  request(method, params) {
    if (this.closed) return Promise.reject(new RpcError('offline', '来源已断开'));
    const id = String(++this.nextId);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new RpcError('timeout', '来源未及时回应；操作结果可能未知，请刷新确认')); }, this.options.timeoutMs ?? 15_000);
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ id, method, params }); } catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }

  receive(text) {
    let message;
    try { message = JSON.parse(text); } catch { this.fail(new RpcError('invalid_response', '来源返回了无效数据')); return; }
    if (message.method === undefined && message.id != null) {
      const pending = this.pending.get(String(message.id));
      if (!pending) return;
      clearTimeout(pending.timer); this.pending.delete(String(message.id));
      if (message.error || message.ok === false) pending.reject(new RpcError(String(message.error?.code ?? 'upstream_error'), message.error?.message ?? '来源拒绝了请求'));
      else pending.resolve(message.result);
    } else {
      if (message.type === 'ping') this.send({ type: 'pong', ts: message.ts });
      for (const listener of this.listeners) listener(message);
    }
  }

  respond(id, result) { this.send({ id, result }); }

  fail(error) {
    if (this.closed) return;
    this.close();
    for (const listener of this.listeners) listener({ method: 'panecast/disconnected', params: {} });
    this.listeners.clear();
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new RpcError('offline', '来源连接已关闭')); }
    this.pending.clear(); this.ws?.terminate();
    // Only terminate the child we launched (or the proxy), never the desktop service.
    if (this.child) { this.child.stdin.end(); this.child.kill('SIGTERM'); }
  }
}

export function localEndpoint(url) {
  const parsed = new URL(url);
  if (!['ws:', 'wss:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.hash) throw new Error('Invalid source WebSocket URL');
  if (parsed.protocol === 'ws:' && !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)) throw new Error('Non-local sources require wss://');
  return parsed.toString();
}
