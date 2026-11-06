import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InboxJournal, inboxEvent } from '../src/inbox.mjs';
import { notificationAllowed, notificationPreferences } from '../src/notification-policy.mjs';
import { PushService } from '../src/push.mjs';
import { createTmuxRelay } from '../src/server.mjs';

async function directory(t) { const path = await mkdtemp(join(tmpdir(), 'panecast-inbox-')); t.after(() => rm(path, { recursive: true, force: true })); return path; }
const event = (id) => ({ type: 'event', category: 'notification', name: 'notification.created', payload: { id, workspace_id: 'w', title: `notification ${id}`, body: 'body', needs_input: true } });
test('journal persists cursor epochs and bounded replay snapshots across restart', async (t) => {
  const path = join(await directory(t), 'events.json');
  const first = new InboxJournal(path); await first.load();
  await first.append(event('one')); const snapshot = await first.page({ limit: 1 });
  await first.append(event('two')); await first.append(event('three'));
  const bounded = await first.page({ cursor: snapshot.next_cursor, until_cursor: snapshot.head_cursor });
  assert.equal(bounded.events.length, 0);
  const restored = new InboxJournal(path); await restored.load();
  const next = await restored.page({ cursor: snapshot.next_cursor, limit: 1 });
  assert.equal(next.events[0].payload.id, 'two'); assert.equal(next.has_more, true);
  const last = await restored.page({ cursor: next.next_cursor, until_cursor: next.head_cursor });
  assert.equal(last.events[0].payload.id, 'three'); assert.equal(last.has_more, false);
});
test('journal reports a retention gap and strips conversation streams', async (t) => {
  const journal = new InboxJournal(join(await directory(t), 'events.json'), { limit: 2 }); await journal.load();
  await journal.append(event('one')); const first = await journal.page({});
  await journal.append(event('two')); await journal.append(event('three')); await journal.append(event('four'));
  const result = await journal.page({ cursor: first.next_cursor }); assert.equal(result.reset, true); assert.equal(result.events.length, 2);
  assert.equal(await journal.append({ type: 'event', category: 'agent', name: 'item/agentMessage/delta', payload: { delta: 'SECRET command output' } }), null);
  assert.equal(inboxEvent({ type: 'event', category: 'agent', name: 'message', payload: { text: 'done' } }), null);
});
test('explicit Codex approval and resolution have stable request correlation', () => {
  const approval = inboxEvent({ type: 'event', category: 'agent', name: 'item/commandExecution/requestApproval', payload: { source_id: 'agent', threadId: 'thread', request_id: '42', turnId: 'turn', command: 'SECRET' } });
  assert.equal(approval.payload.id, 'request:agent:42'); assert.equal(approval.payload.needs_input, true);
  assert.equal(JSON.stringify(approval).includes('SECRET'), false);
  const resolution = inboxEvent({ type: 'event', category: 'agent', name: 'serverRequest/resolved', payload: { source_id: 'agent', requestId: '42', threadId: 'thread' } });
  assert.equal(resolution.payload.resolved, true);
});
test('notification policies honor project/needs-input filters and overnight selected-zone hours', () => {
  const preferences = notificationPreferences({ needs_input_only: true, muted_workspaces: ['muted'], quiet_hours: { enabled: true, start_minutes: 1320, end_minutes: 480, time_zone: 'America/Los_Angeles' } });
  assert.equal(notificationAllowed(preferences, { workspace_id: 'w', needs_input: true }, Date.parse('2026-11-04T07:00:00Z')), false);
  assert.equal(notificationAllowed(preferences, { workspace_id: 'w', needs_input: true }, Date.parse('2026-11-04T16:00:00Z')), true);
  assert.equal(notificationAllowed(preferences, { workspace_id: 'muted', needs_input: true }, Date.parse('2026-11-04T16:00:00Z')), false);
  assert.equal(notificationAllowed(preferences, { workspace_id: 'w', needs_input: false }, Date.parse('2026-11-04T16:00:00Z')), false);
});
test('push preferences are per device and repeated alerts are coalesced', async (t) => {
  const sent = [], now = Date.parse('2026-11-04T20:00:00Z');
  const service = new PushService({ path: join(await directory(t), 'push.json'), relayId: 'r', now: () => now,
    config: { key_path: 'test', key_id: 'test', team_id: 'test', topic: 'app', env: 'prod' }, send: async (_c, d) => { sent.push(d.token); return { status: 200 }; } });
  await service.receive({ type: 'push.sync', text: '["a","b"]' });
  for (const [id, token, muted] of [['a', 'aabb', ['w']], ['b', 'ccdd', []]]) {
    const result = await service.receive({ type: 'push.register', device_id: id, text: JSON.stringify({ apns_token: token, env: 'prod', preferences: { muted_workspaces: muted, dedupe_seconds: 60 } }) });
    assert.equal(result.preferences_applied, true);
  }
  await service.notify(event('one').payload); await service.notify(event('one').payload);
  assert.deepEqual(sent, ['ccdd']);
});

