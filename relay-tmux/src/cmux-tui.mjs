import { spawn } from 'node:child_process';
import { access, constants } from 'node:fs/promises';
import { delimiter, isAbsolute, join } from 'node:path';
import { RpcError, project } from './tmux.mjs';

/**
 * cmux TUI (manaflow-ai/cmux `cmux-tui`, the cmux that also runs on Windows)
 * as a terminal source. Every operation is one public CLI call with `--json`
 * against a named session; the session owner keeps the terminals running.
 */
const ID = { workspace: /^ws_[0-9a-f]{8,64}$/, terminal: /^term_[0-9a-f]{8,64}$/ };
const SESSION = /^[\w.-]{1,64}$/;

/** Runs the CLI and keeps stdout on failure: JSON-mode errors are written there. */
export function invoke(command, args, input, limit = 16 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const output = [], errors = [];
    let size = 0, failure;
    const timer = setTimeout(() => { failure = new RpcError('timeout', '电脑上的命令执行超时'); child.kill(); }, 15_000);
    child.on('error', (error) => { clearTimeout(timer); reject(new RpcError('backend_unavailable', `无法启动 cmux：${error.code ?? error.message}`)); });
    child.stdout.on('data', (chunk) => { size += chunk.length; if (size > limit) { failure = new RpcError('too_large', '输出过大，请在电脑上查看'); child.kill(); } else output.push(chunk); });
    child.stderr.on('data', (chunk) => { if (errors.length < 16) errors.push(chunk); });
    child.stdin.on('error', () => {});
    child.on('close', (code) => {
      clearTimeout(timer);
      if (failure) reject(failure);
      else resolve({ code, stdout: Buffer.concat(output).toString(), stderr: Buffer.concat(errors).toString() });
    });
    child.stdin.end(input);
  });
}

/** Panecast key names (`ctrl-c`, `pgup`, `shift-tab`) as cmux key chords, or literal text. */
export function cmuxKey(value) {
  if (typeof value !== 'string' || !value || value.length > 64) throw new RpcError('invalid_key', '无效按键');
  let rest = value, modifiers = [];
  for (let match; (match = /^(ctrl|alt|shift)-(?=.)/i.exec(rest));) { modifiers.push(match[1].toLowerCase()); rest = rest.slice(match[0].length); }
  const named = { enter: 'enter', tab: 'tab', escape: 'escape', esc: 'escape', up: 'up', down: 'down', left: 'left', right: 'right',
    home: 'home', end: 'end', pgup: 'pageup', pgdn: 'pagedown', pageup: 'pageup', pagedown: 'pagedown', backspace: 'backspace', delete: 'delete', space: 'space' };
  const lower = rest.toLowerCase();
  const key = named[lower] ?? (/^f(?:[1-9]|1[0-2])$/.test(lower) ? lower : /^[a-z0-9]$/i.test(rest) ? rest.toLowerCase() : null);
  if (key) return { chord: [...new Set(modifiers), key].join('+') };
  // cmux names letters and digits; other characters without modifiers are typed as text.
  if (!modifiers.length && /^[\x20-\x7e]$/.test(rest)) return { text: rest };
  throw new RpcError('invalid_key', 'cmux 不支持这个组合键');
}

export class CmuxTuiBackend {
  constructor({ binary, session = 'main', execute = invoke } = {}) {
    if (typeof binary !== 'string' || !isAbsolute(binary)) throw new Error('cmux TUI needs an absolute binary path');
    if (!SESSION.test(session)) throw new Error('invalid cmux session name');
    Object.assign(this, { binary, session, execute });
    this.screens = new Map();
  }

  async cli(args, input) {
    const { code, stdout, stderr } = await this.execute(this.binary, ['--session', this.session, ...args, '--json'], input);
    let value;
    try { value = stdout.trim() ? JSON.parse(stdout) : null; } catch { value = null; }
    if (code === 0) return value?.value !== undefined && value?.generation ? value.value : value;
    // Exit 3: the session owner is not running (or not reachable).
    if (code === 3) throw new RpcError('backend_unavailable', 'cmux DR2 没有运行，请在电脑上打开 cmux DR2');
    if (value?.code === 'not_found' || /not[_ ]found/i.test(value?.code ?? '')) throw new RpcError('not_found', '这个终端已经关闭');
    throw new RpcError('backend_error', value?.message ?? (stderr.trim() || 'cmux 命令失败'));
  }

  workspace(id) { if (typeof id !== 'string' || !ID.workspace.test(id)) throw new RpcError('invalid_params', '无效工作区'); return id; }
  terminal(id) { if (typeof id !== 'string' || !ID.terminal.test(id)) throw new RpcError('invalid_params', '无效终端'); return id; }

