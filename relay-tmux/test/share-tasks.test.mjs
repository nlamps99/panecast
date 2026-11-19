import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocketServer } from 'ws';
import { createHub } from '../src/hub/server.mjs';
import { ShareStore, shareCommand } from '../src/hub/share.mjs';
import { ShareTasks, agentCommand, agyHooks, readHookEvents, surfaceFileName, taskAgent, taskAttachment, taskEventsDirectory, taskHookCommand, taskPrompt, taskWindowSettings, withTaskHooks, ENV_HOOK_COMMAND } from '../src/hub/share-tasks.mjs';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

/** A share made with --full --tasks, a stand-in cmux and hook files the test writes as Claude would. */
async function fixture(t, { surfaces = ['S-1'] } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'panecast-tasks-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = { state_directory: join(root, 'state') };
  const directory = join(root, 'shared');
  await mkdir(directory, { recursive: true });
  const share = { id: 'st1', name: '任务', directory, source_id: 'cmux', workspace_id: 'W-1', surface_id: 'S-1', session_id: 'x', terminals: [{ surface_id: 'S-1', session_id: 'x', created_at: '' }],
    created_at: '', revoked_at: null, prompt_hook: false, full: true, tasks: true, guests: [{ device_id: 'guest-a', label: '', created_at: '', revoked_at: null }] };
  const shares = new ShareStore(join(config.state_directory, 'shares', 'shares.json'));
  await shares.write([share]);
  const live = new Set(surfaces), calls = [], screens = {};
  let created = 0, clock = Date.parse('2026-11-18T10:00:00Z');
  const cmux = {
    async call(method, params) {
      calls.push({ method, params });
      if (method === 'surface.list') return { surfaces: [...live].map((id) => ({ id, type: 'terminal' })) };
      if (method === 'surface.create') { const id = `S-NEW-${++created}`; live.add(id); return { surface_id: id }; }
      if (method === 'surface.read_text') return { text: screens[params.surface_id] ?? '' };
      return {};
    },
  };
  const make = () => new ShareTasks({ config, shares, client: () => cmux, now: () => clock, pollMs: 60_000, settleMs: 0,
    laneCommand: async (agent) => `/bin/zsh -lc '${agent} for tasks'`,
    shareTerminalCommand: async (_config, entry, sessionId) => `/bin/zsh -lc 'claude --session-id ${sessionId}'` });
  const hook = (surface, event) => appendFile(join(taskEventsDirectory(config, share), `${surfaceFileName(surface)}.jsonl`), JSON.stringify(event) + '\n');
  await mkdir(taskEventsDirectory(config, share), { recursive: true });
  const fx = {
    root, config, share, shares, live, calls, screens, make, hook, tasks: make(),
    advance(ms) { clock += ms; },
    pastes: () => calls.filter((c) => c.method === 'terminal.paste'),
    async current() { return (await shares.read())[0]; },
  };
  return fx;
}

const start = (fx, surface = 'S-1', session = 'sess-1') => fx.hook(surface, { hook_event_name: 'SessionStart', session_id: session, transcript_path: join(fx.root, `${session}.jsonl`), source: 'startup' });
const submitted = (fx, prompt, promptId, surface = 'S-1') => fx.hook(surface, { hook_event_name: 'UserPromptSubmit', session_id: 'sess-1', transcript_path: join(fx.root, 'sess-1.jsonl'), prompt_id: promptId, prompt });
const stopped = (fx, promptId, message, surface = 'S-1') => fx.hook(surface, { hook_event_name: 'Stop', session_id: 'sess-1', prompt_id: promptId, last_assistant_message: message });
/** What /clear does in the window: the session ends and a new one starts. */
const cleared = async (fx, session = 'sess-2', surface = 'S-1') => {
  await fx.hook(surface, { hook_event_name: 'SessionEnd', session_id: 'sess-1', reason: 'clear' });
  await fx.hook(surface, { hook_event_name: 'SessionStart', session_id: session, transcript_path: join(fx.root, `${session}.jsonl`), source: 'clear' });
};
const clears = (fx) => fx.calls.filter((c) => c.method === 'surface.send_text' && c.params.text === '/clear').length;

test('the hook appends what Claude passes to the file of its own terminal and prints nothing', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'panecast-task-hook-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const events = join(directory, "it's events");
  const run = async (input, env) => {
    const child = spawn('/bin/sh', ['-c', taskHookCommand(events)], { env: { PATH: '/usr/bin:/bin', ...env } });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stdin.end(input);
    const [code] = await once(child, 'exit');
    return { code, output };
  };
  assert.deepEqual(await run('{"hook_event_name":"SessionStart","session_id":"a"}', { CMUX_SURFACE_ID: 'AB12-CD' }), { code: 0, output: '' });
  assert.deepEqual(await run('{"hook_event_name":"Stop","prompt_id":"p","last_assistant_message":"好的\\n两行"}\n', { CMUX_SURFACE_ID: 'AB12-CD' }), { code: 0, output: '' });
  await run('{"hook_event_name":"SessionStart","session_id":"b"}', {});
  const read = await readHookEvents(join(events, `${surfaceFileName('AB12-CD')}.jsonl`));
  assert.deepEqual(read.events.map((event) => event.hook_event_name), ['SessionStart', 'Stop']);
  assert.equal(read.events[1].last_assistant_message, '好的\n两行');
  assert.equal((await readHookEvents(join(events, 'unknown.jsonl'))).events[0].session_id, 'b');
  // A half-written line waits for the next read.
  await appendFile(join(events, 'ab12-cd.jsonl'), '{"hook_event_name":"Sto');
  const again = await readHookEvents(join(events, 'ab12-cd.jsonl'), read.offset);
  assert.deepEqual(again, { events: [], offset: read.offset });
});

