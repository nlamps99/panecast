import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { access, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { writeInitialConfig, brokerURL, lanAddress, setup } from '../src/installation.mjs';
import { renderPlist } from '../src/service.mjs';

const cli = fileURLToPath(new URL('../bin/panecast.mjs', import.meta.url));
const brokerMissing = !existsSync(fileURLToPath(new URL('../../broker/node_modules/ws/package.json', import.meta.url))) && 'Run npm ci in broker/ to test enrollment against the real broker';
const quiet = async (operation) => {
  const log = console.log; console.log = () => {};
  try { return await operation(); } finally { console.log = log; }
};
function run(args, input = '') {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', (data) => { stdout += data; }); child.stderr.on('data', (data) => { stderr += data; });
    child.once('error', reject); child.once('exit', (code) => resolve({ code, stdout, stderr })); child.stdin.end(input);
  });
}

test('first-run config keeps credentials private and refuses to replace existing pairing', async (t) => {
  const directory = await mkdtemp('/tmp/pc-install-'); t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'hub-relay.json');
  const options = { url: 'https://relay.example.com/panecast/', relayId: 'my-mac', token: 'relay-secret', source: 'tmux', lan: true };
  const config = await writeInitialConfig(path, options);
  assert.equal(config.broker.url, 'https://relay.example.com/panecast');
  assert.equal(config.sources[0].access, 'control');
  assert.equal(config.sources[1].enabled, false);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.notEqual(config.lan.pairing_code, options.token);
  const before = await readFile(path, 'utf8');
  await assert.rejects(writeInitialConfig(path, { ...options, token: 'new-secret' }), { code: 'EEXIST' });
  assert.equal(await readFile(path, 'utf8'), before);
  const setup = await run(['setup', '--config', path]);
  assert.equal(setup.code, 0); assert.ok(!setup.stdout.includes('relay-secret'));
});

test('installed command delegates source management and generates an app-compatible QR payload', async (t) => {
  const directory = await mkdtemp('/tmp/pc-cli-'); t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'hub-relay.json');
  await writeInitialConfig(path, { url: 'https://relay.example.com', relayId: 'test-mac', token: 'relay-secret', lan: true });
  let result = await run(['sources', 'grant', 'tmux', '--access', 'control', '--config', path]);
  assert.equal(result.code, 0, result.stderr);
  result = await run(['sources', 'list', '--config', path]);
  assert.match(result.stdout, /tmux\ttmux\tcontrol/);
  result = await run(['pair', '--config', path, '--lan-host', '192.168.20.2', '--url-only'], 'phone-pairing-code\n');
  assert.equal(result.code, 0, result.stderr);
  const url = new URL(result.stdout.trim());
  assert.equal(url.protocol, 'cmux:'); assert.equal(url.hostname, 'pair');
  assert.equal(url.searchParams.get('server'), 'https://relay.example.com');
  assert.equal(url.searchParams.get('relay'), 'test-mac');
  assert.equal(url.searchParams.get('code'), 'phone-pairing-code');
  assert.equal(url.searchParams.get('lan'), 'http://192.168.20.2:4400');
  assert.ok(url.searchParams.get('lancode')); assert.ok(!result.stdout.includes('relay-secret'));
});

test('setup rejects unsafe broker endpoints and chooses a real private interface', () => {
  for (const value of ['http://example.com', 'https://user:pass@example.com', 'https://example.com/?token=x', 'https://example.com/#x']) assert.throws(() => brokerURL(value));
  assert.equal(lanAddress({ utun0: [{ address: '10.0.0.1', family: 'IPv4' }], en0: [{ address: '192.168.1.2', family: 'IPv4' }] }), '192.168.1.2');
  assert.equal(lanAddress({ en0: [{ address: '100.64.0.1', family: 'IPv4' }] }), undefined);
});

test('LaunchAgent handles spaces and XML characters without embedding credentials', () => {
  const plist = renderPlist({ label: 'com.example.panecast', launcher: '/Users/A & B/bin/panecast', config: '/Users/A & B/config.json', logDirectory: '/Users/A & B/log', path: '/bin:/Users/A & B/bin' });
  assert.ok(plist.includes('/Users/A &amp; B/bin/panecast'));
  assert.ok(plist.includes('<string>--config</string>'));
  assert.ok(!plist.includes('relay_token'));
  assert.throws(() => renderPlist({ label: '../bad', launcher: 'relative', config: 'relative' }));
});

