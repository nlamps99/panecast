import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, symlink, realpath, readFile, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocketServer } from 'ws';
import { createHub } from '../src/hub/server.mjs';
import { createTmuxRelay } from '../src/server.mjs';
import { scoped } from '../src/hub/ids.mjs';
import * as relayServer from '../src/server.mjs';
import { HubSession } from '../src/hub/session.mjs';

// The same tests run on gateways with and without batched input and transcripts.
const batchedInput = typeof relayServer.inputItems === 'function';
const conversationBatch = typeof HubSession.prototype.conversationBatch === 'function';
import { guestText, guestKey, guestPaste } from '../src/hub/guest-session.mjs';
import { shareConversationBinding } from '../src/hub/share-binding.mjs';
import { decodeShareKey, encodeShareKey, PROMPT_HOOK, shareCommand, shareDirectory, shareSettings, ShareStore, BrokerGuests, validName, withPromptHook } from '../src/hub/share.mjs';
import { spawn } from 'node:child_process';

/** A cmux relay with two workspaces of two terminals each. */
async function cmux(t) {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(server, 'listening');
  t.after(async () => { for (const ws of server.clients) ws.terminate(); await new Promise((resolve) => server.close(resolve)); });
  const calls = [];
  // Terminals made with surface.create, and terminals closed, per workspace.
  const fx = { calls, methods: [], added: { $0: [], $1: [] }, closed: new Set(), created: 0 };
  server.on('connection', (ws) => ws.on('message', (raw) => {
    const m = JSON.parse(raw); if (!m.method) return;
    calls.push(m);
    let result = {};
    if (m.method === 'system.capabilities') result = { methods: fx.methods };
    if (m.method === 'relay.info') result = { max_message_bytes: 1024, max_upload_bytes: 1024 };
    if (m.method === 'window.list') result = { windows: [{ id: 'w1' }, { id: 'w2' }] };
    if (m.method === 'workspace.list') result = m.params.window_id === 'w2'
      ? { workspaces: [{ id: '$1', title: 'shared paper' }] } : { workspaces: [{ id: '$0', title: 'private work' }] };
    if (m.method === 'surface.list') {
      const ids = [m.params.workspace_id === '$1' ? '%1' : '%0', '%9', ...(fx.added[m.params.workspace_id] ?? [])].filter((id) => !fx.closed.has(id));
      result = { surfaces: ids.map((id) => ({ id, type: 'terminal', title: id === '%9' ? 'b' : 'a' })) };
    }
    if (m.method === 'surface.create') { const id = `%${100 + fx.created++}`; fx.added[m.params.workspace_id]?.push(id); result = { surface_id: id, workspace_id: m.params.workspace_id, type: 'terminal' }; }
    if (m.method === 'surface.close') fx.closed.add(m.params.surface_id);
    if (m.method === 'surface.subscribe') ws.send(JSON.stringify({ type: 'screen.full', surface_id: m.params.surface_id, rev: 1, rows: ['claude'], cols: 80, rowsCount: 1, cursor: { x: 0, y: 0 } }));
    ws.send(JSON.stringify({ id: m.id, ok: true, result }));
  }));
  return Object.assign(fx, { url: `ws://127.0.0.1:${server.address().port}`, sent: () => calls.filter((c) => /send_(text|key)/.test(c.method)) });
}

/** Stands in for the broker: opens sessions on the hub's tunnel and collects replies. */
async function broker(t) {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(server, 'listening');
  t.after(async () => { for (const ws of server.clients) ws.terminate(); await new Promise((resolve) => server.close(resolve)); });
  const frames = [];
  let tunnel, request;
  server.on('connection', (ws, req) => { tunnel = ws; request = req; ws.on('message', (raw) => frames.push(JSON.parse(raw))); });
  let next = 0;
  const fx = {
    frames,
    url: `http://127.0.0.1:${server.address().port}`,
    get request() { return request; },
    async ready() { for (let i = 0; i < 200 && !tunnel; i++) await delay(10); assert.ok(tunnel, 'hub connected to the broker'); },
    open(session, deviceId, guest) {
      tunnel.send(JSON.stringify({ type: 'session.open', session_id: session, device_id: deviceId, ...(guest ? { guest } : {}) }));
      tunnel.send(JSON.stringify({ type: 'session.text', session_id: session, text: JSON.stringify({ deviceId, protocolVersion: 1, appVersion: 'test' }) }));
    },
    async call(session, method, params = {}) {
      const id = `r${++next}`;
      tunnel.send(JSON.stringify({ type: 'session.text', session_id: session, text: JSON.stringify({ id, method, params }) }));
      for (let i = 0; i < 300; i++) {
        for (const frame of frames) {
          if (frame.session_id !== session) continue;
          if (frame.type === 'session.close') throw Object.assign(new Error('session closed'), { code: 'closed' });
          const message = JSON.parse(frame.text);
          if (message.id === id) { if (!message.ok) throw Object.assign(new Error(message.error.message), { code: message.error.code }); return message.result; }
        }
        await delay(10);
      }
      throw new Error(`no reply to ${method}`);
    },
    texts(session) { return frames.filter((f) => f.session_id === session && f.type === 'session.text').map((f) => JSON.parse(f.text)); },
    closed(session) { return frames.some((f) => f.session_id === session && f.type === 'session.close'); },
  };
  return fx;
}