test('a task share starts the owner\'s Claude with the hooks and without questions it cannot ask', () => {
  const command = shareCommand('/bin/claude', '/state/s.json', { full: true, tasks: true, sessionId: 'abc' });
  assert.ok(command.includes("--dangerously-skip-permissions --settings '/state/s.json' --disallowedTools=AskUserQuestion"), command);
  assert.ok(!shareCommand('/bin/claude', '/state/s.json', { full: true }).includes('--settings'));
  const settings = withTaskHooks(withTaskHooks({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'mine' }] }] } }, '/e'), '/e');
  assert.deepEqual(Object.keys(settings.hooks).sort(), ['SessionEnd', 'SessionStart', 'Stop', 'UserPromptSubmit']);
  assert.equal(settings.hooks.Stop.length, 2, 'the owner\'s hook stays and ours is there once');
  assert.equal(settings.hooks.Stop[0].hooks[0].command, 'mine');
  // Nothing a task asks Claude to remember reaches the next task through its memory files.
  const window = taskWindowSettings('/e');
  assert.equal(window.autoMemoryEnabled, false);
  assert.deepEqual(window.hooks, withTaskHooks({}, '/e').hooks);
});

test('attachments come as base64 or data URLs', () => {
  assert.deepEqual(taskAttachment({ data: `data:image/png;base64,${PNG}` }, 0).name, '1.png');
  assert.equal(taskAttachment({ name: 'a.jpg', data_base64: PNG }, 0).data.length, Buffer.from(PNG, 'base64').length);
  assert.throws(() => taskAttachment({ name: 'x', data_base64: '%%%' }, 0), { code: 'invalid_params' });
  assert.throws(() => taskAttachment('x', 0), { code: 'invalid_params' });
  assert.match(taskPrompt({ id: 't0123456789', text: '看图', attachments: ['tasks/t0123456789/a.png'] }), /^【任务 t0123456789】\n看图\n\n附件.*\n- \.\/tasks\/t0123456789\/a\.png\n/);
});

test('tasks go into the window one at a time, each when Claude is idle, and come back with its last message', async (t) => {
  const fx = await fixture(t);
  const first = await fx.tasks.submit(fx.share, { text: '把图里的字抄下来', attachments: [{ name: '图.png', data_base64: PNG }] });
  assert.equal(first.status, 'queued');
  assert.equal(first.position, 1);
  assert.deepEqual(first.attachments, [`tasks/${first.id}/图.png`]);
  assert.deepEqual(await readFile(join(fx.share.directory, 'tasks', first.id, '图.png')), Buffer.from(PNG, 'base64'));
  const second = await fx.tasks.submit(fx.share, { text: '第二个任务' });
  assert.equal(second.position, 2);

  // Claude has not reported its start yet: nothing is typed.
  await fx.tasks.tick();
  assert.equal(fx.pastes().length, 0);
  await start(fx);
  await fx.tasks.tick();
  assert.equal(fx.pastes().length, 1);
  const paste = fx.pastes()[0].params;
  assert.deepEqual({ ...paste, text: undefined }, { workspace_id: 'W-1', surface_id: 'S-1', text: undefined });
  // Enter goes as its own key after the paste (Claude drops one that comes with a multi-line paste).
  assert.deepEqual(fx.calls.slice(-1).map((c) => [c.method, c.params.key]), [['surface.send_key', 'enter']]);
  assert.ok(paste.text.startsWith(`【任务 ${first.id}】\n把图里的字抄下来`));
  assert.ok(paste.text.includes(`./tasks/${first.id}/图.png`));
  assert.equal((await fx.tasks.get(fx.share, first.id)).status, 'sending');

  // As Claude hands it to the hook: the paste wrapped in tags.
  await submitted(fx, `\n\n<pasted_content id="ab12">\n${paste.text}\n</pasted_content>`, 'p1');
  await fx.tasks.tick();
  assert.equal((await fx.tasks.get(fx.share, first.id)).status, 'running');
  await fx.tasks.tick();
  assert.equal(fx.pastes().length, 1, 'the second task waits while the first runs');

  // Claude leaves a file and ends its turn.
  await mkdir(join(fx.share.directory, 'tasks', first.id, 'out'), { recursive: true });
  await writeFile(join(fx.share.directory, 'tasks', first.id, 'out', '结果.txt'), '你好');
  const waiting = fx.tasks.get(fx.share, first.id, 30);
  await stopped(fx, 'p1', '图里写的是：你好');
  await fx.tasks.tick();
  const done = await waiting;
  assert.equal(done.status, 'done');
  assert.equal(done.result, '图里写的是：你好');
  assert.deepEqual(done.files, [{ path: `tasks/${first.id}/out/结果.txt`, size: 6 }]);
  assert.equal(done.prompt_id, undefined, 'internal fields stay inside');

  // The next task starts from an empty conversation: /clear first (the first task went into a fresh
  // window without one), the task once the new session starts.
  assert.equal(clears(fx), 1);
  assert.deepEqual(fx.calls.slice(-2).map((c) => [c.method, c.params.text ?? c.params.key]), [['surface.send_text', '/clear'], ['surface.send_key', 'enter']]);
  assert.equal(fx.pastes().length, 1);
  await fx.tasks.tick();
  assert.equal(clears(fx), 1, '/clear is typed once');
  await cleared(fx);
  await fx.tasks.tick();
  assert.equal(fx.pastes().length, 2);
  assert.ok(fx.pastes()[1].params.text.startsWith(`【任务 ${second.id}】\n第二个任务`));
  const listed = await fx.tasks.list(fx.share);
  assert.deepEqual(listed.map((task) => [task.id, task.status]), [[second.id, 'sending'], [first.id, 'done']]);
});

