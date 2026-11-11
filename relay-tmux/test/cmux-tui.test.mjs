import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { CmuxTuiBackend, CmuxTuiOwner, cmuxKey, invoke } from '../src/cmux-tui.mjs';
import { RelaySession } from '../src/server.mjs';
import { SourceRegistry } from '../src/hub/registry.mjs';
import { discoverSources } from '../src/hub/discover.mjs';

const BINARY = process.platform === 'win32' ? 'C:\\cmux\\cmux-tui.exe' : '/opt/cmux/cmux-tui';
const W = `ws_${'a'.repeat(32)}`, T1 = `term_${'1'.repeat(32)}`, T2 = `term_${'2'.repeat(32)}`;
const SNAPSHOT = {
  workspaces: [{ id: W, index: 0, name: '项目', focused: true }, { id: `ws_${'b'.repeat(32)}`, index: 1, name: null, focused: false }],
  screens: [{ id: 'screen_1', index: 0, workspace_id: W, focused: true, name: null }],
  panes: [{ id: 'pane_1', screen_id: 'screen_1', focused: true }, { id: 'pane_2', screen_id: 'screen_1', focused: false }],
  tabs: [{ id: 'tab_1', pane_id: 'pane_1', content_kind: 'terminal', content_id: T1, index: 0, focused: true, name: null },
    { id: 'tab_b', pane_id: 'pane_1', content_kind: 'browser', content_id: 'browser_1', index: 1 },
    { id: 'tab_2', pane_id: 'pane_2', content_kind: 'terminal', content_id: T2, index: 0, focused: true, name: '构建' }],
  terminals: [{ id: T1, cols: 100, rows: 30, title: '~/src', cwd: process.cwd() }, { id: T2, cols: 80, rows: 24, title: '', cwd: process.cwd() }],
};

function fake(handler) {
  const calls = [];
  const execute = async (binary, args, input) => {
    assert.equal(binary, BINARY);
    assert.deepEqual(args.slice(0, 2), ['--session', 'main']);
    assert.equal(args.at(-1), '--json');
    const command = args.slice(2, -1);
    calls.push({ command, input });
    const result = await handler(command, input);
    return typeof result === 'object' && 'code' in result ? result : { code: 0, stdout: JSON.stringify(result), stderr: '' };
  };
  return { backend: new CmuxTuiBackend({ binary: BINARY, execute }), calls };
}

test('Panecast key names become cmux key chords or typed text', () => {
  assert.deepEqual(cmuxKey('enter'), { chord: 'enter' });
  assert.deepEqual(cmuxKey('pgup'), { chord: 'pageup' });
  assert.deepEqual(cmuxKey('ctrl-c'), { chord: 'ctrl+c' });
  assert.deepEqual(cmuxKey('shift-tab'), { chord: 'shift+tab' });
  assert.deepEqual(cmuxKey('ctrl-alt-Delete'), { chord: 'ctrl+alt+delete' });
  assert.deepEqual(cmuxKey('F5'), { chord: 'f5' });
  assert.deepEqual(cmuxKey('~'), { text: '~' });
  assert.throws(() => cmuxKey('ctrl-~'), { code: 'invalid_key' });
  assert.throws(() => cmuxKey(''), { code: 'invalid_key' });
});

test('one snapshot lists workspaces and their terminals in screen, pane and tab order', async () => {
  const { backend } = fake((command) => { assert.deepEqual(command, ['session', 'current', 'snapshot']); return SNAPSHOT; });
  assert.deepEqual((await backend.dispatch('workspace.list')).workspaces.map((w) => [w.title, w.selected]), [['项目', true], ['工作区 2', false]]);
  const { surfaces } = await backend.dispatch('surface.list', { workspace_id: W });
  assert.deepEqual(surfaces.map((s) => [s.id, s.title, s.focused, s.cols, s.height]), [[T1, '~/src', true, 100, 30], [T2, '构建', false, 80, 24]]);
  await assert.rejects(backend.dispatch('surface.list', { workspace_id: `ws_${'c'.repeat(32)}` }), { code: 'not_found' });
  await assert.rejects(backend.dispatch('surface.list', { workspace_id: '../x' }), { code: 'invalid_params' });
});

test('a session that is not running has no workspaces, and actions explain why', async () => {
  const { backend } = fake(() => ({ code: 3, stdout: '', stderr: 'cannot connect to session socket' }));
  assert.deepEqual(await backend.workspaces(), []);
  await assert.rejects(backend.capture({ workspace_id: W, surface_id: T1 }), { code: 'backend_unavailable' });
});

