import nodeTest from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import http from 'node:http';
import { WeixinApi, WeixinError, weixinOrigin } from '../src/weixin/api.mjs';
import { WeixinState, savePrivate, readAccount, acquireLock, accountPath, statePath } from '../src/weixin/storage.mjs';
import { loginWeixin } from '../src/weixin/login.mjs';
import { loginPage } from '../src/weixin/cli.mjs';
import { WeixinBridge, inboundMessage, messageChunks } from '../src/weixin/bridge.mjs';
import { WeixinRuntime } from '../src/weixin/runtime.mjs';
import { decisionPrompt } from '../src/weixin/terminal.mjs';
import { scoped } from '../src/hub/ids.mjs';

const account = { version: 1, enabled: true, token: 'fixture-secret', origin: 'https://ilinkai.weixin.qq.com', botId: 'bot', ownerId: 'owner', epoch: 'login-1' };
const test = (name, fn) => nodeTest(name, { skip: process.platform === 'win32' ? 'Weixin currently runs on the Mac gateway' : false }, fn);
const target = { sourceId: 'cmux', workspace_id: scoped('cmux', 'workspace'), surface_id: scoped('cmux', 'first'), title: 'Project / Codex', code: 'first', access: 'control' };
const second = { ...target, surface_id: scoped('cmux', 'second'), code: 'second', title: 'Project / Claude' };
const message = (id, text, fields = {}) => ({ message_id: id, from_user_id: 'owner', to_user_id: 'bot', message_type: 1, message_state: 2, context_token: 'context-' + id, item_list: [{ type: 1, text_item: { text } }], ...fields });
const item = (id, sequence, text, fields = {}) => ({ id, type: 'agentMessage', text, sequence, updatedSequence: sequence, timestamp: Date.now(), ...fields });

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'panecast-weixin-test-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const state = new WeixinState(join(directory, 'state.json')); await state.load();
  const controller = new AbortController(), calls = [], sent = [];
  const pages = { first: { available: true, conversation_id: 'a', generation: 'e', head_sequence: 1000, items: [item('old', 10, 'old reply', { phase: 'final' })] }, second: { available: true, conversation_id: 'b', generation: 'e', head_sequence: 1000, items: [] } };
  const terminal = {
    allowed: true, readOnly: false, text: '$ ready',
    async list() { return { targets: [target, second], offline: 0 }; },
    async validate(_target, control) { if (!this.allowed) throw new Error('revoked'); if (control && this.readOnly) throw new Error('read only'); },
    async snapshot(t) { await this.validate(t); return structuredClone(pages[t.code]); },
    async screen(t) { await this.validate(t); return this.text; },
    async input(t, text) { calls.push({ kind: 'input', target: t.code, text }); },
    async key(t, key) { calls.push({ kind: 'key', target: t.code, key }); },
    close() {},
  };
  const journal = { epoch: 'events', sequence: 0, events: [], async page({ cursor }) { const index = Number(cursor?.split(':')[1] ?? 0); return { events: this.events.slice(index), next_cursor: `events:${this.events.length}`, reset: false }; } };
  const api = { async send(to, text, context, id) { sent.push({ to, text, context, id }); } };
  const bridge = new WeixinBridge({ account, state, api, terminal, journal, signal: controller.signal });
  t.after(() => controller.abort());
  const receive = async (id, text, fields) => { await bridge.accept({ msgs: [message(id, text, fields)], get_updates_buf: id }); await bridge.flush(); };
  return { directory, state, bridge, api, terminal, pages, journal, calls, sent, controller, receive };
}

