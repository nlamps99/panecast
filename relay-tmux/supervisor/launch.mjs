#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { spawn, execFileSync } from 'node:child_process';
import { MANAGER_PROMPT, TOOLS } from './tools.mjs';

const path = process.argv[2], spec = JSON.parse(await readFile(path, 'utf8'));
const env = { ...process.env }; delete env.CLAUDECODE;
let previous;
try { previous = JSON.parse(await readFile(path + '.process.json', 'utf8')); } catch {}
if (previous?.sessionId === spec.sessionId && Number.isSafeInteger(previous.pid)) {
  let command = ''; try { command = execFileSync('/bin/ps', ['-p', String(previous.pid), '-o', 'command='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch {}
  if (command.includes(spec.sessionId)) { console.error('这个监工或执行者仍在运行，已阻止重复启动。'); process.exit(1); }
}
const resuming = process.argv.includes('--resume') || previous?.sessionId === spec.sessionId;
const args = [resuming ? '--resume' : '--session-id', spec.sessionId, '--name', spec.title];
if (spec.role === 'manager') args.push('--tools', '', '--strict-mcp-config', '--mcp-config', spec.mcpConfig,
  '--allowedTools', TOOLS.map(tool => `mcp__panecast_supervisor__${tool.name}`).join(','), '--permission-mode', 'dontAsk', '--system-prompt', MANAGER_PROMPT);
// Start the manager's TUI first. The host waits for the MCP tools/list handshake
// before injecting its first wake, so the first model turn has its tools.
if (spec.role !== 'manager' && !resuming) args.push('--', spec.goal);
const child = spawn(spec.binary, args, { cwd: spec.cwd, env, stdio: 'inherit' });
await writeFile(path + '.process.json', JSON.stringify({ pid: child.pid, sessionId: spec.sessionId, startedAt: Date.now() }), { mode: 0o600 });
child.once('error', () => { console.error('无法启动 Claude Code，请检查安装和登录状态。'); process.exitCode = 1; });
child.once('exit', code => { process.exitCode = code ?? 1; });
