import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket, WebSocketServer } from 'ws';
import { TmuxBackend } from '../src/tmux.mjs';
import { createHub } from '../src/hub/server.mjs';
import { scoped } from '../src/hub/ids.mjs';
import { RpcPeer } from '../src/hub/rpc.mjs';
import { CodexSource } from '../src/hub/codex.mjs';
import { SourceRegistry } from '../src/hub/registry.mjs';

async function upstream(t, codex = false) {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(server, 'listening');
  t.after(async () => { for (const ws of server.clients) ws.terminate(); await new Promise((resolve) => server.close(resolve)); });
  const calls = [], responses = [], bindings = new Map();
  const limits = { max_message_bytes: 24 * 1024 * 1024, max_upload_bytes: 12 * 1024 * 1024 };
  server.on('connection', (ws) => ws.on('message', (raw) => {
    const m = JSON.parse(raw); if (!m.method) { if ('result' in m) responses.push(m); return; }
    calls.push(m);
    if (m.id == null) return;
    let result = {};
    if (m.method === 'relay.info') result = limits;
    if (m.method === 'window.list') result = { windows: [{ id: 'window', ref: 'window:1', key: true }] };
    if (m.method === 'workspace.list') result = { window_id: 'window', workspaces: [{ id: '$0', title: 'cmux workspace', selected: true }] };
    if (m.method === 'surface.list') result = { surfaces: [{ id: '%0', title: 'cmux shell', type: 'terminal' }] };
    if (m.method === 'surface.resume.get') result = { resume_binding: bindings.get(m.params.surface_id) ?? null };
    if (m.method === 'surface.subscribe') ws.send(JSON.stringify({ type: 'screen.full', surface_id: m.params.surface_id, rev: 1, rows: ['cmux output'], cols: 80, rowsCount: 1, cursor: { x: 0, y: 0 } }));
    if (m.method === 'thread/loaded/list') result = { data: ['thread-1'] };
    const thread = { id: 'thread-1', name: 'Desktop conversation', cwd: '/project', status: { type: 'idle' } };
    if (m.method === 'thread/list') result = { data: [thread], nextCursor: null };
    if (['thread/read', 'thread/resume', 'thread/start'].includes(m.method)) result = { thread };
    if (m.method === 'thread/turns/list') result = { data: [{ id: 'turn-1', status: 'completed', items: [{ id: 'item-1', type: 'agentMessage', text: 'hello' }] }], nextCursor: null };
    if (m.method === 'turn/start') result = { turn: { id: 'turn-2', status: 'inProgress', items: [] } };
    ws.send(JSON.stringify({ id: m.id, ...(codex ? {} : { ok: true }), result }));
  }));
  return { server, calls, responses, bindings, limits, url: `ws://127.0.0.1:${server.address().port}`, emit(message) { for (const ws of server.clients) ws.send(JSON.stringify(message)); } };
}

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'panecast-hub-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const tmux = new TmuxBackend({ socketName: `panecast-test-${randomUUID()}`, configFile: '/dev/null' });
  t.after(() => tmux.tmux(['kill-server']).catch(() => {}));
  const { workspace_id } = await tmux.dispatch('workspace.create', { title: 'hub-test' });
  const surface = (await tmux.surfaces(workspace_id))[0];
  const cmux = await upstream(t), codex = await upstream(t, true);
  const sources = [
    { id: 'tmux', type: 'tmux', name: 'tmux', tmux_socket: tmux.prefix[1] },
    { id: 'cmux', type: 'cmux', name: 'cmux', url: cmux.url, token: 'upstream-secret', device_id: 'hub' },
    { id: 'codex', type: 'codex', name: 'Codex', mode: 'attach', url: codex.url, cwd: directory },
  ];
  return { directory, tmux, workspace_id, surface, cmux, codex, sources };
}

async function connect(t, config) {
  const hub = await createHub(config);
  const address = await hub.start(); t.after(() => hub.close());
  const base = `http://127.0.0.1:${address.port}`;
  const response = await fetch(base + '/v1/devices/me/register', { method: 'POST', body: JSON.stringify({ pairing_code: 'pair-secret', client_id: 'phone', device_name: 'Phone' }) });
  const credentials = await response.json();
  const peer = new RpcPeer({ url: base.replace('http', 'ws') + '/v1/ws', token: credentials.token, protocols: ['cmuxremote.v1'], hello: { deviceId: credentials.device_id, protocolVersion: 1 } });
  const pushes = []; peer.onMessage((m) => pushes.push(m)); await peer.connect(); t.after(() => peer.close());
  return { hub, peer, pushes, base, credentials };
}

