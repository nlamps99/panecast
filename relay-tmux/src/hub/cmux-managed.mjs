import { execFile, spawn as spawnProcess } from 'node:child_process';
import { constants } from 'node:fs';
import { access, chmod, mkdir, open, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import net from 'node:net';

/**
 * The gateway runs its own copy of the Swift cmux relay, one per cmux app on
 * this computer (the official app, nightly, or a self-hosted build such as
 * cmux DR2), so each app is a separate source. Every relay listens on
 * loopback only, keeps its devices in its own state directory, is pinned to
 * its app with `cmux_variant`, and starts and stops with the gateway.
 */
export const MANAGED_DEVICE_ID = 'panecast-gateway';
export const STATE_DIRECTORY_NAME = 'cmux-gateway';
const CAPABILITY_FILE = 'socket-control-capability';
const VARIANT = /^(?:stable|(?:dev|nightly|rc|staging)(?:-[a-z0-9-]*[a-z0-9])?)$/;
const exec = promisify(execFile);
const exists = (path) => access(path).then(() => true, () => false);

export const isCmuxVariant = (name) => typeof name === 'string' && name.length <= 64 && VARIANT.test(name);

/** The variant cmux derives from its bundle ID, which names its socket markers. */
export function variantFromBundleId(bundleId) {
  const id = String(bundleId ?? '').trim();
  if (id === 'com.cmuxterm.app') return 'stable';
  for (const [prefix, base] of [['com.cmuxterm.app.debug', 'dev'], ['com.cmuxterm.app.nightly', 'nightly'], ['com.cmuxterm.app.rc', 'rc'], ['com.cmuxterm.app.staging', 'staging']]) {
    if (id === prefix) return base;
    if (id.startsWith(`${prefix}.`)) {
      const tag = id.slice(prefix.length + 1).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
      const variant = tag ? `${base}-${tag}` : base;
      return isCmuxVariant(variant) ? variant : null;
    }
  }
  return null;
}

/** State directory of the relay for one variant. The stable app keeps the original directory. */
export const stateDirectoryFor = (base, variant) => (variant === 'stable' ? base : `${base}-${variant}`);

/** Source ID and display name for a variant. */
export function sourceIdentity(variant, appName) {
  return variant === 'stable' ? { id: 'cmux', name: 'cmux' } : { id: `cmux-${variant}`, name: appName || `cmux (${variant})` };
}

/** The relay binary shipped in the package (`vendor/darwin/cmux-relay`), or an explicit override. */
export async function bundledRelay({ env = process.env, platform = process.platform,
  root = fileURLToPath(new URL('../../', import.meta.url)) } = {}) {
  const candidates = env.PANECAST_CMUX_RELAY ? [env.PANECAST_CMUX_RELAY]
    : platform === 'darwin' ? [join(root, 'vendor', 'darwin', 'cmux-relay')] : [];
  for (const path of candidates) if (await access(path, constants.X_OK).then(() => true, () => false)) return path;
  return null;
}

async function readAppBundle(path) {
  const value = async (key) => (await exec('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', join(path, 'Contents', 'Info.plist')])).stdout.trim();
  const id = await value('CFBundleIdentifier');
  return { id, name: await value('CFBundleDisplayName').catch(() => value('CFBundleName')).catch(() => '') };
}

/**
 * Every cmux app installed or run on this computer: installed apps (they carry
 * a display name) and apps known only from a socket marker, the official app
 * first. Returns `[{ variant, name }]`.
 */
export async function cmuxInstallations({ home = homedir(), tmpDirectory = '/tmp',
  applicationDirectories = ['/Applications', join(home, 'Applications')], readBundle = readAppBundle } = {}) {
  const found = new Map();
  const add = (variant, name = '') => {
    if (!isCmuxVariant(variant)) return;
    if (!found.has(variant) || (!found.get(variant).name && name)) found.set(variant, { variant, name });
  };
  for (const directory of applicationDirectories) {
    for (const entry of (await readdir(directory).catch(() => [])).filter((n) => /^cmux\b.*\.app$/i.test(n)).sort()) {
      const bundle = await readBundle(join(directory, entry)).catch(() => null);
      const variant = variantFromBundleId(bundle?.id);
      if (variant) add(variant, bundle.name);
    }
  }
  for (const name of await readdir(tmpDirectory).catch(() => [])) {
    if (name === 'cmux-last-socket-path') add('stable');
    else { const match = /^cmux-(.+)-last-socket-path$/.exec(name); if (match) add(match[1]); }
  }
  for (const name of await readdir(join(home, '.local', 'state', 'cmux')).catch(() => [])) {
    if (name === 'last-socket-path') add('stable');
    else { const match = /^(.+)-last-socket-path$/.exec(name); if (match) add(match[1]); }
  }
  // The official app first; other apps keep discovery order.
  return [...found.values()].sort((a, b) => Number(b.variant === 'stable') - Number(a.variant === 'stable'));
}