test('relay pushes questions and whole-turn completion once, with silent progress and replay', async (t) => {
  const path = await directory(t), sent = [];
  let now = 1000;
  const push = new PushService({ path: join(path, 'push.json'), relayId: 'r', now: () => now,
    config: { key_path: 'test', key_id: 'test', team_id: 'test', topic: 'app', env: 'prod' },
    send: async (_c, _d, notification) => { sent.push(notification); return { status: 200 }; } });
  const relay = await createTmuxRelay({ state_directory: path }, { push, backend: {} });
  t.after(() => relay.close());
  const renew = () => push.receive({ type: 'push.sync', text: '["phone"]' });
  await renew();
  await push.receive({ type: 'push.register', device_id: 'phone', text: JSON.stringify({ apns_token: 'aabb', env: 'prod' }) });
  await relay.notify({ id: 'noise', title: 'Working', status: 'running' });
  await relay.ingestEvent({ type: 'event', category: 'agent', name: 'item/completed', payload: { status: 'completed' } });
  await relay.notify({ id: 'ask', task_id: 't', needs_input: true, title: 'Task' });
  const completed = { type: 'event', category: 'agent', name: 'turn/completed', payload: { source_id: 's', threadId: 'th', turn: { id: 't', status: 'completed' } } };
  await relay.ingestEvent(completed);
  now += 61_000; await renew(); await relay.ingestEvent(completed);
  await relay.ingestEvent({ type: 'event', category: 'agent', name: 'serverRequest/resolved', payload: { requestId: 'r', threadId: 'th' } });
  await relay.ingestEvent({ ...completed, payload: { ...completed.payload, turn: { id: 'old', status: 'completed' } } }, { replay: true });
  assert.deepEqual(sent.map((n) => n.id), ['ask', 'task-event:s:th:t:completed']);
  assert.equal(sent[0].needs_input, true); assert.equal(sent[1].needs_input, false);
  assert.equal(sent[1].thread_id, 'th');
});

test('concurrent redelivery and duplicate registrations only push once with coalescing disabled', async (t) => {
  const path = await directory(t), sent = [];
  let finish;
  const pending = new Promise((resolve) => { finish = resolve; });
  const push = new PushService({ path: join(path, 'push.json'), relayId: 'r', config: { key_path: 'test', key_id: 'test', team_id: 'test', topic: 'app', env: 'prod' },
    send: async (_c, _d, notification) => { sent.push(notification); await pending; return { status: 200 }; } });
  await push.receive({ type: 'push.sync', text: '["first","second"]' });
  for (const id of ['first', 'second']) await push.receive({ type: 'push.register', device_id: id, text: JSON.stringify({ apns_token: 'aabb', env: 'prod', preferences: { dedupe_seconds: 0 } }) });
  const notification = { id: 'completion', status: 'completed' };
  const first = push.notify(notification), repeat = push.notify(notification);
  finish(); await Promise.all([first, repeat]); await push.notify(notification);
  assert.equal(sent.length, 1);
});
