import { createBrokerServer } from '../../../broker/src/server.mjs';
import { createTmuxRelay, RelaySession } from '../../../relay-tmux/src/server.mjs';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const directory = await mkdtemp(join(tmpdir(), 'panecast-scroll-ui-'));
const workspace = 'qa-scroll-workspace', surface = 'qa-scroll-surface';
let calls = [], frames = 0;
class Session extends RelaySession {
  position = 1000;
  revision = 0;
  subscribed = false;
  screen() {
    if (!this.subscribed || this.disposed) return;
    const rows = Array.from({ length: 47 }, (_, i) => `CMUX_HISTORY_${this.position + i}`);
    frames++;
    this.send({ type: 'screen.full', surface_id: surface, rev: ++this.revision, rows,
      cols: 80, rowsCount: rows.length, cursor: { x: 0, y: 46 } });
  }
  async dispatch(method, params) {
    if (method === 'window.list') return { windows: [{ id: 'qa-window', ref: 'window:1', key: true }] };
    if (method === 'workspace.list') return { workspaces: [{ id: workspace, title: 'cmux 连续滚动测试', selected: true }] };
    if (method === 'surface.list') return { surfaces: [{ id: surface, title: 'cmux 终端', type: 'terminal', focused: true }] };
    if (method === 'surface.subscribe') { this.subscribed = true; this.screen(); return {}; }
    if (method === 'surface.unsubscribe') { this.subscribed = false; return {}; }
    if (['surface.focus', 'workspace.select'].includes(method)) return {};
    if (method === 'terminal.replay') return { render_grid: { active_screen: 'alternate', columns: 80, rows: 47,
      modes: [{ ansi: false, code: 1000, on: true }] } };
    if (method === 'terminal.scroll') {
      if (params.workspace_id !== workspace || params.surface_id !== surface) throw new Error('Wrong scroll target');
      calls.push({ at: Date.now(), lines: params.delta_lines });
      this.position -= params.delta_lines;
      this.screen();
      return {};
    }
    if (method === 'surface.history') throw new Error('Application history must use wheel input');
    return super.dispatch(method, params);
  }
}
const control = createServer((req, res) => {
  if (req.url === '/reset') { calls = []; frames = 0; }
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ calls, frames, total: calls.reduce((sum, c) => sum + c.lines, 0) }));
});
await new Promise((resolve) => control.listen(4496, '127.0.0.1', resolve));
const broker = await createBrokerServer({ host: '127.0.0.1', port: 4495, relayId: 'qa-scroll', relayToken: 'qa-relay-only',
  pairingCode: 'qa-pair-only', dataFile: join(directory, 'devices.json'), logger: { error() {} } });
await broker.listen();
const config = { state_directory: join(directory, 'hub'), broker: { url: 'http://127.0.0.1:4495', relay_id: 'qa-scroll', relay_token: 'qa-relay-only' } };
const relay = await createTmuxRelay(config, { backend: {}, createSession: ({ send, close, notify }) => new Session({}, config,
  // Delay transport delivery, not host execution: successive requests still
  // reach the terminal while earlier acknowledgements are on the wire.
  (frame) => setTimeout(() => send(frame), frame.id ? 180 : 90), close, notify) });
await relay.start();
console.log('Terminal scroll fixture ready on localhost:4495 (control:4496)');
const stop = async () => { await relay.close(); await broker.close(); control.close(); await rm(directory, { recursive: true, force: true }); process.exit(0); };
process.once('SIGTERM', stop); process.once('SIGINT', stop);
