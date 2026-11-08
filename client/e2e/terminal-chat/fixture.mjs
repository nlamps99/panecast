import { createBrokerServer } from '../../../broker/src/server.mjs';
import { createTmuxRelay, RelaySession } from '../../../relay-tmux/src/server.mjs';
import { TerminalConversationReader } from '../../../relay-tmux/src/hub/terminal-conversation.mjs';
import { mkdtemp, mkdir, writeFile, appendFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';

const directory = await mkdtemp(join(tmpdir(), 'panecast-chat-ui-'));
const workspace = 'qa-chat-workspace', surfaces = ['qa-chat-first', 'qa-chat-second'];
const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];
const reader = new TerminalConversationReader({ home: directory });
const files = ids.map(id => join(directory, '.codex/sessions', `${id}.jsonl`));
const line = value => JSON.stringify(value) + '\n';
const completed = (index, turn, item) => ({ type: 'event_msg', payload: { type: 'item_completed', thread_id: ids[index], turn_id: turn, item } });
const message = (type, id, text) => ({ type, id, content: [{ type: 'text', text }], phase: 'final' });
await mkdir(join(directory, '.codex/sessions'), { recursive: true });
for (let index = 0; index < 2; index++) {
  const values = [{ type: 'session_meta', payload: { id: ids[index] } }];
  for (let turn = 0; turn < 90; turn++) values.push(
    completed(index, `turn-${turn}`, message('UserMessage', 'user', `CHAT_${index}_QUESTION_${turn}`)),
    completed(index, `turn-${turn}`, { type: 'CommandExecution', id: 'tool', command: ['zsh', '-lc', 'npm test'], aggregated_output: `CHAT_TOOL_OUTPUT_${index}_${turn}`, status: 'completed' }),
    completed(index, `turn-${turn}`, message('AgentMessage', 'answer', `CHAT_${index}_ANSWER_${turn}`)),
  );
  await writeFile(files[index], values.map(line).join(''));
}
const sends = [], reads = []; let counter = 0;
class Session extends RelaySession {
  pending = new Map();
  screen(surface) { this.send({ type: 'screen.full', surface_id: surface, rev: ++counter, rows: [`SHELL_SCREEN_${surfaces.indexOf(surface)}`, '$ ready'], cols: 80, rowsCount: 2, cursor: { x: 0, y: 1 } }); }
  async dispatch(method, p) {
    if (method === 'window.list') return { windows: [{ id: 'qa-window', key: true }] };
    if (method === 'workspace.list') return { workspaces: [{ id: workspace, title: '终端对话测试', selected: true }] };
    if (method === 'surface.list') return { surfaces: surfaces.map((id, i) => ({ id, title: i ? '第二个终端' : '第一个终端', type: 'terminal', focused: i === 0 })) };
    if (method === 'surface.subscribe') { this.screen(p.surface_id); return {}; }
    if (['surface.unsubscribe', 'surface.focus', 'workspace.select'].includes(method)) return {};
    if (method === 'terminal.replay') return {};
    if (method === 'surface.history') return { rows: [], next_cursor: null };
    if (method === 'terminal.conversation') {
      const index = surfaces.indexOf(p.surface_id); if (p.workspace_id !== workspace || index < 0) throw new Error('wrong target');
      reads.push({ surface: p.surface_id, cursor: Boolean(p.cursor) });
      return reader.read({ kind: 'codex', checkpoint_id: ids[index], execution_location: 'local' }, p);
    }
    if (method === 'surface.send_text') { this.pending.set(p.surface_id, p.text); sends.push({ ...p }); return {}; }
    if (method === 'surface.send_key') {
      sends.push({ ...p });
      if (p.key === 'enter' && this.pending.has(p.surface_id)) {
        const text = this.pending.get(p.surface_id), index = surfaces.indexOf(p.surface_id), turn = `sent-${++counter}`; this.pending.delete(p.surface_id);
        if (p.workspace_id !== workspace || index < 0) throw new Error('wrong target');
        await appendFile(files[index], [completed(index, turn, message('UserMessage', 'input', text)),
          completed(index, turn, message('AgentMessage', 'reply', `CHAT_REPLY_${index}: ${text}`))].map(line).join(''));
      }
      return {};
    }
    return super.dispatch(method, p);
  }
}
const broker = await createBrokerServer({ host: '127.0.0.1', port: 4493, relayId: 'qa-chat', relayToken: 'qa-relay-only', pairingCode: 'qa-pair-only', dataFile: join(directory, 'devices.json'), logger: { error() {} } });
await broker.listen();
const config = { state_directory: join(directory, 'hub'), broker: { url: 'http://127.0.0.1:4493', relay_id: 'qa-chat', relay_token: 'qa-relay-only' } };
const relay = await createTmuxRelay(config, { backend: {}, createSession: ({ send, close, notify }) => new Session({}, config, send, close, notify) }); await relay.start();
const control = http.createServer((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ sends, reads })); });
await new Promise(resolve => control.listen(4492, '127.0.0.1', resolve));
console.log('Terminal chat fixture ready on localhost:4493');
const stop = async () => { await relay.close(); await broker.close(); await new Promise(resolve => control.close(resolve)); await rm(directory, { recursive: true, force: true }); process.exit(0); };
process.once('SIGTERM', stop); process.once('SIGINT', stop);
