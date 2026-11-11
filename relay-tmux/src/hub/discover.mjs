import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir, hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { lanAddress } from '../installation.mjs';
import { bundledRelay, cmuxPresent, provisionManagedCmux, STATE_DIRECTORY_NAME } from './cmux-managed.mjs';
import { usableCmux } from './registry.mjs';

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
 * Starts the gateway's own loopback relay when cmux is present but no relay
 * accepts the gateway, which is the case after a plain `panecast` install.
 */
async function managedCmuxSource({ home, managed }) {
  if (!managed?.stateDirectory) return null;
  const binary = managed.binary === undefined ? await bundledRelay() : managed.binary;
  if (!binary || !await (managed.present ?? (() => cmuxPresent({ home })))()) return null;
  try { return await provisionManagedCmux({ stateDirectory: managed.stateDirectory, binary, run: managed.run }); }
  catch { return null; }
}

/** Returns the given sources plus every source this computer can provide. Existing entries are kept as they are. */
export async function discoverSources(sources = [], { home = homedir(), lanHost = lanAddress(), fetch: request = fetch, tmux = tmuxInstalled, managed } = {}) {
  const next = [...sources], added = [];
  const freeId = (base) => { let id = base; for (let n = 2; next.some((s) => s.id === id); n++) id = `${base}-${n}`; return id; };
  const add = (source) => { const entry = { ...source, id: freeId(source.id) }; next.push(entry); added.push(entry); };
  if (!next.some((s) => s.type === 'tmux') && tmux()) add({ id: 'tmux', name: 'tmux', type: 'tmux' });
  if (!next.some((s) => s.type === 'codex' && s.mode !== 'attach') && await exists(join(home, '.codex'))) add({ id: 'codex', name: 'Codex', type: 'codex', mode: 'managed' });
  try {
    const { enabled, access: _access, ...desktop } = JSON.parse(await readFile(join(home, '.cmuxremote', 'desktop', 'source.json'), 'utf8'));
    if (desktop.type === 'codex' && typeof desktop.id === 'string' && !next.some((s) => s.id === desktop.id)) add(desktop);
  } catch {}
  if (!next.some(usableCmux)) {
    const cmux = await cmuxSource({ home, lanHost, fetch: request }) ?? await managedCmuxSource({ home, managed });
    if (cmux) {
      const placeholder = next.findIndex((s) => s.type === 'cmux');
      if (placeholder >= 0) { next[placeholder] = { ...cmux, id: next[placeholder].id }; added.push(next[placeholder]); }
      else add({ id: 'cmux', ...cmux });
    }
  }
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