test('the owner\'s own prompt in the window holds the queue until its turn ends', async (t) => {
  const fx = await fixture(t);
  await start(fx);
  await submitted(fx, '我自己问一句', 'owner-1');
  const task = await fx.tasks.submit(fx.share, { text: '排队的任务' });
  await fx.tasks.tick();
  assert.equal(fx.pastes().length, 0);
  await stopped(fx, 'owner-1', '回答了主人');
  await fx.tasks.tick();
  assert.equal(clears(fx), 1, 'the owner\'s conversation is cleared before the task');
  await cleared(fx);
  await fx.tasks.tick();
  assert.equal(fx.pastes().length, 1);
  assert.equal((await fx.tasks.get(fx.share, task.id)).status, 'sending');
});

test('a task interrupted with Esc fails with what Claude wrote, and the queue goes on', async (t) => {
  const fx = await fixture(t);
  await start(fx);
  const task = await fx.tasks.submit(fx.share, { text: '长任务' });
  const next = await fx.tasks.submit(fx.share, { text: '下一个' });
  await fx.tasks.tick();
  await submitted(fx, fx.pastes()[0].params.text, 'p1');
  await fx.tasks.tick();
  await writeFile(join(fx.root, 'sess-1.jsonl'), [
    { type: 'user', promptId: 'p1', message: { role: 'user', content: '【任务】长任务' } },
    { type: 'assistant', promptId: 'p1', message: { role: 'assistant', content: [{ type: 'text', text: '先看看目录' }] } },
    { type: 'user', promptId: 'p1', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } },
  ].map((entry) => JSON.stringify(entry)).join('\n') + '\n');
  fx.advance(4000);
  await fx.tasks.tick();
  const failed = await fx.tasks.get(fx.share, task.id);
  assert.deepEqual([failed.status, failed.result], ['failed', '先看看目录']);
  await cleared(fx);
  await fx.tasks.tick();
  assert.equal((await fx.tasks.get(fx.share, next.id)).status, 'sending');
});

test('a paste Claude never takes is reported, not sent again, and a late start still counts', async (t) => {
  const fx = await fixture(t);
  await start(fx);
  const task = await fx.tasks.submit(fx.share, { text: '没送进去' });
  await fx.tasks.tick();
  const enters = () => fx.calls.filter((c) => c.method === 'surface.send_key' && c.params.key === 'enter').length;
  assert.equal(enters(), 1);
  fx.advance(11_000);
  await fx.tasks.tick();
  assert.equal(enters(), 2, 'Enter is pressed again, the text is not pasted again');
  fx.advance(15_000);
  await fx.tasks.tick();
  fx.advance(15_000);
  await fx.tasks.tick();
  assert.equal(enters(), 3);
  fx.advance(31_000);
  await fx.tasks.tick();
  const failed = await fx.tasks.get(fx.share, task.id);
  assert.equal(failed.status, 'failed');
  assert.match(failed.error, /没有开始处理/);
  assert.equal(fx.pastes().length, 1);
  await submitted(fx, fx.pastes()[0].params.text, 'late');
  await fx.tasks.tick();
  assert.equal((await fx.tasks.get(fx.share, task.id)).status, 'running');
  await stopped(fx, 'late', '还是做完了');
  await fx.tasks.tick();
  assert.equal((await fx.tasks.get(fx.share, task.id)).status, 'done');
});

