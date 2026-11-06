import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile, chmod, access } from 'node:fs/promises';
import { homedir, networkInterfaces } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';

export function configPath(args = []) {
  const i = args.indexOf('--config');
  if (i >= 0 && (!args[i + 1] || args[i + 1].startsWith('--'))) throw new Error('--config requires a path');
  return resolve(i >= 0 ? args[i + 1] : join(process.env.PANECAST_CONFIG_DIR ?? join(homedir(), '.cmuxremote'), 'hub-relay.json'));
}

export function brokerURL(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('中转地址必须是完整的 HTTPS URL。'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('中转地址必须使用 HTTPS，且不能包含凭据、查询参数或片段。');
  }
  return url.toString().replace(/\/+$/, '');
}

export function lanAddress(interfaces = networkInterfaces()) {
  // Prefer physical Wi-Fi/Ethernet interfaces over virtual adapters.
  const entries = Object.entries(interfaces).sort(([a], [b]) => Number(!/^en\d+$/.test(a)) - Number(!/^en\d+$/.test(b)));
  for (const [name, addresses] of entries) {
    if (/^(utun|tun|tap|bridge|docker|veth)/.test(name)) continue;
    for (const address of addresses ?? []) {
      if (!address.internal && address.family === 'IPv4' && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(address.address)) return address.address;
    }
  }
  return undefined;
}

export async function writeInitialConfig(path, { url, relayId, token, source = 'none', lan = false }) {
  if (!relayId || !/^[\w.-]{1,128}$/.test(relayId)) throw new Error('电脑 ID 只能包含字母、数字、点、横线或下划线。');
  if (!token || /\s/.test(token)) throw new Error('连接密钥不能为空或包含空白。');
  if (!['tmux', 'codex', 'none'].includes(source)) throw new Error('--source 支持 tmux、codex 或 none。');
  const config = {
    broker: { url: brokerURL(url), relay_id: relayId, relay_token: token },
    host: '0.0.0.0', port: 4400,
    ...(lan ? { lan: { pairing_code: randomBytes(32).toString('hex') } } : {}),
    state_directory: join(dirname(path), 'hub'),
    sources: [
      { id: 'tmux', name: 'tmux', type: 'tmux', enabled: source === 'tmux', access: source === 'tmux' ? 'control' : 'read' },
      { id: 'codex', name: 'Codex 历史', type: 'codex', mode: 'history', enabled: source === 'codex', access: 'read' },
    ],
  };
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  // Exclusive creation preserves every existing pairing and source permission.
  await writeFile(path, JSON.stringify(config, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  await chmod(path, 0o600);
  return config;
}

export async function setup(args) {
  const path = configPath(args);
  try { await access(path); console.log(`已有配置：${path}\n配置已保留。运行 panecast start，然后 panecast pair。`); return; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const flag = (name) => { const i = args.indexOf(name); if (i < 0) return undefined; if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`${name} 缺少值`); return args[i + 1]; };
  let url = flag('--broker-url'), relayId = flag('--relay-id'), source = flag('--source'), token;
  const tokenFile = flag('--token-file');
  if (tokenFile) token = (await readFile(tokenFile, 'utf8')).trim();
  let lan = args.includes('--lan');
  if (!url || !relayId || !token) {
    if (!process.stdin.isTTY) throw new Error('请在终端运行 panecast setup，或提供 --broker-url、--relay-id、--token-file。');
    console.log('连接信息由中转服务器管理员分配。每台电脑使用独立凭据。');
    let muted = false;
    const output = new Writable({ write(chunk, encoding, done) { if (!muted) process.stderr.write(chunk, encoding); done(); } });
    output.isTTY = process.stderr.isTTY;
    const prompt = createInterface({ input: process.stdin, output, terminal: true });
    try {
      url ??= (await prompt.question('中转地址 [https://ningzx.cn/cmux-remote]：')).trim() || 'https://ningzx.cn/cmux-remote';
      relayId ??= (await prompt.question('分配给这台电脑的 ID：')).trim();
      if (!token) {
        process.stderr.write('这台电脑的连接密钥（输入不显示）：'); muted = true;
        try { token = (await prompt.question('')).trim(); } finally { muted = false; process.stderr.write('\n'); }
      }
      if (!source) {
        const choice = (await prompt.question('授权来源：1 查看和控制 tmux，2 只读 Codex 历史，3 稍后配置 [3]：')).trim();
        source = choice === '1' ? 'tmux' : choice === '2' ? 'codex' : 'none';
      }
      if (!lan) lan = /^(y|yes)$/i.test((await prompt.question('启用可信 Wi-Fi 下的 HTTP 直连？[y/N]：')).trim());
    } finally { prompt.close(); }
  }
  await writeInitialConfig(path, { url, relayId, token, source: source ?? 'none', lan });
  console.log(`配置已保存：${path}\n运行 panecast start 启动后台服务，再运行 panecast pair 用手机扫码。`);
  if (source === 'tmux') console.log('终端任务需要在 tmux 中运行：tmux new -s work');
  if (!source || source === 'none') console.log('授权终端来源：panecast sources grant tmux --access control');
}
