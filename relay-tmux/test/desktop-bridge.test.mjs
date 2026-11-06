import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import http from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { bridgeArguments, isDesktopParent } from '../src/hub/desktop-bridge.mjs';
import { desktopIsRunning } from '../src/hub/desktop-setup.mjs';
import { RpcPeer } from '../src/hub/rpc.mjs';
import { CodexSource } from '../src/hub/codex.mjs';

test('desktop bridge preserves configuration and leaves non-server CLI commands untouched', () => {
  assert.deepEqual(bridgeArguments(['-c', 'model="example"', 'app-server', '--listen', 'stdio://', '--analytics-default-enabled'], '/tmp/test.sock'),
    ['-c', 'model="example"', 'app-server', '--analytics-default-enabled', '--listen', 'unix:///tmp/test.sock']);
  assert.deepEqual(bridgeArguments(['app-server', '--stdio'], '/tmp/test.sock'), ['app-server', '--listen', 'unix:///tmp/test.sock']);
  assert.equal(bridgeArguments(['--version'], '/tmp/test.sock'), null);
  assert.equal(bridgeArguments(['app-server', 'proxy', '--sock', '/tmp/other.sock'], '/tmp/test.sock'), null);
  assert.equal(bridgeArguments(['app-server', '--print-startup-config'], '/tmp/test.sock'), null);
});

test('desktop handoff waits for the application, not helpers or commands which mention its path', () => {
  const app = '/Applications/ChatGPT.app/Contents/MacOS/ChatGPT';
  assert.equal(desktopIsRunning(`  ${app}\n`, app), true);
  assert.equal(desktopIsRunning(`${app} --some-flag\n`, app), true);
  assert.equal(desktopIsRunning(`${app} Helper\n`, app), true);
  assert.equal(desktopIsRunning(`/bin/zsh -c ${app}\n/Applications/ChatGPT.app/Contents/Frameworks/Helper`, app), false);
});

test('nested Codex processes cannot take over the desktop bridge endpoint', () => {
  const app = '/Applications/ChatGPT.app/Contents/MacOS/ChatGPT';
  assert.equal(isDesktopParent(app, app), true);
  assert.equal(isDesktopParent('/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node_repl', app), false);
  assert.equal(isDesktopParent('/bin/zsh -c '+app, app), false);
  assert.equal(isDesktopParent(app, undefined), false);
});