test('canceling takes a task out of the queue, or interrupts it in the window', async (t) => {
  const fx = await fixture(t);
  await start(fx);
  const running = await fx.tasks.submit(fx.share, { text: '一' });
  const queued = await fx.tasks.submit(fx.share, { text: '二' });
  await fx.tasks.tick();
  await submitted(fx, fx.pastes()[0].params.text, 'p1');
  await fx.tasks.tick();
  assert.equal((await fx.tasks.cancel(fx.share, queued.id)).status, 'canceled');
  assert.equal((await fx.tasks.cancel(fx.share, running.id)).status, 'canceled');
  assert.deepEqual(fx.calls.filter((c) => c.method === 'surface.send_key' && c.params.key !== 'enter').map((c) => [c.params.surface_id, c.params.key]), [['S-1', 'escape']]);
  await assert.rejects(fx.tasks.cancel(fx.share, 'tffffffffff'), { code: 'task_not_found' });
});

test('a closed task window is opened again in the share\'s workspace when a task arrives', async (t) => {
  const fx = await fixture(t, { surfaces: [] });
  const task = await fx.tasks.submit(fx.share, { text: '窗口关了也要做' });
  await fx.tasks.tick();
  const create = fx.calls.find((c) => c.method === 'surface.create');
  assert.deepEqual({ ...create.params, initial_command: undefined }, { workspace_id: 'W-1', type: 'terminal', cwd: fx.share.directory, focus: false, initial_command: undefined });
  const share = await fx.current();
  assert.equal(share.surface_id, 'S-NEW-1');
  assert.ok(create.params.initial_command.includes(share.session_id));
  assert.deepEqual(share.terminals.map((terminal) => terminal.surface_id), ['S-NEW-1']);
  // Typed only once the new Claude reports its start.
  await fx.tasks.tick();
  assert.equal(fx.pastes().length, 0);
  await start(fx, 'S-NEW-1', 'sess-2');
  await fx.tasks.tick();
  assert.deepEqual(fx.pastes().map((c) => c.params.surface_id), ['S-NEW-1']);
  assert.equal((await fx.tasks.get(fx.share, task.id)).status, 'sending');
});

test('a restarted gateway picks up its tasks from the record and the hook file', async (t) => {
  const fx = await fixture(t);
  await start(fx);
  const task = await fx.tasks.submit(fx.share, { text: '跨重启' });
  await fx.tasks.tick();
  await submitted(fx, fx.pastes()[0].params.text, 'p1');
  await fx.tasks.tick();
  fx.tasks.close();
  await stopped(fx, 'p1', '重启后也拿到了');
  const restarted = fx.make();
  await restarted.tick();
  const done = await restarted.get(fx.share, task.id);
  assert.deepEqual([done.status, done.result], ['done', '重启后也拿到了']);
});

test('the guest key of a task share submits, waits for and lists tasks; other shares refuse them', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'panecast-task-hub-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(server, 'listening');
  t.after(async () => { for (const ws of server.clients) ws.terminate(); await new Promise((resolve) => server.close(resolve)); });
  const frames = []; let tunnel;
  server.on('connection', (ws) => { tunnel = ws; ws.on('message', (raw) => frames.push(JSON.parse(raw))); });
  const calls = [];
  const stub = { submit: async (share, p) => { calls.push(['submit', share.id, p.text]); return { id: 't1', status: 'queued' }; }, get: async (share, id, wait) => { calls.push(['get', id, wait]); return { id, status: 'done', result: 'ok' }; },
    list: async () => [{ id: 't1' }], cancel: async (share, id) => ({ id, status: 'canceled' }), start() {}, close() {} };
  const share = { id: 'st1', name: '任务', directory: root, source_id: 'cmux', workspace_id: 'W', surface_id: 'S', created_at: '', revoked_at: null, full: true, tasks: true,
    guests: [{ device_id: 'guest-a', label: '', created_at: '', revoked_at: null }] };
  const plain = { ...share, id: 'sp', tasks: undefined, guests: [{ device_id: 'guest-b', label: '', created_at: '', revoked_at: null }] };
  await new ShareStore(join(root, 'state', 'shares', 'shares.json')).write([share, plain]);
  const hub = await createHub({ state_directory: join(root, 'state'), port: 0, broker: { url: `http://127.0.0.1:${server.address().port}`, relay_id: 'home', relay_token: 'secret' },
    sources: [{ id: 'cmux', type: 'cmux', name: 'cmux', enabled: true, access: 'control', url: 'ws://127.0.0.1:9', token: 'upstream', device_id: 'hub' }] }, { tasks: stub });
  await hub.start(); t.after(() => hub.close());
  for (let i = 0; i < 300 && !tunnel; i++) await delay(10);
  let next = 0;
  const call = async (session, method, params = {}) => {
    const id = `r${++next}`;
    tunnel.send(JSON.stringify({ type: 'session.text', session_id: session, text: JSON.stringify({ id, method, params }) }));
    for (let i = 0; i < 300; i++) {
      const reply = frames.filter((f) => f.session_id === session && f.type === 'session.text').map((f) => JSON.parse(f.text)).find((m) => m.id === id);
      if (reply) { if (!reply.ok) throw Object.assign(new Error(reply.error.message), { code: reply.error.code }); return reply.result; }
      await delay(10);
    }
    throw new Error(`no reply to ${method}`);
  };
  for (const [session, device, shareId] of [['g', 'guest-a', 'st1'], ['p', 'guest-b', 'sp']]) {
    tunnel.send(JSON.stringify({ type: 'session.open', session_id: session, device_id: device, guest: { share_id: shareId } }));
    tunnel.send(JSON.stringify({ type: 'session.text', session_id: session, text: JSON.stringify({ deviceId: device, protocolVersion: 1, appVersion: 'test' }) }));
  }
  assert.equal((await call('g', 'relay.info')).share.tasks, true);
  assert.deepEqual(await call('g', 'task.submit', { text: '做点事' }), { task: { id: 't1', status: 'queued' } });
  assert.deepEqual(await call('g', 'task.get', { task_id: 't1', wait_s: 5 }), { task: { id: 't1', status: 'done', result: 'ok' } });
  assert.deepEqual(await call('g', 'task.list', {}), { tasks: [{ id: 't1' }] });
  await assert.rejects(call('g', 'task.get', {}), { code: 'invalid_params' });
  assert.equal((await call('p', 'relay.info')).share.tasks, undefined);
  await assert.rejects(call('p', 'task.submit', { text: 'x' }), { code: 'tasks_disabled' });
  assert.deepEqual(calls, [['submit', 'st1', '做点事'], ['get', 't1', 5]]);
});

