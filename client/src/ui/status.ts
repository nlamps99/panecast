import type { ConnectionStatus } from '../protocol/connection';
import { desktopBridge } from '../platform/desktop';
import type { Machine } from '../state/appStore';
import { colors } from './theme';

/** The desktop app: never call it "这台手机". Tests pass the flag instead. */
const onDesktop = () => desktopBridge() !== null;

/** Not open, and what is not answering is this computer's own gateway (desktop app on the paired Mac). */
export function isLocalOutage(status: ConnectionStatus): boolean {
  return (status.state === 'waiting' || status.state === 'connecting') && status.local === true;
}

export function statusColor(status: ConnectionStatus): string {
  switch (status.state) {
    case 'open':
      return colors.green;
    case 'connecting':
      return colors.yellow;
    case 'waiting':
      return colors.orange;
    case 'auth_failed':
      return colors.red;
    case 'idle':
      return colors.muted;
  }
}

/** `guest`: the computer is someone else's window, opened with a share key. */
export function statusLabel(status: ConnectionStatus, guest = false): string {
  switch (status.state) {
    case 'open':
      return '已连接';
    case 'connecting':
      if (status.local && status.attempt > 0) return '重连本机网关…';
      return status.attempt > 0 ? '重连中…' : '连接中…';
    case 'waiting':
      if (status.local) return '本机网关未响应，正在重试';
      if (status.reason === 'relay_offline') return '电脑离线';
      return status.reason === 'network' ? '网络断开，稍后自动重试' : '已断开，稍后自动重试';
    case 'auth_failed':
      return guest ? '分享密钥已失效' : '配对已失效';
    case 'idle':
      return '未连接';
  }
}

/** A banner for problems the user has to act on; null when there is nothing to say. */
export function statusBanner(status: ConnectionStatus, guest = false, desktop = onDesktop()): string | null {
  if (status.state === 'auth_failed') {
    if (guest) return '这把分享密钥已失效（可能被对方撤销了）。请向分享给你的人要一把新的密钥，再到「设置」里点「粘贴新的分享密钥」。';
    return desktop
      ? '这个 App 和这台电脑的配对已失效（可能在电脑上被撤销了），请到「设置」里重新配对。'
      : '这台手机的配对已失效（可能在电脑上被撤销了），请到「设置」里重新配对。';
  }
  if (status.state === 'waiting' && status.local) {
    return '本机的 Panecast 网关没有响应，正在自动重试。网关重启时通常几秒就会恢复；一直连不上的话，在终端运行 panecast status 查看。';
  }
  if (status.state === 'waiting' && status.reason === 'relay_offline') {
    if (guest) return '服务器连上了，但对方的电脑现在不在线。等对方的电脑开机、联网后会自动连上。';
    return desktop
      ? '服务器连上了，但那台电脑不在线。请确认它开着、没有休眠，并且 Panecast 正在运行（在那台电脑上运行 panecast status 查看）。'
      : '服务器连上了，但电脑不在线。请确认电脑开着、没有休眠，并且 Panecast 正在运行（在电脑上运行 panecast status 查看）。';
  }
  return null;
}

/**
 * The workspace list's offline card: what is wrong and whether retrying now
 * could help. Null while connected, and for problems `statusBanner` covers.
 */
export function offlineNotice(status: ConnectionStatus, waitedLong: boolean, desktop = onDesktop()): string | null {
  if (status.state === 'waiting' && status.local) return null;
  if (status.state === 'waiting' && status.reason !== 'relay_offline') {
    return status.reason === 'network'
      ? '连不上服务器，可能是网络断了。网络恢复后会自动重连，也可以现在重试。'
      : '和电脑的连接断开了，稍后会自动重连，也可以现在重试。';
  }
  if ((status.state === 'connecting' || status.state === 'idle') && waitedLong) {
    if (isLocalOutage(status)) return '一直连不上本机的 Panecast 网关。请在终端运行 panecast status 查看它是否在运行。';
    return desktop ? '一直连不上电脑。请检查网络，并确认电脑开着、没有休眠。' : '一直连不上电脑。请检查手机网络，并确认电脑开着、没有休眠。';
  }
  return null;
}

/**
 * What the connection line can offer: start over now (`reconnect`), or the
 * pairing has to be fixed in 设置 (`repair`). Null while open or connecting.
 */
export function connectionAction(status: ConnectionStatus): 'reconnect' | 'repair' | null {
  switch (status.state) {
    case 'waiting':
    case 'idle':
      return 'reconnect';
    case 'auth_failed':
      return 'repair';
    default:
      return null;
  }
}

/** Whether a computer is someone else's window opened with a share key. */
export function isGuest(machine: Pick<Machine, 'computer'>): boolean {
  return Boolean(machine.computer?.share);
}

/** What to call the Mac: its name and broker host, or "演示电脑". */
export function machineLabel(machine: Machine): { name: string; detail: string } {
  if (machine.mode === 'demo' || !machine.computer) return { name: '演示电脑', detail: '演示数据，不会连接真实电脑' };
  const host = machine.computer.broker.serverUrl.replace(/^https?:\/\//, '');
  return { name: machine.computer.name, detail: host };
}
