import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir, hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { lanAddress } from '../installation.mjs';
import { bundledRelay, cmuxInstallations, pinRelayVariant, provisionManagedCmux, sourceIdentity, stateDirectoryFor, STATE_DIRECTORY_NAME } from './cmux-managed.mjs';
import { usableCmux } from './registry.mjs';
import { findCmuxTui } from '../cmux-tui.mjs';

const exists = (path) => access(path).then(() => true, () => false);
const tmuxInstalled = () => spawnSync('tmux', ['-V'], { stdio: 'ignore' }).status === 0;

/** Registers the hub as a device of this computer's cmux relay through its LAN pairing route. */
async function cmuxSource({ home, lanHost, fetch: request }) {
  let relay;
  try { relay = JSON.parse(await readFile(join(home, '.cmuxremote', 'relay.json'), 'utf8')); } catch { return null; }
  const code = relay?.lan?.pairing_code;
  const [, host, port] = /^(.*):(\d+)$/.exec(String(relay?.listen ?? '0.0.0.0:4399')) ?? [];
  // The relay accepts LAN pairing only from private addresses, never loopback.
  if (typeof code !== 'string' || !code || relay.transport === 'broker' || !lanHost || !port || ['127.0.0.1', 'localhost', '[::1]'].includes(host)) return null;
  try {
    const response = await request(`http://${lanHost}:${port}/v1/devices/me/register`, {
      method: 'POST', signal: AbortSignal.timeout(5000), headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pairing_code: code, client_id: `panecast-hub-${hostname()}`, device_name: 'Panecast 网关' }),
    });
    if (!response.ok) return null;
    const { device_id: deviceId, token } = await response.json();
    if (typeof deviceId !== 'string' || typeof token !== 'string' || !deviceId || !token) return null;
    return { name: 'cmux', type: 'cmux', url: `ws://127.0.0.1:${port}/v1/ws`, device_id: deviceId, token };
  } catch { return null; }
}

/**
 * Gives every cmux app on this computer (official, nightly, self-hosted such
 * as cmux DR2) its own loopback relay and source, unless a relay already
 * serves it. A relay registered through LAN pairing serves the official app.
 */
async function manageCmuxApps({ home, managed, next, add, changed }) {
  if (!managed?.stateDirectory) return;
  const binary = managed.binary === undefined ? await bundledRelay() : managed.binary;
  if (!binary) return;
  const installations = await (managed.installations ?? (() => cmuxInstallations({ home })))();
  if (!installations.length) return;
  const nameOf = (variant) => installations.find((i) => i.variant === variant)?.name;
  const usable = next.filter(usableCmux);
  // Relays created before variants existed follow whichever cmux runs. Pin
  // them to the official app, or to the only app this computer has.
  for (const source of usable.filter((s) => s.managed && !s.variant)) {
    const variant = installations.some((i) => i.variant === 'stable') || installations.length > 1 ? 'stable' : installations[0].variant;
    try { await pinRelayVariant(source.state_dir, variant); } catch { continue; }
    Object.assign(source, { variant, ...(variant === 'stable' ? {} : { name: sourceIdentity(variant, nameOf(variant)).name }) });
    changed(source);
  }
  const covered = new Set(usable.map((s) => (s.managed ? s.variant : s.variant ?? 'stable')).filter(Boolean));
  const ports = new Set(next.filter((s) => s.type === 'cmux').map((s) => Number(/:(\d+)\//.exec(String(s.url))?.[1])).filter(Boolean));
  for (const { variant, name } of installations) {
    if (covered.has(variant)) continue;
    let source;
    try {
      source = await provisionManagedCmux({ stateDirectory: stateDirectoryFor(managed.stateDirectory, variant), binary, variant, exclude: ports, run: managed.run });
    } catch { continue; }
    ports.add(Number(/:(\d+)\//.exec(source.url)[1]));
    const identity = sourceIdentity(variant, name);
    const placeholder = next.findIndex((s) => s.type === 'cmux' && !usableCmux(s));
    if (variant === 'stable' && placeholder >= 0) { next[placeholder] = { ...source, ...identity, id: next[placeholder].id }; changed(next[placeholder]); }
    else add({ ...source, ...identity });
    covered.add(variant);
  }
}

/** Returns the given sources plus every source this computer can provide. Existing entries are kept as they are. */
export async function discoverSources(sources = [], { home = homedir(), lanHost = lanAddress(), fetch: request = fetch, tmux = tmuxInstalled, managed, cmuxTui = findCmuxTui, platform = process.platform } = {}) {
  const next = [...sources], added = [];
  const freeId = (base) => { let id = base; for (let n = 2; next.some((s) => s.id === id); n++) id = `${base}-${n}`; return id; };
  const add = (source) => { const entry = { ...source, id: freeId(source.id) }; next.push(entry); added.push(entry); };
  const changed = (source) => { if (!added.includes(source)) added.push(source); };
  if (!next.some((s) => s.type === 'tmux') && tmux()) add({ id: 'tmux', name: 'tmux', type: 'tmux' });
  if (!next.some((s) => s.type === 'codex' && s.mode !== 'attach') && await exists(join(home, '.codex'))) add({ id: 'codex', name: 'Codex', type: 'codex', mode: 'managed' });
  if (!next.some((s) => s.type === 'cmux-tui')) {
    // cmux DR2 for Windows ships the cmux TUI; the gateway keeps its main session running there.
    const binary = await cmuxTui();
    if (binary) add({ id: 'cmux-tui', name: platform === 'win32' ? 'cmux DR2' : 'cmux TUI', type: 'cmux-tui', binary, session: 'main', owner: platform === 'win32' });
  }
  try {
    const { enabled, access: _access, ...desktop } = JSON.parse(await readFile(join(home, '.cmuxremote', 'desktop', 'source.json'), 'utf8'));
    if (desktop.type === 'codex' && typeof desktop.id === 'string' && !next.some((s) => s.id === desktop.id)) add(desktop);
  } catch {}
  if (!next.some(usableCmux)) {
    const cmux = await cmuxSource({ home, lanHost, fetch: request });
    if (cmux) {
      const placeholder = next.findIndex((s) => s.type === 'cmux');
      if (placeholder >= 0) { next[placeholder] = { ...cmux, id: next[placeholder].id }; added.push(next[placeholder]); }
      else add({ id: 'cmux', ...cmux });
    }
  }
  await manageCmuxApps({ home, managed, next, add, changed });
  return { sources: next, added };
}

/** Adds discovered sources to the config file and returns their IDs. */
export async function discoverInto(path, options = {}) {
  const before = JSON.parse(await readFile(path, 'utf8'));
  const managed = { stateDirectory: join(dirname(path), STATE_DIRECTORY_NAME), ...options.managed };
  const { added } = await discoverSources(before.sources ?? [], { ...options, managed });
  if (!added.length) return [];
  // Discovery may wait on the network, so merge into the latest file instead of the snapshot.
  const config = JSON.parse(await readFile(path, 'utf8'));
  const ids = new Set(added.map((s) => s.id));
  config.sources = [...(config.sources ?? []).filter((s) => !ids.has(s.id)), ...added];
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  await rename(temporary, path);
  return [...ids];
}
