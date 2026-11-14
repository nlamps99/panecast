// Test the real cache storage module under Tauri's tauri://localhost origin.
// The QA app has a separate bundle ID and never reads user credentials.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
const desktop = fileURLToPath(new URL('../../', import.meta.url));
const output = fileURLToPath(new URL('../../../build/cache-native-qa/', import.meta.url));
const web = join(output, 'web'); await mkdir(web, { recursive: true });
const require = createRequire(new URL('../../../client/package.json', import.meta.url));
const ts = require('typescript');
const source = await readFile(new URL('../../../client/src/session/cacheStorage.web.ts', import.meta.url), 'utf8');
await writeFile(join(web, 'storage.js'), ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText);
const reports = [];
const server = createServer(async (req, res) => {
  let body = ''; for await (const chunk of req) body += chunk;
  const report = JSON.parse(body); reports.push(report);
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ clear: reports.filter(item => item.phase === 'restored').length >= 2 }));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
await writeFile(join(web, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"><script type="module" src="/smoke.js"></script></head><body>Checking native cache persistence</body></html>');
const namespace = `native-qa-${Date.now()}`;
await writeFile(join(web, 'smoke.js'), `import { cacheStorage } from './storage.js';
const cache = cacheStorage(${JSON.stringify(namespace)});
const expected = JSON.stringify({ text: '本机会话缓存', marker: ${JSON.stringify(namespace)} });
async function report(phase, error) {
 const onStarted = new window.__TAURI__.core.Channel();
 const result = await window.__TAURI__.core.invoke('request', { id: 'cache-qa-' + Date.now(), url: 'http://127.0.0.1:${server.address().port}/v1/health', options: { method: 'POST', body: JSON.stringify({ phase, origin: location.origin, error }) }, onStarted });
 return JSON.parse(result.body);
}
try {
 const saved = await cache.read('conversation.json');
 if (saved === null) { await cache.write('conversation.json', expected); await report('written'); location.reload(); }
 else if (saved === expected) { document.body.textContent = 'Native cache restored'; const result = await report('restored'); if (result.clear) { await cache.clear(); await report('cleared'); } }
 else throw new Error('Cache content mismatch');
} catch (error) { document.body.textContent = String(error); await report('failed', String(error)); }
`);
const config = join(output, 'tauri.qa.json');
await writeFile(config, JSON.stringify({ productName: 'Panecast Cache QA', identifier: 'com.nzx.panecast.cache-qa', build: { frontendDist: web } }));
async function run(command, args, options = {}) {
  const child = spawn(command, args, { cwd: desktop, stdio: 'inherit', ...options });
  const code = await new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
  assert.equal(code, 0);
}
async function waitUntil(check) {
  const deadline = Date.now() + 30_000;
  while (!check()) {
    assert.ok(!reports.some(item => item.phase === 'failed'), JSON.stringify(reports));
    assert.ok(Date.now() < deadline, `Native cache timed out: ${JSON.stringify(reports)}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}
let child;
async function stop() {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGTERM'); await exited; child = null;
}
try {
  await run(process.execPath, [join(desktop, 'node_modules/@tauri-apps/cli/tauri.js'), 'build', '--debug', '--bundles', 'app', '--config', config, '--', '--locked']);
  const executable = join(desktop, 'src-tauri/target/debug/bundle/macos/Panecast Cache QA.app/Contents/MacOS/panecast-desktop');
  child = spawn(executable, [], { stdio: 'ignore' });
  await waitUntil(() => reports.some(item => item.phase === 'restored')); await stop();
  child = spawn(executable, [], { stdio: 'ignore' });
  await waitUntil(() => reports.some(item => item.phase === 'cleared'));
  assert.equal(reports.filter(item => item.phase === 'restored').length, 2);
  assert.ok(reports.every(item => item.origin === 'tauri://localhost'));
  await writeFile(join(output, 'result.json'), JSON.stringify(reports, null, 2));
  console.log('Native WKWebView cache survives page reload and app relaunch. QA cache cleared.');
} finally { await stop(); await new Promise(resolve => server.close(resolve)); }