/** Whether any cmux app is installed or has run on this computer. */
export async function cmuxPresent(options) {
  return (await cmuxInstallations(options)).length > 0;
}

/** Finds a free loopback port, preferring the one after the classic relay's 4399/4400. */
export async function freePort(preferred = 4401, attempts = 50, exclude = new Set()) {
  const tryPort = (port) => new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
  for (let port = preferred; port < preferred + attempts; port++) if (!exclude.has(port) && await tryPort(port)) return port;
  throw new Error('No free loopback port for the cmux relay');
}

/**
 * Prepares one managed relay and returns the hub source that reaches it.
 * The relay must not be running: it reads its device store only at startup.
 */
export async function provisionManagedCmux({ stateDirectory, binary, port, variant, exclude, run = exec }) {
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  await chmod(stateDirectory, 0o700);
  const listenPort = port ?? await freePort(4401, 50, exclude);
  // Loopback only and no pairing routes: the gateway is the relay's only client.
  await writeAtomic(join(stateDirectory, 'relay.json'), JSON.stringify({
    listen: `127.0.0.1:${listenPort}`, transport: 'direct', ...(variant ? { cmux_variant: variant } : {}),
  }, null, 2) + '\n');
  const { stdout } = await run(binary, ['devices', 'add', '--device-id', MANAGED_DEVICE_ID, '--name', 'Panecast 网关', '--state-dir', stateDirectory], { timeout: 15_000 });
  const { device_id: deviceId, token } = JSON.parse(stdout);
  if (deviceId !== MANAGED_DEVICE_ID || typeof token !== 'string' || !token) throw new Error('cmux relay returned an incomplete credential');
  return { name: 'cmux', type: 'cmux', url: `ws://127.0.0.1:${listenPort}/v1/ws`, device_id: deviceId, token, managed: true,
    state_dir: stateDirectory, ...(variant ? { variant } : {}) };
}

/** Pins an existing managed relay (created before variants existed) to one cmux app. */
export async function pinRelayVariant(stateDirectory, variant) {
  if (!isCmuxVariant(variant)) throw new Error('Invalid cmux variant');
  const path = join(stateDirectory, 'relay.json');
  const config = JSON.parse(await readFile(path, 'utf8'));
  await writeAtomic(path, JSON.stringify({ ...config, cmux_variant: variant }, null, 2) + '\n');
}

/**
 * Saves the socket capability cmux gives to processes started inside its own
 * terminals. cmux's default access mode only admits those processes, so a
 * relay started by launchd needs this saved capability. The capability is
 * bound to the app named by CMUX_BUNDLE_ID, so it goes only to that app's
 * relay. Returns true when the stored value changed.
 */
