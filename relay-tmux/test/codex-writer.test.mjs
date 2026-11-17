import test from 'node:test';
import assert from 'node:assert/strict';
import { CodexSource } from '../src/hub/codex.mjs';
import { RpcError } from '../src/tmux.mjs';

test('an idle original writer is reported without stealing its conversation', async () => {
  const calls = [];
  const peer = { closed: false, connect: async () => {}, onMessage() {}, close() {}, async call(method, params) {
    calls.push(method);
    if (method === 'thread/loaded/list') return { data: [] };
    if (method === 'thread/resume') throw new RpcError('-32600', 'thread saved already has an active writer');
    if (method === 'thread/read') return { thread: { id: params.threadId, status: { type: 'notLoaded' } } };
    if (method === 'thread/turns/list') return { data: [{ id: 'completed', status: 'completed', items: [] }], nextCursor: null };
    throw new Error(method);
  } };
  const target = { backend: 'cmux', workspaceId: 'workspace', surfaceId: 'surface' };
  const source = new CodexSource({ mode: 'attach', access: 'control' }, () => {}, () => peer, async () => ({ pid: 123, terminal: target }));
  await assert.rejects(source.dispatch('agent.resume', { thread_id: 'saved' }), (error) => error.code === 'thread_owned_elsewhere' && error.message.includes('原终端'));
  const read = await source.dispatch('agent.read', { thread_id: 'saved' });
  assert.equal(read.thread.writerState, 'other_process'); assert.deepEqual(read.thread.writerTarget, target);
  assert.equal(calls.filter((m) => m === 'thread/resume').length, 1);
  assert.equal(calls.includes('turn/start'), false); assert.equal(calls.includes('thread/archive'), false);
});

test('old inProgress history does not block recovery after the native writer has released it', async () => {
  const peer = { closed: false, connect: async () => {}, onMessage() {}, close() {}, async call(method, p) {
    if (method === 'thread/resume') return { thread: { id: p.threadId } };
    if (method === 'thread/loaded/list') return { data: [] };
    if (method === 'thread/turns/list') return { data: [{ status: 'inProgress' }] };
    throw new Error(method);
  } };
  const source = new CodexSource({ mode: 'attach', access: 'control' }, () => {}, () => peer);
  assert.equal((await source.dispatch('agent.resume', { thread_id: 'stale' })).thread.live, true);
});

test('an already subscribed conversation is reused without another resume', async () => {
  let resumes = 0;
  const peer = { closed: false, connect: async () => {}, onMessage() {}, close() {}, async call(method, p) {
    if (method === 'thread/loaded/list') return { data: ['live'] };
    if (method === 'thread/resume') { resumes++; return { thread: { id: p.threadId } }; }
    if (method === 'thread/read') return { thread: { id: p.threadId } };
    throw new Error(method);
  } };
  const source = new CodexSource({ mode: 'attach', access: 'control' }, () => {}, () => peer);
  await source.dispatch('agent.subscribe', { thread_id: 'live' });
  assert.equal((await source.dispatch('agent.resume', { thread_id: 'live' })).thread.live, true);
  assert.equal(resumes, 1);
});