test('setup with only an account gets credentials from the broker and pair needs no code', { skip: brokerMissing }, async (t) => {
  const { createBrokerServer } = await import('../../broker/src/server.mjs');
  const directory = await mkdtemp('/tmp/pc-enroll-');
  const broker = await createBrokerServer({ host: '127.0.0.1', port: 0, dataFile: join(directory, 'broker', 'devices.json'), logger: { error() {} } });
  const base = `http://127.0.0.1:${(await broker.listen()).port}`;
  t.after(async () => { await broker.close(); await rm(directory, { recursive: true, force: true }); });
  const viaLocalBroker = (url, init) => fetch(String(url).replace('https://relay.example.com', base), init);
  const password = 'a sufficiently long test password';
  const phone = await (await fetch(`${base}/v1/account/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'alice', password, device_name: 'Phone' }) })).json();

  const path = join(directory, 'hub-relay.json'), passwordFile = join(directory, 'password');
  await writeFile(passwordFile, `${password}\n`, { mode: 0o600 });
  await quiet(() => setup(['--config', path, '--broker-url', 'https://relay.example.com/', '--username', 'Alice', '--password-file', passwordFile, '--name', 'Studio Mac', '--source', 'tmux'], { fetch: viaLocalBroker }));
  const config = JSON.parse(await readFile(path, 'utf8'));
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal(config.broker.url, 'https://relay.example.com');
  assert.match(config.broker.relay_id, /^pc-[0-9a-f]{16}$/);
  assert.ok(config.broker.relay_token && config.broker.pairing_code);
  assert.equal(config.sources[0].enabled, true);

  const tunnel = new WebSocket(`${base.replace('http', 'ws')}/v1/relay/ws?relay_id=${config.broker.relay_id}`, { headers: { authorization: `Bearer ${config.broker.relay_token}` } });
  await new Promise((resolve, reject) => { tunnel.once('open', resolve); tunnel.once('error', reject); });
  t.after(() => tunnel.terminate());
  const computers = (await (await fetch(`${base}/v1/account/computers`, { headers: { authorization: `Bearer ${phone.token}` } })).json()).computers;
  assert.deepEqual(computers.map((c) => [c.relay_id, c.name, c.online]), [[config.broker.relay_id, 'Studio Mac', true]]);
  const accounts = JSON.parse(await readFile(join(directory, 'broker', 'accounts.json'), 'utf8'));
  assert.equal(accounts.sessions.length, 1, 'the gateway login is ended after enrollment');

  const pair = await run(['pair', '--config', path, '--url-only']);
  assert.equal(pair.code, 0, pair.stderr);
  const url = new URL(pair.stdout.trim());
  assert.equal(url.searchParams.get('relay'), config.broker.relay_id);
  assert.equal(url.searchParams.get('code'), config.broker.pairing_code);
  assert.ok(!pair.stdout.includes(config.broker.relay_token));
});

test('setup reports a broker that does not allow enrollment and writes nothing', async (t) => {
  const directory = await mkdtemp('/tmp/pc-enroll-off-'); t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'hub-relay.json'), passwordFile = join(directory, 'password');
  await writeFile(passwordFile, 'a sufficiently long test password', { mode: 0o600 });
  const routes = [];
  const stub = async (url, init) => {
    const route = new URL(url).pathname; routes.push(route);
    if (route.endsWith('/login')) return Response.json({ token: 'session', user: { id: '1', username: 'alice' } });
    if (route.endsWith('/relays')) return Response.json({ error: 'relay_enrollment_disabled' }, { status: 403 });
    return new Response(null, { status: 204 });
  };
  await assert.rejects(setup(['--config', path, '--broker-url', 'https://relay.example.com', '--username', 'alice', '--password-file', passwordFile], { fetch: stub }), /--relay-id/);
  assert.deepEqual(routes, ['/v1/account/login', '/v1/account/relays', '/v1/account/logout']);
  await assert.rejects(access(path), { code: 'ENOENT' });
});