test('a task that continues goes on in the previous conversation without a clear', async (t) => {
  const fx = await fixture(t);
  await start(fx);
  const first = await fx.tasks.submit(fx.share, { text: '先分析' });
  const second = await fx.tasks.submit(fx.share, { text: '按分析结果改', continue: true });
  assert.equal(second.continue, true);
  await fx.tasks.tick();
  await submitted(fx, fx.pastes()[0].params.text, 'p1');
  await stopped(fx, 'p1', '分析完了');
  await fx.tasks.tick();
  await fx.tasks.tick();
  assert.equal(clears(fx), 0);
  assert.equal(fx.pastes().length, 2);
  assert.equal((await fx.tasks.get(fx.share, first.id)).status, 'done');
});

test('a clear Claude does not take gets one more Enter, then fails the task without pasting it', async (t) => {
  const fx = await fixture(t);
  await start(fx);
  await submitted(fx, '主人的问题', 'owner');
  await stopped(fx, 'owner', '答');
  const task = await fx.tasks.submit(fx.share, { text: '任务' });
  await fx.tasks.tick();
  const enters = () => fx.calls.filter((c) => c.method === 'surface.send_key' && c.params.key === 'enter').length;
  assert.deepEqual([clears(fx), enters()], [1, 1]);
  fx.advance(11_000);
  await fx.tasks.tick();
  assert.deepEqual([clears(fx), enters()], [1, 2]);
  fx.advance(20_000);
  await fx.tasks.tick();
  const failed = await fx.tasks.get(fx.share, task.id);
  assert.equal(failed.status, 'failed');
  assert.match(failed.error, /清空/);
  assert.equal(fx.pastes().length, 0);
});

test('task folders are deleted some days after their task ends, and nothing else is', async (t) => {
  const fx = await fixture(t);
  const keep = await fx.tasks.submit(fx.share, { text: '还在排队', attachments: [{ name: 'a.png', data_base64: PNG }] });
  const tasks = join(fx.share.directory, 'tasks');
  const old = 't00000000aa', recent = 't00000000bb', unknown = 't00000000cc';
  for (const id of [old, recent, unknown, 'notes']) await mkdir(join(tasks, id, 'out'), { recursive: true });
  const outside = join(fx.root, 'outside');
  await mkdir(outside);
  await writeFile(join(outside, 'keep.txt'), 'x');
  await symlink(outside, join(tasks, 't00000000dd'));
  const day = 86_400_000, now = Date.parse('2026-11-18T10:00:00Z');
  const state = await fx.tasks.state(fx.share);
  state.tasks.push({ id: old, status: 'done', finished_at: new Date(now - 8 * day).toISOString(), files: [{ path: `tasks/${old}/out/a.txt`, size: 1 }] },
    { id: recent, status: 'done', finished_at: new Date(now - 2 * day).toISOString(), files: [] });
  const ancient = new Date(now - 30 * day);
  await utimes(join(tasks, unknown), ancient, ancient);
  state.cleanedAt = 0;
  await fx.tasks.tick();
  assert.deepEqual((await readdir(tasks)).sort(), [keep.id, 'notes', recent, 't00000000dd'].sort());
  assert.equal(await readFile(join(outside, 'keep.txt'), 'utf8'), 'x', 'a link is never followed');
  const cleaned = await fx.tasks.get(fx.share, old);
  assert.deepEqual(cleaned.files, []);
  assert.ok(cleaned.files_removed_at);
  // 0 keeps everything.
  const shares = await fx.shares.read();
  shares[0].task_keep_days = 0;
  await fx.shares.write(shares);
  state.tasks.find((task) => task.id === recent).finished_at = new Date(now - 100 * day).toISOString();
  state.cleanedAt = 0;
  await fx.tasks.tick();
  assert.ok((await readdir(tasks)).includes(recent));
});

