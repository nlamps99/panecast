import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, appendFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocketServer } from 'ws';
import { createHub } from '../src/hub/server.mjs';
import { savePrivate, accountPath } from '../src/weixin/storage.mjs';
import { TerminalGateway } from '../src/weixin/terminal.mjs';
import { SourceRegistry } from '../src/hub/registry.mjs';
import { parseConversation } from '../src/hub/terminal-conversation.mjs';

const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];
const record = (index, turn, item) => ({ type: 'event_msg', timestamp: new Date().toISOString(), payload: { thread_id: ids[index], turn_id: turn, type: 'item_completed', item } });
const text = (type, id, value, phase) => ({ type, id, phase, content: [{ type: 'text', text: value }] });
async function waitFor(predicate, timeout = 6000) { const end = Date.now() + timeout; while (Date.now() < end) { if (predicate()) return; await delay(20); } throw new Error('fixture condition timed out'); }

test('Weixin owner messages traverse the actual hub into the exact cmux terminal and receive only its final response', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'panecast-weixin-hub-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const codexHome = join(directory, 'codex'), sessionDirectory = join(codexHome, 'sessions'); await mkdir(sessionDirectory, { recursive: true });
  const files = ids.map(id => join(sessionDirectory, id + '.jsonl'));
  for (let index = 0; index < 2; index++) await writeFile(files[index], [{ type: 'session_meta', payload: { id: ids[index] } }, record(index, 'old', text('AgentMessage', 'a', 'old reply', 'final'))].map(r => JSON.stringify(r) + '\n').join(''));
  const upstream = new WebSocketServer({ port: 0, host: '127.0.0.1' }); await once(upstream, 'listening');
  t.after(async () => { for (const ws of upstream.clients) ws.terminate(); await new Promise(resolve => upstream.close(resolve)); });
  const calls = [];
  upstream.on('connection', ws => ws.on('message', async raw => {
    const m = JSON.parse(raw); if (!m.method) return; calls.push(m); let result = {};
    if (m.method === 'window.list') result = { windows: [{ id: 'window' }] };
    if (m.method === 'workspace.list') result = { workspaces: [{ id: 'work', title: 'same project' }] };
    if (m.method === 'surface.list') result = { surfaces: [{ id: 'one', type: 'terminal', title: 'first' }, { id: 'two', type: 'terminal', title: 'second' }] };
    if (m.method === 'surface.resume.get') result = { resume_binding: { kind: 'codex', checkpoint_id: ids[m.params.surface_id === 'one' ? 0 : 1], execution_location: 'local' } };
    if (m.method === 'system.capabilities') result = { methods: ['terminal.paste'] };
    if (m.method === 'surface.read_text') result = { text: '$ ready' };
    if (m.method === 'terminal.paste') {
      const index = m.params.surface_id === 'one' ? 0 : 1;
      await appendFile(files[index], [record(index, 'new', text('UserMessage', 'user', m.params.text)),
        record(index, 'new', text('AgentMessage', 'progress', 'internal progress', 'commentary')),
        record(index, 'new', { type: 'CommandExecution', id: 'cmd', command: 'hidden Ran tool', status: 'completed' }),
        record(index, 'new', text('AgentMessage', 'done', `finished on ${m.params.surface_id}`, 'final'))].map(r => JSON.stringify(r) + '\n').join(''));
    }
    ws.send(JSON.stringify({ id: m.id, ok: true, result }));
  }));
  const sources = [{ id: 'cmux', type: 'cmux', enabled: true, access: 'control', url: `ws://127.0.0.1:${upstream.address().port}`, token: 'upstream-fixture', device_id: 'fixture', codex_home: codexHome }];
  const account = { version: 1, enabled: true, botId: 'bot', ownerId: 'owner', token: 'test', epoch: 'login', origin: 'https://ilinkai.weixin.qq.com' };
  await savePrivate(accountPath(join(directory, 'state/weixin')), account);
  const queue = [], sent = []; let wake, sequence = 0;
  const api = { async updates(_cursor, signal) {
    if (!queue.length) await new Promise(resolve => { wake = resolve; signal.addEventListener('abort', resolve, { once: true }); });
    return { msgs: queue.splice(0), get_updates_buf: String(sequence) };
  }, async send(to, body) { sent.push({ to, body }); } };
  const receive = (body, owner = 'owner') => { queue.push({ message_id: String(++sequence), from_user_id: owner, to_user_id: 'bot', message_type: 1, message_state: 2, context_token: 'context', item_list: [{ type: 1, text_item: { text: body } }] }); wake?.(); wake = null; };
  const hub = await createHub({ state_directory: join(directory, 'state'), sources }, { weixin: { apiFactory: () => api } }); await hub.start(); t.after(() => hub.close());
  receive('/list'); await waitFor(() => sent.some(s => s.body.includes('second')));
  const line = sent.find(s => s.body.includes('second')).body.split('\n').find(line => line.includes('second')); const code = line.split(' ')[0];
  receive('/use ' + code); await waitFor(() => sent.some(s => s.body.includes('已选择')));
  receive('foreign command', 'stranger'); receive('检查中文项目');
  await waitFor(() => calls.some(c => c.method === 'terminal.paste'));
  const paste = calls.find(c => c.method === 'terminal.paste'); assert.deepEqual(paste.params, { workspace_id: 'work', surface_id: 'two', text: '检查中文项目', submit_key: 'return' });
  await waitFor(() => sent.some(s => s.body.includes('finished on two')));
  assert.equal(calls.filter(c => c.method === 'terminal.paste').length, 1);
  assert.equal(sent.some(s => /internal progress|hidden Ran tool|old reply/.test(s.body)), false); assert.ok(sent.every(s => s.to === 'owner'));
  assert.equal(calls.some(c => /turn\/start|thread\/resume|agent.send/.test(c.method)), false);
  hub.reloadSources([]); receive('must not run'); await delay(300);
  assert.equal(calls.filter(c => c.method === 'terminal.paste').length, 1);
});

