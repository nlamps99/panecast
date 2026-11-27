import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, writeFile, rm, symlink, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import { WebSocket, WebSocketServer } from 'ws';
import { once } from 'node:events';
import { TmuxBackend, tmuxKey, project, projectPath, run } from '../src/tmux.mjs';
import { createTmuxRelay, RelaySession, sendInputItems } from '../src/server.mjs';
import { PushService } from '../src/push.mjs';

async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'panecast-tmux-'));
  const backend = new TmuxBackend({ socketName: `panecast-test-${randomUUID()}`, configFile: '/dev/null', ...options });
  t.after(async () => { await backend.tmux(['kill-server']).catch(() => {}); await rm(directory, { recursive: true, force: true }); });
  return { directory, backend };
}
const delay = (ms) => new Promise((res) => setTimeout(res, ms));

test('maps Ctrl + Up and modifiers to tmux keys', () => {
  assert.equal(tmuxKey('ctrl-up'), 'C-Up'); assert.equal(tmuxKey('ctrl-alt-left'), 'C-M-Left');
  assert.equal(tmuxKey('ctrl-c'), 'C-c'); assert.throws(() => tmuxKey('cmd-unknown'));
});
test('tmux takes both Panecast and cmux key names', () => {
  for (const name of ['pgup', 'pageup', 'page_up', 'PageUp']) assert.equal(tmuxKey(name), 'PPage', name);
  for (const name of ['pgdn', 'pagedown', 'page_down']) assert.equal(tmuxKey(name), 'NPage', name);
  assert.equal(tmuxKey('return'), 'Enter'); assert.equal(tmuxKey('del'), 'DC'); assert.equal(tmuxKey('arrow_up'), 'Up');
  assert.equal(tmuxKey('ctrl+up'), 'C-Up'); assert.equal(tmuxKey('shift+tab'), tmuxKey('shift-tab')); assert.equal(tmuxKey('ctrl+alt+left'), 'C-M-Left');
  assert.equal(tmuxKey('alt-ctrl-x'), 'M-C-x'); assert.equal(tmuxKey('backtab'), 'BTab'); assert.equal(tmuxKey('space'), 'Space');
  for (const n of [1, 5, 12]) assert.equal(tmuxKey(`f${n}`), `F${n}`);
  // A literal - or + is still a key of its own.
  assert.equal(tmuxKey('-'), '-'); assert.equal(tmuxKey('ctrl--'), 'C--'); assert.equal(tmuxKey('+'), '+');
  for (const bad of ['f13', 'cmd+c', 'pageupp', 'ctrl+']) assert.throws(() => tmuxKey(bad), { code: 'invalid_key' }, bad);
});
test('batched input joins consecutive text and keys, keeps their order, and counts what arrived', async () => {
  const calls = [];
  const call = async (name, params) => { calls.push([name, params.text ?? params.key]); if (params.text === 'fail') throw Object.assign(new Error('nope'), { code: 'backend_error' }); };
  const target = { workspace_id: '$0', surface_id: '%0' };
  const items = [{ text: 'echo ' }, { text: '中文' }, { key: 'enter' }, { key: 'up' }, { text: 'x' }, { key: 'tab' }];
  assert.deepEqual(await sendInputItems(items, target, call), { sent: 6 });
  assert.deepEqual(calls, [['surface.send_text', 'echo 中文'], ['surface.send_key', 'enter'], ['surface.send_key', 'up'], ['surface.send_text', 'x'], ['surface.send_key', 'tab']]);
  calls.length = 0; const batches = [];
  assert.deepEqual(await sendInputItems(items, target, call, async (keys) => { batches.push(keys); }), { sent: 6 });
  assert.deepEqual(batches, [['enter', 'up']]);
  assert.deepEqual(calls, [['surface.send_text', 'echo 中文'], ['surface.send_text', 'x'], ['surface.send_key', 'tab']]);
  // A run that fails is not counted; everything before it arrived. ('fa' + 'il' go as one 'fail'.)
  await assert.rejects(sendInputItems([{ text: 'a' }, { key: 'enter' }, { text: 'fa' }, { text: 'il' }, { key: 'enter' }], target, call),
    (error) => error.code === 'backend_error' && error.data.sent === 2);
});
test('tmux gets one paste per text run and one send-keys per key run', async (t) => {
  const commands = [];
  const { backend } = await fixture(t, { execute: (command, args, input) => { commands.push(args.find((arg) => /^[a-z]+-[a-z]+$/.test(arg))); return run(command, args, input); } });
  const { workspace_id } = await backend.dispatch('workspace.create', { title: 'batch-test' });
  const pane = (await backend.surfaces(workspace_id))[0];
  const target = { workspace_id, surface_id: pane.id };
  const session = new RelaySession(backend, {}, () => {}, () => {}, () => {});
  t.after(() => session.dispose());
  commands.length = 0;
  const items = [{ text: 'echo pane' }, { text: 'cast-X' }, { key: 'backspace' }, { key: 'enter' }, { text: 'echo second-line' }, { key: 'enter' }];
  assert.deepEqual(await session.dispatch('surface.input', { ...target, items }), { sent: 6 });
  assert.equal(commands.filter((c) => c === 'load-buffer').length, 2);
  assert.equal(commands.filter((c) => c === 'send-keys').length, 2);
  let output = '';
  for (let i = 0; i < 100 && !/^second-line$/m.test(output); i++) { await delay(50); output = (await backend.capture(target, 50)).rows.join('\n'); }
  // The backspace took the X back before Enter ran the line.
  assert.match(output, /^panecast-$/m); assert.doesNotMatch(output, /panecast-X/);
  assert.match(output, /^panecast-\n[\s\S]*^second-line$/m);
});
test('an idle terminal is polled less often until input or a change wakes it', async (t) => {
  let captures = 0, rows = ['same'], tick = 0, lastPoll = 0, longestGap = 0;
  const backend = { surface: async () => ({}), dispatch: async () => ({}),
    capture: async () => { captures++; longestGap = Math.max(longestGap, tick - lastPoll); lastPoll = tick; return { rows, surface: { cols: 80, height: 1, cursor: { x: 0, y: 0 } } }; } };
  const frames = [];
  const session = new RelaySession(backend, {}, (frame) => frames.push(frame), () => {}, () => {});
  t.after(() => session.dispose());
  const target = { workspace_id: '$0', surface_id: '%0' };
  await session.dispatch('surface.subscribe', target);
  const ticks = async (count) => { const before = captures; for (let i = 0; i < count; i++) { tick++; session.tick(); await new Promise((res) => setImmediate(res)); } return captures - before; };
  assert.equal(await ticks(4), 4, 'the first second polls every tick');
  // 500 ms between polls for the next second, then 1 s (every fourth tick), never longer.
  assert.equal(await ticks(8), 4, 'then every other tick');
  assert.equal(await ticks(32), 8, 'then every fourth tick');
  assert.equal(longestGap, 4, 'an idle terminal is still polled at least once a second');
  await session.dispatch('surface.input', { ...target, items: [{ text: 'ls' }, { key: 'enter' }] });
  assert.equal(await ticks(1), 1, 'input wakes it at once');
  await ticks(30); rows = ['changed'];
  const sent = frames.length;
  for (let i = 0; i < 8 && frames.length === sent; i++) await ticks(1);
  assert.equal(frames.at(-1).type, 'screen.diff'); assert.equal(await ticks(3), 3, 'a change brings back every tick');
  await ticks(30); await session.dispatch('surface.send_key', { ...target, key: 'enter' });
  assert.equal(await ticks(1), 1);
});
test('no new screen is made while the transport still holds earlier ones', async (t) => {
  let captures = 0, row = 0, congested = false;
  const backend = { surface: async () => ({}), dispatch: async () => ({}),
    capture: async () => { captures++; return { rows: [`row ${row++}`], surface: { cols: 80, height: 1, cursor: { x: 0, y: 0 } } }; } };
  const frames = [];
  const session = new RelaySession(backend, {}, (frame) => frames.push(frame), () => {}, () => {});
  session.congested = () => congested; t.after(() => session.dispose());
  await session.dispatch('surface.subscribe', { workspace_id: '$0', surface_id: '%0' });
  congested = true;
  for (let i = 0; i < 5; i++) { session.tick(); await new Promise((res) => setImmediate(res)); }
  assert.equal(captures, 1); assert.equal(frames.length, 1);
  congested = false; session.tick(); await new Promise((res) => setImmediate(res));
  assert.equal(frames.length, 2); assert.equal(frames[1].rev, 2, 'the next screen follows the last one sent');
});
test('manages isolated real tmux sessions, sends Chinese input and reads history', async (t) => {
  const { backend } = await fixture(t);
  assert.deepEqual(await backend.workspaces(), []);
  const created = await backend.dispatch('workspace.create', { title: 'panecast-test' });
  const workspace_id = created.workspace_id;
  const pane = (await backend.surfaces(workspace_id))[0];
  const target = { workspace_id, surface_id: pane.id };
  await backend.dispatch('surface.send_text', { ...target, text: "printf '手机终端验证\\n'" });
  await backend.dispatch('surface.send_key', { ...target, key: 'enter' });
  await delay(150);
  assert.match((await backend.capture(target, 200)).rows.join('\n'), /手机终端验证/);
  const second = await backend.dispatch('surface.create', { workspace_id });
  assert.equal((await backend.surfaces(workspace_id)).length, 2);
  await backend.dispatch('surface.close', { workspace_id, surface_id: second.surface_id });
  await assert.rejects(backend.dispatch('surface.close', target), /最后一个/);
  await assert.rejects(backend.dispatch('surface.send_text', { workspace_id: '$99999', surface_id: pane.id, text: 'bad' }));
});
test('Ctrl + Up arrives at the target program as the actual terminal escape sequence', async (t) => {
  const { backend, directory } = await fixture(t);
  const reader = join(directory, 'keys.cjs');
  await writeFile(reader, "process.stdin.setRawMode(true); process.stdin.on('data', data => console.log([...data].join(','))); console.log('READY');");
  const id = (await backend.tmux(['new-session', '-d', '-P', '-F', '#{session_id}', '-s', 'keys', '--', process.execPath, reader])).trim();
  const pane = (await backend.surfaces(id))[0]; const target = { workspace_id: id, surface_id: pane.id };
  for (let attempt = 0; attempt < 20; attempt++) { if ((await backend.capture(target)).rows.join('\n').includes('READY')) break; await delay(50); }
  await backend.dispatch('surface.send_key', { ...target, key: 'ctrl-up' }); await delay(100);
  assert.match((await backend.capture(target)).rows.join('\n'), /27,91,49,59,53,65/);
});
test('a C locale preserves tmux identifiers, Unicode output and multiline input', async (t) => {
  const { backend, directory } = await fixture(t, {
    execute: (command, args, input) => run('env', ['LANG=C', 'LC_ALL=C', 'LC_CTYPE=C', command, ...args], input),
  });
  const reader = join(directory, 'reader.cjs'), received = join(directory, 'received');
  await writeFile(received, '');
  await writeFile(reader, `
    const fs = require('node:fs');
    process.stdin.setRawMode(true);
    process.stdin.on('data', data => fs.appendFileSync(${JSON.stringify(received)}, data));
    console.log('READY 中文输出');
  `);
  const workspace_id = (await backend.tmux(['new-session', '-d', '-P', '-F', '#{session_id}', '-s', '中文工作区', '--', process.execPath, reader])).trim();
  const workspaces = await backend.workspaces();
  assert.equal(workspaces[0].id, workspace_id);
  assert.equal(workspaces[0].title, '中文工作区');
  const pane = (await backend.surfaces(workspace_id))[0];
  assert.match(pane.id, /^%\d+$/);
  assert.ok(pane.cols > 0 && pane.height > 0);
  assert.ok(Number.isFinite(pane.cursor.x) && Number.isFinite(pane.cursor.y));
  const target = { workspace_id, surface_id: pane.id };
  await backend.tmux(['select-pane', '-t', pane.id, '-T', '中文标题']);
  assert.equal((await backend.surface(target)).title, '中文标题');
  let output = '';
  for (let attempt = 0; attempt < 40; attempt++) {
    output = (await backend.capture(target)).rows.join('\n');
    if (output.includes('READY 中文输出')) break;
    await delay(50);
  }
  assert.match(output, /READY 中文输出/);
  const text = '中文\t first line\n第二行\r';
  await backend.dispatch('surface.send_text', { ...target, text });
  let actual;
  for (let attempt = 0; attempt < 40; attempt++) {
    actual = await readFile(received);
    if (actual.length >= Buffer.byteLength(text)) break;
    await delay(50);
  }
  assert.deepEqual(actual, Buffer.from(text));
});
test('project preview rejects traversal and symlinks escaping the project', async (t) => {
  const { directory } = await fixture(t);
  const root = join(directory, 'project'); await (await import('node:fs/promises')).mkdir(root);
  await writeFile(join(root, 'hello.txt'), '你好'); await writeFile(join(directory, 'outside'), 'secret');
  await symlink(join(directory, 'outside'), join(root, 'escape'));
  await assert.rejects(projectPath(root, '../outside')); await assert.rejects(projectPath(root, 'escape'));
  assert.equal((await project('project.read', root, 'hello.txt')).text, '你好');
  assert.deepEqual((await project('project.list', root, '')).entries.map((e) => e.name), ['hello.txt']);
});
test('push registrations require a live device lease and stop after revocation or disconnect', async (t) => {
  const { directory } = await fixture(t); let now = 1000, deliveries = 0;
  const push = new PushService({ path: join(directory, 'push.json'), relayId: 'test', now: () => now,
    config: { key_path: 'key', key_id: 'key', team_id: 'team', topic: 'app', env: 'prod' }, send: async () => { deliveries++; return { status: 200 }; } });
  const registration = { type: 'push.register', device_id: 'phone', text: JSON.stringify({ apns_token: 'aabb', env: 'prod' }) };
  assert.equal((await push.receive(registration)).ok, false);
  await push.receive({ type: 'push.sync', text: '["phone"]' });
  assert.equal((await push.receive(registration)).push_enabled, true);
  await push.notify({ id: 'n', workspace_id: '$0', status: 'completed' }); assert.equal(deliveries, 1);
  now += 46_000; await push.notify({ id: 'n', workspace_id: '$0', status: 'completed' }); assert.equal(deliveries, 1);
  await push.receive({ type: 'push.sync', text: '[]' }); assert.equal(Object.keys(push.devices).length, 0);
});
test('authenticated WebSocket carries hello, workspace RPC and screens from real tmux', async (t) => {
  const { backend, directory } = await fixture(t);
  const { workspace_id } = await backend.dispatch('workspace.create', { title: 'wire-test' });
  const pane = (await backend.surfaces(workspace_id))[0];
  const relay = await createTmuxRelay({ state_directory: directory, notify_socket: join(directory, 'notify.sock'), lan: { pairing_code: 'pair-secret' }, port: 0, host: '127.0.0.1' }, { backend });
  const address = await relay.start(); t.after(() => relay.close());
  const url = `http://127.0.0.1:${address.port}`;
  const credentials = await (await fetch(`${url}/v1/devices/me/register`, { method: 'POST', body: JSON.stringify({ pairing_code: 'pair-secret', client_id: 'phone', device_name: 'test' }) })).json();
  const ws = new WebSocket(url.replace('http', 'ws') + '/v1/ws', ['cmuxremote.v1'], { headers: { Authorization: `Bearer ${credentials.token}` } });
  t.after(() => ws.terminate());
  const frames = []; ws.on('message', (data) => frames.push(JSON.parse(data)));
  await new Promise((res, rej) => { ws.on('open', () => { ws.send(JSON.stringify({ deviceId: credentials.device_id, protocolVersion: 1, appVersion: 'test' })); res(); }); ws.on('error', rej); });
  ws.send(JSON.stringify({ id: '1', method: 'workspace.list', params: {} }));
  ws.send(JSON.stringify({ id: '2', method: 'surface.subscribe', params: { workspace_id, surface_id: pane.id, lines: 120 } }));
  for (let i = 0; i < 30 && !frames.some((f) => f.type === 'screen.full'); i++) await delay(50);
  assert.equal(frames.find((f) => f.id === '1').result.workspaces[0].id, workspace_id);
  assert.ok(frames.some((f) => f.type === 'screen.full' && f.surface_id === pane.id));
});
test('history cursors cannot be reused for another terminal', async () => {
  const backend = { capture: async () => ({ rows: Array.from({ length: 100 }, (_, i) => String(i)) }) };
  const session = new RelaySession(backend, {}, () => {}, () => {}, () => {});
  const first = await session.historyPage({ workspace_id: '$0', surface_id: '%0', tail_lines: 10, limit: 10 });
  assert.deepEqual(first.rows, Array.from({ length: 10 }, (_, i) => String(80 + i)));
  await assert.rejects(session.historyPage({ workspace_id: '$0', surface_id: '%1', cursor: first.next_cursor }), /过期/);
  session.dispose();
});

