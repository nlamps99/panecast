import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readdir, realpath, stat, open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve, relative, isAbsolute, sep, extname, basename } from 'node:path';

export class RpcError extends Error { constructor(code, message) { super(message); this.code = code; } }
export function run(command, args, input, limit = 8 * 1024 * 1024) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const output = [], errors = [];
    let size = 0, errorSize = 0, failure;
    const timer = setTimeout(() => { failure = new RpcError('timeout', '电脑上的命令执行超时'); child.kill('SIGKILL'); }, 10_000);
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.stdout.on('data', (chunk) => { size += chunk.length; if (size > limit) { failure = new RpcError('too_large', '输出过大，请在电脑上查看'); child.kill('SIGKILL'); } else output.push(chunk); });
    child.stderr.on('data', (chunk) => { errorSize += chunk.length; if (errorSize < 4096) errors.push(chunk); });
    child.stdin.on('error', () => {});
    child.on('close', (code) => {
      clearTimeout(timer);
      if (failure) reject(failure);
      else if (code !== 0) reject(new RpcError('backend_error', Buffer.concat(errors).toString().trim() || `${command} 失败`));
      else resolveRun(Buffer.concat(output).toString());
    });
    child.stdin.end(input);
  });
}
export function tmuxKey(value) {
  if (typeof value !== 'string' || value.length > 64) throw new RpcError('invalid_key', '无效按键');
  let rest = value.toLowerCase(), prefix = '';
  for (const [name, code] of [['ctrl-', 'C-'], ['alt-', 'M-'], ['shift-', 'S-']]) {
    if (rest.startsWith(name)) { prefix += code; rest = rest.slice(name.length); }
  }
  const named = { enter: 'Enter', tab: 'Tab', escape: 'Escape', esc: 'Escape', up: 'Up', down: 'Down', left: 'Left', right: 'Right', home: 'Home', end: 'End', pgup: 'PPage', pgdn: 'NPage', backspace: 'BSpace', delete: 'DC' };
  const key = named[rest] ?? (/^[\x20-\x7e]$/.test(rest) ? rest : /^f(?:[1-9]|1[0-2])$/.test(rest) ? rest.toUpperCase() : null);
  if (!key) throw new RpcError('invalid_key', 'tmux 不支持这个组合键');
  return prefix + key;
}

export class TmuxBackend {
  constructor({ socketName, executable = 'tmux', execute = run, configFile } = {}) {
    if (socketName && !/^[\w-]{1,80}$/.test(socketName)) throw new Error('invalid tmux socket name');
    this.prefix = socketName ? ['-L', socketName] : [];
    if (configFile) this.prefix.push('-f', configFile);
    this.executable = executable; this.execute = execute;
  }
  tmux(args, input) { return this.execute(this.executable, [...this.prefix, ...args], input); }
  async workspaces() {
    let output;
    try { output = await this.tmux(['list-sessions', '-F', '#{session_id}\t#{session_name}\t#{session_attached}']); }
    catch (error) { if (/no server running|no sessions|No such file or directory/.test(error.message)) return []; throw error; }
    return output.trim().split('\n').filter(Boolean).map((line, index) => {
      const [id, title, attached] = line.split('\t');
      return { id, title, ref: id, index, selected: Number(attached) > 0 };
    });
  }
  workspace(id) { if (typeof id !== 'string' || !/^\$\d+$/.test(id)) throw new RpcError('invalid_params', '无效工作区'); return id; }
  async surfaces(workspaceId) {
    this.workspace(workspaceId);
    const output = await this.tmux(['list-panes', '-s', '-t', workspaceId, '-F', '#{pane_id}\t#{pane_title}\t#{window_name}\t#{pane_active}\t#{window_active}\t#{pane_width}\t#{pane_height}\t#{cursor_x}\t#{cursor_y}']);
    return output.trim().split('\n').filter(Boolean).map((line, index) => {
      const [id, title, window, active, windowActive, cols, height, x, y] = line.split('\t');
      return { id, ref: id, pane_id: id, workspace_id: workspaceId, index, type: 'terminal', title: title || window || id,
        focused: active === '1' && windowActive === '1', cols: Number(cols), height: Number(height), cursor: { x: Number(x), y: Number(y) } };
    });
  }
  async surface(params) {
    if (typeof params.surface_id !== 'string' || !/^%\d+$/.test(params.surface_id)) throw new RpcError('invalid_params', '无效终端');
    const found = (await this.surfaces(params.workspace_id)).find((s) => s.id === params.surface_id);
    if (!found) throw new RpcError('not_found', '这个终端已经关闭');
    return found;
  }
  async capture(params, lines = 120) {
    const surface = await this.surface(params);
    const count = Math.min(20_000, Math.max(1, Number.isFinite(lines) ? Math.floor(lines) : 120));
    const output = await this.tmux(['capture-pane', '-p', '-e', '-J', '-t', surface.id, '-S', `-${count}`]);
    const rows = output.replace(/\n$/, '').split('\n').slice(-count);
    return { surface, rows };
  }
  async dispatch(method, p = {}) {
    switch (method) {
      case 'window.list': return { windows: [{ id: 'tmux', ref: 'tmux', index: 0, key: true, workspace_count: (await this.workspaces()).length }] };
      case 'workspace.list': return { window_id: 'tmux', workspaces: await this.workspaces() };
      case 'workspace.create': {
        const name = String(p.title || p.name || `panecast-${Date.now()}`).replace(/[.:\r\n\t]/g, '-').slice(0, 80);
        const id = (await this.tmux(['new-session', '-d', '-P', '-F', '#{session_id}', '-s', name, '-c', homedir()])).trim();
        return { workspace_id: id, workspace: { id, title: name } };
      }
      case 'workspace.rename': await this.tmux(['rename-session', '-t', this.workspace(p.workspace_id), String(p.title).replace(/[.:\r\n\t]/g, '-').slice(0, 80)]); return {};
      case 'workspace.close': await this.tmux(['kill-session', '-t', this.workspace(p.workspace_id)]); return {};
      case 'workspace.select': this.workspace(p.workspace_id); return {};
      case 'surface.list': return { workspace_id: p.workspace_id, surfaces: await this.surfaces(p.workspace_id) };
      case 'surface.create': {
        const id = (await this.tmux(['new-window', '-d', '-P', '-F', '#{pane_id}', '-t', this.workspace(p.workspace_id)])).trim();
        return { workspace_id: p.workspace_id, surface_id: id, surface: { id, type: 'terminal' } };
      }
      case 'surface.close': {
        await this.surface(p);
        if ((await this.surfaces(p.workspace_id)).length <= 1) throw new RpcError('last_surface', '不能关闭工作区里的最后一个终端');
        await this.tmux(['kill-pane', '-t', p.surface_id]); return {};
      }
      case 'surface.focus': await this.surface(p); return {}; // Keys explicitly target a pane; viewing never steals desktop focus.
      case 'surface.send_key': await this.surface(p); await this.tmux(['send-keys', '-t', p.surface_id, '--', tmuxKey(p.key)]); return {};
      case 'surface.send_text': {
        await this.surface(p);
        if (typeof p.text !== 'string' || Buffer.byteLength(p.text) > 512 * 1024) throw new RpcError('invalid_params', '输入过大');
        const buffer = `panecast-${randomUUID()}`;
        await this.tmux(['load-buffer', '-b', buffer, '-'], p.text);
        try { await this.tmux(['paste-buffer', '-d', '-r', '-b', buffer, '-t', p.surface_id]); }
        finally { await this.tmux(['delete-buffer', '-b', buffer]).catch(() => {}); }
        return {};
      }
      case 'surface.read_text': return { text: (await this.capture(p, p.lines)).rows.join('\n') };
      case 'relay.diagnostics': await this.tmux(['-V']); return { backend: 'tmux', backend_ready: true, project_access: true };
      case 'host.battery': return { available: false };
      default:
        if (method.startsWith('project.')) {
          await this.surface(p);
          const root = (await this.tmux(['display-message', '-p', '-t', p.surface_id, '#{pane_current_path}'])).trim();
          return project(method, root, p.path ?? '');
        }
        throw new RpcError('method_not_found', `不支持 ${method}`);
    }
  }
}