test('cmux application history forwards replay and scrolling with target checks', async (t) => {
  const fx = await fixture(t);
  const { peer } = await connect(t, { state_directory: join(fx.directory, 'scroll'), lan: { pairing_code: 'pair-secret' }, port: 0, sources: fx.sources });
  const target = { workspace_id: scoped('cmux', '$0'), surface_id: scoped('cmux', '%0') };
  await peer.call('terminal.replay', { ...target, anchor: 'screen', max_scrollback_rows: 0 });
  assert.deepEqual(fx.cmux.calls.at(-1).params, { workspace_id: '$0', surface_id: '%0', anchor: 'screen', max_scrollback_rows: 0 });
  await peer.call('terminal.scroll', { ...target, delta_lines: 10, col: 40, row: 10 });
  assert.deepEqual(fx.cmux.calls.at(-1).params, { workspace_id: '$0', surface_id: '%0', delta_lines: 10, col: 40, row: 10 });
  await assert.rejects(peer.call('terminal.scroll', { ...target, surface_id: scoped('tmux', fx.surface.id), delta_lines: 10 }), { code: 'invalid_target' });
  await assert.rejects(peer.call('terminal.replay', { workspace_id: scoped('tmux', fx.workspace_id), surface_id: scoped('tmux', fx.surface.id) }), { code: 'method_not_found' });
});

test('attachment limits come from the selected source and respect the hub transport', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'panecast-upload-info-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const cmux = await upstream(t);
  const source = { id: 'cmux', type: 'cmux', url: cmux.url, token: 'fixture-only', device_id: 'fixture' };
  const { peer, hub } = await connect(t, { state_directory: directory, port: 0, lan: { pairing_code: 'pair-secret' }, sources: [source] });
  const target = { workspace_id: scoped('cmux', '$0'), surface_id: scoped('cmux', '%0') };
  assert.equal((await peer.call('relay.info')).backend, 'hub');
  const info = await peer.call('relay.info', target);
  assert.equal(info.max_upload_bytes, 12 * 1024 * 1024); assert.equal(info.max_message_bytes, 24 * 1024 * 1024);
  cmux.limits.max_message_bytes = 64 * 1024 * 1024;
  assert.equal((await peer.call('relay.info', target)).max_message_bytes, 32 * 1024 * 1024);
  await assert.rejects(peer.call('relay.info', { ...target, surface_id: scoped('other', '%0') }), { code: 'invalid_target' });
  hub.reloadSources([]);
  await assert.rejects(peer.call('relay.info', target), { code: 'source_revoked' });
});

test('terminal chat reads only the selected binding and honors source scope and removal', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'panecast-bound-chat-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const cmux = await upstream(t), id = randomUUID(), other = randomUUID();
  const codexHome = join(directory, 'codex'); await mkdir(join(codexHome, 'sessions'), { recursive: true });
  for (const [sessionId, text] of [[id, 'selected answer'], [other, 'different terminal']]) await writeFile(join(codexHome, 'sessions', `${sessionId}.jsonl`), [
    { type: 'session_meta', payload: { id: sessionId } }, { type: 'event_msg', payload: { type: 'user_message', message: text } },
  ].map(value => JSON.stringify(value) + '\n').join(''));
  cmux.bindings.set('%0', { kind: 'codex', checkpoint_id: id, execution_location: 'local', cwd: directory });
  cmux.bindings.set('%1', { kind: 'codex', checkpoint_id: other, execution_location: 'local', cwd: directory });
  const sources = [{ id: 'cmux', type: 'cmux', url: cmux.url, token: 'fixture-only', device_id: 'fixture', codex_home: codexHome }];
  const { peer, hub } = await connect(t, { state_directory: join(directory, 'hub'), port: 0, lan: { pairing_code: 'pair-secret' }, sources });
  const target = { workspace_id: scoped('cmux', '$0'), surface_id: scoped('cmux', '%0') };
  const page = await peer.call('terminal.conversation', target);
  assert.equal(page.available, true); assert.equal(page.conversation_id, id); assert.equal(page.items[0].content[0].text, 'selected answer');
  assert.deepEqual(cmux.calls.at(-1).params, { workspace_id: '$0', surface_id: '%0' });
  const second = await peer.call('terminal.conversation', { ...target, surface_id: scoped('cmux', '%1') });
  assert.equal(second.conversation_id, other); assert.equal(second.items[0].content[0].text, 'different terminal');
  assert.equal((await peer.call('terminal.conversation', { ...target, surface_id: scoped('cmux', '%2') })).available, false);
  await assert.rejects(peer.call('terminal.conversation', { ...target, surface_id: scoped('different', '%0') }), { code: 'invalid_target' });
  assert.equal(cmux.calls.some(call => /send|resume$|turn\/start/.test(call.method)), false);
  hub.reloadSources([]);
  await assert.rejects(peer.call('terminal.conversation', target), { code: 'source_revoked' });
});