const SHARE = { id: 's1', name: '论文', directory: '/tmp/paper', source_id: 'cmux', workspace_id: '$1', surface_id: '%1', created_at: '', revoked_at: null, prompt_hook: true,
  guests: [{ device_id: 'guest-a', label: '同学', created_at: '', revoked_at: null }] };

async function setup(t, shares = [SHARE], options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'panecast-share-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const upstream = await cmux(t), relay = await broker(t);
  const store = new ShareStore(join(directory, 'state', 'shares', 'shares.json'));
  if (shares) await store.write(structuredClone(shares));
  const hub = await createHub({ state_directory: join(directory, 'state'), port: 0, broker: { url: relay.url, relay_id: 'home', relay_token: 'relay-secret' },
    sources: [{ id: 'cmux', type: 'cmux', name: 'cmux', enabled: true, access: 'control', url: upstream.url, token: 'upstream-secret', device_id: 'hub' }] }, options);
  await hub.start(); t.after(() => hub.close());
  await relay.ready();
  return { directory, upstream, relay, store, hub };
}

const own = { workspace_id: scoped('cmux', '$1'), surface_id: scoped('cmux', '%1') };

test('the hub asks the broker for guests only because it confines them', async (t) => {
  const { relay } = await setup(t);
  assert.equal(new URL(relay.request.url, 'http://x').searchParams.get('features'), 'guest-sessions');
});

test('a guest sees one source, one workspace and one terminal', async (t) => {
  const { relay } = await setup(t);
  relay.open('g', 'guest-a', { share_id: 's1' });
  const sources = await relay.call('g', 'source.list');
  assert.deepEqual(sources.sources.map((s) => [s.id, s.name, s.status, s.capabilities.create]), [['cmux', '论文', 'online', false]]);
  assert.equal(JSON.stringify(sources).includes('upstream-secret'), false);
  const info = await relay.call('g', 'relay.info');
  assert.deepEqual(info.share, { id: 's1', name: '论文', ...own, max_terminals: 5, files: { list: true, links: true, upload: true } });
  const { windows } = await relay.call('g', 'window.list');
  assert.equal(windows.length, 1);
  const listing = await relay.call('g', 'workspace.list', { window_id: windows[0].id });
  assert.deepEqual(listing.workspaces.map((w) => [w.id, w.title]), [[own.workspace_id, 'shared paper']]);
  const { surfaces } = await relay.call('g', 'surface.list', { workspace_id: own.workspace_id });
  assert.deepEqual(surfaces.map((s) => s.id), [own.surface_id]);
  assert.deepEqual((await relay.call('g', 'relay.snippets')).snippets, []);
  const requests = [own, { workspace_id: scoped('cmux', '$0'), surface_id: scoped('cmux', '%0') }];
  if (conversationBatch) {
    const batch = await relay.call('g', 'terminal.conversation.batch', { requests });
    assert.deepEqual(batch.results.map((r) => r.ok ? 'ok' : r.error.code), ['ok', 'forbidden']);
  } else await assert.rejects(relay.call('g', 'terminal.conversation.batch', { requests }), { code: 'method_not_found' });
  await relay.call('g', 'surface.subscribe', own);
  assert.ok(relay.texts('g').some((m) => m.type === 'screen.full' && m.surface_id === own.surface_id));
});

test('a guest cannot reach any other terminal or management call', async (t) => {
  const { relay, upstream } = await setup(t);
  relay.open('g', 'guest-a', { share_id: 's1' });
  const other = { workspace_id: scoped('cmux', '$0'), surface_id: scoped('cmux', '%0') };
  // %9 is a terminal the owner opened in the shared workspace.
  const owners = { ...own, surface_id: scoped('cmux', '%9') };
  for (const [method, params] of [
    ['surface.subscribe', other], ['surface.subscribe', owners], ['surface.history', other],
    ['surface.send_text', { ...other, text: 'hi' }], ['surface.list', { workspace_id: other.workspace_id }], ['terminal.conversation', other],
    ['workspace.create', { source_id: 'cmux', title: 'x' }], ['workspace.close', { workspace_id: own.workspace_id }], ['surface.close', owners], ['surface.close', other],
    ['surface.create', { workspace_id: other.workspace_id }], ['surface.create', { workspace_id: own.workspace_id, type: 'browser', url: 'https://example.com' }],
    ['surface.create', { workspace_id: own.workspace_id, pane_id: scoped('cmux', '%0') }], ['workspace.rename', { workspace_id: own.workspace_id, title: 'x' }],
    ['file.upload', { ...other, data_base64: 'aGk=' }], ['notification.create', own], ['project.read', { ...own, path: 'a.txt' }], ['project.list', own], ['agent.threads', { source_id: 'cmux' }],
    ['workspace.list', { source_id: 'other' }], ['surface.subscribe', { ...own, pane_id: scoped('cmux', '%0') }],
  ]) await assert.rejects(relay.call('g', method, params), { code: 'forbidden' }, method);
  assert.equal(upstream.calls.some((c) => c.params?.surface_id === '%0' || c.params?.surface_id === '%9' || /create|close|rename/.test(c.method)), false);
});