export async function projectPath(root, path) {
  if (typeof path !== 'string' || isAbsolute(path) || path.includes('\0') || path.split(/[\\/]/).includes('..')) throw new RpcError('forbidden', '只能查看当前项目目录内的文件');
  const base = await realpath(root), file = await realpath(resolve(base, path));
  const rel = relative(base, file);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new RpcError('forbidden', '不能访问项目目录外的文件');
  return file;
}
export async function project(method, root, path) {
  const file = await projectPath(root, path);
  if (method === 'project.list') {
    const all = (await readdir(file)).filter((name) => !['.git', 'node_modules', '.build'].includes(name)).sort();
    const entries = [];
    for (const name of all.slice(0, 500)) {
      try {
        const safe = await projectPath(root, [path, name].filter(Boolean).join('/')), info = await stat(safe);
        if (info.isDirectory() || info.isFile()) entries.push({ name, directory: info.isDirectory(), size: info.size });
      } catch { /* Out-of-project symlinks are not listed. */ }
    }
    return { root, path, entries, truncated: all.length > 500 };
  }
  if (method === 'project.read') {
    const handle = await open(file, 'r');
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > 4 * 1024 * 1024) throw new RpcError('too_large', '文件超过 4 MB 或不是普通文件');
      const buffer = Buffer.alloc(info.size + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead > info.size) throw new RpcError('file_changed', '文件正在变化，请重试');
      const data = buffer.subarray(0, bytesRead);
      const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.pdf': 'application/pdf' }[extname(file).toLowerCase()] ?? 'application/octet-stream';
      let text;
      if (!data.includes(0) && data.length <= 512 * 1024) { try { text = new TextDecoder('utf-8', { fatal: true }).decode(data); } catch {} }
      return { name: basename(file), mime_type: mime, size: data.length, data_base64: data.toString('base64'), ...(text === undefined ? {} : { text }) };
    } finally { await handle.close(); }
  }
  if (method === 'project.diff') {
    const args = ['-C', root, 'diff', '--no-ext-diff', '--no-textconv', '--color=never'];
    const [working, staged] = await Promise.all([run('git', [...args, '--', '.'], undefined, 512 * 1024), run('git', [...args, '--cached', '--', '.'], undefined, 512 * 1024)]);
    return { root, working, staged, truncated: false };
  }
  throw new RpcError('method_not_found', '不支持这个项目操作');
}