// Opt in with a real Codex executable. The model provider is a local test server;
// no account, production thread, OpenAI request, or command execution is involved.
test('desktop and phone share one real running Codex turn: steer and interrupt', { skip: !process.env.PANECAST_TEST_CODEX, timeout: 30_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'pcx-'));
  const socket = join(directory, 'codex.sock');
  const codexHome = join(directory, 'home'); await mkdir(codexHome);
  let requests = 0;
  const modelRequests = [], modelResponses = [];
  const responses = new Set();
  const provider = http.createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => { if (request.url?.endsWith('/responses')) modelRequests.push(JSON.parse(body)); });
    if (!request.url?.endsWith('/responses')) { response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"data":[]}'); return; }
    requests++;
    modelResponses.push(response);
    responses.add(response); response.on('close', () => responses.delete(response));
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const event = { type: 'response.created', response: { id: `response-${requests}`, object: 'response', status: 'in_progress', output: [] } };
    response.write(`event: response.created\ndata: ${JSON.stringify(event)}\n\n`);
  });
  provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
  t.after(async () => { for (const response of responses) response.destroy(); provider.closeAllConnections(); await new Promise((res) => provider.close(res)); await rm(directory, { recursive: true, force: true }); });
  const executable = process.env.PANECAST_TEST_CODEX;
  const desktop = new RpcPeer({ command: process.execPath, args: [resolve('src/hub/desktop-bridge.mjs'), 'app-server',
    '-c', 'model_provider="panecast_test"', '-c', 'model="panecast-test"',
    '-c', 'model_providers.panecast_test.name="Panecast test"',
    '-c', `model_providers.panecast_test.base_url="http://127.0.0.1:${provider.address().port}/v1"`,
    '-c', 'model_providers.panecast_test.wire_api="responses"',
    '-c', 'model_providers.panecast_test.requires_openai_auth=false',
    '-c', 'model_providers.panecast_test.supports_websockets=false'],
    env: { PANECAST_CODEX_EXECUTABLE: executable, PANECAST_CODEX_SOCKET: socket, PANECAST_BRIDGE_TEST_OWNER: '1', CODEX_HOME: codexHome }, codex: true });
  const events = []; desktop.onMessage((message) => events.push(message));
  t.after(async () => { desktop.close(); for (let i = 0; i < 60 && desktop.child?.exitCode === null && desktop.child?.signalCode === null; i++) await delay(50); });
  const connecting = desktop.connect();
  let diagnostic = ''; desktop.child.stderr.on('data', (chunk) => { diagnostic += chunk.toString(); });
  try { await connecting; } catch (error) { t.diagnostic(diagnostic.slice(-6000)); throw error; }
  const { thread } = await desktop.call('thread/start', { cwd: directory });
  const phone = new CodexSource({ id: 'phone', executable, socket, mode: 'attach', access: 'control', codex_home: codexHome, cwd: directory }, () => {});
  t.after(() => phone.close());
  const { turn } = await desktop.call('turn/start', { threadId: thread.id, input: [{ type: 'text', text: 'Wait for the local test response.' }] });
  for (let i = 0; i < 100 && requests === 0; i++) await delay(50);
  assert.ok(requests > 0, 'the desktop has an active turn in the local provider');
  await phone.dispatch('agent.subscribe', { thread_id: thread.id });
  const steered = await phone.dispatch('agent.steer', { thread_id: thread.id, turn_id: turn.id, text: 'Continue waiting for this test.', client_message_id: 'pc-steer-test' });
  assert.equal(steered.turnId, turn.id);
  assert.equal(steered.delivery.client_message_id, 'pc-steer-test');
  const firstResponse = modelResponses[0];
  if (!firstResponse.destroyed) {
    const message = { id: 'initial-answer', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'First step finished.', annotations: [] }] };
    for (const event of [
      { type: 'response.output_item.done', output_index: 0, item: message },
      { type: 'response.completed', response: { id: 'response-1', object: 'response', status: 'completed', output: [message], usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } },
    ]) firstResponse.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    firstResponse.end();
  }
  for (let i = 0; i < 100 && modelRequests.length < 2; i++) await delay(50);
  assert.ok(modelRequests.length >= 2, 'Codex starts another model step after accepting the steering input');
  assert.ok(JSON.stringify(modelRequests.at(-1).input).includes('Continue waiting for this test.'), 'the model actually receives the appended user instruction');
  const history = await phone.dispatch('agent.read', { thread_id: thread.id });
  assert.ok(history.turns.some((t) => t.items.some((item) => item.clientId === 'pc-steer-test' && item.type === 'userMessage' && item.content.some((part) => part.text.includes('Continue waiting for this test.')))), 'the appended instruction is recorded with its client message ID in the same conversation');
  assert.equal(history.active_turn_id, turn.id);
  await phone.dispatch('agent.interrupt', { thread_id: thread.id, turn_id: turn.id });
  for (let i = 0; i < 100 && !events.some((m) => m.method === 'turn/completed' && m.params.turn.id === turn.id); i++) await delay(50);
  const completed = events.find((m) => m.method === 'turn/completed' && m.params.turn.id === turn.id);
  assert.equal(completed?.params.turn.status, 'interrupted');
  const following = await phone.dispatch('agent.steer', { thread_id: thread.id, turn_id: turn.id, text: 'Continue after the earlier turn ended.', client_message_id: 'pc-finished-turn' });
  assert.equal(following.delivery.mode, 'start'); assert.notEqual(following.turn.id, turn.id);
  for (let i = 0; i < 100 && modelRequests.length < 3; i++) await delay(50);
  assert.ok(modelRequests.length >= 3);
  await phone.dispatch('agent.interrupt', { thread_id: thread.id, turn_id: following.turn.id });
  const created = await phone.dispatch('agent.create', { name: '手机新建对话' });
  assert.equal(created.thread.name, '手机新建对话');
  assert.equal((await phone.dispatch('agent.subscribe', { thread_id: created.thread.id })).thread.live, true);
  assert.deepEqual((await phone.dispatch('agent.read', { thread_id: created.thread.id })).turns, []);
});