test('a guest types and edits freely, with ! kept out of shell mode', async (t) => {
  const { relay, upstream } = await setup(t);
  relay.open('g', 'guest-a', { share_id: 's1' });
  for (const text of ['把第三章改得简洁一些，引用 src/paper.tex', '谢谢!', '/add-dir /Users', '第一行\n第二行\t缩进']) await relay.call('g', 'surface.send_text', { ...own, text });
  const keys = ['enter', 'ctrl-c', 'backspace', 'delete', 'tab', 'shift-tab', 'home', 'end', 'ctrl-u', 'ctrl-w', 'ctrl-d', 'ctrl-s', 'alt-b', 'alt-backspace', 'alt-p', 'f5', 'ctrl-shift-_'];
  for (const key of keys) await relay.call('g', 'surface.send_key', { ...own, key });
  // Escapes could spell any key or end a paste; these keys reach past the window.
  for (const text of ['\u001b[201~', 'a\u001b[103;5u', 'tab\u0008', 'bell\u0007', '']) {
    await assert.rejects(relay.call('g', 'surface.send_text', { ...own, text }), (error) => /guest_|invalid_params/.test(error.code), JSON.stringify(text));
  }
  for (const key of ['ctrl-g', 'ctrl-shift-g', 'ctrl-v', 'ctrl-alt-v', 'ctrl-z', 'ctrl-r', 'ctrl-y', 'alt-y', 'cmd-v', 'cmd-w', 'meta-q', '!', 'shift-1', 'alt-!', 'ctrl-\u0007']) {
    await assert.rejects(relay.call('g', 'surface.send_key', { ...own, key }), { code: 'guest_key' }, key);
  }
  if (batchedInput) {
    await relay.call('g', 'surface.input', { ...own, items: [{ text: '再改一下结论' }, { key: 'enter' }] });
    // Without terminal.paste a typed line gets ！; keys and edits go through.
    await relay.call('g', 'surface.input', { ...own, items: [{ text: 'if (!done) 继续' }, { key: 'enter' }] });
    await relay.call('g', 'surface.input', { ...own, items: [{ text: 'ab' }, { key: 'backspace' }, { key: 'tab' }] });
    for (const items of [[{ text: 'ok' }, { key: 'ctrl-g' }], [{ text: 'x\u001b' }]]) {
      await assert.rejects(relay.call('g', 'surface.input', { ...own, items }), (error) => /guest_/.test(error.code), JSON.stringify(items));
    }
  } else await assert.rejects(relay.call('g', 'surface.input', { ...own, items: [{ text: 'hi' }] }), { code: 'method_not_found' });
  await assert.rejects(relay.call('g', 'surface.input', { workspace_id: scoped('cmux', '$0'), surface_id: scoped('cmux', '%0'), items: [{ text: 'hi' }] }), { code: 'forbidden' });
  await assert.rejects(relay.call('g', 'terminal.paste', { ...own, text: 'a\u001b[201~', submit_key: 'return' }), { code: 'guest_input' });
  await assert.rejects(relay.call('g', 'terminal.paste', { ...own, text: 'ok', submit_key: 'tab' }), { code: 'invalid_params' });
  assert.deepEqual(upstream.sent().map((c) => c.params.text ?? c.params.key), [
    '把第三章改得简洁一些，引用 src/paper.tex', '谢谢！', '/add-dir /Users', '第一行\n第二行\t缩进', ...keys,
    ...(batchedInput ? ['再改一下结论', 'enter', 'if (！done) 继续', 'enter', 'ab', 'backspace', 'tab'] : []),
  ]);
  assert.ok(upstream.sent().every((c) => c.params.workspace_id === '$1' && c.params.surface_id === '%1'));
});

test('a window opened before the prompt hook keeps the keys that cannot delete', async (t) => {
  const { relay, upstream } = await setup(t, [{ ...SHARE, prompt_hook: undefined }]);
  relay.open('g', 'guest-a', { share_id: 's1' });
  const keys = ['enter', 'escape', 'up', 'tab', 'shift-tab', 'home', 'end', 'ctrl-c', 'ctrl-a', 'ctrl-e', 'ctrl-s', 'f1'];
  for (const key of keys) await relay.call('g', 'surface.send_key', { ...own, key });
  for (const key of ['backspace', 'delete', 'ctrl-u', 'ctrl-w', 'ctrl-k', 'ctrl-d', 'ctrl-h', 'ctrl-_', 'alt-backspace', 'alt-d', 'ctrl-y', 'ctrl-g']) {
    await assert.rejects(relay.call('g', 'surface.send_key', { ...own, key }), { code: 'guest_key' }, key);
  }
  await relay.call('g', 'surface.send_text', { ...own, text: '/plan 写大纲!' });
  assert.deepEqual(upstream.sent().map((c) => c.params.text ?? c.params.key), [...keys, '/plan 写大纲！']);
});

test('a full-access guest types anything into the one shared terminal and nowhere else', async (t) => {
  const { relay, upstream } = await setup(t, [{ ...SHARE, full: true, prompt_hook: false }]);
  relay.open('g', 'guest-a', { share_id: 's1' });
  assert.equal((await relay.call('g', 'relay.info')).share.full, true);
  for (const text of ['!ls ~/.ssh', 'a\u001b[201~']) await relay.call('g', 'surface.send_text', { ...own, text });
  for (const key of ['ctrl-g', 'ctrl-v', 'ctrl-r', 'ctrl-y', 'backspace', '!']) await relay.call('g', 'surface.send_key', { ...own, key });
  if (batchedInput) await relay.call('g', 'surface.input', { ...own, items: [{ text: '!pwd' }, { key: 'enter' }] });
  assert.deepEqual(upstream.sent().map((c) => c.params.text ?? c.params.key), ['!ls ~/.ssh', 'a\u001b[201~', 'ctrl-g', 'ctrl-v', 'ctrl-r', 'ctrl-y', 'backspace', '!',
    ...(batchedInput ? ['!pwd', 'enter'] : [])]);
  // Still one terminal: no other surface and no management calls.
  await assert.rejects(relay.call('g', 'surface.send_text', { workspace_id: scoped('cmux', '$0'), surface_id: scoped('cmux', '%0'), text: 'hi' }), { code: 'forbidden' });
  await assert.rejects(relay.call('g', 'workspace.create', {}), { code: 'forbidden' });
  assert.ok(upstream.sent().every((c) => c.params.workspace_id === '$1' && c.params.surface_id === '%1'));
});

