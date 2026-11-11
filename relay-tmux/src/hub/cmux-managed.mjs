import { execFile, spawn as spawnProcess } from 'node:child_process';
import { constants } from 'node:fs';
import { access, chmod, mkdir, open, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import net from 'node:net';

/**
 * The gateway runs its own copy of the Swift cmux relay when the computer has
 * cmux but no relay that the gateway can register with. The relay listens on
 * loopback only, keeps its devices in a separate state directory, and is
 * started, restarted and stopped together with the gateway.
 */
export const MANAGED_DEVICE_ID = 'panecast-gateway';
export const STATE_DIRECTORY_NAME = 'cmux-gateway';
const CAPABILITY_FILE = 'socket-control-capability';
const exec = promisify(execFile);
const exists = (path) => access(path).then(() => true, () => false);

/** The relay binary shipped in the package (`vendor/darwin/cmux-relay`), or an explicit override. */
export async function bundledRelay({ env = process.env, platform = process.platform,
  root = fileURLToPath(new URL('../../', import.meta.url)) } = {}) {
  const candidates = env.PANECAST_CMUX_RELAY ? [env.PANECAST_CMUX_RELAY]
    : platform === 'darwin' ? [join(root, 'vendor', 'darwin', 'cmux-relay')] : [];
  for (const path of candidates) if (await access(path, constants.X_OK).then(() => true, () => false)) return path;
  return null;
}

/** Whether cmux (official or a variant build such as cmux DR2) is installed or has run on this computer. */
export async function cmuxPresent({ home = homedir(), tmpDirectory = '/tmp',
  applicationDirectories = ['/Applications', join(home, 'Applications')] } = {}) {
  for (const directory of applicationDirectories) {
    const names = await readdir(directory).catch(() => []);
    if (names.some((name) => /^cmux\b.*\.app$/i.test(name))) return true;
  }
  const tmp = await readdir(tmpDirectory).catch(() => []);
  if (tmp.some((name) => /^cmux-(?:(?:dev|nightly|rc|staging)(?:-[a-z0-9-]+)?-)?last-socket-path$/.test(name))) return true;
  const state = await readdir(join(home, '.local', 'state', 'cmux')).catch(() => []);
  return state.some((name) => name.endsWith('last-socket-path'));
}

/** Finds a free loopback port, preferring the one after the classic relay's 4399/4400. */
export async function freePort(preferred = 4401, attempts = 50) {
  const tryPort = (port) => new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
  for (let port = preferred; port < preferred + attempts; port++) if (await tryPort(port)) return port;
  throw new Error('No free loopback port for the cmux relay');
}

/**
 * Prepares the managed relay and returns the hub source that reaches it.
 * The relay must not be running: it reads its device store only at startup.
 */
export async function provisionManagedCmux({ stateDirectory, binary, port, run = exec }) {
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  await chmod(stateDirectory, 0o700);
  const listenPort = port ?? await freePort();
  const relayConfig = join(stateDirectory, 'relay.json');
  // Loopback only and no pairing routes: the gateway is the relay's only client.
  await writeAtomic(relayConfig, JSON.stringify({ listen: `127.0.0.1:${listenPort}`, transport: 'direct' }, null, 2) + '\n');
  const { stdout } = await run(binary, ['devices', 'add', '--device-id', MANAGED_DEVICE_ID, '--name', 'Panecast 网关', '--state-dir', stateDirectory], { timeout: 15_000 });
  const { device_id: deviceId, token } = JSON.parse(stdout);
  if (deviceId !== MANAGED_DEVICE_ID || typeof token !== 'string' || !token) throw new Error('cmux relay returned an incomplete credential');
  return { name: 'cmux', type: 'cmux', url: `ws://127.0.0.1:${listenPort}/v1/ws`, device_id: deviceId, token, managed: true, state_dir: stateDirectory };
}

/**
 * Saves the socket capability cmux gives to processes started inside its own
 * terminals. cmux's default access mode only admits those processes, so a
 * relay started by launchd needs this saved capability. Returns true when the
 * stored value changed.
 */
export async function captureCmuxCapability(stateDirectory, env = process.env) {
  const capability = env.CMUX_SOCKET_CAPABILITY?.trim();
  if (!capability || /\s/.test(capability)) return false;
  const path = join(stateDirectory, CAPABILITY_FILE);
  if ((await readFile(path, 'utf8').catch(() => '')).trim() === capability) return false;
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  await writeAtomic(path, capability + '\n');
  return true;
}

async function writeAtomic(path, text) {
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, text, { mode: 0o600 });
  await rename(temporary, path);
}

