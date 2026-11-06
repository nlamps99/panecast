#!/usr/bin/env node
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, stat, mkdir, open, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import net from 'node:net';
import { WebSocket } from 'ws';

const SUBCOMMANDS = new Set(['daemon', 'proxy', 'generate-ts', 'generate-json-schema', 'help']);
const exec = promisify(execFile);

export function isDesktopParent(command, expectedApp) {
  const value = command.trim();
  return typeof expectedApp === 'string' && expectedApp.length > 0 && (value === expectedApp || value.startsWith(expectedApp + ' '));
}

export async function desktopParent(expectedApp, pid = process.ppid) {
  if (!expectedApp) return false;
  try { const { stdout } = await exec('ps', ['-p', String(pid), '-o', 'command=']); return isDesktopParent(stdout, expectedApp); }
  catch { return false; }
}

export function bridgeArguments(args, socketPath) {
  const position = args.indexOf('app-server');
  if (position < 0 || SUBCOMMANDS.has(args[position + 1]) || args.some((arg) => ['--help', '-h', '--version', '-V', '--print-startup-config'].includes(arg))) return null;
  const result = [];
  for (let i = 0; i < args.length; i++) {
    if (i > position && args[i] === '--listen') { i++; continue; }
    if (i > position && (args[i] === '--stdio' || args[i].startsWith('--listen='))) continue;
    result.push(args[i]);
  }
  return [...result, '--listen', `unix://${socketPath}`];
}

async function absent(path) {
  try { await lstat(path); return false; } catch (error) { if (error.code === 'ENOENT') return true; throw error; }
}

async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  for (let i = 0; i < 40 && child.exitCode === null && child.signalCode === null; i++) await delay(50);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}

/** Preserve the desktop's stdio protocol and config; expose the same process on a private Unix socket. */
export async function runDesktopBridge({ executable, socketPath, args, input = process.stdin, output = process.stdout, env = process.env, bridgeAllowed = true }) {
  if (!executable || !isAbsolute(executable)) throw new Error('PANECAST_CODEX_EXECUTABLE must identify the real Codex binary');
  const serverArgs = bridgeAllowed ? bridgeArguments(args, socketPath) : null;
  if (!serverArgs) {
    const child = spawn(executable, args, { env, stdio: ['pipe', 'pipe', 'inherit'] });
    input.pipe(child.stdin); child.stdout.pipe(output, { end: false }); child.stdin.on('error', () => {});
    try { return await new Promise((res, rej) => { child.once('error', rej); child.once('exit', (code) => res(code ?? 1)); }); }
    finally { input.unpipe(child.stdin); input.pause(); }
  }
  if (!socketPath || !isAbsolute(socketPath) || Buffer.byteLength(socketPath) > 100) throw new Error('Use an absolute socket path shorter than 101 bytes');
  await mkdir(dirname(socketPath), { recursive: true, mode: 0o700 });
  const directory = await lstat(dirname(socketPath));
  if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o077) || (process.getuid && directory.uid !== process.getuid())) throw new Error('The bridge directory must be owned by this user with permissions 0700');
  const lockPath = `${socketPath}.lock`;
  const lock = await open(lockPath, 'wx', 0o600).catch(() => { throw new Error('A desktop bridge is already running, or its lock needs inspection'); });
  await lock.writeFile(JSON.stringify({ pid: process.pid, parent_pid: process.ppid, desktop_app: env.PANECAST_DESKTOP_APP_EXECUTABLE ?? null })); await lock.close();
  let server, transport, socketIdentity, failure, stopping = false;
  let onData, onEnd;
  let finish;
  const finished = new Promise((res) => { finish = res; });
  const onSignal = () => { stopping = true; finish(0); };
  process.once('SIGINT', onSignal); process.once('SIGTERM', onSignal); process.once('SIGHUP', onSignal);
  try {
    if (!(await absent(socketPath))) throw new Error('The socket already exists; the bridge will not replace another service');
    server = spawn(executable, serverArgs, { env, stdio: ['ignore', 'ignore', 'inherit'] });
    server.once('error', (error) => { failure = error; finish(1); });
    server.once('exit', (code) => { failure ??= new Error('Codex app-server exited'); finish(code ?? 1); });
    for (let i = 0; i < 200; i++) {
      if (stopping) return 0;
      if (failure) throw failure;
      if (!(await absent(socketPath))) {
        socketIdentity = await lstat(socketPath);
        // Codex can publish a symlink to its own short Unix socket on macOS.
        if ((await stat(socketPath).catch(() => null))?.isSocket()) break;
      }
      await delay(50);
    }
    if (!(await stat(socketPath).catch(() => null))?.isSocket()) throw new Error('Codex did not open its control socket');
    // The CLI's proxy command carries raw WebSocket bytes, not JSONL. Translate
    // the desktop's original stdio JSONL transport at the framing boundary.
    transport = new WebSocket('ws://localhost/rpc', { createConnection: () => net.connect(socketPath), maxPayload: 32 * 1024 * 1024 });
    transport.on('error', () => finish(1)); transport.on('close', () => finish(0));
    await new Promise((res, rej) => { transport.once('open', res); transport.once('error', rej); });
    transport.on('message', (data) => {
      if (!output.write(data.toString() + '\n')) { transport.pause(); output.once('drain', () => transport?.resume()); }
    });
    let buffer = '';
    input.setEncoding('utf8');
    onData = (chunk) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > 32 * 1024 * 1024) { finish(1); return; }
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        if (line.trim() && transport.readyState === WebSocket.OPEN) transport.send(line);
      }
    };
    onEnd = () => finish(0);
    input.on('data', onData); input.once('end', onEnd);
    return await finished;
  } finally {
    process.off('SIGINT', onSignal); process.off('SIGTERM', onSignal); process.off('SIGHUP', onSignal);
    if (onData) input.off('data', onData);
    if (onEnd) input.off('end', onEnd);
    input.pause();
    transport?.terminate(); await stop(server);
    if (socketIdentity) {
      const current = await lstat(socketPath).catch(() => null);
      if (current?.ino === socketIdentity.ino && current.dev === socketIdentity.dev) await unlink(socketPath).catch(() => {});
    }
    await unlink(lockPath).catch(() => {});
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const bridgeAllowed = process.env.PANECAST_BRIDGE_TEST_OWNER === '1' || await desktopParent(process.env.PANECAST_DESKTOP_APP_EXECUTABLE);
  runDesktopBridge({ executable: process.env.PANECAST_CODEX_EXECUTABLE, socketPath: process.env.PANECAST_CODEX_SOCKET, args: process.argv.slice(2), bridgeAllowed })
    .then((code) => { process.exitCode = code; })
    .catch((error) => { console.error(`Panecast desktop bridge: ${error.message}`); process.exitCode = 1; });
}
