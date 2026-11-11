#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import net from 'node:net';
import { createInterface } from 'node:readline/promises';
import qrcode from 'qrcode-terminal';
import { createTmuxRelay } from './server.mjs';
import { TmuxBackend } from './tmux.mjs';

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
const command = args[0] ?? 'serve';
const path = resolve(flag('--config') ?? join(homedir(), '.cmuxremote', 'tmux-relay.json'));
async function main() {
  const config = JSON.parse(await readFile(path, 'utf8'));
  if (command === 'serve') {
    const relay = await createTmuxRelay(config);
    try { await relay.start(); } catch (error) { await relay.close(); throw error; }
    console.log('Panecast tmux relay started');
    const stop = async () => { await relay.close(); process.exit(0); };
    process.once('SIGTERM', stop); process.once('SIGINT', stop);
  } else if (command === 'pair') {
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
      url.searchParams.set('lan', `http://${flag('--lan-host')}:${config.port ?? 4399}`); url.searchParams.set('lancode', config.lan.pairing_code);
    }
    if (args.includes('--url-only')) console.log(url.toString());
    else { qrcode.generate(url.toString(), { small: true }); console.log('Scan this code with Panecast.'); }
  } else if (command === 'notify') {
    const backend = new TmuxBackend({ socketName: config.tmux_socket });
    const surface = flag('--surface') ?? process.env.TMUX_PANE;
    if (!surface) throw new Error('Run inside tmux or supply --surface %N');
    const workspace = flag('--workspace') ?? (await backend.tmux(['display-message', '-p', '-t', surface, '#{session_id}'])).trim();
    const socketPath = config.notify_socket ?? join(config.state_directory ?? join(homedir(), '.cmuxremote', 'tmux'), 'notify.sock');
    await new Promise((res, rej) => {
      const socket = net.connect(socketPath); let response = '';
      socket.setTimeout(10_000, () => socket.destroy(new Error('Notification timed out')));
      socket.on('error', rej);
      socket.on('connect', () => socket.write(JSON.stringify({ workspace_id: workspace, surface_id: surface, title: flag('--title') ?? '终端通知', body: flag('--body') ?? '', status: args.includes('--needs-input') ? 'needs input' : args.includes('--failed') ? 'failed' : args.includes('--completed') ? 'completed' : undefined, needs_input: args.includes('--needs-input') }) + '\n'));
      socket.on('data', (chunk) => { response += chunk; });
      socket.on('end', () => { try { if (!JSON.parse(response).ok) throw new Error('Notification rejected'); res(); } catch (error) { rej(error); } });
    });
  } else throw new Error('Usage: node src/cli.mjs serve|pair|notify [--config path]');
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
