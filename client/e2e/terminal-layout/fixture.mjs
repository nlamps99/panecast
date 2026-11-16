// A loopback computer showing a 150-column Claude Code screen, for measuring how
// much of the phone the terminal gets and how its long rows wrap.
import { createBrokerServer } from '../../../broker/src/server.mjs';
import { createTmuxRelay, RelaySession } from '../../../relay-tmux/src/server.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = 4491, W = 150;
const pad = (s, n = W) => s + ' '.repeat(Math.max(0, n - [...s].length));
const rule = '─'.repeat(W);
const rows = [
  '╭' + '─'.repeat(W - 2) + '╮', pad('│ ✻ Welcome to Claude Code!', W - 1) + '│', pad('│   cwd: /Users/qa/code/panecast', W - 1) + '│', '╰' + '─'.repeat(W - 2) + '╯', '',
  '> 帮我看看为什么手机上的终端画面看起来太小了，顺便检查一下 TerminalView 的列数是怎么算的', '',
  '⏺ I\'ll start by reading how the terminal view computes its column count and line height.', '',
  '⏺ Read(client/src/ui/TerminalView.tsx)', '  ⎿  Read 506 lines (ctrl+r to expand)', '',
  '⏺ Bash(cd client && npx jest src/ui/__tests__/TerminalView.test.tsx 2>&1 | tail -20)',
  '  ⎿  PASS src/ui/__tests__/TerminalView.test.tsx (4.213 s)', '       TerminalView', '         ✓ wraps long lines by word (31 ms)', '         ✓ truncates rule lines to the screen width (4 ms)', '     Tests:       12 passed, 12 total', '',
  '⏺ The column count is width ÷ (font size × 0.6). At 13 pt on a 393 pt wide phone that gives 48 columns, while the Mac pane is 150 columns wide,',
  '  so most lines wrap three times. 主要原因是电脑上的面板有 150 列，而手机竖屏只放得下 48 列左右，所以几乎每一行都会被折成三行。', '',
  '⏺ Update(client/src/ui/TerminalView.tsx)', '  ⎿  Updated client/src/ui/TerminalView.tsx with 3 additions and 1 removal', '       78    const size = pinchSize ?? fontSize;', '       79 -  const lineHeight = Math.round(size * 1.3);', '       79 +  const lineHeight = Math.round(size * 1.25);', '',
  '✻ Thinking… (esc to interrupt · 12s · ↑ 1.2k tokens)', '',
  rule, pad('> '), rule, pad('  ? for shortcuts', W - 22) + '◯ IDE disconnected   ',
];

const directory = await mkdtemp(join(tmpdir(), 'panecast-layout-ui-'));
class Session extends RelaySession {
  async dispatch(method, params) {
    if (method === 'window.list') return { windows: [{ id: 'w', key: true }] };
    if (method === 'workspace.list') return { workspaces: [{ id: 'ws', title: '布局测量', selected: true }] };
    if (method === 'surface.list') return { surfaces: [{ id: 's', title: 'claude', type: 'terminal', focused: true }] };
    if (method === 'surface.subscribe') {
      this.send({ type: 'screen.full', surface_id: params.surface_id, rev: 1, rows, cols: W, rowsCount: rows.length, cursor: { x: 2, y: rows.length - 3 } });
      return {};
    }
    if (['surface.unsubscribe', 'surface.focus', 'workspace.select', 'terminal.replay'].includes(method)) return {};
    if (method === 'surface.history') return { rows: [], next_cursor: null };
    if (method === 'terminal.conversation') return { available: false };
    return super.dispatch(method, params);
  }
}
const broker = await createBrokerServer({ host: '127.0.0.1', port: PORT, relayId: 'qa-layout', relayToken: 'qa-relay-only',
  pairingCode: 'qa-pair-only', dataFile: join(directory, 'devices.json'), logger: { error() {} } });
await broker.listen();
const config = { state_directory: join(directory, 'hub'), broker: { url: `http://127.0.0.1:${PORT}`, relay_id: 'qa-layout', relay_token: 'qa-relay-only' } };
const relay = await createTmuxRelay(config, { backend: {}, createSession: ({ send, close, notify }) => new Session({}, config, send, close, notify) });
await relay.start();
console.log(`Terminal layout fixture ready on localhost:${PORT}`);
const stop = async () => { await relay.close(); await broker.close(); await rm(directory, { recursive: true, force: true }); process.exit(0); };
process.once('SIGTERM', stop); process.once('SIGINT', stop);
