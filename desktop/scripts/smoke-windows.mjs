// Installs the built Windows package silently, starts the installed app and
// checks it through WebView2's DevTools port: the bundled page loads at the
// app origin, and the native bridge accepts its commands (authenticated HTTP
// transport, credential vault backed by Credential Manager). Then uninstalls.
import { execFileSync, spawn } from 'node:child_process';
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

execFileSync(join(output, metadata.file), ['/S'], { stdio: 'inherit' });
const installation = join(process.env.LOCALAPPDATA, 'Panecast');
const program = readdirSync(installation).find((name) => /\.exe$/i.test(name) && !/^uninstall/i.test(name));
if (!program) throw new Error(`No program installed in ${installation}`);

const server = createServer((request, response) => {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ path: request.url, authorization: request.headers.authorization ?? null }));
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const port = 9333;
const app = spawn(join(installation, program), [], {
  env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` },
  detached: true, stdio: 'ignore',
});
let exited = null;
app.on('exit', (code) => { exited = code; });

function screenshot(name) {
  const script = `Add-Type -AssemblyName System.Windows.Forms,System.Drawing
$b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$i=New-Object System.Drawing.Bitmap $b.Width,$b.Height
[System.Drawing.Graphics]::FromImage($i).CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$b.Size)
$i.Save('${join(results, name).replace(/'/g, "''")}')`;
  try { execFileSync('powershell', ['-NoProfile', '-Command', script], { stdio: 'inherit' }); } catch { console.log('Screenshot unavailable'); }
}

let report;
try {
  let page;
  for (const deadline = Date.now() + 90_000; !page;) {
    if (exited !== null) throw new Error(`The app exited with code ${exited}`);
    if (Date.now() > deadline) throw new Error('The app page did not appear');
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      page = targets.find((target) => target.type === 'page' && target.url.startsWith('http://tauri.localhost/'));
    } catch { /* WebView2 is still starting */ }
    if (!page) await wait(1000);
  }
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((done, fail) => { socket.onopen = done; socket.onerror = fail; });
  const pending = new Map();
  let next = 0;
  socket.onmessage = ({ data }) => { const message = JSON.parse(data); pending.get(message.id)?.(message); pending.delete(message.id); };
  const evaluate = (expression) => new Promise((done, fail) => {
    const id = ++next;
    pending.set(id, (message) => {
      const details = message.result?.exceptionDetails;
      if (message.error || details) fail(new Error(JSON.stringify(message.error ?? details.exception?.description ?? details)));
      else done(message.result.result.value);
    });
    socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
  });
  let text = '';
  for (const deadline = Date.now() + 60_000; text.trim().length < 2;) {
    if (Date.now() > deadline) throw new Error('The interface did not render');
    text = await evaluate('document.body ? document.body.innerText : ""');
    if (text.trim().length < 2) await wait(1000);
  }
  await wait(3000);
  screenshot('launch.png');
  report = await evaluate(`(async () => {
    const desktop = window.panecastDesktop;
    const response = await desktop.request('smoke-request', 'http://127.0.0.1:${server.address().port}/v1/health',
      { method: 'GET', authorization: 'Bearer smoke-token' });
    const previous = await desktop.getSecret('panecast.pairing.v1');
    await desktop.setSecret('panecast.pairing.v1', 'smoke-value');
    const stored = await desktop.getSecret('panecast.pairing.v1');
    if (previous === null) await desktop.deleteSecret('panecast.pairing.v1');
    else await desktop.setSecret('panecast.pairing.v1', previous);
    const restored = await desktop.getSecret('panecast.pairing.v1');
    let rejected = false;
    try { await desktop.request('smoke-reject', 'http://example.com/v1/health', { method: 'GET' }); } catch { rejected = true; }
    return { origin: location.origin, userAgent: navigator.userAgent, status: response.status, body: JSON.parse(response.body),
      stored, restored: restored === previous, rejected, text: document.body.innerText.slice(0, 600) };
  })()`);
  const problems = [];
  if (report.origin !== 'http://tauri.localhost') problems.push('origin');
  if (report.status !== 200 || report.body.path !== '/v1/health' || report.body.authorization !== 'Bearer smoke-token') problems.push('transport');
  if (report.stored !== 'smoke-value' || !report.restored) problems.push('vault');
  if (!report.rejected) problems.push('transport scope');
  if (!/\bWindows\b/.test(report.userAgent)) problems.push('platform detection');
  if (exited !== null) problems.push('app exited');
  writeFileSync(join(results, 'result.json'), `${JSON.stringify({ ...report, program, problems }, null, 2)}\n`);
  console.log(JSON.stringify({ ...report, program, problems }, null, 2));
  socket.close();
  if (problems.length) throw new Error(`Smoke test failed: ${problems.join(', ')}`);
} catch (error) {
  screenshot('failure.png');
  throw error;
} finally {
  server.close();
  try { execFileSync('taskkill', ['/PID', String(app.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* already closed */ }
}

await wait(2000);
execFileSync(join(installation, 'uninstall.exe'), ['/S'], { stdio: 'inherit' });
for (const deadline = Date.now() + 30_000; existsSync(join(installation, program));) {
  if (Date.now() > deadline) throw new Error('Uninstall left the program in place');
  await wait(1000);
}
console.log('Installed, launched, verified and uninstalled', metadata.file);
