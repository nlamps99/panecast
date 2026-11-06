import { createBrokerServer } from '../../../broker/src/server.mjs';
import { createTmuxRelay, RelaySession } from '../../../relay-tmux/src/server.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const directory = await mkdtemp(join(tmpdir(), 'panecast-key-ui-'));
const workspace = 'qa-key-workspace', surface = 'qa-key-surface';
const initialRows = Array.from({ length: 120 }, (_, i) => `KEY_TEST_LINE_${i + 1}`);
class Session extends RelaySession {
  rows = initialRows;
  revision = 1;
  presses = 0;
  screen() {
    this.send({ type: 'screen.full', surface_id: surface, rev: this.revision, rows: this.rows,
      cols: 80, rowsCount: this.rows.length, cursor: { x: 0, y: this.rows.length - 1 } });
  }
  async dispatch(method, params) {
    if (method === 'window.list') return { windows: [{ id: 'qa-window', ref: 'window:1', key: true }] };
    if (method === 'workspace.list') return { workspaces: [{ id: workspace, title: '快捷键回归测试', selected: true }] };
    if (method === 'surface.list') return { surfaces: [{ id: surface, title: '快捷键终端', type: 'terminal', focused: true }] };
    if (method === 'surface.subscribe') { this.screen(); return {}; }
    if (['surface.unsubscribe', 'surface.focus', 'workspace.select'].includes(method)) return {};
    if (method === 'terminal.replay') return {};
    if (method === 'surface.history') return { rows: Array.from({ length: 200 }, (_, i) => `OLD_KEY_TEST_${i}`), anchor_rows: this.rows, next_cursor: null };
    if (method === 'surface.send_key') {
      if (params.key !== 'ctrl-up' || params.workspace_id !== workspace || params.surface_id !== surface) throw new Error('Unexpected key or target');
      this.presses++;
      console.log(JSON.stringify({ ctrlUpReceived: this.presses }));
      this.rows = [...initialRows.slice(0, -1), `CTRL_UP_RECEIVED_${this.presses}`];
      this.revision++;
      this.screen();
      return {};
    }
    return super.dispatch(method, params);
  }
}
const broker = await createBrokerServer({ host: '127.0.0.1', port: 4499, relayId: 'qa-keys', relayToken: 'qa-relay-only',
  pairingCode: 'qa-pair-only', dataFile: join(directory, 'devices.json'), logger: { error() {} } });
await broker.listen();
const config = { state_directory: join(directory, 'hub'), broker: { url: 'http://127.0.0.1:4499', relay_id: 'qa-keys', relay_token: 'qa-relay-only' } };
const relay = await createTmuxRelay(config, { backend: {}, createSession: ({ send, close, notify }) => new Session({}, config, send, close, notify) });
await relay.start();
console.log('Keyboard fixture ready on localhost:4499');
const stop = async () => { await relay.close(); await broker.close(); await rm(directory, { recursive: true, force: true }); process.exit(0); };
process.once('SIGTERM', stop); process.once('SIGINT', stop);
