import test from 'node:test';
import assert from 'node:assert/strict';
import { CodexSource } from '../src/hub/codex.mjs';
import { RpcError } from '../src/tmux.mjs';

function fixture(error) {
  const calls = [];
  const peer = { closed: false, connect: async () => {}, onMessage() {}, close() {}, async call(method, params) {
    calls.push({ method, params });
    if (method === 'thread/loaded/list') return { data: ['thread'] };
    if (method === 'thread/resume') return { thread: { id: 'thread' } };
    if (method === 'turn/steer') { if (error) throw error; return { turnId: 'active' }; }
    if (method === 'turn/start') return { turn: { id: 'next', status: 'inProgress', items: [] } };
    throw new Error(method);
  } };
  return { source: new CodexSource({ mode: 'attach', access: 'control' }, () => {}, () => peer), calls };
}

test('an ended-turn rejection starts the follow-up once and retains the message identity', async () => {
  const { source, calls } = fixture(new RpcError('-32600', 'no active turn to steer'));
  const result = await source.dispatch('agent.steer', { thread_id: 'thread', turn_id: 'ended', text: '请继续修复', client_message_id: 'message-id' });
  assert.equal(result.delivery.mode, 'start'); assert.equal(result.delivery.client_message_id, 'message-id');
  assert.equal(calls.filter((c) => c.method === 'turn/start').length, 1);
  assert.equal(calls.find((c) => c.method === 'turn/start').params.clientUserMessageId, 'message-id');
});

for (const [label, error, code] of [
  ['timeout', new RpcError('timeout', 'timed out'), 'timeout'],
  ['different active turn', new RpcError('-32600', 'expected active turn id old but found new'), 'turn_changed'],
  ['other invalid request', new RpcError('-32600', 'invalid input'), '-32600'],
]) test(`${label} never triggers an automatic duplicate input`, async () => {
  const { source, calls } = fixture(error);
  await assert.rejects(source.dispatch('agent.steer', { thread_id: 'thread', turn_id: 'old', text: '请继续修复' }), { code });
  assert.equal(calls.filter((c) => c.method === 'turn/steer').length, 1);
  assert.equal(calls.some((c) => c.method === 'turn/start'), false);
});
