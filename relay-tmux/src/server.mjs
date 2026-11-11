import { randomBytes, randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { readFile, mkdir, writeFile, chmod, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { WebSocket, WebSocketServer } from 'ws';
import { TmuxBackend, RpcError } from './tmux.mjs';
import { PushService, writeJSON } from './push.mjs';
import { InboxJournal } from './inbox.mjs';
import { notificationSignal } from './notification-signal.mjs';
import { isNamedPipe, notifySocketPath } from './platform.mjs';

const MAX_MESSAGE = 32 * 1024 * 1024;
const hash = (value) => createHash('sha256').update(String(value)).digest();
const equal = (a, b) => timingSafeEqual(hash(a), hash(b));
const clamp = (n, fallback, max) => Number.isInteger(n) ? Math.min(max, Math.max(1, n)) : fallback;
const json = (response, status, body) => { response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); response.end(JSON.stringify(body)); };
const bearer = (request) => /^Bearer (.+)$/i.exec(request.headers.authorization ?? '')?.[1];
const privateIP = (ip = '') => /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip.replace(/^::ffff:/, '')) || ip === '::1';
async function bodyJSON(request) {
  const parts = []; let size = 0;
  for await (const chunk of request) { size += chunk.length; if (size > 65_536) throw new Error('request too large'); parts.push(chunk); }
  return JSON.parse(Buffer.concat(parts).toString() || '{}');
}

