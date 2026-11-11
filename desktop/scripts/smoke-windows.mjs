// End-to-end check of the built Windows package on a Windows machine:
// installs it silently, starts the installed app, and pairs it through its own
// interface (UI Automation types a pairing link) with a stand-in relay served
// here. That exercises the native bridge from the app origin: authenticated
// HTTP registration, the credential vault, and the WebSocket with its
// Authorization header, subprotocol and hello. A restart must reconnect with
// the stored credentials alone. Then the app is uninstalled.
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'win32') throw new Error('Run the Windows smoke test on Windows');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(root, '../build/desktop');
const metadata = JSON.parse(readFileSync(join(output, 'desktop-windows-x64.json'), 'utf8'));
const results = join(output, 'smoke');
mkdirSync(results, { recursive: true });
const wait = (ms) => new Promise((done) => setTimeout(done, ms));
async function until(check, timeout, message) {
  for (const deadline = Date.now() + timeout; !(await check());) {
    if (Date.now() > deadline) throw new Error(message);
    await wait(500);
  }
}

// ---- Stand-in relay: registration over HTTP, then the WebSocket protocol.
const RELAY = 'smoke-relay', CODE = 'smoke-code', DEVICE = 'smoke-device', TOKEN = 'smoke-token-7f3a';
const relay = { registrations: [], sockets: [], requests: [] };
const server = createServer((request, response) => {
  let body = '';
  request.on('data', (chunk) => { body += chunk; });
  request.on('end', () => {
    relay.requests.push(`${request.method} ${request.url}`);
    let reply = { ok: true };
    if (request.method === 'POST' && request.url === '/v1/devices/me/register') {
      relay.registrations.push({ body: JSON.parse(body || '{}'), contentType: request.headers['content-type'] ?? null });
      reply = { device_id: DEVICE, token: TOKEN };
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(reply));
  });
});
function frame(text) {
  const payload = Buffer.from(text);
  const header = payload.length < 126 ? Buffer.from([0x81, payload.length])
    : payload.length < 65536 ? Buffer.from([0x81, 126, payload.length >> 8, payload.length & 255])
      : Buffer.concat([Buffer.from([0x81, 127]), (() => { const size = Buffer.alloc(8); size.writeBigUInt64BE(BigInt(payload.length)); return size; })()]);
  return Buffer.concat([header, payload]);
}
server.on('upgrade', (request, socket) => {
  const record = { path: request.url, authorization: request.headers.authorization ?? null,
    protocol: request.headers['sec-websocket-protocol'] ?? null, hello: null, helloAfterMs: null, methods: [] };
  relay.sockets.push(record);
  const accept = createHash('sha1').update(`${request.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
  socket.write(['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${accept}`, 'Sec-WebSocket-Protocol: cmuxremote.v1', '', ''].join('\r\n'));
  const opened = Date.now();
  let buffer = Buffer.alloc(0);
  socket.on('error', () => {});
  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      if (buffer.length < 2) return;
      const opcode = buffer[0] & 15;
      let length = buffer[1] & 127, offset = 2;
      if (length === 126) { if (buffer.length < 4) return; length = buffer.readUInt16BE(2); offset = 4; }
      else if (length === 127) { if (buffer.length < 10) return; length = Number(buffer.readBigUInt64BE(2)); offset = 10; }
      const masked = buffer[1] & 128;
      if (buffer.length < offset + (masked ? 4 : 0) + length) return;
      const mask = masked ? buffer.subarray(offset, offset + 4) : null;
      offset += masked ? 4 : 0;
      const payload = Buffer.from(buffer.subarray(offset, offset + length));
      if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
      buffer = buffer.subarray(offset + length);
      if (opcode === 8) { socket.end(); return; }
      if (opcode === 9) { socket.write(Buffer.concat([Buffer.from([0x8a, payload.length]), payload])); continue; }
      if (opcode !== 1) continue;
      const message = JSON.parse(payload.toString());
      if (!record.hello) { record.hello = message; record.helloAfterMs = Date.now() - opened; continue; }
      if (message.type === 'ping') { socket.write(frame(JSON.stringify({ type: 'pong' }))); continue; }
      if (message.id === undefined) continue;
      record.methods.push(message.method);
      const result = message.method === 'workspace.list' ? { workspaces: [] } : {};
      socket.write(frame(JSON.stringify({ id: message.id, ok: true, result })));
    }
  });
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const pairing = `cmux://pair?server=http://127.0.0.1:${server.address().port}&relay=${RELAY}&code=${CODE}`;

