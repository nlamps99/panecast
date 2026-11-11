#!/usr/bin/env node
import { readFile, writeFile, rename } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { randomUUID } from 'node:crypto';
import net from 'node:net';
import qrcode from 'qrcode-terminal';
import { TmuxBackend } from '../tmux.mjs';
import { scoped } from './ids.mjs';
import { SourceRegistry } from './registry.mjs';
import { createHub } from './server.mjs';

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
const path = resolve(flag('--config') ?? join(homedir(), '.cmuxremote', 'hub-relay.json'));

async function main() {
  const raw = await readFile(path, 'utf8'), config = JSON.parse(raw);
  if ((args[0] ?? 'serve') === 'serve') {
    const relay = await createHub(config);
    try { await relay.start(); } catch (error) { await relay.close(); throw error; }
    console.log('Panecast hub started');
    let previous = raw, loading = false;
    const timer = setInterval(async () => {
      if (loading) return;
      loading = true;
      try {
        const next = await readFile(path, 'utf8');
        if (next !== previous) { relay.reloadSources(JSON.parse(next).sources ?? []); previous = next; console.log('Source authorization updated'); }
      } catch { console.error('Cannot reload sources; check the local config file'); }
      finally { loading = false; }
    }, 1000);
    const stop = async () => { clearInterval(timer); await relay.close(); process.exit(0); };
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
  } else if (args[0] === 'sources') {
    const action = args[1] ?? 'list';
    if (action === 'list') {
      for (const s of config.sources ?? []) console.log(`${s.id}\t${s.type}\t${s.enabled === true ? s.access ?? 'read' : 'revoked'}\t${s.name ?? s.id}`);
      return;
    }
    const source = config.sources?.find((s) => s.id === args[2]);
    if (!source || !['grant', 'revoke'].includes(action)) throw new Error('Usage: sources list|grant|revoke SOURCE_ID [--access read|control]');
    source.enabled = action === 'grant';
    if (source.enabled) source.access = flag('--access') ?? 'read';
    const validation = new SourceRegistry(config.sources); validation.close();
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
    await rename(temporary, path);
    console.log(`${source.id}: ${source.enabled ? source.access : 'revoked'} (applies to a running hub within one second)`);
  } else if (args[0] === 'pair') {
    if (!config.broker?.url || !config.broker?.relay_id) throw new Error('Configure broker.url and broker.relay_id first');
    let code = config.broker.pairing_code;
    if (!code) {
      const prompt = createInterface({ input: process.stdin, output: process.stderr });
      try { code = (await prompt.question('Broker pairing code: ')).trim(); } finally { prompt.close(); }
    }
    if (!code) throw new Error('Pairing code is required');
    const url = new URL('cmux://pair');
    url.searchParams.set('server', config.broker.url); url.searchParams.set('relay', config.broker.relay_id); url.searchParams.set('code', code);
    if (config.lan?.pairing_code && flag('--lan-host')) {
      url.searchParams.set('lan', `http://${flag('--lan-host')}:${config.port ?? 4400}`); url.searchParams.set('lancode', config.lan.pairing_code);
    }
    if (args.includes('--url-only')) console.log(url.toString());
    else { qrcode.generate(url.toString(), { small: true }); console.log('Scan with Panecast to connect all authorized sources.'); }
  } else if (args[0] === 'notify') {
    const source = config.sources?.find((s) => s.id === flag('--source') && s.enabled && s.type === 'tmux');
    if (!source) throw new Error('Choose an authorized tmux source with --source SOURCE_ID');
    const backend = new TmuxBackend({ socketName: source.tmux_socket });
    const surface = flag('--surface') ?? process.env.TMUX_PANE;
    if (!surface) throw new Error('Run inside tmux or supply --surface');
    const workspace = flag('--workspace') ?? (await backend.tmux(['display-message', '-p', '-t', surface, '#{session_id}'])).trim();
    const notifyPath = config.notify_socket ?? join(config.state_directory ?? join(homedir(), '.cmuxremote', 'hub'), 'notify.sock');
    await new Promise((res, rej) => {
      const socket = net.connect(notifyPath); let response = '';
      socket.setTimeout(5000, () => socket.destroy(new Error('Notification timed out')));
      socket.on('error', rej);
      socket.on('connect', () => socket.write(JSON.stringify({ workspace_id: scoped(source.id, workspace), surface_id: scoped(source.id, surface),
        title: flag('--title') ?? '终端通知', body: flag('--body') ?? '', needs_input: args.includes('--needs-input'), status: args.includes('--needs-input') ? 'needs input' : args.includes('--failed') ? 'failed' : args.includes('--completed') ? 'completed' : undefined }) + '\n'));
      socket.on('data', (data) => { response += data; });
      socket.on('end', () => { try { if (!JSON.parse(response).ok) throw new Error('Notification rejected'); res(); } catch (error) { rej(error); } });
    });
  } else throw new Error('Usage: hub serve|pair|sources|notify [--config PATH]');
}

main().catch(() => { console.error('Hub command failed. Check the command, source authorization, and local configuration.'); process.exitCode = 1; });