test('a second relay failing to bind never removes the first relay socket', async (t) => {
  const { backend, directory } = await fixture(t);
  const config = { state_directory: directory, notify_socket: join(directory, 'notify.sock') };
  const first = await createTmuxRelay(config, { backend }); await first.start();
  t.after(() => first.close());
  const second = await createTmuxRelay(config, { backend });
  await assert.rejects(second.start(), /EADDRINUSE/); await second.close();
  assert.equal((await stat(config.notify_socket)).isSocket(), true);
});

test('a relay starts over the socket a crashed relay left behind', async (t) => {
  const { backend, directory } = await fixture(t);
  const config = { state_directory: directory, notify_socket: join(directory, 'notify.sock') };
  // A process killed while listening leaves its socket file with nobody answering.
  await new Promise((res, rej) => {
    const child = spawn(process.execPath, ['-e', `require('net').createServer().listen(${JSON.stringify(config.notify_socket)}, () => process.kill(process.pid, 'SIGKILL'))`]);
    child.on('exit', res); child.on('error', rej);
  });
  assert.equal((await stat(config.notify_socket)).isSocket(), true);
  const relay = await createTmuxRelay(config, { backend }); await relay.start();
  t.after(() => relay.close());
  const answer = await new Promise((res) => { const probe = connect(config.notify_socket); probe.once('connect', () => { probe.destroy(); res(true); }); probe.once('error', () => res(false)); });
  assert.equal(answer, true);
});

