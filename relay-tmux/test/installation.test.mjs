import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writeInitialConfig, brokerURL, lanAddress } from '../src/installation.mjs';
import { renderPlist } from '../src/service.mjs';

const cli = fileURLToPath(new URL('../bin/panecast.mjs', import.meta.url));
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
