import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { bundledRelay, captureCmuxCapability, cmuxInstallations, isCmuxVariant, ManagedCmuxRelay, MANAGED_DEVICE_ID, variantFromBundleId } from '../src/hub/cmux-managed.mjs';
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

const STABLE = { variant: 'stable', name: 'cmux' };
const DR2 = { variant: 'dev-dr2-selfhost', name: 'cmux DR2' };
const port = (source) => Number(/:(\d+)\//.exec(source.url)[1]);

test('cmux app variants follow the names cmux uses for its socket markers', () => {
  assert.equal(variantFromBundleId('com.cmuxterm.app'), 'stable');
  assert.equal(variantFromBundleId('com.cmuxterm.app.debug.dr2.selfhost'), 'dev-dr2-selfhost');
  assert.equal(variantFromBundleId('com.cmuxterm.app.debug'), 'dev');
  assert.equal(variantFromBundleId('com.cmuxterm.app.nightly'), 'nightly');
  assert.equal(variantFromBundleId('com.cmuxterm.app.rc.Beta_2'), 'rc-beta-2');
  for (const other of ['com.genie.cmuxremote', 'com.cmuxterm.appx', '', undefined]) assert.equal(variantFromBundleId(other), null);
  for (const good of ['stable', 'dev', 'dev-dr2-selfhost', 'nightly']) assert.ok(isCmuxVariant(good), good);
  for (const bad of ['', 'dev-', 'beta', 'dev-DR2', '../x', 'dev-a/b']) assert.ok(!isCmuxVariant(bad), bad);
});

test('installed cmux apps and socket markers of every build are recognised', async (t) => {
  const root = await directory(t);
  const apps = join(root, 'Applications');
  for (const name of ['cmux.app', 'cmux DR2.app', 'cmux Remote.app', 'Other.app']) await mkdir(join(apps, name), { recursive: true });
  const bundles = { 'cmux.app': { id: 'com.cmuxterm.app', name: 'cmux' }, 'cmux DR2.app': { id: 'com.cmuxterm.app.debug.dr2.selfhost', name: 'cmux DR2' },
    'cmux Remote.app': { id: 'com.genie.cmuxremote', name: 'cmux Remote' } };
  const readBundle = async (path) => bundles[path.split('/').pop()];
  const tmp = join(root, 'tmp');
  await mkdir(tmp);
  await mkdir(join(root, '.local', 'state', 'cmux'), { recursive: true });
  const options = { home: root, tmpDirectory: tmp, applicationDirectories: [apps], readBundle };

  assert.deepEqual(await cmuxInstallations(options), [STABLE, DR2], 'installed apps, not the unrelated one');
  await writeFile(join(tmp, 'cmux-last-debug-log-path'), '/tmp/x.log');
  await writeFile(join(tmp, 'cmux-nightly-last-socket-path'), '/tmp/cmux-nightly.sock');
  await writeFile(join(root, '.local', 'state', 'cmux', 'rc-last-socket-path'), '/tmp/cmux-rc.sock');
  assert.deepEqual(await cmuxInstallations({ ...options, applicationDirectories: [] }),
    [{ variant: 'nightly', name: '' }, { variant: 'rc', name: '' }], 'markers only; unrelated cmux files ignored');
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

test('each cmux app gets its own loopback relay, state and source', async (t) => {
  const root = await directory(t);
  const relay = await fakeRelay(t, root);
  const path = join(root, 'config', 'hub-relay.json');
  await mkdir(join(root, 'config'));
  await writeFile(path, JSON.stringify({ sources: [{ id: 'tmux', type: 'tmux' }] }), { mode: 0o600 });
  const options = { home: root, lanHost: undefined, tmux: () => true, managed: { binary: relay.binary, installations: async () => [STABLE, DR2] } };

  assert.deepEqual(await discoverInto(path, options), ['cmux', 'cmux-dev-dr2-selfhost']);
  const [, stable, dr2] = JSON.parse(await readFile(path, 'utf8')).sources;
  const base = join(root, 'config', 'cmux-gateway');
  assert.deepEqual({ id: stable.id, name: stable.name, variant: stable.variant, state_dir: stable.state_dir, managed: stable.managed },
    { id: 'cmux', name: 'cmux', variant: 'stable', state_dir: base, managed: true });
  assert.deepEqual({ id: dr2.id, name: dr2.name, variant: dr2.variant, state_dir: dr2.state_dir },
    { id: 'cmux-dev-dr2-selfhost', name: 'cmux DR2', variant: 'dev-dr2-selfhost', state_dir: `${base}-dev-dr2-selfhost` });
  assert.notEqual(port(stable), port(dr2), 'separate ports');
  for (const source of [stable, dr2]) {
    const config = JSON.parse(await readFile(join(source.state_dir, 'relay.json'), 'utf8'));
    assert.deepEqual(config, { listen: `127.0.0.1:${port(source)}`, transport: 'direct', cmux_variant: source.variant }, 'loopback, no pairing route');
    assert.equal(source.device_id, MANAGED_DEVICE_ID);
    assert.match(source.token, /^token-\d+$/);
    assert.equal((await stat(source.state_dir)).mode & 0o777, 0o700);
    assert.equal((await stat(join(source.state_dir, 'relay.json'))).mode & 0o777, 0o600);
  }
  assert.deepEqual(await discoverInto(path, options), [], 'served apps are left alone');
});

test('a relay from before variants is pinned to the official app, or to the only app installed', async (t) => {
  const root = await directory(t);
  const relay = await fakeRelay(t, root);
  const base = join(root, 'cmux-gateway');
  const legacy = async () => {
    await rm(base, { recursive: true, force: true }); await mkdir(base, { recursive: true });
    await writeFile(join(base, 'relay.json'), JSON.stringify({ listen: '127.0.0.1:4401', transport: 'direct' }));
    return [{ id: 'cmux', name: 'cmux', type: 'cmux', url: 'ws://127.0.0.1:4401/v1/ws', device_id: MANAGED_DEVICE_ID, token: 't', managed: true, state_dir: base }];
  };
  const run = (installations, sources) => discoverSources(sources, { home: root, tmux: () => false, managed: { stateDirectory: base, binary: relay.binary, installations: async () => installations } });

  let { sources, added } = await run([DR2], await legacy());
  assert.deepEqual(added.map((s) => s.id), ['cmux'], 'only the pinned source changes');
  assert.deepEqual([sources[0].variant, sources[0].name, sources[0].url], ['dev-dr2-selfhost', 'cmux DR2', 'ws://127.0.0.1:4401/v1/ws']);
  assert.equal(JSON.parse(await readFile(join(base, 'relay.json'), 'utf8')).cmux_variant, 'dev-dr2-selfhost');

  ({ sources, added } = await run([DR2, STABLE], await legacy()));
  assert.deepEqual(sources.map((s) => [s.id, s.variant, s.name]), [['cmux', 'stable', 'cmux'], ['cmux-dev-dr2-selfhost', 'dev-dr2-selfhost', 'cmux DR2']]);
  assert.notEqual(port(sources[1]), 4401, 'the new relay avoids the pinned relay port');
});

test('a relay registered through LAN pairing serves the official app; other apps still get relays', async (t) => {
  const root = await directory(t);
  const relay = await fakeRelay(t, root);
  const lan = { id: 'cmux', type: 'cmux', url: 'ws://127.0.0.1:4399/v1/ws', device_id: 'hub', token: 'x' };
  const { sources, added } = await discoverSources([lan], { home: root, tmux: () => false,
    managed: { stateDirectory: join(root, 'cmux-gateway'), binary: relay.binary, installations: async () => [STABLE, DR2] } });
  assert.deepEqual(added.map((s) => s.id), ['cmux-dev-dr2-selfhost']);
  assert.deepEqual(sources[0], lan, 'the installed relay is untouched');
});

test('no relay is provisioned without cmux, without a binary, or when the relay cannot issue a credential', async (t) => {
  const root = await directory(t);
  const relay = await fakeRelay(t, root);
  const base = { home: root, lanHost: undefined, tmux: () => false };
  const managed = { stateDirectory: join(root, 'state'), binary: relay.binary };
  assert.deepEqual((await discoverSources([], { ...base, managed: { ...managed, installations: async () => [] } })).added, []);
  assert.deepEqual((await discoverSources([], { ...base, managed: { ...managed, binary: null, installations: async () => [DR2] } })).added, []);
  const failing = join(root, 'failing-relay');
  await writeFile(failing, '#!/bin/sh\nexit 1\n'); await chmod(failing, 0o755);
  assert.deepEqual((await discoverSources([], { ...base, managed: { ...managed, binary: failing, installations: async () => [DR2] } })).added, []);
  await assert.rejects(readFile(join(root, 'devices-calls.log')), 'no credential was requested');
});

test('the supervisor runs one relay per managed source and restarts or stops each on its own', async (t) => {
  const root = await directory(t);
  const relay = await fakeRelay(t, root);
  const stableDir = join(root, 'stable'), dr2Dir = join(root, 'dr2');
  await mkdir(stableDir); await mkdir(dr2Dir);
  await writeFile(join(dr2Dir, 'socket-control-capability'), 'v1.a.b\n');
  const stable = { id: 'cmux', type: 'cmux', managed: true, variant: 'stable', state_dir: stableDir, url: 'ws://127.0.0.1:4401/v1/ws', token: 'a' };
  const dr2 = { id: 'cmux-dev-dr2-selfhost', type: 'cmux', managed: true, variant: 'dev-dr2-selfhost', state_dir: dr2Dir, url: 'ws://127.0.0.1:4402/v1/ws', token: 'b' };
  const supervisor = new ManagedCmuxRelay({ binary: relay.binary, minimumDelay: 50 });
  t.after(() => supervisor.close());
  const previous = process.env.CMUX_SOCKET_CAPABILITY;
  process.env.CMUX_SOCKET_CAPABILITY = 'from-terminal';
  t.after(() => { if (previous === undefined) delete process.env.CMUX_SOCKET_CAPABILITY; else process.env.CMUX_SOCKET_CAPABILITY = previous; });
  const child = (dir) => supervisor.relays.get(dir)?.child;

  await supervisor.sync([{ id: 'tmux', type: 'tmux' }, stable, dr2]);
  await until(async () => (await relay.calls()).length === 2, 'both relays started');
  const calls = Object.fromEntries((await relay.calls()).map((line) => { const [args, ...rest] = line.split('|'); return [args, rest]; }));
  assert.deepEqual(calls[`serve --config ${join(stableDir, 'relay.json')} --state-dir ${stableDir}`], ['1', 'none', 'none']);
  assert.deepEqual(calls[`serve --config ${join(dr2Dir, 'relay.json')} --state-dir ${dr2Dir}`], ['1', join(dr2Dir, 'socket-control-capability'), 'none'],
    'each relay uses only its own saved capability; the terminal capability is never passed on');
  const stablePid = child(stableDir).pid;
  assert.equal((await readFile(join(dr2Dir, 'relay.pid'), 'utf8')).trim(), String(child(dr2Dir).pid));

  await supervisor.sync([stable, { ...dr2, token: 'c' }]);
  await until(async () => (await relay.calls()).length === 3, 'a new credential restarts that relay');
  assert.equal(child(stableDir).pid, stablePid, 'the other relay keeps running');

  process.kill(child(dr2Dir).pid, 'SIGKILL');
  await until(async () => (await relay.calls()).length === 4, 'a crashed relay is restarted');
  assert.equal(child(stableDir).pid, stablePid);

  const dr2Child = child(dr2Dir);
  await supervisor.sync([stable]);
  assert.equal(supervisor.relays.has(dr2Dir), false);
  assert.notEqual(dr2Child.exitCode ?? dr2Child.signalCode, null, 'removing a source stops its relay');
  await assert.rejects(readFile(join(dr2Dir, 'relay.pid')));
  assert.equal(child(stableDir).pid, stablePid);

  const stableChild = child(stableDir);
  await supervisor.close();
  assert.notEqual(stableChild.exitCode ?? stableChild.signalCode, null, 'closing the hub stops every relay');
  await delay(150);
  assert.equal((await relay.calls()).length, 4, 'stopped relays are not restarted');
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
  assert.equal(supervisor.relays.get(stateDirectory).delay, 160);
});

test('a socket capability from a cmux terminal is saved, owner-only, for that app only', async (t) => {
  const root = await directory(t);
  const configPath = join(root, 'hub-relay.json');
  const base = join(root, 'cmux-gateway');
  const saved = (dir) => readFile(join(dir, 'socket-control-capability'), 'utf8');
  assert.equal(await captureCmuxCapability(configPath, {}), false);
  assert.equal(await captureCmuxCapability(configPath, { CMUX_SOCKET_CAPABILITY: 'bad value' }), false);
  assert.equal(await captureCmuxCapability(configPath, { CMUX_SOCKET_CAPABILITY: 'x', CMUX_BUNDLE_ID: 'com.example.other' }), false);

  assert.equal(await captureCmuxCapability(configPath, { CMUX_SOCKET_CAPABILITY: ' v1.stable.mac\n', CMUX_BUNDLE_ID: 'com.cmuxterm.app' }), true);
  assert.equal(await saved(base), 'v1.stable.mac\n');
  assert.equal((await stat(join(base, 'socket-control-capability'))).mode & 0o777, 0o600);
  assert.equal(await captureCmuxCapability(configPath, { CMUX_SOCKET_CAPABILITY: 'v1.stable.mac', CMUX_BUNDLE_ID: 'com.cmuxterm.app' }), false, 'unchanged');

  assert.equal(await captureCmuxCapability(configPath, { CMUX_SOCKET_CAPABILITY: 'v1.dr2.mac', CMUX_BUNDLE_ID: 'com.cmuxterm.app.debug.dr2.selfhost' }), true);
  assert.equal(await saved(`${base}-dev-dr2-selfhost`), 'v1.dr2.mac\n');
  assert.equal(await saved(base), 'v1.stable.mac\n', 'the official app keeps its own capability');

  // A relay pinned during an upgrade keeps its original directory.
  const pinned = join(root, 'pinned');
  await writeFile(configPath, JSON.stringify({ sources: [{ id: 'cmux', type: 'cmux', managed: true, variant: 'dev-dr2-selfhost', state_dir: pinned }] }));
  assert.equal(await captureCmuxCapability(configPath, { CMUX_SOCKET_CAPABILITY: 'v1.dr2.new', CMUX_BUNDLE_ID: 'com.cmuxterm.app.debug.dr2.selfhost' }), true);
  assert.equal(await saved(pinned), 'v1.dr2.new\n');
});