export class RelaySession {
  constructor(backend, config, send, close, notify) {
    this.backend = backend; this.config = config; this.send = send; this.close = close; this.notify = notify;
    this.hello = false; this.disposed = false; this.subscriptions = new Map(); this.history = new Map(); this.queue = Promise.resolve();
    this.timer = setTimeout(() => { if (!this.hello) close(); }, 100);
  }
  dispose() { this.disposed = true; clearTimeout(this.timer); this.subscriptions.clear(); this.history.clear(); }
  receive(text) { this.queue = this.queue.then(() => this.process(text)).catch(() => this.close()); }
  async process(text) {
    if (this.disposed) return;
    let request; try { request = JSON.parse(text); } catch { this.close(); return; }
    if (!this.hello) {
      if (request.protocolVersion !== 1 || typeof request.deviceId !== 'string') { this.close(); return; }
      this.hello = true; clearTimeout(this.timer); return;
    }
    if (typeof request.id !== 'string' || typeof request.method !== 'string') return;
    try {
      const result = request.method === 'inbox.sync' && this.inboxSync
        ? await this.inboxSync(request.params ?? {}) : await this.dispatch(request.method, request.params ?? {});
      if (!this.disposed) this.send({ id: request.id, ok: true, result });
    } catch (error) { if (!this.disposed) this.send({ id: request.id, ok: false, error: { code: error.code ?? 'internal_error', message: error.message } }); }
  }
  async dispatch(method, p) {
    if (method === 'relay.info') return { backend: 'tmux', max_message_bytes: MAX_MESSAGE, max_upload_bytes: 12 * 1024 * 1024 };
    if (method === 'relay.snippets') return { snippets: this.config.snippets ?? [] };
    if (method === 'surface.subscribe') {
      await this.backend.surface(p);
      if (!this.subscriptions.has(p.surface_id) && this.subscriptions.size >= 4) throw new RpcError('limit', '同时最多查看 4 个终端');
      const sub = { ...p, lines: clamp(p.lines, 120, 2000), rev: 0, last: null, busy: false };
      this.subscriptions.set(p.surface_id, sub); await this.poll(sub); return {};
    }
    if (method === 'surface.unsubscribe') { this.subscriptions.delete(p.surface_id); return {}; }
    if (method === 'surface.history') return this.historyPage(p);
    if (method === 'notification.create') {
      await this.backend.surface(p);
      const notification = { ...p, id: randomUUID(), title: String(p.title ?? '终端通知').slice(0, 300), body: String(p.body ?? '').slice(0, 2000), ts: Date.now() / 1000 };
      await this.notify(notification); return notification;
    }
    if (method === 'file.upload') {
      if (typeof p.data_base64 !== 'string' || p.data_base64.length > 16 * 1024 * 1024 || !/^[\w+/]*={0,2}$/.test(p.data_base64)) throw new RpcError('upload_failed', '图片过大或格式无效');
      const data = Buffer.from(p.data_base64, 'base64');
      const name = `${Date.now()}-${randomBytes(4).toString('hex')}-${String(p.filename ?? 'image.png').replace(/[^\p{L}\p{N}._-]/gu, '_').slice(-120)}`;
      const directory = this.config.upload_directory ?? join(homedir(), 'Downloads', 'cmux-remote');
      await mkdir(directory, { recursive: true }); const path = join(directory, name); await writeFile(path, data, { mode: 0o600 });
      return { path, filename: name, size: data.length, mime_type: p.mime_type ?? 'image/png' };
    }
    const result = await this.backend.dispatch(method, p);
    if (/^(workspace|surface)\.(create|close|rename)$/.test(method)) this.notify({ category: method.split('.')[0], name: `${method}d`, workspace_id: p.workspace_id });
    return result;
  }
  async historyPage(p) {
    const limit = clamp(p.limit, 200, 1000);
    let snapshot, end, id, first = false, anchor;
    if (p.cursor) {
      const [key, offset] = String(p.cursor).split(':'); id = key; snapshot = this.history.get(id); end = Number(offset);
      if (!snapshot || snapshot.expires < Date.now() || snapshot.workspace !== p.workspace_id || snapshot.surface !== p.surface_id || !Number.isInteger(end) || end < 0 || end > snapshot.rows.length) throw new RpcError('history_unavailable', '历史快照已过期，请回到底部后重试');
    } else {
      const captured = await this.backend.capture(p, 20_000);
      id = randomUUID(); snapshot = { rows: captured.rows, workspace: p.workspace_id, surface: p.surface_id, expires: Date.now() + 300_000 };
      const tail = clamp(p.tail_lines, 120, 2000); end = Math.max(0, snapshot.rows.length - tail); anchor = snapshot.rows.slice(end); first = true;
      this.history.set(id, snapshot); while (this.history.size > 8) this.history.delete(this.history.keys().next().value);
    }
    const start = Math.max(0, end - limit);
    return { rows: snapshot.rows.slice(start, end), next_cursor: start ? `${id}:${start}` : null, ...(first ? { anchor_rows: anchor } : {}) };
  }
  async poll(sub) {
    if (sub.busy || this.disposed) return; sub.busy = true;
    try {
      const { rows, surface } = await this.backend.capture(sub, sub.lines);
      if (this.disposed || this.subscriptions.get(sub.surface_id) !== sub) return;
      const current = { rows, cursor: surface.cursor, cols: surface.cols };
      if (JSON.stringify(current) === JSON.stringify(sub.last)) return;
      const previous = sub.last; sub.last = current;
      if (previous && previous.rows.length === rows.length && previous.cols === surface.cols) {
        const ops = rows.flatMap((text, y) => text === previous.rows[y] ? [] : [{ op: 'row', y, text }]);
        ops.push({ op: 'cursor', ...surface.cursor });
        this.send({ type: 'screen.diff', surface_id: sub.surface_id, rev: ++sub.rev, ops });
      } else this.send({ type: 'screen.full', surface_id: sub.surface_id, rev: ++sub.rev, rows, cols: surface.cols, rowsCount: rows.length, cursor: surface.cursor });
    } catch { /* A closed pane is reconciled by the workspace refresh. */ }
    finally { sub.busy = false; }
  }
  tick() { for (const sub of this.subscriptions.values()) void this.poll(sub); }
}

