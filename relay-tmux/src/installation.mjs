import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile, chmod, access } from 'node:fs/promises';
import { homedir, hostname, networkInterfaces } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';

const DEFAULT_BROKER = 'https://ningzx.cn/cmux-remote';
const accountErrors = {
  invalid_login: '用户名或密码不正确。',
  invalid_username: '用户名需为 3–64 位字母、数字、点、下划线或短横线，以字母或数字开头。',
  password_length: '密码需要 12–256 个字符。',
  username_taken: '这个用户名已被使用。',
  too_many_account_attempts: '操作过于频繁，请一分钟后重试。',
  relay_limit_reached: '这个账号的电脑数量已达上限。请先在 App 中移除不用的电脑。',
  relay_enrollment_disabled: '这个中转服务器没有开放自动分配。请向管理员索取电脑 ID 和连接密钥，再运行 panecast setup --relay-id ID --token-file PATH。',
  not_found: '中转服务器版本过旧，不支持自动分配。请升级 broker，或使用 --relay-id 和 --token-file 手动配置。',
};

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

export function computerName() {
  return hostname().replace(/\.local$/i, '').trim().slice(0, 60) || 'Mac';
}

/** Signs in, asks the broker to assign this computer a relay identity, then ends the temporary login. */
export async function enrollComputer({ url, username, password, register = false, name = computerName(), fetch: request = fetch }) {
  const base = brokerURL(url);
  const call = async (route, body, token) => {
    let response;
    try {
      response = await request(`${base}/v1/account/${route}`, {
        method: 'POST', signal: AbortSignal.timeout(15_000),
        headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(body ?? {}),
      });
    } catch { throw new Error('无法连接中转服务器，请检查地址和网络。'); }
    if (response.status === 204) return null;
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(accountErrors[data.error] ?? `中转服务器返回错误（HTTP ${response.status}）。`);
    return data;
  };
  const session = await call(register ? 'register' : 'login', { username, password, device_name: `Panecast 网关 · ${name}` });
  try {
    const relay = await call('relays', { name }, session.token);
    if (!relay?.relay_id || !relay.relay_token || !relay.pairing_code) throw new Error('中转服务器返回的电脑凭据不完整。');
    return { url: base, relayId: relay.relay_id, token: relay.relay_token, pairingCode: relay.pairing_code, name: relay.name ?? name };
  } finally {
    await call('logout', undefined, session.token).catch(() => {});
  }
}

export async function writeInitialConfig(path, { url, relayId, token, pairingCode, source = 'none', lan = false }) {
  if (!relayId || !/^[\w.-]{1,128}$/.test(relayId)) throw new Error('电脑 ID 只能包含字母、数字、点、横线或下划线。');
  if (!token || /\s/.test(token)) throw new Error('连接密钥不能为空或包含空白。');
  if (pairingCode !== undefined && (!pairingCode || /\s/.test(pairingCode))) throw new Error('配对码不能为空或包含空白。');
  if (!['tmux', 'codex', 'none'].includes(source)) throw new Error('--source 支持 tmux、codex 或 none。');
  const config = {
    broker: { url: brokerURL(url), relay_id: relayId, relay_token: token, ...(pairingCode ? { pairing_code: pairingCode } : {}) },
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

export async function setup(args, { fetch: request = fetch } = {}) {
  const path = configPath(args);
  try { await access(path); console.log(`已有配置：${path}\n配置已保留。运行 panecast start，然后 panecast pair。`); return; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const flag = (name) => { const i = args.indexOf(name); if (i < 0) return undefined; if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`${name} 缺少值`); return args[i + 1]; };
  let url = flag('--broker-url'), relayId = flag('--relay-id'), source = flag('--source'), username = flag('--username'), token, password, pairingCode;
  const tokenFile = flag('--token-file'), passwordFile = flag('--password-file'), name = flag('--name') ?? computerName();
  let register = args.includes('--register'), lan = args.includes('--lan');
  if (tokenFile) token = (await readFile(tokenFile, 'utf8')).trim();
  if (passwordFile) password = (await readFile(passwordFile, 'utf8')).replace(/\r?\n$/, '');
  // Explicit relay credentials keep working for brokers that do not allow enrollment.
  const manual = Boolean(relayId || tokenFile);
  if (!url || (manual ? !relayId || !token : !username || !password)) {
    if (!process.stdin.isTTY) throw new Error('请在终端运行 panecast setup，或提供 --broker-url 与 --username、--password-file（自动分配），或 --relay-id、--token-file（手动配置）。');
    let muted = false;
    const output = new Writable({ write(chunk, encoding, done) { if (!muted) process.stderr.write(chunk, encoding); done(); } });
    output.isTTY = process.stderr.isTTY;
    const prompt = createInterface({ input: process.stdin, output, terminal: true });
    const secret = async (label) => {
      process.stderr.write(label); muted = true;
      try { return await prompt.question(''); } finally { muted = false; process.stderr.write('\n'); }
    };
    try {
      url ??= (await prompt.question(`中转地址 [${DEFAULT_BROKER}]：`)).trim() || DEFAULT_BROKER;
      if (manual) {
        relayId ??= (await prompt.question('分配给这台电脑的 ID：')).trim();
        token ??= (await secret('这台电脑的连接密钥（输入不显示）：')).trim();
      } else {
        console.log('登录 Panecast 账号，服务器会自动为这台电脑分配连接凭据。手机登录同一账号即可看到这台电脑。');
        if (!username) {
          if (!register) register = (await prompt.question('1 登录已有账号，2 注册新账号 [1]：')).trim() === '2';
          username = (await prompt.question('用户名：')).trim();
        }
        if (!password) {
          password = await secret(register ? '设置密码（12 个字符以上，输入不显示）：' : '密码（输入不显示）：');
          if (register && await secret('再次输入密码：') !== password) throw new Error('两次输入的密码不一致。');
        }
      }
      if (!source) {
        const choice = (await prompt.question('授权来源：1 查看和控制 tmux，2 只读 Codex 历史，3 稍后配置 [3]：')).trim();
        source = choice === '1' ? 'tmux' : choice === '2' ? 'codex' : 'none';
      }
      if (!lan) lan = /^(y|yes)$/i.test((await prompt.question('启用可信 Wi-Fi 下的 HTTP 直连？[y/N]：')).trim());
    } finally { prompt.close(); }
  }
  if (!manual) ({ url, relayId, token, pairingCode } = await enrollComputer({ url, username, password, register, name, fetch: request }));
  await writeInitialConfig(path, { url, relayId, token, pairingCode, source: source ?? 'none', lan });
  console.log(`配置已保存：${path}\n运行 panecast start 启动后台服务。`);
  if (manual) console.log('然后运行 panecast pair 用手机扫码。');
  else console.log(`手机 App 登录账号 ${username.trim().toLowerCase()} 后会自动出现「${name}」；未登录账号的手机可运行 panecast pair 扫码。`);
  if (source === 'tmux') console.log('终端任务需要在 tmux 中运行：tmux new -s work');
  if (!source || source === 'none') console.log('授权终端来源：panecast sources grant tmux --access control');
}