test('a guest line with ! goes as one paste where the terminal takes pastes', { skip: !batchedInput }, async (t) => {
  const { relay, upstream } = await setup(t);
  upstream.methods = ['terminal.paste'];
  relay.open('g', 'guest-a', { share_id: 's1' });
  await relay.call('g', 'surface.input', { ...own, items: [{ text: 'if (!done) 继续' }, { key: 'enter' }] });
  await relay.call('g', 'surface.input', { ...own, items: [{ text: '  !rm -rf ~' }, { key: 'enter' }] });
  await relay.call('g', 'terminal.paste', { ...own, text: '!ls\n第二段 a != b', submit_key: 'return' });
  await relay.call('g', 'surface.input', { ...own, items: [{ text: '没有感叹号' }, { key: 'enter' }] });
  // A paste that starts with ! would start shell mode: only that one changes.
  assert.deepEqual(upstream.calls.filter((c) => c.method === 'terminal.paste').map((c) => [c.params.surface_id, c.params.text, c.params.submit_key]),
    [['%1', 'if (!done) 继续', 'return'], ['%1', '  ！rm -rf ~', 'return'], ['%1', '！ls\n第二段 a != b', 'return']]);
  assert.deepEqual(upstream.sent().map((c) => c.params.text ?? c.params.key), ['没有感叹号', 'enter']);
});

test('a guest gets no notifications while the owner does', async (t) => {
  const { relay, hub } = await setup(t);
  relay.open('g', 'guest-a', { share_id: 's1' });
  relay.open('o', 'owner-phone');
  await relay.call('g', 'source.list'); await relay.call('o', 'source.list');
  await hub.notify({ title: '私人终端完成', body: 'secret', status: 'completed', workspace_id: scoped('cmux', '$0'), surface_id: scoped('cmux', '%0'), source_id: 'cmux' });
  await delay(50);
  assert.ok(relay.texts('o').some((m) => m.type === 'event' && m.payload?.title === '私人终端完成'));
  assert.equal(relay.texts('g').some((m) => m.type === 'event'), false);
  const page = await relay.call('g', 'inbox.sync', {});
  assert.deepEqual(page.events, []);
  const owner = await relay.call('o', 'inbox.sync', {});
  assert.ok(owner.events.some((e) => e.payload?.title === '私人终端完成'));
  assert.equal((await relay.call('o', 'workspace.list', {})).workspaces.length >= 1, true, 'an owner session keeps full access');
});

test('unknown, revoked or unreadable shares refuse the guest', async (t) => {
  const { relay, store, directory } = await setup(t);
  relay.open('x', 'guest-a', { share_id: 'missing' });
  for (let i = 0; i < 100 && !relay.closed('x'); i++) await delay(10);
  assert.ok(relay.closed('x'), 'a guest of an unknown share is closed');
  relay.open('y', 'someone-else', { share_id: 's1' });
  for (let i = 0; i < 100 && !relay.closed('y'); i++) await delay(10);
  assert.ok(relay.closed('y'), 'a device that holds no key for the share is closed');

  relay.open('g', 'guest-a', { share_id: 's1' });
  await relay.call('g', 'source.list');
  await store.write([{ ...SHARE, guests: [{ ...SHARE.guests[0], revoked_at: new Date().toISOString() }] }]);
  await delay(2100);
  await assert.rejects(relay.call('g', 'source.list'), (error) => ['share_revoked', 'closed'].includes(error.code));
  assert.ok(relay.closed('g'));

  await writeFile(join(directory, 'state', 'shares', 'shares.json'), '{broken');
  relay.open('z', 'guest-a', { share_id: 's1' });
  for (let i = 0; i < 300 && !relay.closed('z'); i++) await delay(10);
  assert.ok(relay.closed('z'), 'an unreadable share file refuses guests');
});

test('a relay that does not know shared windows refuses guests', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'panecast-share-plain-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const relay = await broker(t);
  const plain = await createTmuxRelay({ state_directory: directory, broker: { url: relay.url, relay_id: 'home', relay_token: 'relay-secret' } });
  await plain.start(); t.after(() => plain.close());
  await relay.ready();
  assert.equal(new URL(relay.request.url, 'http://x').searchParams.get('features'), null);
  relay.open('g', 'guest-a', { share_id: 's1' });
  for (let i = 0; i < 100 && !relay.closed('g'); i++) await delay(10);
  assert.ok(relay.closed('g'));
});

test('share keys round-trip and reject anything else', () => {
  const key = encodeShareKey({ serverUrl: 'https://broker.example/cmux', relayId: 'mac', deviceId: 'd', token: 't'.repeat(43), name: '论文' });
  assert.match(key, /^pcs1\.[\w-]+$/);
  assert.deepEqual(decodeShareKey(`  ${key}\n`), { serverUrl: 'https://broker.example/cmux', relayId: 'mac', deviceId: 'd', token: 't'.repeat(43), name: '论文' });
  for (const value of ['', 'cmux://pair?x', 'pcs1.', 'pcs1.@@', `pcs1.${Buffer.from('{"v":2}').toString('base64url')}`]) assert.equal(decodeShareKey(value), null);
});

