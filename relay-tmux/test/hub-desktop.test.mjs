import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readFile, stat, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocketServer } from 'ws';
import { createHub } from '../src/hub/server.mjs';
import { scoped } from '../src/hub/ids.mjs';
import { RpcPeer } from '../src/hub/rpc.mjs';
import { inputItems } from '../src/server.mjs';

/** A stand-in cmux relay that records calls and can answer some methods slowly. */
async function upstream(t) {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(server, 'listening');
  t.after(async () => { for (const ws of server.clients) ws.terminate(); await new Promise((resolve) => server.close(resolve)); });
  const calls = [], answered = [], delays = new Map(), failures = new Map(), bindings = new Map();
  server.on('connection', (ws) => ws.on('message', async (raw) => {
    const m = JSON.parse(raw); if (!m.method) return;
    calls.push(m);
    if (m.id == null) return;
    const wait = delays.get(m.method); if (wait) await delay(wait);
    answered.push(m.method);
    if (failures.has(m.method)) { ws.send(JSON.stringify({ id: m.id, ok: false, error: failures.get(m.method) })); return; }
    let result = {};
    if (m.method === 'workspace.list') result = { window_id: 'window', workspaces: [{ id: '$0', title: 'cmux workspace', selected: true }] };
    if (m.method === 'surface.resume.get') result = { resume_binding: bindings.get(m.params.surface_id) ?? null };
    ws.send(JSON.stringify({ id: m.id, ok: true, result }));
  }));
  return { calls, answered, delays, failures, bindings, url: `ws://127.0.0.1:${server.address().port}` };
}

