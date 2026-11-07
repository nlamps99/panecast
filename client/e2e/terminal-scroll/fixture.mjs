import { createBrokerServer } from '../../../broker/src/server.mjs';
import { createTmuxRelay, RelaySession } from '../../../relay-tmux/src/server.mjs';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const directory = await mkdtemp(join(tmpdir(), 'panecast-scroll-ui-'));
const workspace = 'qa-scroll-workspace', primary = 'qa-scroll-primary', application = 'qa-scroll-application';
const history = Array.from({ length: 10000 }, (_, i) => `CMUX_HISTORY_${i + 1}`);
let calls = [], frames = 0, historyCalls = [], latency = 500;
const applicationRows = (position) => ['PROGRAM HEADER', ...Array.from({ length: 43 }, (_, i) => `APP_HISTORY_${position + i}`), '────────', '› fixture prompt', 'PROGRAM FOOTER'];
class Session extends RelaySession {
  position = 1000;
  revision = 0;
  subscribed = new Set();
  screen(surface) {
    if (!this.subscribed.has(surface) || this.disposed) return;
    const rows = surface === primary ? history.slice(-47) : applicationRows(this.position);
    frames++;
    this.send({ type: 'screen.full', surface_id: surface, rev: ++this.revision, rows,
      cols: 80, rowsCount: rows.length, cursor: { x: 0, y: 46 } });
  }
  async dispatch(method, params) {
    if (method === 'window.list') return { windows: [{ id: 'qa-window', ref: 'window:1', key: true }] };
    if (method === 'workspace.list') return { workspaces: [{ id: workspace, title: 'cmux 连续滚动测试', selected: true }] };
    if (method === 'surface.list') return { surfaces: [
      { id: primary, title: '普通终端', type: 'terminal', focused: true },
      { id: application, title: '程序终端', type: 'terminal', focused: false },
    ] };
    if (method === 'surface.subscribe') { this.subscribed.add(params.surface_id); this.screen(params.surface_id); return {}; }
    if (method === 'surface.unsubscribe') { this.subscribed.delete(params.surface_id); return {}; }
    if (['surface.focus', 'workspace.select', 'surface.send_key'].includes(method)) return {};
    if (method === 'terminal.replay') return { render_grid: { active_screen: params.surface_id === application ? 'alternate' : 'primary', columns: 80, rows: 47,
      modes: [{ ansi: false, code: 1000, on: params.surface_id === application }] } };
    if (method === 'terminal.scroll') {
      if (params.workspace_id !== workspace || params.surface_id !== application) throw new Error('Wrong scroll target');
      calls.push({ at: Date.now(), lines: params.delta_lines });
      this.position = Math.max(1, this.position - params.delta_lines * 3);
      this.screen(application);
      return {};
    }
    if (method === 'surface.read_text') return { text: (params.surface_id === application ? applicationRows(this.position) : history.slice(-47)).join('\n') };
    if (method === 'surface.history') {
      if (params.surface_id !== primary) throw new Error('Application history must use captures');
      historyCalls.push({ at: Date.now(), cursor: params.cursor ?? null });
      const end = params.cursor ? Number(params.cursor.slice('history:'.length)) : history.length - params.tail_lines;
      const start = Math.max(0, end - Math.min(160, params.limit));
      return { rows: history.slice(start, end), next_cursor: start ? `history:${start}` : null,
        ...(!params.cursor ? { anchor_rows: history.slice(end) } : {}) };
    }
    return super.dispatch(method, params);
  }
}
const control = createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/reset') { calls = []; frames = 0; historyCalls = []; }
  if (url.pathname === '/latency') latency = Math.max(0, Math.min(5000, Number(url.searchParams.get('ms'))));
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ calls, historyCalls, frames, latency, total: calls.reduce((sum, c) => sum + c.lines, 0) }));
});
await new Promise((resolve) => control.listen(4496, '127.0.0.1', resolve));
const broker = await createBrokerServer({ host: '127.0.0.1', port: 4495, relayId: 'qa-scroll', relayToken: 'qa-relay-only',
  pairingCode: 'qa-pair-only', dataFile: join(directory, 'devices.json'), logger: { error() {} } });
await broker.listen();
const config = { state_directory: join(directory, 'hub'), broker: { url: 'http://127.0.0.1:4495', relay_id: 'qa-scroll', relay_token: 'qa-relay-only' } };
const relay = await createTmuxRelay(config, { backend: {}, createSession: ({ send, close, notify }) => new Session({}, config,
  (frame) => setTimeout(() => send(frame), latency), close, notify) });
await relay.start();
console.log('Terminal scroll fixture ready on localhost:4495 (control:4496)');
const stop = async () => { await relay.close(); await broker.close(); control.close(); await rm(directory, { recursive: true, force: true }); process.exit(0); };
process.once('SIGTERM', stop); process.once('SIGINT', stop);