test('the shared Claude is confined by its launch flags and settings', () => {
  const command = shareCommand("/opt/claude's/bin/claude", '/state/s1/claude-settings.json');
  for (const flag of ['--restricted', '--disable-slash-commands', '--strict-mcp-config', '--permission-mode acceptEdits']) assert.ok(command.includes(flag), flag);
  assert.ok(command.startsWith('exec '), 'no shell is left behind when Claude exits');
  assert.ok(command.includes(`'/opt/claude'\\''s/bin/claude'`));
  const settings = shareSettings('/Users/me/Panecast-Shares/论文', { allowDomains: ['pypi.org'] });
  assert.equal(settings.sandbox.enabled, true); assert.equal(settings.sandbox.allowUnsandboxedCommands, false); assert.equal(settings.sandbox.failIfUnavailable, true);
  assert.deepEqual(settings.sandbox.filesystem, { denyRead: ['~/'], allowRead: ['/Users/me/Panecast-Shares/论文'] });
  assert.deepEqual(settings.sandbox.network, { strictAllowlist: true, allowedDomains: ['pypi.org'] });
  assert.equal(settings.promptSuggestionEnabled, false);
  assert.equal(settings.permissions.disableBypassPermissionsMode, 'disable');
});

test('a full-access share runs the owner\'s Claude without sandbox, restrictions or prompts', async (t) => {
  const command = shareCommand('/opt/homebrew/bin/claude', '/state/s1/claude-settings.json', { full: true });
  assert.equal(command, "exec /usr/bin/env -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT '/opt/homebrew/bin/claude' --dangerously-skip-permissions");
  const home = await realpath(await mkdtemp(join(tmpdir(), 'panecast-home-full-'))); t.after(() => rm(home, { recursive: true, force: true }));
  assert.equal(await shareDirectory(home, 'x', home, { full: true }), home);
});

test('an open-network share keeps the file sandbox and only widens the network', () => {
  const settings = shareSettings('/Users/me/Panecast-Shares/x', { allowDomains: ['example.org'], openNetwork: true });
  assert.deepEqual(settings.sandbox.filesystem, { denyRead: ['~/'], allowRead: ['/Users/me/Panecast-Shares/x'] });
  assert.equal(settings.sandbox.enabled, true); assert.equal(settings.sandbox.allowUnsandboxedCommands, false);
  assert.equal(settings.sandbox.network.strictAllowlist, false);
  assert.ok(settings.sandbox.network.allowedDomains.includes('pypi.org') && settings.sandbox.network.allowedDomains.includes('example.org'));
  assert.equal(settings.sandbox.network.allowedDomains.includes('*'), false);
  assert.deepEqual(settings.sandbox.network.deniedDomains, ['localhost', '127.0.0.1', '[::1]', '0.0.0.0']);
  assert.ok(settings.hooks.UserPromptSubmit, 'the ! hook stays');
  const command = shareCommand('/bin/claude', '/s.json', { web: true });
  for (const flag of ['--restricted', '--disable-slash-commands', '--strict-mcp-config', '--allowedTools=Bash,WebFetch']) assert.ok(command.includes(flag), flag);
  assert.ok(command.includes(",WebFetch'"));
  assert.ok(!shareCommand('/bin/claude', '/s.json').includes('WebFetch'));
});

test('the prompt hook refuses exactly the prompts that start with !', async () => {
  const settings = shareSettings('/tmp/x');
  const [{ hooks: [hook] }] = settings.hooks.UserPromptSubmit;
  assert.equal(hook.command, PROMPT_HOOK);
  const run = (prompt) => new Promise((resolve) => {
    const child = spawn('/bin/sh', ['-c', PROMPT_HOOK], { stdio: ['pipe', 'ignore', 'pipe'] });
    let error = ''; child.stderr.on('data', (chunk) => { error += chunk; });
    child.on('close', (code) => resolve({ code, error }));
    child.stdin.end(JSON.stringify({ session_id: 'x', transcript_path: '/tmp/a"prompt":"!.jsonl', hook_event_name: 'UserPromptSubmit', prompt }));
  });
  for (const prompt of ['!ls', '!']) assert.equal((await run(prompt)).code, 2, prompt);
  assert.match((await run('!ls')).error, /全角/);
  for (const prompt of ['hi !', ' !ls', '！ls', 'x "prompt":"!y', '']) assert.equal((await run(prompt)).code, 0, prompt);
  // Reopening an older window adds the hook and keeps its own choices.
  const older = { sandbox: { network: { allowedDomains: ['pypi.org'] } }, hooks: { Stop: [] } };
  assert.deepEqual(withPromptHook(older), { ...older, hooks: { Stop: [], UserPromptSubmit: settings.hooks.UserPromptSubmit } });
});

test('a share directory never exposes the home folder or credentials', async (t) => {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'panecast-home-'))); t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(join(home, '.ssh'));
  assert.equal(await shareDirectory(undefined, '论文', home), join(home, 'Panecast-Shares', '论文'));
  await assert.rejects(shareDirectory(home, 'x', home), /主目录/);
  await assert.rejects(shareDirectory(join(home, '..'), 'x', home), /主目录/);
  await assert.rejects(shareDirectory(join(home, '.ssh', 'keys'), 'x', home), /凭据/);
  await symlink(join(home, '.ssh'), join(home, 'innocent'));
  await assert.rejects(shareDirectory(join(home, 'innocent'), 'x', home), /凭据/);
  for (const name of ['', '.hidden', 'a/b', 'x'.repeat(61)]) assert.throws(() => validName(name));
});

