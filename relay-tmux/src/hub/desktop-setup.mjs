#!/usr/bin/env node
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, mkdir, readFile, writeFile, lstat, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { RpcPeer } from './rpc.mjs';
import { desktopParent } from './desktop-bridge.mjs';

const exec = promisify(execFile);
const shellQuote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const here = dirname(fileURLToPath(import.meta.url));

export function desktopIsRunning(processList, app) {
  return processList.split('\n').some((line) => line.trim() === app || line.trim().startsWith(app + ' '));
}

async function running(manifest) {
  const { stdout } = await exec('ps', ['-axo', 'command='], { maxBuffer: 8 * 1024 * 1024 });
  return desktopIsRunning(stdout, manifest.app);
}

async function check(manifest) {
  const owner = JSON.parse(await readFile(manifest.socket + '.lock', 'utf8'));
  if (owner.desktop_app !== manifest.app || !Number.isInteger(owner.parent_pid) || !await desktopParent(manifest.app, owner.parent_pid)) throw new Error('The control socket does not belong to the desktop app');
  const peer = new RpcPeer({ socketPath: manifest.socket, codex: true, timeoutMs: 5000 });
  try { const { data } = await peer.call('thread/loaded/list'); return { connected: true, loaded_threads: data.length }; }
  finally { peer.close(); }
}

async function launch(manifest, directory) {
  if (await running(manifest)) throw new Error('The desktop app is still running. Quit it normally and let the bridge launcher reopen it.');
  if (process.env.CODEX_APP_SERVER_WS_URL) throw new Error('An existing WebSocket override is set. Resolve it before using the desktop bridge.');
  // Keep startup diagnostics on this host instead of losing the actual failure.
  const log = await open(join(directory, 'desktop-startup.log'), 'a', 0o600);
  try {
    const child = spawn(manifest.app, [], { env: { ...process.env, CODEX_CLI_PATH: manifest.wrapper }, detached: true, stdio: ['ignore', log.fd, log.fd] });
    await new Promise((res, rej) => { child.once('spawn', res); child.once('error', rej); }); child.unref();
  } finally { await log.close(); }
}

/** Run outside the desktop app so its normal exit cannot interrupt the handoff. */
export async function waitAndLaunch(manifest, directory) {
  const statusFile = join(directory, 'pending-launch.json');
  const status = async (state, extra = {}) => writeFile(statusFile, JSON.stringify({ state, ...extra, updated_at: new Date().toISOString() }) + '\n', { mode: 0o600 });
  await status('waiting_for_desktop_exit');
  while (await running(manifest)) await delay(250);
  await status('launching');
  // Updates may briefly move the app bundle. Retry the same intended launch;
  // never terminate an app which the user has already reopened themselves.
  let launched = false;
  for (let attempt = 0; attempt < 20; attempt++) {
    try { await launch(manifest, directory); launched = true; break; }
    catch (error) {
      if (await running(manifest)) {
        await status('waiting_for_desktop_exit', { reason: 'App reopened before the bridge launcher; quit it and wait for automatic reopening.' });
        while (await running(manifest)) await delay(250);
      } else if (attempt === 19) { await status('launch_failed', { reason: error.message }); throw error; }
      await delay(500);
    }
  }
  if (!launched) { await status('launch_failed', { reason: 'The desktop app kept reopening before the bridge handoff.' }); throw new Error('Desktop handoff could not complete'); }
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      const result = await check(manifest); await status('connected', result); return result;
    } catch { await delay(1000); }
  }
  await status('launch_requires_check', { reason: 'The app was launched but its bridge did not become available. See desktop-startup.log.' });
  throw new Error('Desktop started, but the bridge did not become available; see the local desktop-startup.log');
}

async function executable(paths) {
  for (const path of paths) { try { await access(path, constants.X_OK); return path; } catch {} }
  throw new Error('Cannot find the desktop application and its bundled Codex executable');
}