test('a client hanging up before an unauthorized upgrade is answered leaves the relay running', async (t) => {
  const { backend, directory } = await fixture(t);
  const relay = await createTmuxRelay({ state_directory: directory, notify_socket: join(directory, 'notify.sock'), lan: { pairing_code: 'pair-secret' }, port: 0, host: '127.0.0.1' }, { backend });
  const { port } = await relay.start(); t.after(() => relay.close());
  for (let i = 0; i < 20; i++) {
    const socket = connect(port, '127.0.0.1');
    socket.on('error', () => {});
    await new Promise((res) => socket.once('connect', res));
    socket.write('GET /v1/ws HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nAuthorization: Bearer wrong\r\n\r\n');
    socket.resetAndDestroy();
  }
  await delay(200);
  const health = await fetch(`http://127.0.0.1:${port}/v1/health`);
  assert.equal(health.status, 200);
});

test('a request line the URL parser rejects answers 400 and the relay keeps serving', async (t) => {
  const { backend, directory } = await fixture(t);
  const relay = await createTmuxRelay({ state_directory: directory, notify_socket: join(directory, 'notify.sock'), lan: { pairing_code: 'pair-secret' }, port: 0, host: '127.0.0.1' }, { backend });
  const { port } = await relay.start(); t.after(() => relay.close());
  const raw = (text) => new Promise((res) => {
    const socket = connect(port, '127.0.0.1'); let answer = '';
    socket.on('data', (data) => { answer += data; }); socket.on('error', () => {}); socket.on('close', () => res(answer));
    socket.on('connect', () => socket.write(text)); setTimeout(() => socket.destroy(), 1000);
  });
  assert.match(await raw('GET //[ HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n'), /^HTTP\/1\.1 400/);
  assert.match(await raw('POST //[ HTTP/1.1\r\nHost: x\r\nConnection: close\r\nContent-Length: 2\r\n\r\n{}'), /^HTTP\/1\.1 400/);
  assert.match(await raw('GET //[ HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n'), /^HTTP\/1\.1 400/);
  assert.equal((await fetch(`http://127.0.0.1:${port}/v1/health`)).status, 200);
});