test('a key issued right after a lookup is found without waiting for the cache', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'panecast-store-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const writer = new ShareStore(join(directory, 'shares.json')), reader = new ShareStore(join(directory, 'shares.json'));
  await writer.write([structuredClone(SHARE)]);
  assert.ok(await reader.guestShare('s1', 'guest-a'));
  const shares = await writer.read(); shares[0].guests.push({ device_id: 'guest-b', label: '', created_at: '', revoked_at: null }); await writer.write(shares);
  assert.ok(await reader.guestShare('s1', 'guest-b'));
  // A revoke still takes effect within the cache's two seconds at most.
  assert.equal(await reader.guestShare('s1', 'nobody'), null);
});

test('guest credentials need an HTTPS broker', () => {
  assert.throws(() => new BrokerGuests({ url: 'http://broker.example', relay_id: 'a', relay_token: 'b' }), /HTTPS/);
  assert.throws(() => new BrokerGuests(undefined), /broker/);
  new BrokerGuests({ url: 'http://127.0.0.1:1', relay_id: 'a', relay_token: 'b' });
});

test('a pasted message keeps everything but a leading ! and control characters', () => {
  assert.equal(guestPaste('第一段\n\n第二段\t缩进 a != b /login'), '第一段\n\n第二段\t缩进 a != b /login');
  assert.equal(guestPaste('!ls'), '！ls');
  assert.equal(guestPaste(' \n !ls'), ' \n ！ls');
  assert.equal(guestPaste('a\rb'), 'a\rb');
  for (const text of [' \n', 'a\u001b[201~b', '']) assert.throws(() => guestPaste(text), /./, JSON.stringify(text));
});

test('input checks stand alone', () => {
  assert.equal(guestText('你好'), '你好');
  assert.equal(guestText('hi! /login'), 'hi！ /login');
  for (const key of ['up', 'backspace', 'tab', 'shift-tab', 'ctrl-a', 'alt-left', 'f12', '-', 'ctrl--']) assert.equal(guestKey(key), key);
  for (const key of ['ctrl-g', 'CTRL-V', 'control-z', 'ctrl-r', 'ctrl-y', 'alt-y', 'cmd-c', 'command-v', 'super-w', '!', 'shift-1', '']) assert.throws(() => guestKey(key), { code: 'guest_key' }, key);
  assert.equal(guestKey('up', { editing: false }), 'up');
  assert.throws(() => guestKey('backspace', { editing: false }), { code: 'guest_key' });
});

test('a guest lists, links and uploads files of the shared directory only', async (t) => {
  const outside = await mkdtemp(join(tmpdir(), 'panecast-outside-')); t.after(() => rm(outside, { recursive: true, force: true }));
  const folder = await realpath(await mkdtemp(join(tmpdir(), 'panecast-shared-'))); t.after(() => rm(folder, { recursive: true, force: true }));
  await writeFile(join(outside, 'id_rsa'), 'secret');
  await writeFile(join(folder, '论文.docx'), 'paper');
  await mkdir(join(folder, '.git')); await writeFile(join(folder, '.git', 'config'), 'x');
  await symlink(join(outside, 'id_rsa'), join(folder, 'key.txt'));
  const linked = [];
  const fileLinks = { link: async (root, path) => { linked.push([root, path]); return { url: 'https://files.example/x', name: path, path, size: 5, type: 'x', expires_at: '' }; } };
  const { relay } = await setup(t, [{ ...SHARE, directory: folder }], { fileLinks });
  relay.open('g', 'guest-a', { share_id: 's1' });
  const { files } = await relay.call('g', 'share.files.list');
  assert.deepEqual(files.map((f) => f.path), ['论文.docx'], 'no hidden folders or links');
  assert.equal((await relay.call('g', 'share.file.link', { path: '论文.docx' })).url, 'https://files.example/x');
  assert.deepEqual(linked, [[folder, '论文.docx']], 'links are always resolved inside the shared directory');
  const info = await relay.call('g', 'relay.info', own);
  assert.equal(info.max_upload_bytes, 12 * 1024 * 1024);
  const first = await relay.call('g', 'file.upload', { ...own, filename: '../原稿!.docx', data_base64: Buffer.from('v1').toString('base64'), mime_type: 'x' });
  assert.equal(first.path, './原稿！.docx');
  assert.equal(await readFile(join(folder, '原稿！.docx'), 'utf8'), 'v1');
  const second = await relay.call('g', 'file.upload', { ...own, filename: '原稿!.docx', data_base64: Buffer.from('v2').toString('base64') });
  assert.equal(second.path, './原稿！ (2).docx', 'an upload never replaces a file');
  const hidden = await relay.call('g', 'file.upload', { ...own, filename: '.zshrc', data_base64: 'aGk=' });
  assert.equal(hidden.path, './zshrc');
  const viaLink = await relay.call('g', 'file.upload', { ...own, filename: 'key.txt', data_base64: 'aGk=' });
  assert.equal(viaLink.path, './key (2).txt', 'an existing link is never written through');
  assert.equal(await readFile(join(outside, 'id_rsa'), 'utf8'), 'secret');
});