export async function prepareDesktop({ appPath = '/Applications/ChatGPT.app', directory = join(homedir(), '.cmuxremote', 'desktop') } = {}) {
  if (process.platform !== 'darwin') throw new Error('Desktop bridge preparation currently supports macOS');
  appPath = resolve(appPath); directory = resolve(directory);
  const app = await executable(['ChatGPT', 'Codex'].map((name) => join(appPath, 'Contents', 'MacOS', name)));
  const codex = await executable([join(appPath, 'Contents', 'Resources', 'codex-cli', 'CodexCLI.app', 'Contents', 'MacOS', 'codex'), join(appPath, 'Contents', 'Resources', 'codex')]);
  // Preserve the app's signed process ancestry for its native tool channels.
  const bridgeNode = await executable([join(appPath, 'Contents', 'Resources', 'cua_node', 'bin', 'node'), process.execPath]);
  const { stdout: version } = await exec(codex, ['--version']);
  const { stdout: help } = await exec(codex, ['app-server', '--help']);
  if (!help.includes('unix://')) throw new Error('This Codex version does not support the required Unix socket transport');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) || info.uid !== process.getuid()) throw new Error('Use a directory owned by you with permissions 0700');
  const socket = join(directory, 'codex.sock');
  if (Buffer.byteLength(socket) > 100) throw new Error('Choose a shorter bridge directory (Unix socket path limit)');
  const wrapper = join(directory, 'codex-bridge'), manifest = join(directory, 'desktop.json'), launcher = join(directory, 'Launch Panecast Codex.command');
  const source = { id: 'codex-desktop', name: 'Codex 桌面会话', type: 'codex', mode: 'attach', socket, executable: codex, desktop_app: app };
  // Exclusive creation: preparing twice never rewrites an installed launch configuration.
  const artifacts = [
    [wrapper, `#!/bin/sh\nexport PANECAST_CODEX_EXECUTABLE=${shellQuote(codex)}\nexport PANECAST_CODEX_SOCKET=${shellQuote(socket)}\nexport PANECAST_DESKTOP_APP_EXECUTABLE=${shellQuote(app)}\nexec ${shellQuote(bridgeNode)} ${shellQuote(join(here, 'desktop-bridge.mjs'))} "$@"\n`, 0o700],
    [manifest, JSON.stringify({ app, codex, wrapper, socket, bridge_node: bridgeNode, codex_version: version.trim() }, null, 2) + '\n', 0o600],
    [join(directory, 'source.json'), JSON.stringify(source, null, 2) + '\n', 0o600],
    [launcher, `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(fileURLToPath(import.meta.url))} launch --manifest ${shellQuote(manifest)}\n`, 0o700],
  ];
  for (const [path] of artifacts) { try { await lstat(path); throw new Error(`Preparation already exists: ${path}`); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
  for (const [path, contents, mode] of artifacts) await writeFile(path, contents, { mode, flag: 'wx' });
  return { directory, launcher, manifest, sourceFile: join(directory, 'source.json'), version: version.trim() };
}

export async function desktopMain(args) {
  const flag = (name) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
  if (args[0] === 'prepare') {
    console.log(JSON.stringify(await prepareDesktop({ appPath: flag('--app'), directory: flag('--directory') }), null, 2));
    return;
  }
  const manifestPath = resolve(flag('--manifest') ?? join(homedir(), '.cmuxremote', 'desktop', 'desktop.json'));
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (args[0] === 'check') {
    try { await access(manifest.socket); } catch { throw new Error('Desktop control socket is unavailable. Open the app with the prepared launcher after its current tasks finish.'); }
    console.log(JSON.stringify({ ...await check(manifest), socket: manifest.socket }));
  } else if (args[0] === 'wait-and-launch') {
    console.log(JSON.stringify(await waitAndLaunch(manifest, dirname(manifestPath))));
  } else if (args[0] === 'launch') {
    await launch(manifest, dirname(manifestPath));
    console.log('Desktop app launched with the Panecast bridge. Run the check command after startup.');
  } else throw new Error('Usage: desktop prepare [--app PATH] [--directory PATH] | check | launch | wait-and-launch [--manifest PATH]');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) desktopMain(process.argv.slice(2)).catch((error) => { console.error(error.message); process.exitCode = 1; });
