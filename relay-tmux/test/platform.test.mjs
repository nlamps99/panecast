import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isNamedPipe, notifySocketPath } from '../src/platform.mjs';
import { renderStartupScript, windowsLocation } from '../src/service.mjs';
import { createTmuxRelay } from '../src/server.mjs';

test('Windows uses a named pipe per state directory for the local endpoint', () => {
  const pipe = notifySocketPath({ state_directory: 'C:\\Users\\a\\.cmuxremote\\hub' }, undefined, 'win32');
  assert.ok(isNamedPipe(pipe));
  assert.equal(pipe, notifySocketPath({ state_directory: 'c:\\users\\A\\.cmuxremote\\hub' }, undefined, 'win32'), 'case-insensitive paths name one pipe');
  assert.notEqual(pipe, notifySocketPath({ state_directory: 'C:\\Users\\a\\.cmuxremote\\other' }, undefined, 'win32'));
  assert.equal(notifySocketPath({ state_directory: '/home/a/.cmuxremote/hub' }, undefined, 'linux'), join('/home/a/.cmuxremote/hub', 'notify.sock'));
  assert.equal(notifySocketPath({ notify_socket: '/explicit.sock' }, undefined, 'win32'), '/explicit.sock');
  assert.ok(!isNamedPipe('/tmp/notify.sock'));
});

test('the Windows login script runs the gateway hidden, logs it, and restarts it', () => {
  const script = renderStartupScript({ node: 'C:\\cmux-dr2\\node\\node.exe', entry: 'C:\\cmux-dr2\\panecast\\bin\\panecast.mjs',
    config: 'C:\\Users\\张三\\.cmuxremote\\hub-relay.json', logDirectory: 'C:\\Users\\张三\\.cmuxremote\\hub-log',
    environment: { PANECAST_CMUX_TUI: 'C:\\cmux-dr2\\bin\\cmux-tui.exe' } });
  assert.match(script, /shell\.Environment\("Process"\)\("PANECAST_CMUX_TUI"\) = "C:\\cmux-dr2\\bin\\cmux-tui\.exe"/);
  assert.match(script, /shell\.Run "cmd\.exe \/d \/s \/c """"C:\\cmux-dr2\\node\\node\.exe"" ""C:\\cmux-dr2\\panecast\\bin\\panecast\.mjs"" serve --config ""C:\\Users\\张三\\\.cmuxremote\\hub-relay\.json"" >> ""C:\\Users\\张三\\\.cmuxremote\\hub-log\\stdout\.log"" 2>> ""C:\\Users\\张三\\\.cmuxremote\\hub-log\\stderr\.log""""", 0, True/);
  assert.match(script, /WScript\.Sleep 10000\r\nLoop/);
  assert.throws(() => renderStartupScript({ node: 'C:\\n"ode.exe', entry: 'C:\\e', config: 'C:\\c', logDirectory: 'C:\\l' }), /Invalid/);
  assert.throws(() => renderStartupScript({ node: 'C:\\%PATH%\\node.exe', entry: 'C:\\e', config: 'C:\\c', logDirectory: 'C:\\l' }), /Invalid/);
  const where = windowsLocation('C:\\Users\\a\\.cmuxremote\\hub-relay.json', { APPDATA: 'C:\\Users\\a\\AppData\\Roaming' });
  assert.match(where.script, /Startup[\\/]Panecast Gateway\.vbs$/);
});

test('a relay serves its local endpoint and frees it on close', async (t) => {
  // Unix socket paths are short; a long TMPDIR would not fit one.
  const directory = await mkdtemp(join(process.platform === 'win32' ? tmpdir() : '/tmp', 'pc-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = { state_directory: directory };
  const backend = { surface: async () => ({}), dispatch: async () => ({}) };
  const relay = await createTmuxRelay(config, { backend });
  await relay.start();
  const path = notifySocketPath(config);
  const reachable = () => new Promise((resolve) => {
    const socket = net.connect(path);
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
  });
  assert.equal(await reachable(), true);
  await assert.rejects(createTmuxRelay(config, { backend }).then((other) => other.start().finally(() => other.close())), 'a second relay cannot take the endpoint');
  await relay.close();
  assert.equal(await reachable(), false);
});
