import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { WebSocket } from 'ws';
import { AccountStore } from '../src/accounts.mjs';
import { createBrokerServer } from '../src/server.mjs';

const password = 'a sufficiently long test password';
async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'panecast-accounts-'));
  const broker = await createBrokerServer({ host: '127.0.0.1', port: 0, dataFile: join(directory, 'devices.json'),
    relays: [{ relay_id: 'home', relay_token: 'home-tunnel', pairing_code: 'home-pair' }, { relay_id: 'work', relay_token: 'work-tunnel', pairing_code: 'work-pair' }],
    logger: { error() {} }, accountLimit: 100, ...options });
  const address = await broker.listen(), base = `http://127.0.0.1:${address.port}`;
  t.after(async () => { await broker.close(); await rm(directory, { recursive: true, force: true }); });
  const request = async (route, method = 'GET', body, token) => {
    const response = await fetch(`${base}/v1/account/${route}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: response.status === 204 ? null : await response.json() };
  };
  const register = async (username) => {
    const result = await request('register', 'POST', { username, password, device_name: 'First computer' });
    assert.equal(result.status, 201);
    return result.body;
  };
  return { directory, base, request, register };
}
async function socket(base, path, token) {
  const ws = new WebSocket(`${base.replace('http', 'ws')}${path}`, 'cmuxremote.v1', { headers: { authorization: `Bearer ${token}` } });
  await once(ws, 'open');
  return ws;
}

test('another login sees only bound computers; pairing proof and account isolation are enforced', async (t) => {
  const { base, request, register, directory } = await fixture(t);
  const alice = await register('Alice'), bob = await register('bob');
  assert.equal(alice.user.username, 'alice');
  assert.equal((await request('computers', 'POST', { relay_id: 'home', pairing_code: 'wrong' }, alice.token)).status, 403);
  assert.equal((await request('computers', 'POST', { relay_id: 'home', pairing_code: 'home-pair', name: 'Home Mac' }, alice.token)).status, 204);
  const second = await request('login', 'POST', { username: 'ALICE', password, device_name: 'Second computer' });
  assert.equal(second.status, 200);
  const devices = (await request('computers', 'GET', undefined, second.body.token)).body.computers;
  assert.deepEqual(devices.map((c) => [c.relay_id, c.name, c.online]), [['home', 'Home Mac', false]]);
  const first = (await request('computers', 'GET', undefined, alice.token)).body.computers;
  assert.notEqual(first[0].device_id, devices[0].device_id);
  assert.deepEqual((await request('computers', 'GET', undefined, bob.token)).body.computers, []);
  assert.equal((await fetch(`${base}/v1/health?relay_id=work`, { headers: { authorization: `Bearer ${alice.token}` } })).status, 401);
  assert.equal((await fetch(`${base}/v1/health?relay_id=home`, { headers: { authorization: `Bearer ${alice.token}` } })).status, 200);
  const disk = await readFile(join(directory, 'accounts.json'), 'utf8');
  for (const secret of [password, alice.token, second.body.token, 'home-pair']) assert.equal(disk.includes(secret), false);
});

test('logging out closes that session immediately; unbinding closes every remaining session for that computer', async (t) => {
  const { base, request, register } = await fixture(t);
  const first = await register('alice');
  await request('computers', 'POST', { relay_id: 'home', pairing_code: 'home-pair' }, first.token);
  const second = (await request('login', 'POST', { username: 'alice', password, device_name: 'Phone' })).body;
  await socket(base, '/v1/relay/ws?relay_id=home', 'home-tunnel');
  const one = await socket(base, '/v1/ws?relay_id=home', first.token);
  const two = await socket(base, '/v1/ws?relay_id=home', second.token);
  one.send(JSON.stringify({ deviceId: 'test', appVersion: 'test', protocolVersion: 1 }));
  const oneClosed = once(one, 'close');
  assert.equal((await request('logout', 'POST', undefined, first.token)).status, 204);
  assert.equal((await oneClosed)[0], 4003);
  assert.equal(two.readyState, WebSocket.OPEN);
  assert.equal((await request('computers', 'GET', undefined, first.token)).status, 401);
  const twoClosed = once(two, 'close');
  assert.equal((await request('computers?relay_id=home', 'DELETE', undefined, second.token)).status, 204);
  assert.equal((await twoClosed)[0], 4003);
  assert.equal((await fetch(`${base}/v1/health?relay_id=home`, { headers: { authorization: `Bearer ${second.token}` } })).status, 401);
});

test('existing device credentials can bind only their own relay and manual pairings survive account deletion', async (t) => {
  const { base, request, register } = await fixture(t);
  const manual = await (await fetch(`${base}/v1/devices/me/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ relay_id: 'home', pairing_code: 'home-pair', client_id: 'phone', device_name: 'Phone' }) })).json();
  const account = await register('alice');
  assert.equal((await request('computers', 'POST', { relay_id: 'work', device_token: manual.token }, account.token)).status, 403);
  assert.equal((await request('computers', 'POST', { relay_id: 'home', device_token: manual.token }, account.token)).status, 204);
  assert.equal((await request('computers?relay_id=home', 'PATCH', { name: 'My computer' }, account.token)).status, 204);
  assert.equal((await request('computers', 'GET', undefined, account.token)).body.computers[0].name, 'My computer');
  assert.equal((await request('me', 'DELETE', { password: 'wrong' }, account.token)).status, 403);
  assert.equal((await request('me', 'DELETE', { password }, account.token)).status, 204);
  assert.equal((await request('me', 'GET', undefined, account.token)).status, 401);
  assert.equal((await fetch(`${base}/v1/health?relay_id=home`, { headers: { authorization: `Bearer ${manual.token}` } })).status, 200);
});