/** A broker stand-in that never answers pings, as one whose link died. */
async function silentBroker(t, options = {}) {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1', autoPong: false, ...options });
  await once(server, 'listening');
  t.after(async () => { for (const ws of server.clients) ws.terminate(); await new Promise((res) => server.close(res)); });
  const sockets = [];
  server.on('connection', (ws) => { sockets.push(ws); ws.closedAt = null; ws.on('close', () => { ws.closedAt = Date.now(); }); });
  return { server, sockets, url: `http://127.0.0.1:${server.address().port}` };
}
const brokerConfig = (directory, url) => ({ state_directory: directory, notify_socket: join(directory, 'notify.sock'), broker: { url, relay_id: 'relay-test', relay_token: 'relay-token-test' } });

test('the broker link is ended when its pings go unanswered, and kept while they are answered', async (t) => {
  const { backend, directory } = await fixture(t);
  const dead = await silentBroker(t);
  const relay = await createTmuxRelay(brokerConfig(join(directory, 'dead'), dead.url), { backend, brokerHeartbeatMs: 100 });
  await relay.start(); t.after(() => relay.close());
  for (let i = 0; i < 40 && !dead.sockets.length; i++) await delay(25);
  const opened = Date.now();
  for (let i = 0; i < 40 && dead.sockets[0].closedAt === null; i++) await delay(25);
  assert.ok(dead.sockets[0].closedAt !== null && dead.sockets[0].closedAt - opened < 600, 'a silent link ends after two missed heartbeats');
  const live = await silentBroker(t, { autoPong: true });
  const second = await createTmuxRelay(brokerConfig(join(directory, 'live'), live.url), { backend, brokerHeartbeatMs: 100 });
  await second.start(); t.after(() => second.close());
  for (let i = 0; i < 40 && !live.sockets.length; i++) await delay(25);
  await delay(600);
  assert.equal(live.sockets.length, 1); assert.equal(live.sockets[0].closedAt, null, 'an answering broker stays connected');
  // A broker busy sending (its pong queued behind) is not taken for dead.
  const busy = await silentBroker(t);
  const third = await createTmuxRelay(brokerConfig(join(directory, 'busy'), busy.url), { backend, brokerHeartbeatMs: 100 });
  await third.start(); t.after(() => third.close());
  for (let i = 0; i < 40 && !busy.sockets.length; i++) await delay(25);
  const stream = setInterval(() => busy.sockets[0].send(JSON.stringify({ type: 'session.close', session_id: 'none' })), 40);
  t.after(() => clearInterval(stream));
  await delay(600); clearInterval(stream);
  assert.equal(busy.sockets[0].closedAt, null, 'traffic from the broker counts as an answer');
  for (let i = 0; i < 40 && busy.sockets[0].closedAt === null; i++) await delay(25);
  assert.notEqual(busy.sockets[0].closedAt, null, 'and once it stops, the silent link ends');
});

test('a null envelope closes the broker link without ending the relay', async (t) => {
  const { backend, directory } = await fixture(t);
  const broker = await silentBroker(t, { autoPong: true });
  const relay = await createTmuxRelay({ ...brokerConfig(directory, broker.url), lan: { pairing_code: 'pair-secret' }, port: 0, host: '127.0.0.1' }, { backend });
  const { port } = await relay.start(); t.after(() => relay.close());
  for (let i = 0; i < 40 && !broker.sockets.length; i++) await delay(25);
  // `e.type` of null used to throw inside the socket listener and end the process.
  broker.sockets[0].send('null');
  for (let i = 0; i < 40 && broker.sockets[0].closedAt === null; i++) await delay(25);
  assert.notEqual(broker.sockets[0].closedAt, null);
  for (let i = 0; i < 80 && broker.sockets.length < 2; i++) await delay(25);
  assert.equal(broker.sockets.length, 2, 'the relay connects again');
  assert.equal((await fetch(`http://127.0.0.1:${port}/v1/health`)).status, 200);
});