const IDLE = { codex: '› Ask Codex to do anything\n  ? for shortcuts', agy: '>\n? for shortcuts' };
const pastesTo = (fx, surface) => fx.pastes().filter((c) => c.params.surface_id === surface);
const typed = (fx, surface, text) => fx.calls.filter((c) => c.method === 'surface.send_text' && c.params.surface_id === surface && c.params.text === text).length;

test('agents are claude, codex or agy, and the Codex and agy windows start with full access and the hooks', () => {
  assert.deepEqual([taskAgent(undefined), taskAgent('Codex'), taskAgent('antigravity'), taskAgent('agy')], ['claude', 'codex', 'agy', 'agy']);
  assert.throws(() => taskAgent('gpt'), { code: 'invalid_params' });
  const codex = agentCommand('codex', { binary: '/opt/homebrew/bin/codex', events: "/st/it's", directory: '/d' });
  assert.ok(codex.startsWith("exec /usr/bin/env PANECAST_TASK_EVENTS='/st/it'\\''s' '/opt/homebrew/bin/codex' --dangerously-bypass-approvals-and-sandbox --dangerously-bypass-hook-trust --disable memories -c check_for_update_on_startup=false -c 'hooks={SessionStart=[{hooks=[{type=\"command\""), codex);
  for (const event of ['UserPromptSubmit', 'Stop', 'SessionEnd', 'Interrupt']) assert.ok(codex.includes(`${event}=[{hooks=`), event);
  const agy = agentCommand('agy', { binary: '/u/agy', events: '/st/e', directory: '/share' });
  assert.equal(agy, `exec /usr/bin/env PANECAST_TASK_EVENTS='/st/e' '/u/agy' --dangerously-skip-permissions --settings '{"trustedWorkspaces":["/share"]}'`);
  assert.deepEqual(Object.keys(agyHooks().panecast), ['SessionStart', 'UserPromptSubmit', 'Stop', 'SessionEnd']);
});

test('the shared hook records only where a task window set its folder', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'panecast-env-hook-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const run = async (env) => {
    const child = spawn('/bin/sh', ['-c', ENV_HOOK_COMMAND], { env: { PATH: '/usr/bin:/bin', CMUX_SURFACE_ID: 'S-9', ...env } });
    child.stdin.end('{"hookEventName":"Stop","lastUserInput":"x"}');
    return (await once(child, 'exit'))[0];
  };
  assert.equal(await run({}), 0);
  assert.deepEqual(await readdir(directory), [], 'an ordinary agy session leaves nothing');
  assert.equal(await run({ PANECAST_TASK_EVENTS: join(directory, 'e') }), 0);
  const { events } = await readHookEvents(join(directory, 'e', 's-9.jsonl'));
  assert.deepEqual(events.map((event) => event.hookEventName), ['Stop']);
});

test('a Codex task opens a Codex window beside Claude\'s, and Codex tasks clear with /new on their own lane', async (t) => {
  const fx = await fixture(t);
  await start(fx);
  const first = await fx.tasks.submit(fx.share, { text: '用 Codex 做', agent: 'codex' });
  assert.equal(first.agent, 'codex');
  const claude = await fx.tasks.submit(fx.share, { text: 'Claude 同时做' });
  await fx.tasks.tick();
  const create = fx.calls.find((c) => c.method === 'surface.create');
  assert.deepEqual(create.params, { workspace_id: 'W-1', type: 'terminal', cwd: fx.share.directory, initial_command: "/bin/zsh -lc 'codex for tasks'", focus: false });
  const share = await fx.current();
  assert.deepEqual(share.task_windows.codex.surface_id, 'S-NEW-1');
  assert.deepEqual(share.terminals.map((terminal) => [terminal.surface_id, terminal.agent ?? 'claude']), [['S-1', 'claude'], ['S-NEW-1', 'codex']]);
  // Claude's task went in meanwhile: the agents work side by side.
  assert.deepEqual(fx.pastes().map((c) => c.params.surface_id), ['S-1']);
  assert.equal((await fx.tasks.get(fx.share, claude.id)).status, 'sending');
  // Codex has no session before its first prompt: its idle screen means ready.
  await fx.tasks.tick();
  assert.equal(pastesTo(fx, 'S-NEW-1').length, 0);
  fx.screens['S-NEW-1'] = IDLE.codex;
  await fx.tasks.tick();
  assert.equal(pastesTo(fx, 'S-NEW-1').length, 1);
  const text = pastesTo(fx, 'S-NEW-1')[0].params.text;
  await fx.hook('S-NEW-1', { hook_event_name: 'SessionStart', session_id: 'c1', transcript_path: '/x/rollout.jsonl', source: 'startup' });
  await fx.hook('S-NEW-1', { hook_event_name: 'UserPromptSubmit', session_id: 'c1', turn_id: 'turn-1', prompt: text });
  await fx.tasks.tick();
  assert.equal((await fx.tasks.get(fx.share, first.id)).status, 'running');
  const second = await fx.tasks.submit(fx.share, { text: '第二个 Codex 任务', agent: 'codex' });
  await fx.hook('S-NEW-1', { hook_event_name: 'Stop', session_id: 'c1', turn_id: 'turn-1', last_assistant_message: 'Codex 做完了' });
  fx.screens['S-NEW-1'] = `› ${text}\n• Codex 做完了\n${IDLE.codex}`;
  await fx.tasks.tick();
  const done = await fx.tasks.get(fx.share, first.id);
  assert.deepEqual([done.status, done.result], ['done', 'Codex 做完了']);
  assert.equal(typed(fx, 'S-NEW-1', '/new'), 1);
  // Still the old conversation on screen: not cleared yet.
  fx.advance(2000);
  await fx.tasks.tick();
  assert.equal(pastesTo(fx, 'S-NEW-1').length, 1);
  fx.screens['S-NEW-1'] = IDLE.codex;
  await fx.tasks.tick();
  await fx.tasks.tick();
  assert.equal(pastesTo(fx, 'S-NEW-1').length, 2);
  assert.equal((await fx.tasks.get(fx.share, second.id)).status, 'sending');
  // Esc in Codex: its Interrupt hook ends the turn.
  await fx.hook('S-NEW-1', { hook_event_name: 'UserPromptSubmit', session_id: 'c2', turn_id: 'turn-2', prompt: pastesTo(fx, 'S-NEW-1')[1].params.text });
  await fx.hook('S-NEW-1', { hook_event_name: 'Interrupt', session_id: 'c2', turn_id: 'turn-2' });
  await fx.tasks.tick();
  const interrupted = await fx.tasks.get(fx.share, second.id);
  assert.deepEqual([interrupted.status, interrupted.error], ['failed', '任务在窗口里被中断了']);
});