// ---- Install, start, pair, restart.
execFileSync(join(output, metadata.file), ['/S'], { stdio: 'inherit' });
const installation = join(process.env.LOCALAPPDATA, 'Panecast');
const program = readdirSync(installation).find((name) => /\.exe$/i.test(name) && !/^uninstall/i.test(name));
if (!program) throw new Error(`No program installed in ${installation}`);
const vaultFile = join(process.env.LOCALAPPDATA, 'com.nzx.panecast.desktop', 'credentials-v2.enc');

function screenshot(name) {
  const script = `Add-Type -AssemblyName System.Windows.Forms,System.Drawing
$b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$i=New-Object System.Drawing.Bitmap $b.Width,$b.Height
[System.Drawing.Graphics]::FromImage($i).CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$b.Size)
$i.Save('${join(results, name).replace(/'/g, "''")}')`;
  try { execFileSync('powershell', ['-NoProfile', '-Command', script], { stdio: 'inherit' }); } catch { console.log('Screenshot unavailable'); }
}
function launch() {
  const child = spawn(join(installation, program), [], { detached: true, stdio: 'ignore' });
  child.exited = null;
  child.on('exit', (code) => { child.exited = code; });
  return child;
}
function quit(child) {
  try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* already closed */ }
}
const mainWindow = (child) => {
  try {
    return execFileSync('powershell', ['-NoProfile', '-Command', `(Get-Process -Id ${child.pid}).MainWindowTitle`], { encoding: 'utf8' }).trim();
  } catch { return ''; }
};

const problems = [];
const check = (ok, name) => { if (!ok) problems.push(name); };
let app = launch();
try {
  await until(() => app.exited === null && mainWindow(app) === 'Panecast', 60_000, 'The app window did not appear');
  await wait(5000);
  screenshot('launch.png');
  execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(root, 'scripts/smoke-windows-type.ps1'),
    '-ProcessId', String(app.pid), '-Text', pairing], { stdio: 'inherit' });
  await until(() => relay.sockets.some((socket) => socket.hello), 60_000, 'The app did not pair and connect');
  await wait(3000);
  screenshot('paired.png');
  const [registration] = relay.registrations;
  check(registration?.body.relay_id === RELAY && registration.body.pairing_code === CODE && registration.body.client_id, 'registration');
  const first = relay.sockets.find((socket) => socket.hello);
  check(first.path === `/v1/ws?relay_id=${RELAY}`, 'socket path');
  check(first.authorization === `Bearer ${TOKEN}`, 'socket authorization');
  check(first.protocol?.split(/,\s*/).includes('cmuxremote.v1'), 'socket subprotocol');
  check(first.hello.deviceId === DEVICE && first.hello.protocolVersion === 1, 'hello');
  check(existsSync(vaultFile) && !readFileSync(vaultFile).includes(TOKEN), 'encrypted vault');

  // The stored credentials alone must bring the connection back after a restart.
  quit(app);
  await until(() => app.exited !== null, 15_000, 'The app did not quit');
  const before = relay.sockets.length;
  app = launch();
  await until(() => relay.sockets.slice(before).some((socket) => socket.hello), 60_000, 'The app did not reconnect after a restart');
  const again = relay.sockets.slice(before).find((socket) => socket.hello);
  check(again.authorization === `Bearer ${TOKEN}` && again.hello.deviceId === DEVICE, 'reconnect with stored credentials');
  check(relay.registrations.length === 1, 'no second pairing');
  await wait(3000);
  screenshot('restarted.png');
  check(app.exited === null, 'app still running');
} catch (error) {
  screenshot('failure.png');
  problems.push(error.message);
} finally {
  quit(app);
  server.close();
}
const report = { program, problems, requests: relay.requests,
  sockets: relay.sockets.map(({ authorization, hello, ...rest }) => ({ ...rest, authorized: authorization === `Bearer ${TOKEN}`, hello: Boolean(hello) })) };
writeFileSync(join(results, 'result.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
if (problems.length) throw new Error(`Smoke test failed: ${problems.join('; ')}`);

await wait(2000);
execFileSync(join(installation, 'uninstall.exe'), ['/S'], { stdio: 'inherit' });
await until(() => !existsSync(join(installation, program)), 30_000, 'Uninstall left the program in place');
console.log('Installed, paired, reconnected and uninstalled', metadata.file);
