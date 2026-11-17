// A loopback computer for the phone's running indicators, completion alert and local cache.
// One terminal is idle, the other is in the middle of a Codex turn until GET /finish.
// GET /offline stops the relay so the broker reports the computer as offline.
import { createBrokerServer } from '../../../broker/src/server.mjs';
import { createTmuxRelay, RelaySession, inputItems, sendInputItems } from '../../../relay-tmux/src/server.mjs';
import { TerminalConversationReader } from '../../../relay-tmux/src/hub/terminal-conversation.mjs';
import { mkdtemp, mkdir, writeFile, appendFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';

const directory = await mkdtemp(join(tmpdir(), 'panecast-activity-ui-'));
const workspace = 'qa-activity-workspace', surfaces = ['qa-idle', 'qa-running'], titles = ['空闲终端', '运行中终端'];
const ids = ['33333333-3333-4333-8333-333333333333', '44444444-4444-4444-8444-444444444444'];
const reader = new TerminalConversationReader({ home: directory });
const files = ids.map(id => join(directory, '.codex/sessions', `${id}.jsonl`));
const line = value => JSON.stringify(value) + '\n';
const event = (index, payload) => ({ type: 'event_msg', payload: { thread_id: ids[index], ...payload } });
const item = (index, turn, type, id, text) => event(index, { type: 'item_completed', turn_id: turn, item: { type, id, content: [{ type: 'text', text }], phase: 'final' } });
await mkdir(join(directory, '.codex/sessions'), { recursive: true });
for (let index = 0; index < 2; index++) {
  const values = [{ type: 'session_meta', payload: { id: ids[index] } },
    event(index, { type: 'task_started', turn_id: 'turn-0' }),
    item(index, 'turn-0', 'UserMessage', 'question-0', `QUESTION_${index}`),
    item(index, 'turn-0', 'AgentMessage', 'answer-0', `ANSWER_${index}`),
    event(index, { type: 'task_complete', turn_id: 'turn-0' })];
  // The second terminal is still working on its next turn.
  if (index === 1) values.push(event(index, { type: 'task_started', turn_id: 'turn-1' }), item(index, 'turn-1', 'UserMessage', 'question-1', 'RUNNING_QUESTION'));
  await writeFile(files[index], values.map(line).join(''));
}
const reads = [];
class Session extends RelaySession {
  async dispatch(method, p) {
    // The client batches typing into surface.input; split it as the gateway does.
    if (method === 'surface.input') return sendInputItems(inputItems(p), { workspace_id: p.workspace_id, surface_id: p.surface_id }, (name, values) => this.dispatch(name, values));
    if (method === 'window.list') return { windows: [{ id: 'qa-window', key: true }] };
    if (method === 'workspace.list') return { workspaces: [{ id: workspace, title: '运行状态测试', selected: true }] };
    if (method === 'surface.list') return { surfaces: surfaces.map((id, i) => ({ id, title: titles[i], type: 'terminal', focused: i === 0 })) };
    if (method === 'surface.subscribe') {
      const rows = [`CACHED_SCREEN_${surfaces.indexOf(p.surface_id)}`, '$ ready'];
      this.send({ type: 'screen.full', surface_id: p.surface_id, rev: 1, rows, cols: 80, rowsCount: rows.length, cursor: { x: 0, y: 1 } });
      return {};
    }
    if (['surface.unsubscribe', 'surface.focus', 'workspace.select', 'terminal.replay'].includes(method)) return {};
    if (method === 'surface.history') return { rows: [], next_cursor: null };
    // The phone reads every terminal's activity in one batch, as the new gateway answers it.
    if (method === 'terminal.conversation.batch') {
      return { results: await Promise.all((p.requests ?? []).map(async (request) => {
        try { return { ok: true, result: await this.dispatch('terminal.conversation', request) }; }
        catch (error) { return { ok: false, error: { code: error.code ?? 'internal_error', message: error.message } }; }
      })) };
    }
    if (method === 'terminal.conversation') {
      const index = surfaces.indexOf(p.surface_id); if (p.workspace_id !== workspace || index < 0) throw new Error('wrong target');
      reads.push({ surface: p.surface_id, at: Date.now() });
      return await reader.read({ kind: 'codex', checkpoint_id: ids[index], execution_location: 'local' }, p);
    }
    return super.dispatch(method, p);
  }
}
const broker = await createBrokerServer({ host: '127.0.0.1', port: 4497, relayId: 'qa-activity', relayToken: 'qa-relay-only', pairingCode: 'qa-pair-only', dataFile: join(directory, 'devices.json'), logger: { error() {} } });
await broker.listen();
const config = { state_directory: join(directory, 'hub'), broker: { url: 'http://127.0.0.1:4497', relay_id: 'qa-activity', relay_token: 'qa-relay-only' } };
const relay = await createTmuxRelay(config, { backend: {}, createSession: ({ send, close, notify }) => new Session({}, config, send, close, notify) }); await relay.start();
let online = true;
const control = http.createServer(async (req, res) => {
  if (req.url === '/finish') await appendFile(files[1], [item(1, 'turn-1', 'AgentMessage', 'answer-1', 'RUN_FINISHED_ANSWER'), event(1, { type: 'task_complete', turn_id: 'turn-1' })].map(line).join(''));
  if (req.url === '/offline' && online) { online = false; await relay.close(); }
  res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ online, reads }));
});
await new Promise(resolve => control.listen(4496, '127.0.0.1', resolve));
console.log('Activity and cache fixture ready on localhost:4497 (control 4496)');
const stop = async () => { if (online) await relay.close(); await broker.close(); await new Promise(resolve => control.close(resolve)); await rm(directory, { recursive: true, force: true }); process.exit(0); };
process.once('SIGTERM', stop); process.once('SIGINT', stop);