test('a guest uploads a file of any size in chunks kept outside the shared directory', async (t) => {
  const folder = await realpath(await mkdtemp(join(tmpdir(), 'panecast-shared-'))); t.after(() => rm(folder, { recursive: true, force: true }));
  await writeFile(join(folder, '数据.csv'), 'old');
  const { relay, directory } = await setup(t, [{ ...SHARE, directory: folder }]);
  relay.open('g', 'guest-a', { share_id: 's1' });
  assert.equal((await relay.call('g', 'relay.info', own)).upload_chunk_bytes, 4 * 1024 * 1024);
  const bytes = Buffer.alloc(300_000, 7); bytes.write('head'); bytes.write('tail', bytes.length - 4);
  const chunk = (offset, end, done) => relay.call('g', 'file.upload', { ...own, upload_id: 'up-abcdef123456', offset, data_base64: bytes.subarray(offset, end).toString('base64'), done, filename: '数据!.csv' });
  assert.deepEqual(await chunk(0, 100_000, false), { upload_id: 'up-abcdef123456', received: 100_000 });
  const parts = join(directory, 'state', 'shares', 's1', 'uploads');
  assert.deepEqual(await readdir(parts), ['up-abcdef123456.part']);
  assert.deepEqual(await readdir(folder), ['数据.csv'], 'nothing half-written in the shared directory');
  await assert.rejects(chunk(50_000, 100_000, false), (error) => error.code === 'upload_failed');
  assert.deepEqual(await chunk(100_000, 200_000, false), { upload_id: 'up-abcdef123456', received: 200_000 });
  const done = await chunk(200_000, bytes.length, true);
  assert.deepEqual(done, { path: './数据！.csv', filename: '数据！.csv', size: bytes.length, bytes: bytes.length, mime_type: done.mime_type });
  assert.ok((await readFile(join(folder, '数据！.csv'))).equals(bytes));
  assert.equal((await stat(join(folder, '数据！.csv'))).mode & 0o777, 0o644);
  assert.deepEqual(await readdir(parts), []);
  for (const bad of [{ upload_id: '../../x', offset: 0 }, { upload_id: 'up-abcdef123456', offset: -1 }]) {
    await assert.rejects(relay.call('g', 'file.upload', { ...own, ...bad, data_base64: 'aGk=', done: true }), { code: 'invalid_params' }, JSON.stringify(bad));
  }
  await assert.rejects(relay.call('g', 'file.upload', { workspace_id: scoped('cmux', '$0'), surface_id: scoped('cmux', '%0'), upload_id: 'up-abcdef123456', offset: 0, data_base64: 'aGk=' }), { code: 'forbidden' });
});

test('shared windows start Claude with a known session id that the gateway can find', async (t) => {
  const sessionId = '0f750287-1d0a-4d17-8173-f68c540634af';
  for (const options of [{}, { full: true }, { web: true }]) {
    assert.match(shareCommand('/bin/claude', '/s.json', { ...options, sessionId }), new RegExp(`/bin/claude'? --session-id '?${sessionId}`));
  }
  assert.ok(!shareCommand('/bin/claude', '/s.json').includes('--session-id'));
  const state = await mkdtemp(join(tmpdir(), 'panecast-share-binding-'));
  t.after(() => rm(state, { recursive: true, force: true }));
  const config = { state_directory: state };
  assert.equal(await shareConversationBinding(config, 'cmux', 'w1', 's1'), null);
  await mkdir(join(state, 'shares'), { recursive: true });
  const share = { id: 's1', source_id: 'cmux', workspace_id: 'w1', surface_id: 's1', session_id: sessionId, revoked_at: null };
  await writeFile(join(state, 'shares', 'shares.json'), JSON.stringify({ version: 1, shares: [share, { ...share, id: 's2', surface_id: 's2', session_id: 'not-a-uuid' }] }));
  assert.deepEqual(await shareConversationBinding(config, 'cmux', 'w1', 's1'), { kind: 'claude', checkpoint_id: sessionId });
  assert.equal(await shareConversationBinding(config, 'cmux', 'w1', 's2'), null);
  assert.equal(await shareConversationBinding(config, 'other', 'w1', 's1'), null);
  await writeFile(join(state, 'shares', 'shares.json'), JSON.stringify({ version: 1, shares: [{ ...share, revoked_at: '2026-11-17T00:00:00Z' }] }));
  assert.equal(await shareConversationBinding(config, 'cmux', 'w1', 's1'), null);
});

