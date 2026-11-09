import { app, BrowserWindow, dialog, ipcMain, Menu, net, protocol, safeStorage, session, shell } from 'electron';
import { access } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocket } from 'ws';
import { APP_URL, appFrame, assetPath, serviceUrl } from './security.mjs';
import { Vault } from './vault.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
protocol.registerSchemesAsPrivileged([{ scheme: 'panecast-app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);
let window;
const sockets = new Map(), requests = new Map();
const trusted = (event) => event.sender === window?.webContents && event.senderFrame === event.sender.mainFrame && appFrame(event.senderFrame.url);
function requireApp(event) { if (!trusted(event)) throw new Error('Invalid app frame'); }
function disconnect() {
  for (const socket of sockets.values()) socket.terminate();
  sockets.clear();
  for (const request of requests.values()) request.abort();
  requests.clear();
}
function publish(id, payload) { if (window && !window.isDestroyed()) window.webContents.send('panecast:socket:event', { id, ...payload }); }

await app.whenReady();
const vault = new Vault(join(app.getPath('userData'), 'credentials.enc'), safeStorage);
for (const [verb, operation] of [['get', 'get'], ['set', 'set'], ['delete', 'remove']]) {
  ipcMain.handle(`panecast:secret:${verb}`, (event, ...args) => { requireApp(event); return vault[operation](...args); });
}
ipcMain.handle('panecast:request', async (event, id, raw, options = {}) => {
  requireApp(event);
  const url = serviceUrl(raw);
  if (typeof id !== 'string' || requests.has(id) || requests.size >= 32 || !['GET', 'POST', 'PATCH', 'DELETE'].includes(options.method ?? 'GET')) throw new Error('Invalid request');
  if (options.body !== undefined && (typeof options.body !== 'string' || options.body.length > 64 * 1024)) throw new Error('Invalid request body');
  const headers = { 'Content-Type': 'application/json' };
  if (typeof options.authorization === 'string' && /^Bearer [A-Za-z0-9._~-]+$/.test(options.authorization)) headers.Authorization = options.authorization;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  requests.set(id, controller);
  try {
    const result = await fetch(url, { method: options.method ?? 'GET', headers, body: options.body, signal: controller.signal, redirect: 'error' });
    let body = '', size = 0;
    const decoder = new TextDecoder();
    for await (const chunk of result.body ?? []) {
      size += chunk.length;
      if (size > 2 * 1024 * 1024) throw new Error('Response too large');
      body += decoder.decode(chunk, { stream: true });
    }
    body += decoder.decode();
    return { status: result.status, body };
  } catch { throw new Error(controller.signal.aborted ? '请求已取消或超时' : '无法连接服务器，请检查地址和网络。'); }
  finally { clearTimeout(timer); requests.delete(id); }
});
ipcMain.on('panecast:request:abort', (event, id) => { if (trusted(event)) requests.get(id)?.abort(); });
ipcMain.handle('panecast:socket:connect', (event, id, raw, protocols, headers) => {
  requireApp(event);
  const url = serviceUrl(raw, true);
  if (typeof id !== 'string' || sockets.has(id) || sockets.size >= 8 || JSON.stringify(protocols) !== '["cmuxremote.v1"]' || !/^Bearer [A-Za-z0-9._~-]+$/.test(headers?.Authorization)) throw new Error('Invalid connection');
  const socket = new WebSocket(url, protocols, { headers: { Authorization: headers.Authorization }, handshakeTimeout: 15_000, maxPayload: 32 * 1024 * 1024, followRedirects: false });
  sockets.set(id, socket);
  let failure = '';
  socket.on('open', () => publish(id, { type: 'open' }));
  socket.on('message', (data, binary) => { if (!binary) publish(id, { type: 'message', data: data.toString() }); });
  socket.on('unexpected-response', (_request, response) => { failure = `HTTP ${response.statusCode}`; response.resume(); socket.terminate(); });
  socket.on('error', () => publish(id, { type: 'error' }));
  socket.on('close', (code, reason) => { sockets.delete(id); publish(id, { type: 'close', code, reason: failure || reason.toString() }); });
});
ipcMain.on('panecast:socket:send', (event, id, data) => {
  if (!trusted(event) || typeof data !== 'string' || Buffer.byteLength(data) > 32 * 1024 * 1024) return;
  const socket = sockets.get(id);
  if (socket?.readyState === WebSocket.OPEN) socket.send(data);
});
ipcMain.on('panecast:socket:close', (event, id) => {
  if (!trusted(event)) return;
  const socket = sockets.get(id);
  if (!socket) return;
  if (socket.readyState === WebSocket.CONNECTING) socket.terminate();
  else socket.close(1000, 'client stopped');
});
ipcMain.handle('panecast:dialog', async (event, options) => {
  requireApp(event);
  if (!Array.isArray(options?.buttons) || options.buttons.length > 6) throw new Error('Invalid dialog');
  const { response } = await dialog.showMessageBox(window, {
    type: 'question', title: String(options.title).slice(0, 200), message: String(options.title).slice(0, 200),
    detail: String(options.message ?? '').slice(0, 4000), buttons: options.buttons.map((b) => String(b).slice(0, 100)),
    cancelId: options.cancelId, defaultId: options.cancelId ?? 0, noLink: true,
  });
  return response;
});
protocol.handle('panecast-app', async (request) => {
  try {
    let path = assetPath(join(root, 'web'), request.url);
    try { await access(path); }
    catch {
      if (extname(path)) return new Response('Not found', { status: 404 });
      path = join(root, 'web', 'index.html');
    }
    const response = await net.fetch(pathToFileURL(path).href);
    response.headers.set('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' data: blob:; media-src 'self' blob:; object-src 'none'; frame-src 'none'; base-uri 'self'");
    return response;
  } catch { return new Response('Not found', { status: 404 }); }
});
const clipboardPermission = (contents, permission) => contents === window?.webContents && ['clipboard-read', 'clipboard-sanitized-write'].includes(permission);
session.defaultSession.setPermissionCheckHandler((contents, permission, origin) => clipboardPermission(contents, permission) && appFrame(origin));
session.defaultSession.setPermissionRequestHandler((contents, permission, callback) => callback(clipboardPermission(contents, permission)));
function openWindow() {
  window = new BrowserWindow({ width: 1280, height: 860, minWidth: 760, minHeight: 600, title: 'Panecast', backgroundColor: '#1a1b26',
    webPreferences: { preload: join(root, 'src/preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, spellcheck: false } });
  window.webContents.setWindowOpenHandler(({ url }) => { if (/^https:\/\//.test(url)) void shell.openExternal(url); return { action: 'deny' }; });
  window.webContents.on('will-navigate', (event, url) => { if (!appFrame(url)) { event.preventDefault(); if (/^https:\/\//.test(url)) void shell.openExternal(url); } });
  window.webContents.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => { if (mainFrame && !inPlace) disconnect(); });
  window.webContents.on('render-process-gone', disconnect);
  window.on('closed', () => { disconnect(); window = null; });
  void window.loadURL(`${APP_URL}/`);
}
Menu.setApplicationMenu(Menu.buildFromTemplate([
  ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []), { role: 'editMenu' },
  { label: '显示', submenu: [{ role: 'reload' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'togglefullscreen' }] }, { role: 'windowMenu' },
]));
openWindow();
app.on('activate', () => { if (!window) openWindow(); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
