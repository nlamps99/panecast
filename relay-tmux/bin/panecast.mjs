#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, dirname, resolve } from 'node:path';
import { configPath, setup, lanAddress } from '../src/installation.mjs';
import { service, serviceStatus, clearStaleSocket } from '../src/service.mjs';
import { captureCmuxCapability, STATE_DIRECTORY_NAME } from '../src/hub/cmux-managed.mjs';

const args = process.argv.slice(2);
const command = args[0] ?? 'help';
const root = fileURLToPath(new URL('../', import.meta.url));
const version = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version;

async function main() {
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Panecast 需要 Node.js 22 或更新版本。');
  if (['--version', '-v', 'version'].includes(command)) { console.log(version); return; }
  if (['help', '--help', '-h'].includes(command)) {
    console.log(`Panecast ${version} · Mac 终端网关

  panecast setup                         首次配置：登录账号，自动分配电脑凭据（保留已有配置）
  panecast start | stop | restart         管理 macOS 后台服务
  panecast status                        查看运行状态
  panecast logs                          持续查看错误日志
  panecast pair                          显示手机配对二维码
  panecast serve                         在前台运行
  panecast sources list                  查看已接入的来源（tmux、cmux、Codex 自动接入，全部权限）
  panecast desktop prepare | check       Codex 桌面桥接

cmux 只允许自己终端里的程序连接时，在 cmux 终端里运行一次 panecast restart 即可授权网关；
也可以在 cmux 设置中把「套接字控制模式」改为「自动化模式」。

所有网关命令支持 --config /absolute/path/hub-relay.json。
自动配置：setup --broker-url HTTPS_URL --username NAME --password-file PATH
          [--register] [--name 电脑名称] [--lan]
手动凭据：setup --broker-url HTTPS_URL --relay-id ID --token-file PATH
配对：pair [--lan-host PRIVATE_IP] [--url-only]
安装与更新：https://ningzx.cn/panecast/`); return;
  }
  const path = configPath(args);
  if (['setup', 'start', 'restart'].includes(command)) {
    // Inside a cmux terminal, cmux hands out a capability that lets the gateway's relay connect.
    const saved = await captureCmuxCapability(join(dirname(path), STATE_DIRECTORY_NAME)).catch(() => false);
    if (saved) console.log('已保存 cmux 的连接授权。');
    if (saved && command === 'start' && (await serviceStatus(path)).loaded) console.log('后台服务已在运行，运行 panecast restart 让 cmux 授权生效。');
  }
  if (command === 'setup') { await setup(args.slice(1)); return; }
  if (['start', 'stop', 'restart', 'status'].includes(command)) {
    await service(command, path, process.env.PANECAST_LAUNCHER ?? resolve(process.argv[1])); return;
  }
  if (command === 'logs') {
    const log = join(dirname(path), 'hub-log', 'stderr.log');
    const child = spawn('tail', ['-n', '60', '-f', log], { stdio: 'inherit' });
    child.once('error', () => { console.error('无法读取日志。请先运行 panecast start。'); process.exitCode = 1; });
    child.once('exit', (code) => { process.exitCode = code ?? 0; }); return;
  }
  if (command === 'desktop') {
    process.argv = [process.execPath, join(root, 'src/hub/desktop-setup.mjs'), ...args.slice(1)];
    await import('../src/hub/desktop-setup.mjs'); return;
  }
  if (!['serve', 'pair', 'sources', 'notify'].includes(command)) throw new Error('未知命令。运行 panecast --help 查看用法。');
  let config;
  try { config = JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') throw new Error('尚未配置。请先运行 panecast setup。'); throw error; }
  if (command === 'serve') await clearStaleSocket(config);
  const forwarded = [...args];
  const configIndex = forwarded.indexOf('--config');
  if (configIndex >= 0) forwarded.splice(configIndex, 2);
  if (command === 'pair' && config.lan?.pairing_code && !args.includes('--lan-host')) {
    const host = lanAddress(); if (host) forwarded.push('--lan-host', host);
  }
  process.argv = [process.execPath, join(root, 'src/hub/cli.mjs'), ...forwarded, '--config', path];
  await import('../src/hub/cli.mjs');
}

main().catch((error) => { console.error(`Panecast: ${error.code === 'EEXIST' ? '配置已存在，未覆盖。' : error.message}`); process.exitCode = 1; });