/** A share whose Claude settings exist, as `panecast share create` leaves them, with a stand-in Claude binary. */
async function withTerminals(t, share = SHARE) {
  const previous = process.env.PANECAST_CLAUDE_BIN;
  process.env.PANECAST_CLAUDE_BIN = '/opt/test/claude';
  t.after(() => { if (previous === undefined) delete process.env.PANECAST_CLAUDE_BIN; else process.env.PANECAST_CLAUDE_BIN = previous; });
  const fx = await setup(t, [share]);
  const settings = join(fx.directory, 'state', 'shares', share.id, 'claude-settings.json');
  await mkdir(join(settings, '..'), { recursive: true });
  await writeFile(settings, '{}');
  fx.relay.open('g', 'guest-a', { share_id: share.id });
  return { ...fx, settings, config: { state_directory: join(fx.directory, 'state') } };
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

test('a guest adds terminals in the shared workspace running the same confined Claude', async (t) => {
  const { relay, upstream, store, settings, config } = await withTerminals(t);
  const created = await relay.call('g', 'surface.create', { workspace_id: own.workspace_id, type: 'terminal', focus: true });
  assert.deepEqual(created, { workspace_id: own.workspace_id, surface_id: scoped('cmux', '%100'), type: 'terminal' });
  const call = upstream.calls.find((c) => c.method === 'surface.create');
  // In the share's workspace and folder, without taking the owner's focus.
  assert.deepEqual({ ...call.params, initial_command: undefined }, { workspace_id: '$1', type: 'terminal', cwd: '/tmp/paper', focus: false, initial_command: undefined });
  const command = call.params.initial_command;
  assert.ok(command.startsWith("/bin/zsh -lc 'exec /usr/bin/env -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT "), command);
  for (const part of ['/opt/test/claude', '--restricted', '--disable-slash-commands', '--strict-mcp-config', settings, '--session-id']) assert.ok(command.includes(part), part);
  assert.ok(!command.includes('--dangerously-skip-permissions'));
  // The new terminal is the guest's like the first; the owner's %9 stays hidden.
  const { surfaces } = await relay.call('g', 'surface.list', { workspace_id: own.workspace_id });
  assert.deepEqual(surfaces.map((s) => s.id), [own.surface_id, created.surface_id]);
  const [share] = await store.read();
  assert.deepEqual(share.terminals.map((terminal) => terminal.surface_id), ['%1', '%100']);
  const sessionId = share.terminals[1].session_id;
  assert.match(sessionId, UUID_PATTERN);
  assert.ok(command.includes(sessionId));
  assert.deepEqual(await shareConversationBinding(config, 'cmux', '$1', '%100'), { kind: 'claude', checkpoint_id: sessionId });
  // Input to it goes through the same checks.
  await relay.call('g', 'surface.send_text', { ...own, surface_id: created.surface_id, text: '跑一下!' });
  await assert.rejects(relay.call('g', 'surface.send_key', { ...own, surface_id: created.surface_id, key: 'ctrl-g' }), { code: 'guest_key' });
  assert.deepEqual(upstream.sent().map((c) => [c.params.surface_id, c.params.text]), [['%100', '跑一下！']]);
});

test('a share holds at most five terminals and always keeps one', async (t) => {
  const { relay, upstream, store } = await withTerminals(t);
  // Requests sent together cannot pass the limit together.
  const results = await Promise.allSettled(Array.from({ length: 5 }, () => relay.call('g', 'surface.create', { workspace_id: own.workspace_id })));
  assert.deepEqual(results.map((r) => r.status === 'fulfilled' ? 'ok' : r.reason.code).sort(), ['ok', 'ok', 'ok', 'ok', 'share_terminal_limit']);
  assert.equal(upstream.calls.filter((c) => c.method === 'surface.create').length, 4);
  // The first window may close while others remain; the share then points at the next one.
  await relay.call('g', 'surface.close', own);
  let [share] = await store.read();
  assert.equal(share.surface_id, '%100');
  assert.deepEqual(share.terminals.map((terminal) => terminal.surface_id), ['%100', '%101', '%102', '%103']);
  await assert.rejects(relay.call('g', 'surface.send_text', { ...own, text: 'x' }), { code: 'forbidden' });
  assert.equal((await relay.call('g', 'relay.info')).share.surface_id, scoped('cmux', '%100'));
  // A terminal closed in cmux by the owner no longer counts.
  upstream.closed.add('%103');
  await relay.call('g', 'surface.create', { workspace_id: own.workspace_id });
  [share] = await store.read();
  assert.deepEqual(share.terminals.map((terminal) => terminal.surface_id), ['%100', '%101', '%102', '%104']);
  for (const id of ['%101', '%102', '%104']) await relay.call('g', 'surface.close', { ...own, surface_id: scoped('cmux', id) });
  await assert.rejects(relay.call('g', 'surface.close', { ...own, surface_id: scoped('cmux', '%100') }), { code: 'share_last_terminal' });
  [share] = await store.read();
  assert.deepEqual(share.terminals.map((terminal) => terminal.surface_id), ['%100']);
  assert.deepEqual([...upstream.closed].sort(), ['%1', '%101', '%102', '%103', '%104']);
});

test('a full-access share adds terminals with the owner\'s unrestricted Claude', async (t) => {
  const { relay, upstream } = await withTerminals(t, { ...SHARE, full: true, prompt_hook: false });
  const created = await relay.call('g', 'surface.create', { workspace_id: own.workspace_id });
  const command = upstream.calls.find((c) => c.method === 'surface.create').params.initial_command;
  assert.ok(command.includes('--dangerously-skip-permissions') && !command.includes('--restricted'), command);
  await relay.call('g', 'surface.send_key', { ...own, surface_id: created.surface_id, key: 'ctrl-g' });
  assert.deepEqual(upstream.sent().map((c) => [c.params.surface_id, c.params.key]), [['%100', 'ctrl-g']]);
});

test('an open-network share adds terminals with the same network', async (t) => {
  const { relay, upstream } = await withTerminals(t, { ...SHARE, network: 'open' });
  await relay.call('g', 'surface.create', { workspace_id: own.workspace_id });
  const command = upstream.calls.find((c) => c.method === 'surface.create').params.initial_command;
  assert.ok(command.includes('WebFetch') && command.includes('--restricted'), command);
});

test('a confined share without its settings adds no terminal', async (t) => {
  const { relay, upstream, settings } = await withTerminals(t);
  await rm(settings);
  await assert.rejects(relay.call('g', 'surface.create', { workspace_id: own.workspace_id }), { code: 'share_terminal_failed' });
  assert.equal(upstream.calls.some((c) => c.method === 'surface.create'), false);
});