/** Keeps the managed relay running while the hub config contains a managed cmux source. */
export class ManagedCmuxRelay {
  constructor({ binary, spawn = spawnProcess, log = () => {}, minimumDelay = 1000, maximumDelay = 30_000 } = {}) {
    Object.assign(this, { binary, spawn, log, minimumDelay, maximumDelay });
    this.stateDirectory = null; this.key = null; this.child = null; this.timer = null; this.delay = minimumDelay;
    this.queue = Promise.resolve();
  }

  /** Starts, restarts or stops the relay to match the configured sources. Calls run one at a time. */
  sync(sources = []) {
    const run = this.queue.then(() => this.apply(sources));
    this.queue = run.catch(() => {});
    return run;
  }

  async apply(sources) {
    const source = sources.find((s) => s?.type === 'cmux' && s.managed && typeof s.state_dir === 'string');
    const key = source && this.binary ? JSON.stringify([source.state_dir, source.url, source.token]) : null;
    if (key === this.key) return;
    await this.stop();
    this.key = key;
    this.stateDirectory = key ? source.state_dir : null;
    if (key) await this.launch();
  }

  async launch() {
    const stateDirectory = this.stateDirectory;
    if (!stateDirectory) return;
    clearTimeout(this.timer); this.timer = null;
    await killStale(join(stateDirectory, 'relay.pid'));
    if (this.stateDirectory !== stateDirectory) return;
    const env = { ...process.env, CMUX_NO_SELF_LOGIN: '1' };
    // Never inherit the launching terminal's capability or socket; they belong to that terminal.
    delete env.CMUX_SOCKET_CAPABILITY; delete env.CMUX_SOCKET_PATH; delete env.CMUX_SOCKET;
    if (await exists(join(stateDirectory, CAPABILITY_FILE))) env.CMUX_SOCKET_CAPABILITY_FILE = join(stateDirectory, CAPABILITY_FILE);
    const logPath = join(stateDirectory, 'relay.log');
    if ((await stat(logPath).catch(() => null))?.size > 5 * 1024 * 1024) await rename(logPath, `${logPath}.1`).catch(() => {});
    const log = await open(logPath, 'a', 0o600);
    let child;
    try {
      child = this.spawn(this.binary, ['serve', '--config', join(stateDirectory, 'relay.json'), '--state-dir', stateDirectory],
        { env, stdio: ['ignore', log.fd, log.fd] });
    } finally { await log.close(); }
    this.child = child;
    const startedAt = Date.now();
    if (child.pid) await writeFile(join(stateDirectory, 'relay.pid'), `${child.pid}\n`, { mode: 0o600 }).catch(() => {});
    child.once('error', () => this.log('cmux relay could not start'));
    child.once('exit', (code, signal) => {
      if (this.child !== child) return;
      this.child = null;
      if (this.stateDirectory !== stateDirectory) return;
      // A relay that stayed up for a minute was healthy; start the backoff over.
      if (Date.now() - startedAt > 60_000) this.delay = this.minimumDelay;
      this.log(`cmux relay exited (${signal ?? code}); restarting in ${Math.round(this.delay / 1000)}s`);
      this.timer = setTimeout(() => { void this.launch().catch(() => this.log('cmux relay could not restart')); }, this.delay);
      this.timer.unref?.();
      this.delay = Math.min(this.delay * 2, this.maximumDelay);
    });
  }

  async stop() {
    clearTimeout(this.timer); this.timer = null;
    const child = this.child, stateDirectory = this.stateDirectory;
    this.child = null; this.stateDirectory = null; this.key = null; this.delay = this.minimumDelay;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill('SIGTERM');
    const timeout = setTimeout(() => child.kill('SIGKILL'), 3000);
    await exited; clearTimeout(timeout);
    if (stateDirectory) await unlink(join(stateDirectory, 'relay.pid')).catch(() => {});
  }

  close() { return this.sync([]); }
}

/** Stops a relay left behind by a gateway that did not shut down cleanly. */
async function killStale(pidFile) {
  const pid = Number((await readFile(pidFile, 'utf8').catch(() => '')).trim());
  if (!Number.isInteger(pid) || pid <= 1) return;
  try {
    const { stdout } = await exec('ps', ['-p', String(pid), '-o', 'comm=']);
    if (!/cmux-relay$/.test(stdout.trim())) return;
    process.kill(pid, 'SIGTERM');
    for (let i = 0; i < 30; i++) { await new Promise((r) => setTimeout(r, 100)); process.kill(pid, 0); }
    process.kill(pid, 'SIGKILL');
  } catch {}
}
