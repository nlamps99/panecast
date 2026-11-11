import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { bundledRelay, captureCmuxCapability, cmuxPresent, ManagedCmuxRelay, MANAGED_DEVICE_ID } from '../src/hub/cmux-managed.mjs';
import { discoverInto, discoverSources } from '../src/hub/discover.mjs';

async function directory(t) {
  const path = await mkdtemp(join(tmpdir(), 'panecast-cmux-managed-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

/**
 * A stand-in for the Swift relay: `devices add` prints a credential, `serve`
 * records its arguments and environment, then runs until it is stopped.
 */
async function fakeRelay(t, root, { serveExit } = {}) {
  const binary = join(root, 'cmux-relay');
  const record = join(root, 'serve-calls.log');
  await writeFile(binary, `#!/bin/sh
if [ "$1" = devices ]; then
  echo "$@" >> "${join(root, 'devices-calls.log')}"
  printf '{"device_id":"${MANAGED_DEVICE_ID}","token":"token-%s"}\\n' "$$"
  exit 0
fi
printf '%s|%s|%s|%s\\n' "$*" "$CMUX_NO_SELF_LOGIN" "\${CMUX_SOCKET_CAPABILITY_FILE:-none}" "\${CMUX_SOCKET_CAPABILITY:-none}" >> "${record}"
${serveExit ? 'exit 3' : 'trap "exit 0" TERM; while true; do sleep 0.05; done'}
`);
  await chmod(binary, 0o755);
  const calls = async () => (await readFile(record, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean);
  return { binary, calls };
}

async function until(check, message) {
  for (let i = 0; i < 100; i++) { if (await check()) return; await delay(50); }
  assert.fail(message);
}

test('cmux is recognised from an installed app or a socket marker of any build variant', async (t) => {
  const root = await directory(t);
  const empty = { home: root, tmpDirectory: join(root, 'tmp'), applicationDirectories: [join(root, 'Applications')] };
  assert.equal(await cmuxPresent(empty), false);
  await mkdir(join(root, 'Applications', 'cmux DR2.app'), { recursive: true });
  assert.equal(await cmuxPresent(empty), true, 'cmux DR2 app');

  const markerOnly = { ...empty, applicationDirectories: [] };
  await mkdir(join(root, 'tmp'));
  await writeFile(join(root, 'tmp', 'cmux-last-debug-log-path'), '/tmp/x.log');
  assert.equal(await cmuxPresent(markerOnly), false, 'unrelated cmux files do not count');
  await writeFile(join(root, 'tmp', 'cmux-dev-dr2-selfhost-last-socket-path'), '/tmp/cmux-debug-dr2-selfhost.sock');
  assert.equal(await cmuxPresent(markerOnly), true, 'dev-variant marker');
});

test('the packaged relay is used on macOS, and an override must be executable', async (t) => {
  const root = await directory(t);
  assert.equal(await bundledRelay({ env: {}, platform: 'darwin', root }), null);
  await mkdir(join(root, 'vendor', 'darwin'), { recursive: true });
  await writeFile(join(root, 'vendor', 'darwin', 'cmux-relay'), '#!/bin/sh\n');
  assert.equal(await bundledRelay({ env: {}, platform: 'darwin', root }), null, 'not executable');
  await chmod(join(root, 'vendor', 'darwin', 'cmux-relay'), 0o755);
  assert.equal(await bundledRelay({ env: {}, platform: 'darwin', root }), join(root, 'vendor', 'darwin', 'cmux-relay'));
  assert.equal(await bundledRelay({ env: {}, platform: 'linux', root }), null);
  assert.equal(await bundledRelay({ env: { PANECAST_CMUX_RELAY: join(root, 'missing') }, platform: 'darwin', root }), null);
});

test('without a usable relay, discovery provisions the gateway relay on loopback with its own state', async (t) => {
  const root = await directory(t);
  const relay = await fakeRelay(t, root);
  const path = join(root, 'config', 'hub-relay.json');
  await mkdir(join(root, 'config'));
  await writeFile(path, JSON.stringify({ sources: [{ id: 'tmux', type: 'tmux' }] }), { mode: 0o600 });
  const options = { home: root, lanHost: undefined, tmux: () => true, managed: { binary: relay.binary, present: async () => true } };

  assert.deepEqual(await discoverInto(path, options), ['cmux']);
  const [, cmux] = JSON.parse(await readFile(path, 'utf8')).sources;
  const stateDirectory = join(root, 'config', 'cmux-gateway');
  assert.equal(cmux.managed, true);
  assert.equal(cmux.state_dir, stateDirectory);
  assert.equal(cmux.device_id, MANAGED_DEVICE_ID);
  assert.match(cmux.token, /^token-\d+$/);
  const relayConfig = JSON.parse(await readFile(join(stateDirectory, 'relay.json'), 'utf8'));
  assert.match(relayConfig.listen, /^127\.0\.0\.1:\d+$/);
  assert.equal(relayConfig.transport, 'direct');
  assert.equal(relayConfig.lan, undefined, 'no pairing route is opened');
  assert.equal(cmux.url, `ws://${relayConfig.listen}/v1/ws`);
  assert.equal((await stat(stateDirectory)).mode & 0o777, 0o700);
  assert.equal((await stat(join(stateDirectory, 'relay.json'))).mode & 0o777, 0o600);
  assert.match(await readFile(join(root, 'devices-calls.log'), 'utf8'), new RegExp(`--state-dir ${stateDirectory}`));

  assert.deepEqual(await discoverInto(path, options), [], 'a usable source is left alone');
});

test('the gateway relay is not provisioned without cmux, without a binary, or when the relay cannot issue a credential', async (t) => {
  const root = await directory(t);
  const relay = await fakeRelay(t, root);
  const base = { home: root, lanHost: undefined, tmux: () => false };
  const managed = { stateDirectory: join(root, 'state'), binary: relay.binary };
  assert.deepEqual((await discoverSources([], { ...base, managed: { ...managed, present: async () => false } })).added, []);
  assert.deepEqual((await discoverSources([], { ...base, managed: { ...managed, binary: null, present: async () => true } })).added, []);
  const failing = join(root, 'failing-relay');
  await writeFile(failing, '#!/bin/sh\nexit 1\n'); await chmod(failing, 0o755);
  assert.deepEqual((await discoverSources([], { ...base, managed: { ...managed, binary: failing, present: async () => true } })).added, [],
    'a relay that cannot issue a credential adds nothing');
  await assert.rejects(readFile(join(root, 'devices-calls.log')), 'no credential was requested');
});

test('the supervisor starts the relay for a managed source, restarts it, and stops it with the hub', async (t) => {
  const root = await directory(t);
  const relay = await fakeRelay(t, root);
  const stateDirectory = join(root, 'state');
  await mkdir(stateDirectory);
  await writeFile(join(stateDirectory, 'socket-control-capability'), 'v1.a.b\n');
  const source = { id: 'cmux', type: 'cmux', managed: true, state_dir: stateDirectory, url: 'ws://127.0.0.1:4401/v1/ws', token: 'a' };
  const supervisor = new ManagedCmuxRelay({ binary: relay.binary, minimumDelay: 50 });
  t.after(() => supervisor.close());
  const previous = process.env.CMUX_SOCKET_CAPABILITY;
  process.env.CMUX_SOCKET_CAPABILITY = 'from-terminal';
  t.after(() => { if (previous === undefined) delete process.env.CMUX_SOCKET_CAPABILITY; else process.env.CMUX_SOCKET_CAPABILITY = previous; });

  await supervisor.sync([{ id: 'tmux', type: 'tmux' }, source]);
  await until(async () => (await relay.calls()).length === 1, 'relay started');
  const [args, noSelfLogin, capabilityFile, inherited] = (await relay.calls())[0].split('|');
  assert.equal(args, `serve --config ${join(stateDirectory, 'relay.json')} --state-dir ${stateDirectory}`);
  assert.equal(noSelfLogin, '1');
  assert.equal(capabilityFile, join(stateDirectory, 'socket-control-capability'));
  assert.equal(inherited, 'none', 'the launching terminal capability is not passed on');
  const firstPid = supervisor.child.pid;
  assert.equal((await readFile(join(stateDirectory, 'relay.pid'), 'utf8')).trim(), String(firstPid));

  await supervisor.sync([source]);
  assert.equal(supervisor.child.pid, firstPid, 'an unchanged source keeps the running relay');
  await supervisor.sync([{ ...source, token: 'b' }]);
  await until(async () => (await relay.calls()).length === 2, 'a new credential restarts the relay');

  process.kill(supervisor.child.pid, 'SIGKILL');
  await until(async () => (await relay.calls()).length === 3, 'a crashed relay is restarted');

  const child = supervisor.child;
  await supervisor.sync([{ id: 'tmux', type: 'tmux' }]);
  assert.equal(supervisor.child, null);
  assert.notEqual(child.exitCode ?? child.signalCode, null, 'removing the source stops the relay');
  await assert.rejects(readFile(join(stateDirectory, 'relay.pid')));
  await delay(150);
  assert.equal((await relay.calls()).length, 3, 'a stopped relay is not restarted');
});

test('a relay that keeps exiting is retried with growing delays', async (t) => {
  const root = await directory(t);
  const relay = await fakeRelay(t, root, { serveExit: true });
  const stateDirectory = join(root, 'state');
  await mkdir(stateDirectory);
  const supervisor = new ManagedCmuxRelay({ binary: relay.binary, minimumDelay: 40, maximumDelay: 160 });
  t.after(() => supervisor.close());
  await supervisor.sync([{ type: 'cmux', managed: true, state_dir: stateDirectory, url: 'ws://127.0.0.1:1/v1/ws', token: 'a' }]);
  await until(async () => (await relay.calls()).length >= 3, 'retried');
  assert.equal(supervisor.delay, 160);
});

test('a cmux socket capability from a cmux terminal is saved once, owner-only', async (t) => {
  const stateDirectory = join(await directory(t), 'state');
  assert.equal(await captureCmuxCapability(stateDirectory, {}), false);
  assert.equal(await captureCmuxCapability(stateDirectory, { CMUX_SOCKET_CAPABILITY: 'bad value' }), false);
  assert.equal(await captureCmuxCapability(stateDirectory, { CMUX_SOCKET_CAPABILITY: ' v1.nonce.mac\n' }), true);
  assert.equal(await readFile(join(stateDirectory, 'socket-control-capability'), 'utf8'), 'v1.nonce.mac\n');
  assert.equal((await stat(join(stateDirectory, 'socket-control-capability'))).mode & 0o777, 0o600);
  assert.equal(await captureCmuxCapability(stateDirectory, { CMUX_SOCKET_CAPABILITY: 'v1.nonce.mac' }), false, 'unchanged');
});