test('one pairing routes cmux, real tmux and Codex with full control and without mixing IDs', async (t) => {
  const fx = await fixture(t);
  // Use a second listener directory to exercise the complete authenticated phone protocol.
  const { hub, peer, pushes } = await connect(t, { state_directory: join(fx.directory, 'phone'), lan: { pairing_code: 'pair-secret' }, port: 0, sources: fx.sources });
  const info = await peer.call('source.list');
  assert.deepEqual(info.sources.map((s) => s.status), ['online', 'online', 'online']);
  assert.equal(JSON.stringify(info).includes('upstream-secret'), false);
  const { windows } = await peer.call('window.list'); assert.equal(windows.length, 2);
  const cmuxWindow = windows.find((w) => w.source_id === 'cmux');
  const listing = await peer.call('workspace.list', { window_id: cmuxWindow.id });
  assert.equal(listing.workspaces[0].id, scoped('cmux', '$0'));
  const tmuxTarget = { workspace_id: scoped('tmux', fx.workspace_id), surface_id: scoped('tmux', fx.surface.id) };
  await peer.call('surface.subscribe', tmuxTarget);
  await peer.call('surface.subscribe', { workspace_id: scoped('cmux', '$0'), surface_id: scoped('cmux', '%0') });
  assert.ok(pushes.some((f) => f.type === 'screen.full' && f.surface_id === tmuxTarget.surface_id));
  assert.ok(pushes.some((f) => f.type === 'screen.full' && f.surface_id === scoped('cmux', '%0')));
  const cmuxScreens = () => pushes.filter((f) => f.type === 'screen.full' && f.surface_id === scoped('cmux', '%0')).length;
  const beforeReconnect = cmuxScreens();
  for (const ws of fx.cmux.server.clients) ws.terminate();
  for (let attempt = 0; attempt < 30 && cmuxScreens() === beforeReconnect; attempt++) await delay(50);
  assert.ok(cmuxScreens() > beforeReconnect, 'an upstream reconnect restores existing terminal subscriptions');
  await peer.call('surface.send_text', { workspace_id: scoped('cmux', '$0'), surface_id: scoped('cmux', '%0'), text: 'to cmux' });
  assert.deepEqual(fx.cmux.calls.at(-1).params, { workspace_id: '$0', surface_id: '%0', text: 'to cmux' });
  await assert.rejects(peer.call('surface.send_text', { ...tmuxTarget, surface_id: scoped('cmux', '%0'), text: 'no' }), { code: 'invalid_target' });
  await assert.rejects(peer.call('command/exec', { command: 'bad' }), { code: 'method_not_found' });
  await peer.call('surface.send_text', { ...tmuxTarget, text: 'echo hub中文' });
  await peer.call('surface.send_key', { ...tmuxTarget, key: 'enter' });
  await delay(100); assert.match((await fx.tmux.capture({ workspace_id: fx.workspace_id, surface_id: fx.surface.id })).rows.join('\n'), /hub中文/);
  const threads = await peer.call('agent.threads', { source_id: 'codex' }); assert.equal(threads.threads[0].name, 'Desktop conversation');
  const page = await peer.call('agent.read', { source_id: 'codex', thread_id: 'thread-1' }); assert.equal(page.turns[0].items[0].text, 'hello');
  await peer.call('agent.send', { source_id: 'codex', thread_id: 'thread-1', text: 'hello', approvalPolicy: 'never' });
  const sent = fx.codex.calls.find((c) => c.method === 'turn/start').params;
  assert.deepEqual(sent, { threadId: 'thread-1', input: [{ type: 'text', text: 'hello' }], clientUserMessageId: sent.clientUserMessageId });
  assert.equal(typeof sent.clientUserMessageId, 'string');
  hub.reloadSources(fx.sources.filter((s) => s.id !== 'tmux'));
  await assert.rejects(peer.call('surface.send_key', { ...tmuxTarget, key: 'enter' }), { code: 'source_revoked' });
  assert.equal((await peer.call('agent.threads', { source_id: 'codex' })).threads.length, 1);
});

