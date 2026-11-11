// Acts as a phone against an installed cmux DR2 gateway over the LAN protocol:
// pairs, opens the WebSocket with its token, finds the cmux DR2 source, creates
// a workspace, types a command and reads the output back from the terminal.
// Usage: node smoke-client.mjs --root <install dir> --port <port> --code <pairing code>
import { createRequire } from 'node:module';
import { join } from 'node:path';

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); if (i < 0 || !args[i + 1]) throw new Error(`${name} is required`); return args[i + 1]; };
const root = flag('--root'), port = Number(flag('--port')), code = flag('--code');
const WebSocket = createRequire(join(root, 'panecast', 'package.json'))('ws');
const wait = (ms) => new Promise((done) => setTimeout(done, ms));
const base = `http://127.0.0.1:${port}`;

let registration;
for (let attempt = 0; !registration; attempt++) {
  try {
    const response = await fetch(`${base}/v1/devices/me/register`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pairing_code: code, client_id: 'smoke-phone', device_name: 'Smoke phone' }) });
    if (response.status !== 200) throw new Error(`register HTTP ${response.status}`);
    registration = await response.json();
  } catch (error) { if (attempt > 60) throw error; await wait(1000); }
}

const socket = new WebSocket(`ws://127.0.0.1:${port}/v1/ws`, ['cmuxremote.v1'], { headers: { Authorization: `Bearer ${registration.token}` } });
const pending = new Map(), frames = [];
let next = 0;
socket.on('message', (data) => {
  const message = JSON.parse(data.toString());
  if (message.id && pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); } else frames.push(message);
});
await new Promise((done, fail) => { socket.once('open', done); socket.once('error', fail); });
socket.send(JSON.stringify({ deviceId: registration.device_id, appVersion: 'smoke', protocolVersion: 1 }));
const call = (method, params = {}) => new Promise((done, fail) => {
  const id = `r${++next}`;
  const timer = setTimeout(() => fail(new Error(`${method} timed out`)), 30_000);
  pending.set(id, (message) => { clearTimeout(timer); message.ok ? done(message.result) : fail(Object.assign(new Error(`${method}: ${message.error?.message}`), { code: message.error?.code })); });
  socket.send(JSON.stringify({ id, method, params }));
});
async function retry(action, label, attempts = 60) {
  for (let attempt = 0; ; attempt++) {
    try { return await action(); } catch (error) { if (attempt >= attempts) throw new Error(`${label}: ${error.message}`); await wait(1000); }
  }
}

const source = await retry(async () => {
  const { sources } = await call('source.list');
  const found = sources.find((s) => s.type === 'cmux-tui');
  if (!found || found.status !== 'online') throw new Error(JSON.stringify(sources));
  return found;
}, 'cmux DR2 source');
const created = await retry(() => call('workspace.create', { source_id: source.id, title: '手机测试' }), 'workspace.create');
const workspaceId = created.workspace_id;
const { workspaces } = await call('workspace.list', { source_id: source.id });
if (!workspaces.some((w) => w.id === workspaceId && w.title === '手机测试')) throw new Error('The new workspace is not listed');
const surfaceId = (await retry(async () => {
  const { surfaces } = await call('surface.list', { workspace_id: workspaceId });
  if (!surfaces.length) throw new Error('no terminal yet');
  return surfaces;
}, 'surface.list'))[0].id;
const target = { workspace_id: workspaceId, surface_id: surfaceId };
await call('surface.subscribe', { ...target, lines: 200 });
const marker = 'panecast-windows-ok';
await wait(2000); // let the shell print its prompt
await call('surface.send_text', { ...target, text: `echo ${marker}` });
await call('surface.send_key', { ...target, key: 'enter' });
// The marker appears twice: in the typed command and in its output.
const text = await retry(async () => {
  const { text: screen } = await call('surface.read_text', { ...target, lines: 200 });
  if (screen.split(marker).length - 1 < 2) throw new Error(screen.slice(-400));
  return screen;
}, 'command output', 30);
await wait(1500);
const streamed = frames.some((frame) => frame.type?.startsWith('screen.') && JSON.stringify(frame).includes(marker));
if (!streamed) throw new Error('The subscription did not stream the output');
console.log(JSON.stringify({ source: source.name, workspace: '手机测试', streamed, lastLines: text.trimEnd().split('\n').slice(-4) }, null, 2));
socket.close();