test('iLink auth is scoped to approved HTTPS origins and QR requests never carry bot tokens', async () => {
  for (const url of ['http://ilinkai.weixin.qq.com', 'https://weixin.qq.com.evil.test', 'https://127.0.0.1', 'https://x.weixin.qq.com:444', 'https://user:pass@ilinkai.weixin.qq.com', 'https://ilinkai.weixin.qq.com/?token=x']) assert.throws(() => weixinOrigin(url));
  const calls = [];
  const api = new WeixinApi({ token: 'private-token', fetchImpl: async (url, init) => { calls.push({ url, ...init }); return new Response('{"ret":0,"message_id":9007199254740993123}'); } });
  await api.getQR(); await api.qrStatus('private-qr', undefined, undefined);
  const result = await api.send('owner', '你好', 'private-context', 'id');
  assert.equal(calls[0].headers.Authorization, undefined); assert.equal(calls[1].headers.Authorization, undefined);
  assert.equal(calls[2].headers.Authorization, 'Bearer private-token'); assert.equal(calls[2].redirect, 'error');
  assert.equal(JSON.parse(calls[2].body).msg.context_token, 'private-context'); assert.equal(result.message_id, '9007199254740993123');
  assert.match(JSON.parse(calls[2].body).base_info.bot_agent, /^Panecast\//);
  assert.throws(() => api.send('owner', 'hello', '', 'id'), { code: 'missing_context' });
});

test('API distinguishes rejected business requests from uncertain sends without exposing secrets', async () => {
  const api = new WeixinApi({ fetchImpl: async () => new Response('{"ret":-14,"errmsg":"leaked-token"}') });
  await assert.rejects(api.send('owner', 'text', 'context', 'id'), error => error.code === '-14' && !error.uncertain && !error.message.includes('leaked-token'));
  api.fetch = async () => { throw new Error('secret in url'); };
  await assert.rejects(api.send('owner', 'text', 'context', 'id'), error => error.uncertain && !error.message.includes('secret'));
});

test('scan login supports PIN and binds only the confirmed owner while preserving prior credentials on failure', async t => {
  const { directory, controller } = await fixture(t); const shown = [], polls = []; let index = 0;
  const api = { async getQR() { return { qrcode: 'qr', qrcode_img_content: 'https://weixin.qq.com/qa' }; },
    async qrStatus(qr, pin) { polls.push({ qr, pin }); return index++ === 0 ? { status: 'need_verifycode' } : { status: 'confirmed', bot_token: 'test-token', ilink_bot_id: 'bot', ilink_user_id: 'owner', baseurl: account.origin }; } };
  await loginWeixin({ directory, api, signal: controller.signal, onQR: value => shown.push(value), requestPin: async () => '123456' });
  assert.equal(polls[1].pin, '123456'); assert.equal(shown.length, 1);
  assert.equal((await readAccount(directory)).ownerId, 'owner'); assert.equal((await stat(accountPath(directory))).mode & 0o777, 0o600);
  const saved = await readFile(accountPath(directory), 'utf8');
  api.qrStatus = async () => ({ status: 'confirmed', bot_token: 'new-token', ilink_bot_id: 'bot', baseurl: account.origin });
  await assert.rejects(loginWeixin({ directory, api, signal: controller.signal, onQR() {}, requestPin() {} }));
  assert.equal(await readFile(accountPath(directory), 'utf8'), saved);
});

test('browser pairing is loopback-only, refuses cross-origin PINs and never exposes saved credentials', async t => {
  const controller = new AbortController(), page = await loginPage(controller.signal); t.after(() => page.close());
  page.onQR('https://weixin.qq.com/fixture');
  const html = await (await fetch(page.url)).text(); assert.ok(html.includes('Panecast')); assert.equal(html.includes('fixture-secret'), false);
  const waiting = page.requestPin(), url = new URL(page.url);
  assert.equal((await fetch(page.url + '/pin', { method: 'POST', headers: { Origin: 'https://evil.test' }, body: '123456' })).status, 403);
  assert.equal((await fetch(page.url + '/pin', { method: 'POST', headers: { Origin: url.origin, 'x-panecast-login': url.pathname.slice(1) }, body: '123456' })).status, 200);
  assert.equal(await waiting, '123456');
  const status = await new Promise(resolve => { http.get(page.url, { headers: { Host: 'evil.test' } }, r => { r.resume(); resolve(r.statusCode); }); });
  assert.equal(status, 403);
  page.finish(true); const state = await (await fetch(page.url + '/state')).json(); assert.equal(state.state, 'done'); assert.equal(state.svg, '');
});

test('only the QR owner in a private conversation can issue valid completed text messages', () => {
  for (const fields of [{ from_user_id: 'other' }, { group_id: 'group' }, { to_user_id: 'other-bot' }, { message_type: 2 }, { message_state: 1 }, { message_id: null }]) assert.equal(inboundMessage(message('1', 'danger', fields), account), null);
  assert.ok(inboundMessage(message('1', 'bad\x1b[A'), account).invalid);
  assert.ok(inboundMessage(message('1', 'x'.repeat(8001)), account).invalid);
  assert.ok(inboundMessage(message('1', 'hello', { item_list: [{ type: 2, image_item: {} }] }), account).invalid);
  assert.equal(inboundMessage(message('1', '中文\n换行'), account).text, '中文\n换行');
});

test('selects an exact terminal, sends Chinese text once, and persists deduplication across restart', async t => {
  const f = await fixture(t);
  await f.receive('1', 'hello'); assert.equal(f.calls.length, 0); assert.match(f.sent.at(-1).text, /\/list/);
  await f.receive('2', '/list'); await f.receive('3', '/use second'); await f.receive('4', '请检查\n不要重复');
  assert.deepEqual(f.calls, [{ kind: 'input', target: 'second', text: '请检查\n不要重复' }]);
  await f.receive('4', '请检查\n不要重复'); assert.equal(f.calls.length, 1);
  const restored = new WeixinState(f.state.path); await restored.load();
  const bridge = new WeixinBridge({ account, state: restored, api: f.api, terminal: f.terminal, journal: f.journal, signal: f.controller.signal });
  await bridge.accept({ msgs: [message('4', '请检查\n不要重复')], get_updates_buf: '5' }); assert.equal(f.calls.length, 1);
  assert.equal(restored.value.target.code, 'second'); assert.equal(restored.value.cursor, '5');
});

test('pushes only fresh explicit final replies and questions, with no historical or tool spam', async t => {
  const f = await fixture(t); await f.receive('1', '/use first'); const count = f.sent.length;
  await f.bridge.observe(); await f.bridge.flush(); assert.equal(f.sent.length, count);
  f.pages.first.items.push(item('progress', 20, '正在执行命令', { phase: 'commentary' }), item('tool', 30, 'Ran secret command', { type: 'commandExecution' }));
  await f.bridge.observe(); await f.bridge.flush(); assert.equal(f.sent.length, count);
  f.pages.first.items.push(item('question', 40, '选择哪个方案？', { needsInput: true }));
  await f.bridge.observe(); await f.bridge.flush(); assert.match(f.sent.at(-1).text, /选择哪个方案/);
  f.pages.first.items.push(item('done', 50, '测试通过', { phase: 'final' }));
  await f.bridge.observe(); await f.bridge.flush(); const done = f.sent.length;
  f.journal.events.push({ name: 'notification.created', category: 'notification', payload: { ...target, title: '任务已完成', panecast_event_id: 'event:1' } });
  await f.bridge.observe(); await f.bridge.flush(); assert.equal(f.sent.length, done);
  assert.equal(f.sent.some(s => s.text.includes('Ran secret command')), false);
});

test('keeps partial-log final records visible using item offsets rather than the raw file byte size', async t => {
  const f = await fixture(t); await f.receive('1', '/use first');
  f.pages.first.head_sequence = 2000; f.pages.first.items.push(item('completed-partial-record', 500, 'record completed', { phase: 'final' }));
  await f.bridge.observe(); await f.bridge.flush(); assert.match(f.sent.at(-1).text, /record completed/);
});

test('permission menus remain visible and ordinary messages never implicitly accept them', async t => {
  const f = await fixture(t); await f.receive('1', '/use first');
  f.terminal.text = 'Run this command?\n› 1. Yes, proceed\n  2. No\nEnter to select · Esc to cancel';
  assert.ok(decisionPrompt(f.terminal.text)); await f.bridge.observe(); await f.bridge.flush();
  assert.match(f.sent.at(-1).text, /需要你选择/); await f.receive('2', '好的'); assert.equal(f.calls.length, 0);
  await f.receive('3', '/key down'); await f.receive('4', '/key enter'); assert.deepEqual(f.calls.map(c => c.key), ['down', 'enter']);
});

test('source revocation blocks queued result delivery and commands, and a changed session requires a new binding', async t => {
  const f = await fixture(t); await f.receive('1', '/use first');
  f.pages.first.conversation_id = 'different'; await f.receive('2', 'do work'); assert.equal(f.calls.length, 0); assert.match(f.sent.at(-1).text, /会话已变化/);
  await f.receive('3', '/use first'); f.terminal.readOnly = true; await f.receive('4', 'no write'); assert.equal(f.calls.length, 0);
  await f.bridge.enqueue('late', 'private output', target); f.terminal.allowed = false; await f.bridge.flush(); assert.equal(f.sent.some(s => s.text === 'private output'), false);
});

test('a queued manual read is not delivered after its source is revoked', async t => {
  const f = await fixture(t); await f.receive('1', '/use first');
  await f.bridge.accept({ msgs: [message('2', '/read')], get_updates_buf: '2' });
  f.terminal.allowed = false; await f.bridge.flush();
  assert.equal(f.sent.some(s => s.text.includes('old reply')), false);
});

test('lost send acknowledgement never repeats terminal input or an uncertain outgoing message', async t => {
  const f = await fixture(t); await f.receive('1', '/use first');
  f.terminal.input = async (t, text) => { f.calls.push({ text }); throw new Error('ack lost'); };
  await f.receive('2', 'once'); await f.receive('2', 'once'); assert.equal(f.calls.length, 1); assert.match(f.sent.at(-1).text, /未确认/);
  let attempts = 0; f.api.send = async () => { attempts++; throw new WeixinError('network_error', 'timeout', true); };
  await f.bridge.enqueue('output', 'reply'); await f.bridge.flush(); await f.bridge.flush(); assert.equal(attempts, 1);
  await f.state.change(s => { s.context = 'new-context'; }); await f.bridge.flush(); assert.equal(attempts, 1);
});

test('definitely rejected replies wait for fresh context and resume remaining chunks only', async t => {
  const f = await fixture(t); await f.receive('1', '/use first'); let attempts = 0;
  f.api.send = async () => { if (++attempts === 2) throw new WeixinError('expired_context', 'expired'); };
  await f.bridge.enqueue('long', 'a'.repeat(3000)); await f.bridge.flush(); assert.equal(attempts, 2); assert.equal(f.state.value.outbox[0].next, 1);
  await f.bridge.flush(); assert.equal(attempts, 2);
  await f.state.change(s => { s.context = 'fresh'; }); await f.bridge.flush(); assert.equal(attempts, 3); assert.equal(f.state.value.outbox.length, 0);
});

test('crash recovery preserves pending work, reports interrupted sends, and does not retry them', async t => {
  const f = await fixture(t);
  await f.state.change(s => { s.inbox = [{ id: 'attempted', text: 'no repeat', status: 'processing' }, { id: 'pending', text: '/help', status: 'pending' }]; s.context = 'ctx'; s.outbox = [{ id: 'uncertain', text: 'result', chunks: ['result'], next: 0, status: 'sending' }]; });
  const state = new WeixinState(f.state.path); await state.load();
  const bridge = new WeixinBridge({ account, state, api: f.api, terminal: f.terminal, journal: f.journal, signal: f.controller.signal });
  await bridge.processPending(); await bridge.flush();
  assert.equal(f.calls.length, 0); assert.ok(state.value.seen.includes('attempted')); assert.ok(state.value.seen.includes('pending'));
  assert.equal(f.sent.some(s => s.text === 'result'), false); assert.ok(f.sent.some(s => s.text.includes('上次有操作')));
});

test('durable cursor cannot advance after a failed disk write; corrupt state is not reset silently', async t => {
  const f = await fixture(t); const before = f.state.value.cursor;
  f.state.path = join(f.directory, 'state.json', 'cannot-be-a-child');
  await assert.rejects(f.bridge.accept({ msgs: [message('1', 'do work')], get_updates_buf: 'new' }));
  assert.equal(f.state.value.cursor, before); assert.equal(f.calls.length, 0);
  const corrupt = join(f.directory, 'corrupt.json'); await writeFile(corrupt, 'broken', { mode: 0o600 });
  await assert.rejects(new WeixinState(corrupt).load()); assert.equal(await readFile(corrupt, 'utf8'), 'broken');
});

test('single poller lock and runtime shutdown protect the shared account', async t => {
  const f = await fixture(t), release = await acquireLock(f.directory);
  await assert.rejects(acquireLock(f.directory), /另一个进程/); await release(); const again = await acquireLock(f.directory); await again();
  const config = { state_directory: f.directory }, directory = join(f.directory, 'weixin'); await savePrivate(accountPath(directory), account);
  let reads = 0;
  const runtime = new WeixinRuntime({}, config, f.journal, { terminalFactory: () => f.terminal, apiFactory: () => ({ ...f.api, async updates(_cursor, signal) { reads++; await delay(100000, undefined, { signal }); } }) });
  runtime.start(); await runtime.reconcile(); await delay(10); assert.equal(reads, 1);
  await savePrivate(accountPath(directory), { enabled: false }); await runtime.reconcile(); assert.equal(runtime.epoch, null);
  await runtime.close(); const lock = await acquireLock(directory); await lock();
  assert.equal((await stat(statePath(directory, account))).mode & 0o777, 0o600);
});

test('chunking preserves Unicode and deterministic order', () => {
  const text = ('中文😀\n').repeat(1200), chunks = messageChunks(text);
  assert.equal(chunks.join(''), text); assert.ok(chunks.every(c => [...c].length <= 2000 && !/[\ud800-\udbff]$/.test(c)));
});
