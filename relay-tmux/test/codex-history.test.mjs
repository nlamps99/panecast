import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexSource } from '../src/hub/codex.mjs';
import { mobileItem, mobileTurn } from '../src/hub/codex-history.mjs';

test('a long tool-heavy conversation keeps its messages and sends bounded previews', () => {
  const turn = mobileTurn({ id: 'turn', status: 'completed', items: [
    { id: 'user', type: 'userMessage', content: [{ type: 'text', text: '请继续' }] },
    ...Array.from({ length: 500 }, (_, i) => ({ id: `cmd-${i}`, type: 'commandExecution', command: 'check', aggregatedOutput: 'a'.repeat(100_000), unused: 'b'.repeat(100_000) })),
    { id: 'answer', type: 'agentMessage', text: '完成' },
  ] });
  assert.equal(turn.items[0].id, 'user'); assert.equal(turn.items.at(-1).text, '完成');
  assert.equal(turn.omittedItems, 470); assert.ok(JSON.stringify(turn).length < 200_000);
  assert.ok(turn.items[1].truncated); assert.equal('unused' in turn.items[1], false);
});

test('exhausting file diff preview budget never exposes the full remaining diff', () => {
  const item = mobileItem({ id: 'change', type: 'fileChange', changes: Array.from({ length: 20 }, () => ({ path: 'file', diff: 'x'.repeat(100_000) })) });
  assert.ok(JSON.stringify(item).length < 10_000); assert.equal(item.truncated, true);
  assert.deepEqual(mobileTurn({ id: 'empty', items: null }).items, []);
});

test('a user can explicitly resume a completed conversation, but viewing does not resume it', async () => {
  const calls = [], loaded = new Set(); let status = 'completed';
  const peer = { closed: false, connect: async () => {}, onMessage() {}, close() {}, async call(method, p) {
    calls.push(method);
    if (method === 'thread/loaded/list') return { data: [...loaded] };
    if (method === 'thread/read') return { thread: { id: p.threadId } };
    if (method === 'thread/turns/list') return { data: [{ id: 'turn', status, items: [] }] };
    if (method === 'thread/resume') { loaded.add(p.threadId); return { thread: { id: p.threadId } }; }
    if (method === 'thread/fork') { loaded.add('fork'); return { thread: { id: 'fork' } }; }
    throw new Error('unexpected call '+method);
  } };
  const source = new CodexSource({ id: 'codex', mode: 'attach', access: 'control' }, () => {}, () => peer);
  await source.dispatch('agent.subscribe', { thread_id: 'saved' }); assert.equal(calls.includes('thread/resume'), false);
  assert.equal((await source.dispatch('agent.resume', { thread_id: 'saved' })).thread.live, true);
  status = 'inProgress';
  await assert.rejects(source.dispatch('agent.resume', { thread_id: 'other' }), { code: 'thread_busy_elsewhere' });
  assert.equal((await source.dispatch('agent.fork', { thread_id: 'other' })).thread.id, 'fork');
});

test('new conversations use a selected host project and reject arbitrary directories', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'panecast-projects-'));t.after(() => rm(directory, { recursive: true, force: true }));
  const calls = [];
  const peer = { closed: false, connect: async () => {}, onMessage() {}, close() {}, async call(method, p) { calls.push({ method, p }); return { thread: { id: 'new', cwd: p.cwd } }; } };
  const source = new CodexSource({ id: 'codex', mode: 'attach', access: 'control', projects: [{ name: 'Test', cwd: directory }] }, () => {}, () => peer);
  const { projects } = await source.dispatch('agent.projects'); assert.equal(projects.length, 1);
  await assert.rejects(source.dispatch('agent.create', { project_id: '/etc' }), { code: 'invalid_project' });
  const result = await source.dispatch('agent.create', { project_id: projects[0].id, name: '手机新对话' });
  assert.equal(result.thread.live, true); assert.equal(result.thread.name, '手机新对话');
  assert.equal(calls[0].p.cwd, projects[0].cwd);
});

test('mobile history can request larger bounded pages while old clients keep the default', async () => {
  const limits = [];
  const peer = { closed: false, connect: async () => {}, onMessage() {}, close() {}, async call(method, p) {
    if (method === 'thread/read') return { thread: { id: p.threadId } };
    if (method === 'thread/loaded/list') return { data: [] };
    if (method === 'thread/turns/list') { limits.push(p.limit); return { data: [], nextCursor: null }; }
    throw new Error('unexpected '+method);
  } };
  const source = new CodexSource({ id: 'codex', mode: 'attach', access: 'read' }, () => {}, () => peer);
  for (const limit of [undefined, 10, 10000, -1]) await source.dispatch('agent.read', { thread_id: 'history', ...(limit === undefined ? {} : { limit }) });
  assert.deepEqual(limits, [5, 10, 20, 1]); source.close();
});
