import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdir, unlink, lstat, access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, dirname, isAbsolute } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import net from 'node:net';

const exec = promisify(execFile);
export const serviceLabel = () => process.env.PANECAST_SERVICE_LABEL ?? 'com.nzx.panecast.hub';
const xml = (s) => String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]);

export function renderPlist({ label, launcher, config, logDirectory, path }) {
  if (!/^[\w.-]+$/.test(label) || !isAbsolute(launcher) || !isAbsolute(config)) throw new Error('Invalid service paths or label');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${xml(label)}</string>
<key>ProgramArguments</key><array><string>${xml(launcher)}</string><string>serve</string><string>--config</string><string>${xml(config)}</string></array>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(path)}</string></dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer>
<key>StandardOutPath</key><string>${xml(join(logDirectory, 'stdout.log'))}</string>
<key>StandardErrorPath</key><string>${xml(join(logDirectory, 'stderr.log'))}</string>
</dict></plist>\n`;
}

function location(config) {
  const label = serviceLabel();
  if (!/^[\w.-]+$/.test(label)) throw new Error('Invalid service label');
  return {
    label, target: `gui/${process.getuid()}/${label}`,
    plist: join(process.env.PANECAST_LAUNCH_AGENTS_DIR ?? join(homedir(), 'Library', 'LaunchAgents'), `${label}.plist`),
    logDirectory: join(dirname(config), 'hub-log'),
  };
}

export async function serviceStatus(config) {
  const info = location(config);
  try {
    const { stdout } = await exec('launchctl', ['print', info.target]);
    return { ...info, loaded: true, running: /state = running/.test(stdout), pid: /\bpid = (\d+)/.exec(stdout)?.[1] };
  } catch { return { ...info, loaded: false, running: false }; }
}

export async function service(action, config, launcher) {
  if (process.platform !== 'darwin') throw new Error('后台管理命令适用于 macOS；其他系统可运行 panecast serve。');
  const state = await serviceStatus(config);
  if (action === 'status') {
    console.log(state.running ? `后台运行中，PID ${state.pid}` : state.loaded ? '服务已加载但尚未运行；使用 panecast logs 检查。' : '后台服务未启动。');
    console.log(`配置：${config}\n日志：${state.logDirectory}`); return;
  }
  if (action === 'stop') {
    if (state.loaded) await exec('launchctl', ['bootout', state.target]);
    for (let attempt = 0; attempt < 20 && (await serviceStatus(config)).loaded; attempt++) {
      await delay(250);
    }
    await unlink(state.plist).catch((error) => { if (error.code !== 'ENOENT') throw error; });
    console.log('后台服务与登录自启已停止；终端任务和配对配置已保留。'); return;
  }
  if (action === 'start' && state.loaded) { console.log('服务已加载。查看 panecast status，或使用 panecast restart 重启。'); return; }
  await access(config);
  const settings = JSON.parse(await readFile(config, 'utf8'));
  if (action === 'restart' && state.loaded) {
    // launchd can still be tearing down a job after bootout returns. Restart
    // the loaded job directly; the launcher path follows the installed version.
    await exec('launchctl', ['kickstart', '-k', state.target]);
  } else {
    await mkdir(dirname(state.plist), { recursive: true });
    await mkdir(state.logDirectory, { recursive: true, mode: 0o700 });
    const path = [...new Set([dirname(process.execPath), '/opt/homebrew/bin', '/opt/homebrew/opt/node@22/bin', '/usr/local/bin', '/usr/local/opt/node@22/bin', process.env.PATH ?? '', '/usr/bin:/bin:/usr/sbin:/sbin'])].join(':');
    const plist = renderPlist({ ...state, launcher, config, path });
    await writeFile(state.plist, plist, { mode: 0o600 });
    await exec('plutil', ['-lint', state.plist]);
    await exec('launchctl', ['bootstrap', `gui/${process.getuid()}`, state.plist]);
    await exec('launchctl', ['kickstart', state.target]);
  }
  const socketPath = settings.notify_socket ?? join(settings.state_directory ?? join(homedir(), '.cmuxremote', 'hub'), 'notify.sock');
  let ready = false;
  for (let attempt = 0; attempt < 30; attempt++) {
    await delay(500);
    const after = await serviceStatus(config);
    if (!after.running) continue;
    ready = await new Promise((resolve) => {
      const socket = net.connect(socketPath);
      socket.setTimeout(300, () => { socket.destroy(); resolve(false); });
      socket.once('connect', () => { socket.destroy(); resolve(true); });
      socket.once('error', () => resolve(false));
    });
    if (ready) break;
  }
  if (!ready) throw new Error('服务尚未就绪，请运行 panecast logs 查看错误。');
  console.log('后台服务已启动，并将在登录后自动运行。\n运行 panecast pair 显示手机配对二维码。');
}

export async function clearStaleSocket(config) {
  const path = config.notify_socket ?? join(config.state_directory ?? join(homedir(), '.cmuxremote', 'hub'), 'notify.sock');
  let stat;
  try { stat = await lstat(path); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (!stat.isSocket() || stat.uid !== process.getuid()) throw new Error('通知 socket 路径已被占用。');
  const active = await new Promise((resolve, reject) => {
    const socket = net.connect(path);
    socket.setTimeout(1000, () => { socket.destroy(); reject(new Error('无法判断已有服务状态；请先检查 panecast status。')); });
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', (error) => ['ECONNREFUSED', 'ENOENT'].includes(error.code) ? resolve(false) : reject(error));
  });
  if (active) throw new Error('已有 hub 正在运行。请先停止现有服务，避免同一电脑重复连接。');
  await unlink(path).catch((error) => { if (error.code !== 'ENOENT') throw error; });
}