test('captures pad the screen cmux trims and read scrollback once per screen revision', async () => {
  let revision = '7';
  const { backend, calls } = fake((command) => {
    if (command.includes('--lines')) return { text: 'old 1\nold 2\nprompt $ ls\nfile', cols: 40, rows: 4, cursor_row: 2, cursor_col: 3, revision };
    return { text: 'prompt $ ls\nfile', cols: 40, rows: 4, cursor_row: 2, cursor_col: 3, revision };
  });
  const first = await backend.capture({ workspace_id: W, surface_id: T1 }, 120);
  assert.deepEqual(first.rows, ['old 1', 'old 2', 'prompt $ ls', 'file', '', '']);
  assert.deepEqual(first.surface.cursor, { x: 3, y: 2 });
  assert.equal(first.rows[first.rows.length - first.surface.height + first.surface.cursor.y], '');
  await backend.capture({ workspace_id: W, surface_id: T1 }, 120);
  assert.equal(calls.filter((c) => c.command.includes('--lines')).length, 1, 'unchanged screen reuses scrollback');
  revision = '8';
  await backend.capture({ workspace_id: W, surface_id: T1 }, 120);
  assert.equal(calls.filter((c) => c.command.includes('--lines')).length, 2);
  assert.deepEqual((await backend.capture({ workspace_id: W, surface_id: T1 }, 2)).rows, ['', '']);
});

test('input goes to the chosen terminal: text through stdin, keys as chords', async () => {
  const { backend, calls } = fake((command) => command[0] === 'session' ? SNAPSHOT : {});
  await backend.dispatch('surface.send_text', { workspace_id: W, surface_id: T2, text: 'echo 你好\n' });
  await backend.dispatch('surface.send_key', { workspace_id: W, surface_id: T2, key: 'ctrl-c' });
  await backend.dispatch('surface.send_key', { workspace_id: W, surface_id: T2, key: '|' });
  const sent = calls.filter((c) => c.command[0] === 'terminal');
  assert.deepEqual(sent.map((c) => [c.command.slice(1).join(' '), c.input]), [
    [`${T2} write`, 'echo 你好\n'], [`${T2} keys ctrl+c`, undefined], [`${T2} write`, '|']]);
  await assert.rejects(backend.dispatch('surface.send_text', { workspace_id: W, surface_id: `term_${'9'.repeat(32)}`, text: 'x' }), { code: 'not_found' });
});

test('workspaces and terminals are created, renamed and closed through the public CLI', async () => {
  const { backend, calls } = fake((command) => {
    if (command[0] === 'session') return SNAPSHOT;
    if (command.join(' ').startsWith('workspace create')) return { generation: 'g', revision: '2', value: { workspace_id: W, terminal_id: T1 } };
    if (command.join(' ').startsWith('tab create')) return { generation: 'g', revision: '3', value: { terminal_id: T2 } };
    return { generation: 'g', revision: '4', value: {} };
  });
  assert.equal((await backend.dispatch('workspace.create', { title: '手机\n新建' })).workspace_id, W);
  assert.equal((await backend.dispatch('surface.create', { workspace_id: W })).surface_id, T2);
  await backend.dispatch('workspace.rename', { workspace_id: W, title: '新名字' });
  await backend.dispatch('surface.close', { workspace_id: W, surface_id: T2 });
  const commands = calls.map((c) => c.command.join(' ')).filter((c) => !c.startsWith('session'));
  assert.deepEqual(commands, ['workspace create --name 手机 新建', `tab create terminal --workspace ${W}`, `workspace ${W} rename --name 新名字`, `terminal ${T2} close`]);
});

