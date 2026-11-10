import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, writeFile, rm, symlink, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import { TmuxBackend, tmuxKey, project, projectPath, run } from '../src/tmux.mjs';
import { createTmuxRelay, RelaySession } from '../src/server.mjs';
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
