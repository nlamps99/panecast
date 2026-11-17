import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { homedir } from 'node:os';

const exec = promisify(execFile);
export const activeWriterError = (error) => error?.code === '-32600' && /already has an active writer/i.test(error.message ?? '');

/** Advisory discovery only. Codex's own lock acquisition remains authoritative. */
export async function inspectThreadWriter(config, threadId) {
  if (!/^[a-f0-9-]{36}$/i.test(threadId) || (config.url && !['localhost','127.0.0.1','[::1]'].includes(new URL(config.url).hostname))) return null;
  const file = join(config.codex_home ?? join(homedir(), '.codex'), 'thread-writer-locks', threadId + '.lock');
  let output;
  try { ({ stdout: output } = await exec('lsof', ['-nP', '-Fpn', '--', file], { timeout: 2000, maxBuffer: 32 * 1024 })); }
  catch (error) { if (error.code !== 1) throw error; output = error.stdout ?? ''; }
  const pids = [];
  for (const line of output.split('\n')) if (/^p\d+$/.test(line)) pids.push(Number(line.slice(1)));
  if (!pids.length) return null;
  for (const pid of pids) {
    try {
      const { stdout: command } = await exec('ps', ['ww', '-p', String(pid), '-o', 'command='], { timeout: 1500 });
      // A headless app-server can inherit terminal environment variables. It
      // must not be offered as if it were an interactive terminal session.
      if (/(?:^|\s)app-server(?:\s|$)/.test(command)) continue;
      const { stdout: environment } = await exec('ps', ['eww', '-p', String(pid), '-o', 'command='], { timeout: 1500, maxBuffer: 512 * 1024 });
      const full = environment.trimStart(), prefix = command.trim();
      if (!full.startsWith(prefix + ' ')) continue;
      const variables = full.slice(prefix.length);
      const field = (name) => new RegExp('(?:^|\\s)' + name + '=([^\\s]*)').exec(variables)?.[1];
      const pane = field('TMUX_PANE'), tmux = field('TMUX');
      if (pane && /^%\d+$/.test(pane) && tmux) return { pid, terminal: { backend: 'tmux', paneId: pane, socketPath: tmux.split(',')[0] } };
      const workspaceId = field('CMUX_WORKSPACE_ID'), surfaceId = field('CMUX_SURFACE_ID');
      if (/^[a-f0-9-]{36}$/i.test(workspaceId ?? '') && /^[a-f0-9-]{36}$/i.test(surfaceId ?? '')) return { pid, terminal: { backend: 'cmux', workspaceId, surfaceId } };
    } catch { /* The process may have exited during discovery. */ }
  }
  return { pid: pids[0], terminal: null };
}