test('terminal input fallback focuses the selected surface and never retries an uncertain paste via another method', async () => {
  const registry = new SourceRegistry([{ id: 'cmux', type: 'cmux', enabled: true, access: 'control', url: 'ws://127.0.0.1:1', token: 'fixture', device_id: 'fixture' }]);
  const gateway = new TerminalGateway(registry, {}), calls = [], target = { sourceId: 'cmux', workspace_id: 'cmux~dw', surface_id: 'cmux~cw' };
  gateway.session.clients.set('cmux', { async call(method, params) { calls.push({ method, params }); if (method === 'surface.list') return { surfaces: [{ id: 's', type: 'terminal' }] }; if (method === 'terminal.paste') throw new Error('ack lost'); return {}; }, close() {} });
  try {
    await gateway.input(target, 'hello', {});
    assert.deepEqual(calls.filter(c => c.method !== 'surface.list').map(c => c.method), ['surface.send_text', 'surface.focus', 'surface.send_key']);
    calls.length = 0;
    await assert.rejects(gateway.input(target, 'once', { input_method: 'terminal.paste' }));
    assert.deepEqual(calls.filter(c => c.method !== 'surface.list').map(c => c.method), ['terminal.paste']);
  } finally { gateway.close(); registry.close(); }
});

test('normalizers explicitly mark final replies and questions without classifying tool narration as completion', () => {
  const codex = parseConversation([record(0, 't', text('AgentMessage', 'comment', 'progress', 'commentary')), record(0, 't', text('AgentMessage', 'final', 'done', 'final'))].map((value, offset) => ({ value, offset })), 'codex', ids[0]);
  assert.deepEqual(codex.items.map(i => i.phase), ['commentary', 'final']);
  const claude = parseConversation([{ sessionId: ids[0], type: 'assistant', uuid: 'a', message: { content: [{ type: 'text', text: 'checking' }], stop_reason: 'tool_use' } },
    { sessionId: ids[0], type: 'assistant', uuid: 'b', parentUuid: 'a', message: { content: [{ type: 'text', text: 'finished' }], stop_reason: 'end_turn' } }].map((value, offset) => ({ value, offset })), 'claude', ids[0]);
  assert.deepEqual(claude.items.map(i => i.phase), ['commentary', 'final']);
});
