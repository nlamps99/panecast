import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { WebSocket } from 'ws';
import { configFromEnvironment, createBrokerServer } from '../src/server.mjs';

const password = 'a sufficiently long test password';
async function start(directory, options = {}) {
  const broker = await createBrokerServer({ host: '127.0.0.1', port: 0, dataFile: join(directory, 'devices.json'),
    logger: { error() {} }, accountLimit: 100, heartbeatMs: 60_000, ...options });
  const address = await broker.listen();
  return { broker, base: `http://127.0.0.1:${address.port}` };
}
async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'panecast-enroll-'));
  const brokers = [];
  t.after(async () => { for (const b of brokers) await b.close(); await rm(directory, { recursive: true, force: true }); });
  const boot = async (extra = {}) => { const started = await start(directory, { ...options, ...extra }); brokers.push(started.broker); return started; };
  const { broker, base } = await boot();
  const client = (url) => {
    const request = async (route, method = 'GET', body, token) => {
      const response = await fetch(`${url}/v1/account/${route}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, body: response.status === 204 ? null : await response.json() };
    };
    const register = async (username) => (await request('register', 'POST', { username, password, device_name: 'Phone' })).body;
    return { request, register };
  };
  return { directory, broker, base, boot, ...client(base), client };
}
function connect(base, path, token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${base.replace('http', 'ws')}${path}`, 'cmuxremote.v1', { headers: { authorization: `Bearer ${token}` } });
    const frames = [];
    ws.on('message', (raw) => frames.push(JSON.parse(raw.toString())));
    ws.once('unexpected-response', (_request, response) => { response.resume(); resolve({ status: response.statusCode }); });
    ws.once('open', () => resolve({ ws, frames }));
    ws.on('error', (error) => { if (ws.readyState !== WebSocket.CLOSED) reject(error); });
  });
}
const until = async (predicate, timeout = 3000) => {
  const deadline = Date.now() + timeout;
  while (!predicate()) { if (Date.now() > deadline) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 10)); }
};

test('a broker without static relays starts and advertises enrollment', async (t) => {
  const config = configFromEnvironment({ CMUX_BROKER_DATA_DIR: '/tmp/unused' });
  assert.equal(config.relayEnrollment, true);
  assert.throws(() => configFromEnvironment({ CMUX_RELAY_ENROLLMENT: '0' }), /CMUX_RELAY_ID/);
  assert.throws(() => configFromEnvironment({ CMUX_RELAY_ID: 'only-id' }), /CMUX_RELAY_ID/);
  const { base } = await fixture(t);
  const health = await (await fetch(`${base}/v1/health`)).json();
  assert.equal(health.relay_enrollment, true); assert.equal('relay_online' in health, false);
});

test('an enrolled computer connects, appears for the same account and pairs by QR without manual credentials', async (t) => {
  const { base, request, register, directory } = await fixture(t);
  const alice = await register('alice'), bob = await register('bob');
  assert.equal((await request('relays', 'POST', { name: 'Studio Mac' })).status, 401);
  const enrolled = await request('relays', 'POST', { name: '  Studio Mac  ' }, alice.token);
  assert.equal(enrolled.status, 201);
  const { relay_id: relayId, relay_token: relayToken, pairing_code: pairingCode } = enrolled.body;
  assert.match(relayId, /^pc-[0-9a-f]{16}$/); assert.equal(enrolled.body.name, 'Studio Mac');
  assert.notEqual(relayToken, pairingCode);

  assert.equal((await connect(base, `/v1/relay/ws?relay_id=${relayId}`, 'wrong-token')).status, 401);
  assert.equal((await connect(base, `/v1/relay/ws?relay_id=${relayId}`, pairingCode)).status, 401);
  const relay = await connect(base, `/v1/relay/ws?relay_id=${relayId}`, relayToken);
  assert.ok(relay.ws);

  const phone = (await request('login', 'POST', { username: 'alice', password, device_name: 'Second phone' })).body;
  const listed = (await request('computers', 'GET', undefined, phone.token)).body.computers;
  assert.deepEqual(listed.map((c) => [c.relay_id, c.name, c.online]), [[relayId, 'Studio Mac', true]]);
  assert.deepEqual((await request('computers', 'GET', undefined, bob.token)).body.computers, []);
  assert.equal((await connect(base, `/v1/ws?relay_id=${relayId}`, bob.token)).status, 401);

  const session = await connect(base, `/v1/ws?relay_id=${relayId}`, phone.token);
  await until(() => relay.frames.some((f) => f.type === 'session.open' && f.device_id === listed[0].device_id));
  session.ws.send('{"hello":true}');
  await until(() => relay.frames.some((f) => f.type === 'session.text' && f.text === '{"hello":true}'));

  const pairing = (code) => fetch(`${base}/v1/devices/me/register`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ relay_id: relayId, pairing_code: code, client_id: 'legacy-phone', device_name: 'Legacy phone' }) });
  assert.equal((await pairing(relayToken)).status, 403);
  const legacy = await (await pairing(pairingCode)).json();
  assert.equal((await fetch(`${base}/v1/health?relay_id=${relayId}`, { headers: { authorization: `Bearer ${legacy.token}` } })).status, 200);
  assert.equal((await request('computers', 'POST', { relay_id: relayId, pairing_code: pairingCode, name: 'Shared' }, bob.token)).status, 204);

  const disk = await readFile(join(directory, 'accounts.json'), 'utf8');
  for (const secret of [relayToken, pairingCode]) assert.equal(disk.includes(secret), false);
});

