import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverInto, discoverSources } from '../src/hub/discover.mjs';

async function home(t, relay) {
  const directory = await mkdtemp(join(tmpdir(), 'panecast-discover-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, '.cmuxremote'), { recursive: true });
  if (relay) await writeFile(join(directory, '.cmuxremote', 'relay.json'), JSON.stringify(relay));
  return directory;
}

/** A stand-in for the cmux relay's LAN pairing route. */
async function fakeRelay(t, { status = 200, onRegister } = {}) {
  const requests = [];
  const server = http.createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk;
    requests.push({ path: request.url, body: JSON.parse(body) });
    await onRegister?.();
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(status === 200 ? { device_id: 'hub-device', token: 'hub-token' } : {}));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { port: server.address().port, requests };
}

test('every source this computer provides is added with full access and cmux registers itself', async (t) => {
  const relay = await fakeRelay(t);
  const directory = await home(t, { transport: 'both', listen: `0.0.0.0:${relay.port}`, lan: { pairing_code: 'lan-code' } });
  await mkdir(join(directory, '.codex'));
  await mkdir(join(directory, '.cmuxremote', 'desktop'));
  await writeFile(join(directory, '.cmuxremote', 'desktop', 'source.json'), JSON.stringify({ id: 'codex-desktop', name: 'Codex 桌面会话', type: 'codex', enabled: false, access: 'read', mode: 'attach', socket: '/tmp/x.sock' }));
  const path = join(directory, 'hub-relay.json');
  await writeFile(path, JSON.stringify({ broker: { relay_id: 'keep' }, sources: [] }), { mode: 0o600 });
  const options = { home: directory, lanHost: '127.0.0.1', tmux: () => true };

  assert.deepEqual(await discoverInto(path, options), ['tmux', 'codex', 'codex-desktop', 'cmux']);
  const config = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(config.broker.relay_id, 'keep');
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.deepEqual(config.sources, [
    { id: 'tmux', name: 'tmux', type: 'tmux' },
    { id: 'codex', name: 'Codex', type: 'codex', mode: 'managed' },
    { id: 'codex-desktop', name: 'Codex 桌面会话', type: 'codex', mode: 'attach', socket: '/tmp/x.sock' },
    { id: 'cmux', name: 'cmux', type: 'cmux', url: `ws://127.0.0.1:${relay.port}/v1/ws`, device_id: 'hub-device', token: 'hub-token' },
  ]);
  assert.equal(relay.requests.length, 1);
  assert.equal(relay.requests[0].path, '/v1/devices/me/register');
  assert.equal(relay.requests[0].body.pairing_code, 'lan-code');

  assert.deepEqual(await discoverInto(path, options), [], 'a second run changes nothing and does not re-register');
  assert.equal(relay.requests.length, 1);
});

test('a cmux placeholder is filled in place and existing sources are left untouched', async (t) => {
  const relay = await fakeRelay(t);
  const directory = await home(t, { listen: `0.0.0.0:${relay.port}`, lan: { pairing_code: 'lan-code' } });
  const existing = [
    { id: 'tmux', name: 'Work tmux', type: 'tmux', tmux_socket: 'work' },
    { id: 'cmux-main', type: 'cmux', url: 'ws://127.0.0.1:4399/v1/ws', device_id: 'REPLACE_WITH_REGISTERED_DEVICE_ID', token: 'REPLACE_WITH_REGISTERED_DEVICE_TOKEN' },
  ];
  const { sources, added } = await discoverSources(existing, { home: directory, lanHost: '127.0.0.1', tmux: () => true });
  assert.deepEqual(added.map((s) => s.id), ['cmux-main']);
  assert.deepEqual(sources[0], existing[0]);
  assert.equal(sources[1].id, 'cmux-main'); assert.equal(sources[1].token, 'hub-token');
});

test('cmux is skipped without a reachable LAN pairing route and nothing is written', async (t) => {
  const relay = await fakeRelay(t, { status: 403 });
  for (const config of [
    { listen: `0.0.0.0:${relay.port}` },
    { transport: 'broker', listen: `0.0.0.0:${relay.port}`, lan: { pairing_code: 'lan-code' } },
    { listen: `127.0.0.1:${relay.port}`, lan: { pairing_code: 'lan-code' } },
  ]) {
    const directory = await home(t, config);
    assert.deepEqual((await discoverSources([], { home: directory, lanHost: '127.0.0.1', tmux: () => false })).added, []);
  }
  assert.equal(relay.requests.length, 0, 'no request without LAN pairing');
  const directory = await home(t, { listen: `0.0.0.0:${relay.port}`, lan: { pairing_code: 'wrong' } });
  const path = join(directory, 'hub-relay.json'); await writeFile(path, '{"sources":[]}');
  assert.deepEqual(await discoverInto(path, { home: directory, lanHost: '127.0.0.1', tmux: () => false }), []);
  assert.equal(relay.requests.length, 1);
  assert.equal(await readFile(path, 'utf8'), '{"sources":[]}');
});

test('discovery merges into edits made while it waited on the relay', async (t) => {
  let path;
  const relay = await fakeRelay(t, { onRegister: async () => {
    const config = JSON.parse(await readFile(path, 'utf8'));
    await writeFile(path, JSON.stringify({ ...config, sources: [...config.sources, { id: 'manual', type: 'tmux' }] }));
  } });
  const directory = await home(t, { listen: `0.0.0.0:${relay.port}`, lan: { pairing_code: 'lan-code' } });
  path = join(directory, 'hub-relay.json');
  await writeFile(path, JSON.stringify({ sources: [{ id: 'tmux', type: 'tmux' }] }));
  await discoverInto(path, { home: directory, lanHost: '127.0.0.1', tmux: () => true });
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')).sources.map((s) => s.id), ['tmux', 'manual', 'cmux']);
});