export async function createTmuxRelay(config, options = {}) {
  const backend = options.backend ?? new TmuxBackend({ socketName: config.tmux_socket });
  const stateDirectory = config.state_directory ?? join(homedir(), '.cmuxremote', 'tmux');
  const journal = options.journal ?? new InboxJournal(join(stateDirectory, 'inbox-events.json'));
  await journal.load();
  const devicesFile = join(stateDirectory, 'devices.json');
  let devices = {}; try { const parsed = JSON.parse(await readFile(devicesFile, 'utf8')); if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) devices = parsed; } catch {}
  let deviceWrites = Promise.resolve();
  const persistDevices = () => { const snapshot = { ...devices }; deviceWrites = deviceWrites.catch(() => {}).then(() => writeJSON(devicesFile, snapshot)); return deviceWrites; };
  const sessions = new Map(), attempts = new Map();
  const push = options.push ?? new PushService({ path: join(stateDirectory, `push-${hash(config.broker?.url + '|' + config.broker?.relay_id).toString('hex')}.json`), relayId: config.broker?.relay_id, config: config.apns });
  await push.load();
  let tunnel, reconnect, stopped = false, backoff = 1000, ownsNotifySocket = false;
  let publishing = Promise.resolve();
  function ingestEvent(frame, { replay = false } = {}) {
    const publish = publishing.catch(() => {}).then(async () => {
      const retained = await journal.append(frame);
      const events = retained && retained.category !== frame.category ? [frame, retained]
        : [retained ? { ...frame, payload: { ...frame.payload, ...retained.payload } } : frame];
      for (const event of events) for (const session of sessions.values()) if (session.hello) session.send(event);
      return retained;
    });
    publishing = publish.then(() => {});
    return publish.then(async (event) => { if (!replay && event && notificationSignal(event)) await push.notify(event.payload); });
  }
  function notify(payload) {
    return ingestEvent({ type: 'event', category: payload.category ?? 'notification', name: payload.name ?? 'notification.created', payload });
  }
  function createSession(id, send, close) {
    sessions.get(id)?.dispose();
    const session = options.createSession
      ? options.createSession({ send, close, notify })
      : new RelaySession(backend, config, send, close, notify);
    session.inboxSync = (params) => journal.page(params, options.allowInboxEvent);
    sessions.set(id, session); return session;
  }
  function remove(id) { sessions.get(id)?.dispose(); sessions.delete(id); }
  function connectBroker() {
    if (!config.broker || stopped) return;
    const url = new URL(config.broker.url);
    if (!['https:', 'wss:'].includes(url.protocol) && !( ['http:', 'ws:'].includes(url.protocol) && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('broker.url requires HTTPS');
    if (url.username || url.password || url.hash || url.search || !config.broker.relay_token || !config.broker.relay_id) throw new Error('invalid broker configuration');
    url.protocol = ['https:', 'wss:'].includes(url.protocol) ? 'wss:' : 'ws:';
    url.pathname = url.pathname.replace(/\/$/, '') + '/v1/relay/ws'; url.searchParams.set('relay_id', config.broker.relay_id);
    const socket = new WebSocket(url, { headers: { Authorization: `Bearer ${config.broker.relay_token}` }, maxPayload: MAX_MESSAGE, handshakeTimeout: 10_000 });
    tunnel = socket; let openedAt = 0, alive = true;
    const send = (envelope) => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(envelope)); };
    socket.on('open', () => { openedAt = Date.now(); }); socket.on('pong', () => { alive = true; });
    const heartbeat = setInterval(() => { if (socket.readyState !== WebSocket.OPEN) return; if (!alive) { socket.terminate(); return; } alive = false; socket.ping(); }, 20_000);
    socket.on('message', (data) => {
      let e; try { e = JSON.parse(data.toString()); } catch { socket.close(); return; }
      if (e.type === 'session.open' && typeof e.device_id === 'string') createSession(`broker:${e.session_id}`, (frame) => send({ type: 'session.text', session_id: e.session_id, text: JSON.stringify(frame) }), () => { send({ type: 'session.close', session_id: e.session_id }); remove(`broker:${e.session_id}`); });
      else if (e.type === 'session.text' && typeof e.text === 'string') sessions.get(`broker:${e.session_id}`)?.receive(e.text);
      else if (e.type === 'session.close') remove(`broker:${e.session_id}`);
      else if (['push.sync', 'push.register', 'push.test'].includes(e.type)) {
        void push.receive(e).then((result) => { if (result) send({ type: 'push.result', session_id: e.session_id, text: JSON.stringify(result) }); }).catch(() => send({ type: 'push.result', session_id: e.session_id, text: JSON.stringify({ ok: false, error: 'push_registration_failed' }) }));
      }
    });
    socket.on('error', () => {});
    socket.on('close', () => {
      clearInterval(heartbeat); push.suspend();
      for (const id of sessions.keys()) if (id.startsWith('broker:')) remove(id);
      if (openedAt && Date.now() - openedAt > 5000) backoff = 1000;
      if (!stopped) { reconnect = setTimeout(connectBroker, backoff); backoff = Math.min(30_000, backoff * 2); }
    });
  }
  const authenticated = (request) => { const token = bearer(request); return token ? Object.entries(devices).find(([, d]) => equal(d.token_hash, hash(token).toString('hex')))?.[0] : undefined; };
  const server = http.createServer(async (request, response) => {
    const path = new URL(request.url, 'http://localhost').pathname;
    try {
      if (request.method === 'GET' && path === '/v1/health') { json(response, 200, { ok: true, backend: options.backendName ?? 'tmux' }); return; }
      if (request.method === 'POST' && path === '/v1/devices/me/register') {
        const ip = request.socket.remoteAddress;
        if (!config.lan?.pairing_code || !privateIP(ip)) { json(response, 403, { error: 'pairing_rejected' }); return; }
        const now = Date.now(); for (const [key, values] of attempts) if (values.every((at) => at < now - 60_000)) attempts.delete(key);
        const recent = (attempts.get(ip) ?? []).filter((at) => at > now - 60_000);
        if (recent.length >= 5) { json(response, 429, { error: 'too_many_attempts' }); return; }
        attempts.set(ip, [...recent, now]); const body = await bodyJSON(request);
        if (!equal(body.pairing_code ?? '', config.lan.pairing_code) || typeof body.client_id !== 'string' || typeof body.device_name !== 'string') { json(response, 403, { error: 'pairing_rejected' }); return; }
        for (const [id, device] of Object.entries(devices)) if (device.client_id === body.client_id) { delete devices[id]; disconnectDevice(id); }
        const id = randomUUID(), token = randomBytes(32).toString('base64url');
        devices[id] = { client_id: body.client_id, name: body.device_name, token_hash: hash(token).toString('hex') }; await persistDevices();
        json(response, 200, { device_id: id, token }); return;
      }
      const id = authenticated(request);
      if (!id) { json(response, 401, { error: 'unauthorized' }); return; }
      if (request.method === 'DELETE' && path === '/v1/devices/me') { delete devices[id]; disconnectDevice(id); await persistDevices(); json(response, 200, { ok: true }); return; }
      // Push uses the broker's authenticated registration route on both platforms.
      json(response, 404, { error: 'not_found' });
    } catch { json(response, 400, { error: 'invalid_request' }); }
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE });
  function disconnectDevice(deviceId) {
    for (const ws of wss.clients) if (ws.deviceId === deviceId) ws.terminate();
  }
  server.on('upgrade', (request, socket, head) => {
    const deviceId = authenticated(request);
    if (new URL(request.url, 'http://localhost').pathname !== '/v1/ws' || !deviceId) { socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); return; }
    wss.handleUpgrade(request, socket, head, (ws) => {
      ws.deviceId = deviceId;
      const id = `lan:${randomUUID()}`;
      const session = createSession(id, (frame) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame)); }, () => { ws.close(); remove(id); });
      ws.on('message', (data) => session.receive(data.toString())); ws.on('close', () => remove(id)); ws.on('error', () => {});
    });
  });
  const poll = setInterval(() => { for (const session of sessions.values()) session.tick(); }, Math.max(100, clamp(config.poll_ms, 250, 5000)));
  poll.unref();
  const notifyPath = notifySocketPath({ ...config, state_directory: stateDirectory });
  const pipe = isNamedPipe(notifyPath);
  const notifyServer = net.createServer((socket) => {
    let text = ''; socket.setTimeout(2000, () => socket.destroy());
    socket.on('error', () => {});
    socket.on('data', (data) => { text += data; if (text.length > 16_384) { socket.destroy(); return; } if (!text.includes('\n')) return;
      socket.pause();
      void (async () => {
        const payload = JSON.parse(text.slice(0, text.indexOf('\n'))); await backend.surface(payload);
        await notify({ id: randomUUID(), ...payload, title: String(payload.title ?? '终端通知').slice(0, 300), body: String(payload.body ?? '').slice(0, 2000), ts: Date.now() / 1000 });
        socket.end('{"ok":true}\n');
      })().catch(() => socket.end('{"ok":false}\n'));
    });
  });
  return {
    backend, sessions, notify, ingestEvent, journal,
    async start() {
      await mkdir(pipe ? stateDirectory : dirname(notifyPath), { recursive: true, mode: 0o700 });
      // Refuse an existing socket rather than disconnecting another running relay.
      await new Promise((res, rej) => { notifyServer.once('error', rej); notifyServer.listen(notifyPath, res); });
      ownsNotifySocket = !pipe;
      if (!pipe) await chmod(notifyPath, 0o600);
      if (config.lan) await new Promise((res, rej) => { server.once('error', rej); server.listen(config.port ?? 4399, config.host ?? '127.0.0.1', res); });
      connectBroker(); return server.address();
    },
    async close() {
      stopped = true; clearTimeout(reconnect); clearInterval(poll); tunnel?.terminate(); push.suspend();
      for (const session of sessions.values()) session.dispose(); sessions.clear();
      for (const ws of wss.clients) ws.terminate(); wss.close();
      if (server.listening) await new Promise((res) => server.close(res));
      if (notifyServer.listening) await new Promise((res) => notifyServer.close(res));
      if (ownsNotifySocket) await unlink(notifyPath).catch(() => {});
      await deviceWrites; await publishing.catch(() => {}); await journal.writes.catch(() => {});
    },
  };
}