export async function captureCmuxCapability(configPath, env = process.env) {
  const capability = env.CMUX_SOCKET_CAPABILITY?.trim();
  if (!capability || /\s/.test(capability)) return false;
  const variant = env.CMUX_BUNDLE_ID ? variantFromBundleId(env.CMUX_BUNDLE_ID) : 'stable';
  if (!variant) return false;
  let sources = [];
  try { sources = JSON.parse(await readFile(configPath, 'utf8')).sources ?? []; } catch {}
  const pinned = sources.find((s) => s?.type === 'cmux' && s.managed && s.variant === variant && typeof s.state_dir === 'string');
  const stateDirectory = pinned?.state_dir ?? stateDirectoryFor(join(dirname(configPath), STATE_DIRECTORY_NAME), variant);
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

/** Keeps one relay per managed cmux source running while the hub runs. */
export class ManagedCmuxRelay {
  constructor({ binary, spawn = spawnProcess, log = () => {}, minimumDelay = 1000, maximumDelay = 30_000 } = {}) {
    Object.assign(this, { binary, spawn, log, minimumDelay, maximumDelay });
    this.relays = new Map();
    this.queue = Promise.resolve();
  }

  /** Starts, restarts or stops relays to match the configured sources. Calls run one at a time. */
  sync(sources = []) {
    const run = this.queue.then(() => this.apply(sources));
    this.queue = run.catch(() => {});
    return run;
  }

  async apply(sources) {
    const desired = new Map();
    if (this.binary) {
      for (const s of sources) {
        if (s?.type !== 'cmux' || !s.managed || typeof s.state_dir !== 'string' || desired.has(s.state_dir)) continue;
        desired.set(s.state_dir, JSON.stringify([s.state_dir, s.url, s.token, s.variant ?? null]));
      }
    }
    for (const [directory, relay] of this.relays) {
      if (desired.get(directory) === relay.key) continue;
      this.relays.delete(directory);
      await relay.stop();
    }
    for (const [directory, key] of desired) {
      if (this.relays.has(directory)) continue;
      const relay = new RelayProcess(this, directory, key);
      this.relays.set(directory, relay);
      await relay.launch();
    }
  }

  close() { return this.sync([]); }
}

/** One supervised relay: restarted with growing delays, stopped with the hub. */
class RelayProcess {
  constructor(owner, stateDirectory, key) {
    Object.assign(this, { owner, stateDirectory, key });
    this.child = null; this.timer = null; this.delay = owner.minimumDelay; this.stopped = false;
  }

  async launch() {
    const { owner, stateDirectory } = this;
    clearTimeout(this.timer); this.timer = null;
    await killStale(join(stateDirectory, 'relay.pid'));
    if (this.stopped) return;
    const env = { ...process.env, CMUX_NO_SELF_LOGIN: '1' };
    // Never inherit the launching terminal's capability or socket; they belong to that terminal.
    delete env.CMUX_SOCKET_CAPABILITY; delete env.CMUX_SOCKET_PATH; delete env.CMUX_SOCKET;
    if (await exists(join(stateDirectory, CAPABILITY_FILE))) env.CMUX_SOCKET_CAPABILITY_FILE = join(stateDirectory, CAPABILITY_FILE);
    const logPath = join(stateDirectory, 'relay.log');
    if ((await stat(logPath).catch(() => null))?.size > 5 * 1024 * 1024) await rename(logPath, `${logPath}.1`).catch(() => {});
    const log = await open(logPath, 'a', 0o600);
    let child;
    try {
      child = owner.spawn(owner.binary, ['serve', '--config', join(stateDirectory, 'relay.json'), '--state-dir', stateDirectory],
        { env, stdio: ['ignore', log.fd, log.fd] });
      // Listen before awaiting anything: a relay that fails at once can exit
      // within milliseconds, and a missed exit would never be restarted.
      this.watch(child);
    } finally { await log.close(); }
    if (child.pid) await writeFile(join(stateDirectory, 'relay.pid'), `${child.pid}\n`, { mode: 0o600 }).catch(() => {});
  }

  watch(child) {
    const { owner } = this;
    this.child = child;
    const startedAt = Date.now();
    child.once('error', () => owner.log('cmux relay could not start'));
    child.once('exit', (code, signal) => {
      if (this.child !== child) return;
      this.child = null;
      if (this.stopped) return;
      // A relay that stayed up for a minute was healthy; start the backoff over.
      if (Date.now() - startedAt > 60_000) this.delay = owner.minimumDelay;
      owner.log(`cmux relay exited (${signal ?? code}); restarting in ${Math.round(this.delay / 1000)}s`);
      this.timer = setTimeout(() => { void this.launch().catch(() => owner.log('cmux relay could not restart')); }, this.delay);
      this.timer.unref?.();
      this.delay = Math.min(this.delay * 2, owner.maximumDelay);
    });
  }

  async stop() {
    this.stopped = true;
    clearTimeout(this.timer); this.timer = null;
    const child = this.child;
    this.child = null;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill('SIGTERM');
    const timeout = setTimeout(() => child.kill('SIGKILL'), 3000);
    await exited; clearTimeout(timeout);
    await unlink(join(this.stateDirectory, 'relay.pid')).catch(() => {});
  }
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