test('the hub accepts cmux TUI sources and discovers the bundled binary', async () => {
  assert.throws(() => new SourceRegistry([{ id: 'cmux-tui', type: 'cmux-tui' }]), /binary/);
  const registry = new SourceRegistry([{ id: 'cmux-tui', type: 'cmux-tui', name: 'cmux DR2', binary: BINARY }]);
  assert.equal(registry.info(registry.get('cmux-tui')).capabilities.terminal, true);
  const found = await discoverSources([], { home: '/nonexistent', lanHost: null, tmux: () => false, cmuxTui: async () => BINARY, platform: 'win32' });
  assert.deepEqual(found.added, [{ id: 'cmux-tui', name: 'cmux DR2', type: 'cmux-tui', binary: BINARY, session: 'main', owner: true }]);
  const kept = await discoverSources(found.sources, { home: '/nonexistent', lanHost: null, tmux: () => false, cmuxTui: async () => BINARY, platform: 'win32' });
  assert.deepEqual(kept.added, []);
  const mac = await discoverSources([], { home: '/nonexistent', lanHost: null, tmux: () => false, cmuxTui: async () => BINARY, platform: 'darwin' });
  assert.equal(mac.added[0].owner, false, 'elsewhere the user runs their own sessions');
});

test('the session owner is started only while no owner answers', async () => {
  const started = [];
  let running = false;
  const owner = new CmuxTuiOwner({
    execute: async (_binary, args) => { assert.deepEqual(args.slice(0, 2), ['server', 'status']); return { code: running ? 0 : 1 }; },
    spawnProcess: (binary, args) => { started.push([binary, ...args]); return { exitCode: null, on() {} }; },
  });
  await owner.sync([{ id: 'cmux-tui', type: 'cmux-tui', binary: BINARY, session: 'main', owner: true }, { id: 'other', type: 'cmux-tui', binary: BINARY }]);
  assert.deepEqual(started, [[BINARY, 'server', 'start', '--session', 'main']]);
  await owner.check();
  assert.equal(started.length, 1, 'a child that is still running is not started again');
  owner.children.clear(); running = true;
  await owner.check();
  assert.equal(started.length, 1, 'an owner started elsewhere is left alone');
  owner.close();
});

// Runs against a real cmux TUI when CMUX_TUI_BINARY names one (the Windows CI build).
const real = process.env.CMUX_TUI_BINARY;
test('a real cmux TUI session is listed, typed into, read and closed', { skip: !real && 'set CMUX_TUI_BINARY to run' }, async (t) => {
  const session = `panecast-test-${randomBytes(4).toString('hex')}`;
  const server = spawn(real, ['server', 'start', '--session', session], { stdio: 'ignore', windowsHide: true });
  t.after(async () => { await invoke(real, ['server', 'stop', '--session', session, '--json']).catch(() => {}); server.kill(); });
  for (let i = 0; i < 60 && (await invoke(real, ['server', 'status', '--session', session, '--json'])).code !== 0; i++) await delay(500);
  const backend = new CmuxTuiBackend({ binary: real, session });
  const created = await backend.dispatch('workspace.create', { title: '手机测试' });
  const listed = await backend.dispatch('workspace.list');
  assert.ok(listed.workspaces.some((w) => w.id === created.workspace_id && w.title === '手机测试'));
  const [surface] = (await backend.dispatch('surface.list', { workspace_id: created.workspace_id })).surfaces;
  assert.ok(surface, 'the new workspace has a terminal');
  const params = { workspace_id: created.workspace_id, surface_id: surface.id };

  const frames = [];
  const relay = new RelaySession(backend, {}, (frame) => frames.push(frame), () => {}, () => {});
  await relay.process(JSON.stringify({ protocolVersion: 1, deviceId: 'test' }));
  await relay.dispatch('surface.subscribe', { ...params, lines: 200 });
  assert.equal(frames[0]?.type, 'screen.full');

  await backend.dispatch('surface.send_text', { ...params, text: 'echo panecast-$((6*7))' });
  await backend.dispatch('surface.send_key', { ...params, key: 'enter' });
  let text = '';
  for (let i = 0; i < 40 && !text.includes('panecast-42'); i++) { await delay(250); text = (await backend.dispatch('surface.read_text', params)).text; }
  assert.match(text, /panecast-42/);
  relay.tick(); await delay(1000);
  assert.ok(frames.some((f) => f.type?.startsWith('screen.') && JSON.stringify(f).includes('panecast-42')), 'the subscription streams the new output');

  const extra = await backend.dispatch('surface.create', { workspace_id: created.workspace_id });
  assert.equal((await backend.dispatch('surface.list', { workspace_id: created.workspace_id })).surfaces.length, 2);
  await backend.dispatch('surface.close', { workspace_id: created.workspace_id, surface_id: extra.surface_id });
  await backend.dispatch('workspace.close', { workspace_id: created.workspace_id });
  assert.ok(!(await backend.workspaces()).some((w) => w.id === created.workspace_id));
  relay.dispose();
});