  async snapshot() {
    try { return await this.cli(['session', 'current', 'snapshot']); }
    catch (error) { if (error.code === 'backend_unavailable') return null; throw error; }
  }

  async workspaces() {
    const snapshot = await this.snapshot();
    return (snapshot?.workspaces ?? []).slice().sort((a, b) => (a.index ?? 0) - (b.index ?? 0)).map((w, index) => ({
      id: w.id, ref: w.id, title: w.name || `工作区 ${index + 1}`, index, selected: Boolean(w.focused) }));
  }

  /** Terminals of one workspace, in screen, pane and tab order. */
  async surfaces(workspaceId) {
    this.workspace(workspaceId);
    const snapshot = await this.snapshot();
    if (!snapshot?.workspaces?.some((w) => w.id === workspaceId)) throw new RpcError('not_found', '这个工作区已经关闭');
    const byIndex = (a, b) => (a.index ?? 0) - (b.index ?? 0);
    const terminals = new Map((snapshot.terminals ?? []).map((t) => [t.id, t]));
    const surfaces = [];
    for (const screen of (snapshot.screens ?? []).filter((s) => s.workspace_id === workspaceId).sort(byIndex)) {
      for (const pane of (snapshot.panes ?? []).filter((p) => p.screen_id === screen.id)) {
        for (const tab of (snapshot.tabs ?? []).filter((t) => t.pane_id === pane.id && t.content_kind === 'terminal').sort(byIndex)) {
          const terminal = terminals.get(tab.content_id);
          if (!terminal) continue;
          surfaces.push({ id: terminal.id, ref: terminal.id, pane_id: pane.id, workspace_id: workspaceId, index: surfaces.length, type: 'terminal',
            title: tab.name || terminal.title || screen.name || `终端 ${surfaces.length + 1}`,
            focused: Boolean(screen.focused && pane.focused && tab.focused), cols: terminal.cols, height: terminal.rows,
            cursor: { x: 0, y: 0 }, cwd: terminal.cwd });
        }
      }
    }
    return surfaces;
  }

  async surface(params) {
    this.terminal(params.surface_id);
    const found = (await this.surfaces(params.workspace_id)).find((s) => s.id === params.surface_id);
    if (!found) throw new RpcError('not_found', '这个终端已经关闭');
    return found;
  }

  /**
   * The last `lines` rows: scrollback, then the visible screen padded to its
   * height (cmux omits empty rows at the bottom) so the cursor row lines up.
   * The screen revision avoids a second read while nothing changed.
   */
  async capture(params, lines = 120) {
    const id = this.terminal(params.surface_id);
    const count = Math.min(20_000, Math.max(1, Number.isFinite(lines) ? Math.floor(lines) : 120));
    const screen = await this.cli(['terminal', id, 'screen', 'read', '--details']);
    const visibleText = String(screen.text ?? '').split('\n');
    const height = Math.max(1, Number(screen.rows) || visibleText.length);
    const visible = [...visibleText.slice(0, height), ...Array(Math.max(0, height - visibleText.length)).fill('')];
    let rows = visible;
    if (count > height) {
      const cached = this.screens.get(id);
      if (cached && cached.revision === screen.revision && cached.count === count) rows = cached.rows;
      else {
        const all = await this.cli(['terminal', id, 'screen', 'read', '--lines', String(count), '--details']);
        const text = String(all.text ?? '').split('\n');
        rows = [...text.slice(0, Math.max(0, text.length - visibleText.length)), ...visible];
        if (all.revision === screen.revision) {
          this.screens.set(id, { revision: screen.revision, count, rows });
          while (this.screens.size > 16) this.screens.delete(this.screens.keys().next().value);
        }
      }
    }
    const surface = { id, ref: id, workspace_id: params.workspace_id, type: 'terminal', cols: Number(screen.cols) || 80, height,
      cursor: { x: Number(screen.cursor_col) || 0, y: Number(screen.cursor_row) || 0 } };
    return { surface, rows: rows.slice(-count) };
  }