test('a clear waits until the Codex or agy turn has ended, and a /new Codex drops is typed again', async (t) => {
  const fx = await fixture(t);
  const first = await fx.tasks.submit(fx.share, { text: '第一个', agent: 'codex' });
  await fx.tasks.tick();
  fx.screens['S-NEW-1'] = IDLE.codex;
  await fx.tasks.tick();
  const text = pastesTo(fx, 'S-NEW-1')[0].params.text;
  await fx.hook('S-NEW-1', { hook_event_name: 'UserPromptSubmit', session_id: 'c1', turn_id: 'turn-1', prompt: text });
  await fx.tasks.tick();
  const second = await fx.tasks.submit(fx.share, { text: '第二个', agent: 'codex' });
  // Codex's Stop hook can come while its screen still shows the turn running ("? for shortcuts" too).
  await fx.hook('S-NEW-1', { hook_event_name: 'Stop', session_id: 'c1', turn_id: 'turn-1', last_assistant_message: '好了' });
  const old = `› ${text}\n• 好了\n`;
  fx.screens['S-NEW-1'] = `${old}• Working (5s • esc to interrupt)\n${IDLE.codex}`;
  await fx.tasks.tick();
  assert.equal((await fx.tasks.get(fx.share, first.id)).status, 'done');
  assert.equal(typed(fx, 'S-NEW-1', '/new'), 0, 'not typed while Codex is working');
  fx.screens['S-NEW-1'] = old + IDLE.codex;
  await fx.tasks.tick();
  assert.equal(typed(fx, 'S-NEW-1', '/new'), 1);
  // Codex dropped it anyway: typed once more, not just Enter on an empty prompt.
  fx.screens['S-NEW-1'] = `${old}■ '/new' is disabled while a task is in progress.\n${IDLE.codex}`;
  fx.advance(2000);
  await fx.tasks.tick();
  await fx.tasks.tick();
  assert.equal(typed(fx, 'S-NEW-1', '/new'), 2);
  fx.advance(2000);
  await fx.tasks.tick();
  assert.equal(typed(fx, 'S-NEW-1', '/new'), 2, 'the same refusal on screen is not counted twice');
  fx.screens['S-NEW-1'] = IDLE.codex;
  await fx.tasks.tick();
  await fx.tasks.tick();
  assert.equal(pastesTo(fx, 'S-NEW-1').length, 2);
  assert.equal((await fx.tasks.get(fx.share, second.id)).status, 'sending');

  // agy's /clear would cancel a running turn: it waits for "esc to cancel" to go.
  const agyTask = await fx.tasks.submit(fx.share, { text: 'agy 第一个', agent: 'agy' });
  await fx.tasks.tick();
  fx.screens['S-NEW-2'] = IDLE.agy;
  await fx.tasks.tick();
  const agyText = pastesTo(fx, 'S-NEW-2')[0].params.text;
  const agy = (event) => fx.hook('S-NEW-2', { conversationId: 'g1', transcriptPath: join(fx.root, 'g1.jsonl'), fullyIdle: true, ...event });
  await agy({ hookEventName: 'SessionStart', lastUserInput: agyText });
  await agy({ hookEventName: 'Stop', lastUserInput: agyText });
  await fx.tasks.tick();
  assert.equal((await fx.tasks.get(fx.share, agyTask.id)).status, 'done');
  await fx.tasks.submit(fx.share, { text: 'agy 第二个', agent: 'agy' });
  fx.screens['S-NEW-2'] = `> ${agyText}\n  Generating...\nesc to cancel`;
  await fx.tasks.tick();
  assert.equal(typed(fx, 'S-NEW-2', '/clear'), 0);
  fx.screens['S-NEW-2'] = `> ${agyText}\n${IDLE.agy}`;
  await fx.tasks.tick();
  assert.equal(typed(fx, 'S-NEW-2', '/clear'), 1);
});