test('Codex approvals require explicit valid decisions and a removed source stops working', async (t) => {
  const upstreamCodex = await upstream(t, true);
  const directory = await mkdtemp(join(tmpdir(), 'panecast-approval-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const source = { id: 'codex', type: 'codex', mode: 'attach', url: upstreamCodex.url };
  const { peer, hub } = await connect(t, { state_directory: directory, lan: { pairing_code: 'pair-secret' }, port: 0, sources: [source] });
  await peer.call('agent.subscribe', { source_id: 'codex', thread_id: 'thread-1' });
  upstreamCodex.emit({ id: 99, method: 'item/commandExecution/requestApproval', params: { threadId: 'thread-1', turnId: 'turn-2', command: 'npm test' } });
  await delay(20);
  assert.equal(upstreamCodex.responses.length, 0);
  assert.equal((await peer.call('agent.pending', { source_id: 'codex', thread_id: 'thread-1' })).requests.length, 1);
  await assert.rejects(peer.call('agent.respond', { source_id: 'codex', thread_id: 'other', request_id: '99', decision: 'accept' }), { code: 'invalid_target' });
  await peer.call('agent.respond', { source_id: 'codex', thread_id: 'thread-1', request_id: '99', decision: 'decline' });
  await delay(20); assert.deepEqual(upstreamCodex.responses[0], { id: 99, result: { decision: 'decline' } });
  await assert.rejects(peer.call('agent.respond', { source_id: 'codex', thread_id: 'thread-1', request_id: '99', decision: 'accept' }), { code: 'request_resolved' });
  hub.reloadSources([]);
  await assert.rejects(peer.call('agent.send', { source_id: 'codex', thread_id: 'thread-1', text: 'bad' }), { code: 'source_revoked' });
});

test('revoking a paired LAN device disconnects its existing socket', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'panecast-revoke-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const { peer, base, credentials } = await connect(t, { state_directory: directory, lan: { pairing_code: 'pair-secret' }, port: 0, sources: [] });
  const response = await fetch(base + '/v1/devices/me', { method: 'DELETE', headers: { Authorization: `Bearer ${credentials.token}` } });
  assert.equal(response.status, 200); await delay(20); assert.equal(peer.closed, true);
});

test('every configured source has full control regardless of legacy grant fields', () => {
  const registry = new SourceRegistry([
    { id: 'tmux', type: 'tmux', enabled: false, access: 'read' },
    { id: 'codex', type: 'codex', mode: 'history', enabled: true, access: 'read' },
    { id: 'cmux', type: 'cmux', enabled: false, url: 'ws://127.0.0.1:4399/v1/ws', device_id: 'REPLACE_WITH_REGISTERED_DEVICE_ID', token: 'REPLACE_WITH_REGISTERED_DEVICE_TOKEN' },
  ]);
  assert.deepEqual([...registry.sources.keys()], ['tmux', 'codex'], 'an unfilled cmux placeholder is skipped');
  for (const source of registry.sources.values()) {
    const info = registry.info(source);
    assert.equal(info.access, 'control'); assert.equal(info.enabled, true);
    assert.deepEqual(info.capabilities, { ...info.capabilities, read: true, control: true, create: true, resume: true, realtime: true });
  }
  assert.equal(registry.info(registry.get('codex')).mode, 'managed');
  assert.equal(new CodexSource({ id: 'codex', mode: 'history' }, () => {}).mode, 'managed');
  registry.close();
});

test('opening persisted history never starts another copy of a desktop task', async () => {
  const calls = [];
  const peer = { closed: false, connect: async () => {}, onMessage: () => {}, close() {},
    async call(method) { calls.push(method); if (method === 'thread/loaded/list') return { data: [] }; if (method === 'thread/read') return { thread: { id: 'other-process', name: 'Stored task', status: { type: 'notLoaded' } } }; throw new Error('unexpected write'); } };
  const source = new CodexSource({ id: 'codex', mode: 'attach', access: 'control' }, () => {}, () => peer);
  const result = await source.dispatch('agent.subscribe', { thread_id: 'other-process' });
  assert.equal(result.thread.live, false);
  await assert.rejects(source.dispatch('agent.send', { thread_id: 'other-process', text: 'change this' }), { code: 'thread_not_attached' });
  assert.equal(calls.includes('thread/resume'), false);
  assert.equal(calls.includes('turn/start'), false);
});