test('enrolled relays survive a restart and stay reserved from configured IDs', async (t) => {
  const { request, register, boot, broker, client } = await fixture(t);
  const alice = await register('alice');
  const { relay_id: relayId, relay_token: relayToken } = (await request('relays', 'POST', {}, alice.token)).body;
  await broker.close();
  const restarted = await boot();
  const relay = await connect(restarted.base, `/v1/relay/ws?relay_id=${relayId}`, relayToken);
  assert.ok(relay.ws);
  const computers = (await client(restarted.base).request('computers', 'GET', undefined, alice.token)).body.computers;
  assert.deepEqual(computers.map((c) => [c.relay_id, c.name, c.online]), [[relayId, '电脑', true]]);
});

test('removing an enrolled computer or deleting its owner revokes the tunnel, phones and pairing code', async (t) => {
  const { base, request, register } = await fixture(t);
  const alice = await register('alice'), bob = await register('bob');
  const first = (await request('relays', 'POST', { name: 'One' }, alice.token)).body;
  const second = (await request('relays', 'POST', { name: 'Two' }, alice.token)).body;
  assert.equal((await request('computers', 'POST', { relay_id: first.relay_id, pairing_code: first.pairing_code }, bob.token)).status, 204);

  const relay = await connect(base, `/v1/relay/ws?relay_id=${first.relay_id}`, first.relay_token);
  const phone = await connect(base, `/v1/ws?relay_id=${first.relay_id}`, bob.token);
  const relayClosed = once(relay.ws, 'close'), phoneClosed = once(phone.ws, 'close');
  assert.equal((await request(`computers?relay_id=${first.relay_id}`, 'DELETE', undefined, alice.token)).status, 204);
  assert.equal((await relayClosed)[0], 4003);
  assert.equal((await phoneClosed)[0], 1013);
  assert.equal((await connect(base, `/v1/relay/ws?relay_id=${first.relay_id}`, first.relay_token)).status, 401);
  assert.deepEqual((await request('computers', 'GET', undefined, bob.token)).body.computers, []);
  assert.equal((await request('computers', 'POST', { relay_id: first.relay_id, pairing_code: first.pairing_code }, bob.token)).status, 403);

  const other = await connect(base, `/v1/relay/ws?relay_id=${second.relay_id}`, second.relay_token);
  const otherClosed = once(other.ws, 'close');
  assert.equal((await request('me', 'DELETE', { password }, alice.token)).status, 204);
  assert.equal((await otherClosed)[0], 4003);
  assert.equal((await connect(base, `/v1/relay/ws?relay_id=${second.relay_id}`, second.relay_token)).status, 401);
});

test('a non-owner unbinding an enrolled computer keeps it for the owner', async (t) => {
  const { base, request, register } = await fixture(t);
  const alice = await register('alice'), bob = await register('bob');
  const enrolled = (await request('relays', 'POST', { name: 'Mac' }, alice.token)).body;
  await request('computers', 'POST', { relay_id: enrolled.relay_id, pairing_code: enrolled.pairing_code }, bob.token);
  const relay = await connect(base, `/v1/relay/ws?relay_id=${enrolled.relay_id}`, enrolled.relay_token);
  assert.equal((await request(`computers?relay_id=${enrolled.relay_id}`, 'DELETE', undefined, bob.token)).status, 204);
  assert.equal(relay.ws.readyState, WebSocket.OPEN);
  assert.equal((await request('computers', 'GET', undefined, alice.token)).body.computers.length, 1);
  assert.deepEqual((await request('computers', 'GET', undefined, bob.token)).body.computers, []);
});

test('enrollment can be disabled and is bounded per account', async (t) => {
  const { request, register, boot, client } = await fixture(t, { maxRelaysPerAccount: 2 });
  const alice = await register('alice');
  assert.equal((await request('relays', 'POST', { name: 42 }, alice.token)).status, 400);
  assert.equal((await request('relays', 'POST', {}, alice.token)).status, 201);
  assert.equal((await request('relays', 'POST', {}, alice.token)).status, 201);
  assert.deepEqual(await request('relays', 'POST', {}, alice.token), { status: 429, body: { error: 'relay_limit_reached' } });
  const closed = await boot({ relayEnrollment: false, relays: [{ relay_id: 'home', relay_token: 'home-tunnel', pairing_code: 'home-pair' }] });
  const health = await (await fetch(`${closed.base}/v1/health`)).json();
  assert.equal(health.relay_enrollment, false);
  assert.deepEqual(await client(closed.base).request('relays', 'POST', {}, alice.token), { status: 403, body: { error: 'relay_enrollment_disabled' } });
});