async function directory(t, prefix) {
  const path = await mkdtemp(join(tmpdir(), prefix)); t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

async function localPeer(t, hub, path) {
  const local = JSON.parse(await readFile(path, 'utf8'));
  const peer = new RpcPeer({ url: local.url, token: local.token, protocols: ['cmuxremote.v1'], hello: { deviceId: local.device_id, protocolVersion: 1 } });
  await peer.connect(); t.after(() => peer.close());
  return { peer, local };
}

test('the hub leaves an owner-only local credential that a desktop app on this computer can use without pairing', async (t) => {
  const state = await directory(t, 'panecast-local-');
  const cmux = await upstream(t);
  const config = { state_directory: state, port: 0, broker: undefined, sources: [{ id: 'cmux', type: 'cmux', url: cmux.url, token: 'fixture-only', device_id: 'fixture' }] };
  const hub = await createHub(config);
  const address = await hub.start(); t.after(() => hub.close());
  const path = join(state, 'local-gateway.json');
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  const { peer, local } = await localPeer(t, hub, path);
  assert.equal(local.url, `ws://127.0.0.1:${address.port}/v1/ws`);
  assert.equal(local.health_url, `http://127.0.0.1:${address.port}/v1/health`);
  assert.equal(local.backend, 'hub');
  const { workspaces } = await peer.call('workspace.list', {});
  assert.equal(workspaces[0].id, scoped('cmux', '$0'));
  // Without a LAN pairing code nobody can pair over the network.
  const response = await fetch(`http://127.0.0.1:${address.port}/v1/devices/me/register`, { method: 'POST', body: JSON.stringify({ pairing_code: '', client_id: 'x', device_name: 'x' }) });
  assert.equal(response.status, 403);
  await hub.close();
  await assert.rejects(access(path), 'closing the hub withdraws the credential');
});

test('restarting the hub rotates the local credential and turning it off writes nothing', async (t) => {
  const state = await directory(t, 'panecast-local-rotate-');
  const path = join(state, 'local-gateway.json');
  const first = await createHub({ state_directory: state, port: 0, sources: [] });
  await first.start();
  const before = JSON.parse(await readFile(path, 'utf8'));
  await first.close();
  const second = await createHub({ state_directory: state, port: 0, sources: [] });
  const address = await second.start(); t.after(() => second.close());
  const after = JSON.parse(await readFile(path, 'utf8'));
  assert.notEqual(after.token, before.token);
  const stale = await fetch(`http://127.0.0.1:${address.port}/v1/devices/me`, { method: 'DELETE', headers: { Authorization: `Bearer ${before.token}` } });
  assert.equal(stale.status, 401, 'the previous token stopped working');

  const disabledState = await directory(t, 'panecast-local-off-');
  const disabled = await createHub({ state_directory: disabledState, port: 0, sources: [], local_gateway: false });
  await disabled.start(); t.after(() => disabled.close());
  await assert.rejects(access(join(disabledState, 'local-gateway.json')));
});

test('surface.input sends a batch in order and reports how much arrived before a failure', async (t) => {
  const state = await directory(t, 'panecast-input-');
  const cmux = await upstream(t);
  const hub = await createHub({ state_directory: state, port: 0, sources: [{ id: 'cmux', type: 'cmux', url: cmux.url, token: 'fixture-only', device_id: 'fixture' }] });
  await hub.start(); t.after(() => hub.close());
  const { peer } = await localPeer(t, hub, join(state, 'local-gateway.json'));
  const target = { workspace_id: scoped('cmux', '$0'), surface_id: scoped('cmux', '%0') };
  const result = await peer.call('surface.input', { ...target, items: [{ text: 'ls -l' }, { key: 'enter' }, { text: '中文' }, { key: 'ctrl-c' }] });
  assert.deepEqual(result, { sent: 4 });
  const sent = cmux.calls.filter((c) => c.method.startsWith('surface.send_'));
  assert.deepEqual(sent.map((c) => [c.method, c.params]), [
    ['surface.send_text', { workspace_id: '$0', surface_id: '%0', text: 'ls -l' }],
    ['surface.send_key', { workspace_id: '$0', surface_id: '%0', key: 'enter' }],
    ['surface.send_text', { workspace_id: '$0', surface_id: '%0', text: '中文' }],
    ['surface.send_key', { workspace_id: '$0', surface_id: '%0', key: 'ctrl-c' }],
  ]);
  assert.equal(cmux.calls.some((c) => c.method === 'surface.focus'), false, 'named-terminal input never moves focus on the Mac');

  cmux.failures.set('surface.send_key', { code: 'process_exited', message: 'gone' });
  await assert.rejects(peer.call('surface.input', { ...target, items: [{ text: 'a' }, { key: 'enter' }, { text: 'b' }] }),
    (error) => error.code === 'process_exited' && error.data?.sent === 1);
  await assert.rejects(peer.call('surface.input', { ...target, items: [] }), { code: 'invalid_params' });
  await assert.rejects(peer.call('surface.input', { ...target, items: [{ text: 'a', key: 'enter' }] }), { code: 'invalid_params' });
});

test('input validation bounds the batch', () => {
  assert.deepEqual(inputItems({ items: [{ text: 'x' }, { key: 'ctrl-[' }] }), [{ text: 'x' }, { key: 'ctrl-[' }]);
  assert.throws(() => inputItems({ items: [{ key: 'enter\n' }] }), { code: 'invalid_params' });
  assert.throws(() => inputItems({ items: Array.from({ length: 513 }, () => ({ text: 'x' })) }), { code: 'invalid_params' });
  assert.throws(() => inputItems({ items: [{ text: 'x'.repeat(256 * 1024 + 1) }] }), { code: 'invalid_params' });
});

test('a slow read does not hold up keystrokes behind it', async (t) => {
  const state = await directory(t, 'panecast-lanes-');
  const cmux = await upstream(t);
  const hub = await createHub({ state_directory: state, port: 0, sources: [{ id: 'cmux', type: 'cmux', url: cmux.url, token: 'fixture-only', device_id: 'fixture' }] });
  await hub.start(); t.after(() => hub.close());
  const { peer } = await localPeer(t, hub, join(state, 'local-gateway.json'));
  const target = { workspace_id: scoped('cmux', '$0'), surface_id: scoped('cmux', '%0') };
  cmux.delays.set('surface.list', 400);
  const order = [];
  const slow = peer.call('surface.list', { workspace_id: target.workspace_id }).then(() => order.push('read'));
  await delay(20);
  const typed = peer.call('surface.input', { ...target, items: [{ text: 'q' }] }).then(() => order.push('input'));
  await Promise.all([slow, typed]);
  assert.deepEqual(order, ['input', 'read']);

  // Writes still keep their order among themselves.
  cmux.delays.delete('surface.list');
  cmux.delays.set('surface.send_text', 60);
  const writes = await Promise.all([
    peer.call('surface.send_text', { ...target, text: '1' }),
    peer.call('surface.send_key', { ...target, key: 'enter' }),
  ].map((call, index) => call.then(() => index)));
  assert.deepEqual(writes, [0, 1]);
  const lastTwo = cmux.answered.slice(-2);
  assert.deepEqual(lastTwo, ['surface.send_text', 'surface.send_key']);
});

test('terminal.conversation.batch answers each terminal independently', async (t) => {
  const state = await directory(t, 'panecast-batch-');
  const cmux = await upstream(t), id = randomUUID();
  const codexHome = join(state, 'codex'); await mkdir(join(codexHome, 'sessions'), { recursive: true });
  await writeFile(join(codexHome, 'sessions', `${id}.jsonl`), [
    { type: 'session_meta', payload: { id } }, { type: 'event_msg', payload: { type: 'user_message', message: 'batched' } },
  ].map((value) => JSON.stringify(value) + '\n').join(''));
  cmux.bindings.set('%0', { kind: 'codex', checkpoint_id: id, execution_location: 'local', cwd: state });
  const hub = await createHub({ state_directory: join(state, 'hub'), port: 0, sources: [{ id: 'cmux', type: 'cmux', url: cmux.url, token: 'fixture-only', device_id: 'fixture', codex_home: codexHome }] });
  await hub.start(); t.after(() => hub.close());
  const { peer } = await localPeer(t, hub, join(state, 'hub', 'local-gateway.json'));
  const workspace = scoped('cmux', '$0');
  const { results } = await peer.call('terminal.conversation.batch', { requests: [
    { workspace_id: workspace, surface_id: scoped('cmux', '%0'), limit: 20 },
    { workspace_id: workspace, surface_id: scoped('cmux', '%1'), limit: 20 },
    { workspace_id: workspace, surface_id: scoped('other', '%0') },
  ] });
  assert.equal(results[0].ok, true); assert.equal(results[0].result.conversation_id, id);
  assert.equal(results[1].ok, true); assert.equal(results[1].result.available, false);
  assert.equal(results[2].ok, false); assert.equal(results[2].error.code, 'invalid_target');
  const again = await peer.call('terminal.conversation.batch', { requests: [{ workspace_id: workspace, surface_id: scoped('cmux', '%0'), revision: results[0].result.revision }] });
  assert.equal(again.results[0].result.unchanged, true);
  await assert.rejects(peer.call('terminal.conversation.batch', { requests: 'no' }), { code: 'invalid_params' });
});

test('tmux cursors are placed in the same row space as the rows sent', async () => {
  const { screenCursor } = await import('../src/server.mjs');
  const rows = ['history 1', 'history 2', 'line 0', '$ ls', ''];
  assert.deepEqual(screenCursor(rows, { cursor: { x: 4, y: 1 }, height: 3 }), { x: 4, y: 3 });
  assert.deepEqual(screenCursor(rows, { cursor: { x: 0, y: 5 }, height: 3 }), { x: 0, y: 5 }, 'outside the pane: hidden');
  assert.deepEqual(screenCursor(['a'], { cursor: { x: 1, y: 2 }, height: 3 }), { x: 0, y: 1 }, 'fewer rows than the pane: hidden');
  assert.deepEqual(screenCursor(rows, { cursor: { x: 2, y: 0 } }), { x: 2, y: 0 });
});

test('a read that arrives together with the hello still runs beside the ordered lane', async () => {
  const { RelaySession } = await import('../src/server.mjs');
  const sent = [], order = [];
  const session = new RelaySession(null, {}, (frame) => sent.push(frame), () => order.push('closed'), () => {});
  let releaseRead;
  session.dispatch = async (method) => {
    if (method === 'surface.list') { await new Promise((resolve) => { releaseRead = resolve; }); order.push('read'); return {}; }
    order.push(method); return {};
  };
  // All three frames arrive before any of them is processed.
  session.receive(JSON.stringify({ protocolVersion: 1, deviceId: 'phone' }));
  session.receive(JSON.stringify({ id: '1', method: 'surface.list', params: {} }));
  session.receive(JSON.stringify({ id: '2', method: 'surface.send_text', params: { text: 'x' } }));
  for (let i = 0; i < 20 && !order.includes('surface.send_text'); i++) await delay(5);
  assert.deepEqual(order, ['surface.send_text'], 'the keystroke is not stuck behind the read');
  releaseRead();
  for (let i = 0; i < 20 && sent.length < 2; i++) await delay(5);
  assert.deepEqual(sent.map((frame) => frame.id).sort(), ['1', '2']);
  session.dispose();
});
