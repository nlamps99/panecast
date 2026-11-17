import { execFile } from 'node:child_process';
import { basename } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The Antigravity CLI's executable names (cmux's own registration uses the same). */
const NAMES = new Set(['agy', 'antigravity']);
const LIST_TTL_MS = 3_000;
const PROCESS_TTL_MS = 10_000;

/**
 * Which Antigravity CLI conversation runs in a cmux terminal, when cmux
 * itself holds no resume binding for it. Advisory and read-only: it looks at
 * `agy` processes whose environment names the terminal (cmux sets
 * CMUX_WORKSPACE_ID / CMUX_SURFACE_ID in every terminal), then at the
 * conversation id on their command line (`--conversation <id>`) or the
 * presence lock each running `agy` holds open
 * (~/.gemini/antigravity-cli/presence/<id>.lock).
 */
export class AntigravityProcesses {
  constructor(run = exec) { this.run = run; this.list = null; this.processes = new Map(); }

  async binding(workspaceId, surfaceId) {
    if (!['darwin', 'linux'].includes(process.platform) || !surfaceId) return null;
    for (const pid of await this.candidates()) {
      const found = await this.inspect(pid);
      if (found && same(found.surfaceId, surfaceId) && (!found.workspaceId || !workspaceId || same(found.workspaceId, workspaceId)) && found.conversationId) {
        return { kind: 'antigravity', checkpoint_id: found.conversationId.toLowerCase(), execution_location: 'local' };
      }
    }
    return null;
  }

  /** Running agy processes; one `ps` for every terminal polled within a few seconds. */
  async candidates() {
    if (this.list && Date.now() - this.list.at < LIST_TTL_MS) return this.list.pids;
    let pids = [];
    try {
      const { stdout } = await this.run('ps', ['-axo', 'pid=,comm='], { timeout: 2000, maxBuffer: 4 * 1024 * 1024 });
      pids = stdout.split('\n').flatMap((line) => {
        const match = /^\s*(\d+)\s+(.+)$/.exec(line);
        return match && NAMES.has(basename(match[2].trim())) ? [Number(match[1])] : [];
      });
    } catch { /* No process list: nothing to bind. */ }
    this.list = { at: Date.now(), pids };
    return pids;
  }

  async inspect(pid) {
    const cached = this.processes.get(pid);
    if (cached && Date.now() - cached.at < PROCESS_TTL_MS) return cached.value;
    let value = null;
    try {
      const { stdout: command } = await this.run('ps', ['ww', '-p', String(pid), '-o', 'command='], { timeout: 1500 });
      const { stdout: environment } = await this.run('ps', ['eww', '-p', String(pid), '-o', 'command='], { timeout: 1500, maxBuffer: 512 * 1024 });
      const full = environment.trimStart(), prefix = command.trim();
      const variables = full.startsWith(prefix) ? full.slice(prefix.length) : '';
      const field = (name) => new RegExp(`(?:^|\\s)${name}=([^\\s]*)`).exec(variables)?.[1];
      const argument = /(?:^|\s)--conversation(?:=|\s+)([0-9a-f-]{36})(?:\s|$)/i.exec(prefix)?.[1];
      value = { surfaceId: field('CMUX_SURFACE_ID') ?? null, workspaceId: field('CMUX_WORKSPACE_ID') ?? null,
        conversationId: UUID.test(argument ?? '') ? argument : await this.presence(pid) };
    } catch { /* The process may have exited. */ }
    this.processes.set(pid, { at: Date.now(), value });
    for (const [key, entry] of this.processes) if (Date.now() - entry.at > PROCESS_TTL_MS * 6) this.processes.delete(key);
    return value;
  }

  /** The conversation whose presence lock this process holds open. */
  async presence(pid) {
    let output = '';
    try { ({ stdout: output } = await this.run('lsof', ['-nP', '-Fn', '-p', String(pid)], { timeout: 2000, maxBuffer: 4 * 1024 * 1024 })); }
    catch (error) { output = error.stdout ?? ''; }
    for (const line of output.split('\n')) {
      const match = /^n.*\/antigravity-cli\/presence\/([0-9a-f-]{36})\.lock$/i.exec(line);
      if (match && UUID.test(match[1])) return match[1];
    }
    return null;
  }
}

const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