test('password changes revoke other logins and require the old password', async (t) => {
  const { request, register } = await fixture(t);
  const first = await register('alice');
  const second = (await request('login', 'POST', { username: 'alice', password, device_name: 'Phone' })).body;
  assert.equal((await request('password', 'POST', { old_password: 'wrong', password: 'a new sufficiently long password' }, first.token)).status, 403);
  assert.equal((await request('password', 'POST', { old_password: password, password: 'a new sufficiently long password' }, first.token)).status, 204);
  assert.equal((await request('me', 'GET', undefined, first.token)).status, 200);
  assert.equal((await request('me', 'GET', undefined, second.token)).status, 401);
  assert.equal((await request('login', 'POST', { username: 'alice', password, device_name: 'Phone' })).status, 401);
});

test('accounts persist over restart and expired sessions lose all relay access', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'panecast-account-store-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let now = 1000;
  const path = join(directory, 'accounts.json');
  const store = new AccountStore(path, { now: () => now, sessionMs: 100 }); await store.load();
  const account = await store.register('alice', password, 'Mac');
  await store.bind(account.token, 'home', 'Home');
  const restored = new AccountStore(path, { now: () => now }); await restored.load();
  assert.equal(restored.computers(account.token)[0].name, 'Home');
  assert.ok(restored.authenticateDevice(account.token, 'home'));
  now = 1100;
  assert.equal(restored.authenticate(account.token), null);
  assert.equal(restored.authenticateDevice(account.token, 'home'), null);
  assert.deepEqual(restored.deviceIds('home'), []);
});

test('invalid input and rate limiting do not create accounts', async (t) => {
  const { request } = await fixture(t, { accountLimit: 2 });
  assert.equal((await request('register', 'POST', { username: 'alice', password: 'short', device_name: 'Mac' })).status, 400);
  assert.equal((await request('register', 'POST', null)).status, 400);
  assert.equal((await request('register', 'POST', { username: 'alice', password, device_name: 'Mac' })).status, 429);
});