test('agy tasks: the first prompt comes with SessionStart, later ones from the transcript, and the reply from the transcript', async (t) => {
  const fx = await fixture(t);
  const transcript = join(fx.root, 'agy-transcript.jsonl');
  const step = (index, type, content, status = 'DONE') => JSON.stringify({ step_index: index, source: type === 'USER_INPUT' ? 'USER_EXPLICIT' : 'MODEL', type, status, content });
  const first = await fx.tasks.submit(fx.share, { text: '用反重力做', agent: 'agy' });
  await fx.tasks.tick();
  fx.screens['S-NEW-1'] = IDLE.agy;
  await fx.tasks.tick();
  const text = pastesTo(fx, 'S-NEW-1')[0].params.text;
  const agy = (event) => fx.hook('S-NEW-1', { conversationId: 'g1', transcriptPath: transcript, fullyIdle: true, ...event });
  await agy({ hookEventName: 'SessionStart', lastUserInput: text });
  await fx.tasks.tick();
  assert.equal((await fx.tasks.get(fx.share, first.id)).status, 'running');
  // Stop carries no message; the transcript has it, a moment later.
  await agy({ hookEventName: 'Stop', lastUserInput: text, terminationReason: 'NO_TOOL_CALL' });
  await fx.tasks.tick();
  assert.equal((await fx.tasks.get(fx.share, first.id)).status, 'done');
  await writeFile(transcript, [step(0, 'USER_INPUT', `<USER_REQUEST>\n${text}\n</USER_REQUEST>`), step(1, 'PLANNER_RESPONSE', '', 'RUNNING'), step(1, 'PLANNER_RESPONSE', ''), step(2, 'GENERIC', 'ls'), step(3, 'PLANNER_RESPONSE', '反重力做完了')].join('\n') + '\n');
  await fx.tasks.tick();
  assert.equal((await fx.tasks.get(fx.share, first.id)).result, '反重力做完了');

  // A task that continues: agy reports no prompt after the session's first, so the transcript shows it arrived.
  const next = await fx.tasks.submit(fx.share, { text: '接着做', agent: 'agy', continue: true });
  await fx.tasks.tick();
  assert.equal(typed(fx, 'S-NEW-1', '/clear'), 0);
  const nextText = pastesTo(fx, 'S-NEW-1')[1].params.text;
  await appendFile(transcript, step(4, 'USER_INPUT', `<USER_REQUEST>\n${nextText}\n</USER_REQUEST>`) + '\n');
  fx.advance(4000);
  await fx.tasks.tick();
  assert.equal((await fx.tasks.get(fx.share, next.id)).status, 'running');
  // Esc in agy: nothing is reported; the screen says it.
  fx.screens['S-NEW-1'] = `> ${nextText}\n  ⎿  Interrupted · What should Antigravity CLI do instead?\n${IDLE.agy}`;
  fx.advance(4000);
  await fx.tasks.tick();
  const stopped = await fx.tasks.get(fx.share, next.id);
  assert.deepEqual([stopped.status, stopped.error], ['failed', '任务在窗口里被中断了']);
  // The next fresh task clears with /clear once the window is free.
  const third = await fx.tasks.submit(fx.share, { text: '新的', agent: 'agy' });
  await fx.tasks.tick();
  assert.equal(typed(fx, 'S-NEW-1', '/clear'), 1);
  fx.screens['S-NEW-1'] = IDLE.agy;
  fx.advance(2000);
  await fx.tasks.tick();
  await fx.tasks.tick();
  assert.equal(pastesTo(fx, 'S-NEW-1').length, 3);
  assert.equal((await fx.tasks.get(fx.share, third.id)).status, 'sending');
});

test('an agent whose window cannot open fails its task with the reason, and other agents go on', async (t) => {
  const fx = await fixture(t);
  fx.tasks.laneCommand = async () => { throw new Error('找不到 agy 命令，请先在这台电脑上安装 Antigravity CLI'); };
  const task = await fx.tasks.submit(fx.share, { text: 'x', agent: 'agy' });
  await fx.tasks.tick();
  const failed = await fx.tasks.get(fx.share, task.id);
  assert.equal(failed.status, 'failed');
  assert.match(failed.error, /Antigravity 任务窗口没能打开：找不到 agy 命令/);
});
