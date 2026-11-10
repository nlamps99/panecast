import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, appendFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { parseConversation, TerminalConversationReader, localConversationSource } from '../src/hub/terminal-conversation.mjs';

const id = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const records = values => values.map((value, i) => ({ value, offset: i * 100 }));
const completed = (item, turn = 't') => ({ type: 'event_msg', payload: { type: 'item_completed', thread_id: id, turn_id: turn, item } });
const user = text => ({ type: 'UserMessage', id: 'u', content: [{ type: 'text', text }] });
const agent = text => ({ type: 'AgentMessage', id: 'a', content: [{ type: 'text', text }], phase: 'final' });
const claude = (uuid, parentUuid, type, content, extra = {}) => ({ sessionId: id, uuid, parentUuid, type, message: { content }, ...extra });
const jsonl = values => values.map(value => JSON.stringify(value) + '\n').join('');
async function fixture(t, provider, values) {
  const home = await mkdtemp(join(tmpdir(), 'panecast-chat-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const file = join(home, provider === 'codex' ? '.codex/sessions/2026/11/07' : '.claude/projects/project', `${id}.jsonl`);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, jsonl(values));
  return { home, file, reader: new TerminalConversationReader({ home }), binding: { kind: provider, checkpoint_id: id, execution_location: 'local' } };
}

test('canonical Codex messages stay visible while tool details normalize and reasoning stays private', () => {
  const parsed = parseConversation(records([
    completed(user('检查中文项目')), completed({ type: 'Reasoning', id: 'r', raw_content: 'private reasoning' }),
    completed({ type: 'CommandExecution', id: 'c', command: ['/bin/zsh', '-lc', 'npm test'], aggregated_output: 'passed', exit_code: 0, status: 'completed' }),
    completed({ type: 'FileChange', id: 'f', changes: { 'a.ts': { unified_diff: '+ok' } } }),
    completed(agent('检查完成')), completed(user('# AGENTS.md instructions: secret context'), 't2'),
    { type: 'response_item', payload: { role: 'assistant', type: 'message', content: [{ type: 'output_text', text: 'duplicate raw response' }] } },
    { type: 'event_msg', payload: { type: 'task_complete' } },
  ]), 'codex', id);
  assert.deepEqual(parsed.items.map(i => i.type), ['userMessage', 'commandExecution', 'fileChange', 'agentMessage']);
  assert.equal(parsed.items[1].command, 'npm test'); assert.equal(parsed.items[2].changes[0].diff, '+ok');
  assert.equal(parsed.items.at(-1).text, '检查完成'); assert.equal(parsed.active, false);
  assert.equal(JSON.stringify(parsed).includes('private reasoning'), false);
  assert.equal(parseConversation(records([completed(agent('finished without a lifecycle marker'))]), 'codex', id).active, false);
});

test('legacy Codex calls retain visible questions and late results', () => {
  const p = parseConversation(records([
    { type: 'event_msg', payload: { type: 'user_message', message: 'hello' } },
    { type: 'response_item', payload: { type: 'function_call', call_id: 'c', name: 'exec_command', arguments: '{"cmd":"pwd"}' } },
    { type: 'response_item', payload: { type: 'function_call_output', call_id: 'c', output: 'success' } },
    { type: 'response_item', payload: { type: 'function_call', call_id: 'q', name: 'request_user_input', arguments: JSON.stringify({ questions: [{ question: '选择环境？', options: [{ label: '测试' }] }] }) } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', channel: 'analysis', content: [{ type: 'output_text', text: 'hidden' }] } },
  ]), 'codex', id);
  assert.equal(p.items[1].command, 'pwd'); assert.equal(p.items[1].status, 'completed');
  assert.equal(p.items[1].sequence, 100000); assert.equal(p.items[1].updatedSequence, 200000);
  assert.match(p.items.at(-1).text, /选择环境？\n测试/);
});

test('Claude follows the current parent chain, combines tool results and excludes sidechains/thinking', () => {
  const p = parseConversation(records([
    claude('u', null, 'user', 'hello'),
    claude('abandoned', 'u', 'assistant', [{ type: 'text', text: 'abandoned answer' }]),
    claude('tool', 'u', 'assistant', [{ type: 'thinking', thinking: 'secret' }, { type: 'tool_use', id: 'bash', name: 'Bash', input: { command: 'pwd' } }]),
    claude('result', 'tool', 'user', [{ type: 'tool_result', tool_use_id: 'bash', content: 'output' }]),
    claude('answer', 'result', 'assistant', [{ type: 'text', text: 'done' }]),
    claude('side', 'answer', 'assistant', 'side agent', { isSidechain: true }),
  ]), 'claude', id);
  assert.deepEqual(p.items.map(i => i.type), ['userMessage', 'commandExecution', 'agentMessage']);
  assert.equal(p.items[1].aggregatedOutput, 'output'); assert.equal(p.items[1].command, 'pwd');
  assert.equal(p.items.at(-1).text, 'done'); assert.equal(JSON.stringify(p).includes('abandoned answer'), false);
});

test('reader pages an exact bound file, ignores partial appends and keeps active state on unchanged polls', async t => {
  const fx = await fixture(t, 'codex', [{ type: 'session_meta', payload: { id } },
    { type: 'event_msg', payload: { type: 'task_started' } }, ...Array.from({ length: 95 }, (_, i) => completed({ ...agent(`answer ${i}`), phase: 'commentary' }, `t${i}`))]);
  const page = await fx.reader.read(fx.binding, { limit: 20 });
  assert.equal(page.items.length, 20); assert.ok(page.next_cursor); assert.equal(page.active, true);
  const all = [...page.items]; let cursor = page.next_cursor;
  while (cursor) { const older = await fx.reader.read(fx.binding, { cursor, limit: 20 }); all.push(...older.items); cursor = older.next_cursor; }
  assert.equal(new Set(all.map(i => i.id)).size, 95);
  const unchanged = await fx.reader.read(fx.binding, { revision: page.revision, limit: 20 });
  assert.equal(unchanged.unchanged, true); assert.equal(unchanged.active, true);
  const pending = JSON.stringify(completed(agent('new reply'), 'new'));
  await appendFile(fx.file, pending);
  assert.equal((await fx.reader.read(fx.binding, { revision: page.revision, limit: 20 })).unchanged, true);
  await appendFile(fx.file, '\n');
  assert.equal((await fx.reader.read(fx.binding)).items.at(-1).text, 'new reply');
  const token = JSON.parse(Buffer.from(page.next_cursor, 'base64url').toString()); token.id = other;
  await assert.rejects(fx.reader.read(fx.binding, { cursor: Buffer.from(JSON.stringify(token)).toString('base64url') }), { code: 'cursor_expired' });
});

test('Claude pagination preserves ancestors and detects a rewind without changing the file identity', async t => {
  const values = Array.from({ length: 96 }, (_, i) => claude(`m${i}`, i ? `m${i - 1}` : null, i % 2 ? 'assistant' : 'user', `message ${i}`));
  const fx = await fixture(t, 'claude', values);
  const head = await fx.reader.read(fx.binding, { limit: 20 }); let cursor = head.next_cursor; const items = [...head.items];
  while (cursor) { const page = await fx.reader.read(fx.binding, { cursor, limit: 20 }); items.push(...page.items); cursor = page.next_cursor; }
  assert.equal(new Set(items.map(i => i.id)).size, 96);
  await appendFile(fx.file, jsonl([claude('new-branch', 'm20', 'assistant', 'revised answer')]));
  const rewound = await fx.reader.read(fx.binding, { branch: head.branch, revision: head.revision });
  assert.equal(rewound.reset, true); assert.equal(rewound.items.at(-1).text, 'revised answer');
  assert.equal(rewound.items.some(i => i.text === 'message 95'), false);
});

test('Claude compaction context and metadata do not start a new user turn', async t => {
  const values = [claude('u', null, 'user', 'work'),
    claude('done', 'u', 'assistant', 'finished', { message: { content: 'finished', stop_reason: 'end_turn' } }),
    { sessionId: id, uuid: 'boundary', parentUuid: null, logicalParentUuid: 'done', type: 'system', subtype: 'compact_boundary' },
    claude('summary', 'boundary', 'user', 'Previous work summary', { isCompactSummary: true }),
    { type: 'last-prompt', sessionId: id, leafUuid: 'summary' }];
  const fx = await fixture(t, 'claude', values);
  const page = await fx.reader.read(fx.binding);
  assert.equal(page.active, false);
  assert.ok(page.items.some(item => item.content?.[0]?.text === 'Previous work summary'));
  const cached = await fx.reader.read(fx.binding, { revision: page.revision });
  assert.equal(cached.unchanged, true); assert.equal(cached.active, false);
  await appendFile(fx.file, jsonl([claude('meta', 'summary', 'user', 'Context update', { isMeta: true })]));
  assert.equal((await fx.reader.read(fx.binding)).active, false);
  await appendFile(fx.file, jsonl([claude('next', 'meta', 'user', 'Continue the task')]));
  assert.equal((await fx.reader.read(fx.binding)).active, true);
  await appendFile(fx.file, jsonl([claude('answer', 'next', 'assistant', 'done')]));
  assert.equal((await fx.reader.read(fx.binding)).active, false);
});

test('reader crosses giant records without losing preceding text', async t => {
  const fx = await fixture(t, 'codex', [{ type: 'session_meta', payload: { id } }, completed(agent('before'), 'before'),
    { type: 'response_item', payload: { type: 'function_call_output', output: 'x'.repeat(5 * 1024 * 1024) } }, completed(agent('after'), 'after')]);
  const head = await fx.reader.read(fx.binding); const older = await fx.reader.read(fx.binding, { cursor: head.next_cursor });
  assert.equal(head.items.at(-1).text, 'after'); assert.equal(older.items.find(i => i.text === 'before')?.text, 'before');
});

test('reader rejects identity mismatch and never follows symlinks or remote bindings', async t => {
  const fx = await fixture(t, 'codex', [{ type: 'session_meta', payload: { id: other } }, completed(agent('wrong'))]);
  await assert.rejects(fx.reader.read(fx.binding), { code: 'conversation_identity' });
  await rm(fx.file); const outside = join(fx.home, 'outside.jsonl'); await writeFile(outside, jsonl([{ type: 'session_meta', payload: { id } }, completed(agent('outside'))]));
  await symlink(outside, fx.file);
  assert.equal((await fx.reader.read(fx.binding)).available, false);
  assert.equal((await fx.reader.read({ ...fx.binding, execution_location: 'remote' })).available, false);
  assert.equal((await fx.reader.read({ ...fx.binding, checkpoint_id: '../escape' })).available, false);
  assert.equal(localConversationSource('wss://example.com'), false); assert.equal(localConversationSource('ws://127.0.0.1:4399'), true);
});