  async dispatch(method, p = {}) {
    switch (method) {
      case 'window.list': return { windows: [{ id: 'cmux', ref: 'cmux', index: 0, key: true, workspace_count: (await this.workspaces()).length }] };
      case 'workspace.list': return { window_id: 'cmux', workspaces: await this.workspaces() };
      case 'workspace.create': {
        const name = String(p.title || p.name || '手机新建').replace(/[\r\n\t]/g, ' ').slice(0, 80);
        const created = await this.cli(['workspace', 'create', '--name', name]);
        return { workspace_id: created.workspace_id, workspace: { id: created.workspace_id, title: name } };
      }
      case 'workspace.rename': await this.cli(['workspace', this.workspace(p.workspace_id), 'rename', '--name', String(p.title ?? '').replace(/[\r\n\t]/g, ' ').slice(0, 80)]); return {};
      case 'workspace.close': await this.cli(['workspace', this.workspace(p.workspace_id), 'close']); return {};
      case 'workspace.select': this.workspace(p.workspace_id); return {};
      case 'surface.list': return { workspace_id: p.workspace_id, surfaces: await this.surfaces(p.workspace_id) };
      case 'surface.create': {
        const created = await this.cli(['tab', 'create', 'terminal', '--workspace', this.workspace(p.workspace_id)]);
        return { workspace_id: p.workspace_id, surface_id: created.terminal_id, surface: { id: created.terminal_id, type: 'terminal' } };
      }
      case 'surface.close': {
        await this.surface(p);
        if ((await this.surfaces(p.workspace_id)).length <= 1) throw new RpcError('last_surface', '不能关闭工作区里的最后一个终端');
        await this.cli(['terminal', p.surface_id, 'close']); return {};
      }
      case 'surface.focus': await this.surface(p); return {}; // Viewing from the phone never moves focus on the computer.
      case 'surface.send_key': {
        await this.surface(p);
        const key = cmuxKey(p.key);
        if (key.chord) await this.cli(['terminal', p.surface_id, 'keys', key.chord]);
        else await this.cli(['terminal', p.surface_id, 'write'], key.text);
        return {};
      }
      case 'surface.send_text': {
        await this.surface(p);
        if (typeof p.text !== 'string' || Buffer.byteLength(p.text) > 512 * 1024) throw new RpcError('invalid_params', '输入过大');
        await this.cli(['terminal', p.surface_id, 'write'], p.text); return {};
      }
      case 'surface.read_text': return { text: (await this.capture(p, p.lines)).rows.join('\n') };
      case 'relay.diagnostics': {
        const ready = Boolean(await this.snapshot());
        return { backend: 'cmux-tui', backend_ready: ready, project_access: true };
      }
      case 'host.battery': return { available: false };
      default:
        if (method.startsWith('project.')) {
          const surface = await this.surface(p);
          if (!surface.cwd) throw new RpcError('not_found', '无法确定这个终端的目录');
          return project(method, surface.cwd, p.path ?? '');
        }
        throw new RpcError('method_not_found', `不支持 ${method}`);
    }
  }
}

/** The cmux TUI binary: an explicit path, then PATH. */
export async function findCmuxTui({ env = process.env, platform = process.platform } = {}) {
  const file = platform === 'win32' ? 'cmux-tui.exe' : 'cmux-tui';
  const path = env.PATH ?? env.Path ?? '';
  const candidates = [env.PANECAST_CMUX_TUI, ...path.split(platform === 'win32' ? ';' : delimiter).filter(Boolean).map((dir) => join(dir, file))];
  for (const candidate of candidates) {
    if (!candidate || !isAbsolute(candidate)) continue;
    try { await access(candidate, platform === 'win32' ? constants.F_OK : constants.X_OK); return candidate; } catch {}
  }
  return null;
}

/**
 * Keeps a headless owner of the source's session running, so the phone sees
 * the terminals even while no cmux window is open. A window opened later
 * attaches to the same session. Checks every `interval`; an owner started by
 * someone else is left alone.
 */
export class CmuxTuiOwner {
  constructor({ execute = invoke, spawnProcess = spawn, log = () => {}, interval = 10_000 } = {}) {
    Object.assign(this, { execute, spawnProcess, log, interval });
    this.sources = []; this.children = new Map(); this.timer = null; this.checking = false;
  }

  sync(sources = []) {
    this.sources = sources.filter((s) => s.type === 'cmux-tui' && s.owner && typeof s.binary === 'string' && isAbsolute(s.binary));
    clearInterval(this.timer); this.timer = null;
    if (this.sources.length) { this.timer = setInterval(() => void this.check(), this.interval); this.timer.unref?.(); }
    return this.check();
  }

  async check() {
    if (this.checking) return; this.checking = true;
    try {
      for (const source of this.sources) {
        const session = source.session ?? 'main';
        if (!SESSION.test(session)) continue;
        const key = `${source.binary}\n${session}`;
        if (this.children.get(key)?.exitCode === null) continue;
        const { code } = await this.execute(source.binary, ['server', 'status', '--session', session, '--json']).catch(() => ({ code: 1 }));
        if (code === 0) continue;
        this.log(`starting cmux session ${session}`);
        const child = this.spawnProcess(source.binary, ['server', 'start', '--session', session], { stdio: 'ignore', windowsHide: true });
        child.on?.('error', () => this.log('cmux session could not start'));
        this.children.set(key, child);
      }
    } finally { this.checking = false; }
  }

  /** Stops supervising; the session owner keeps running for open windows. */
  close() { clearInterval(this.timer); this.timer = null; this.sources = []; }
}
