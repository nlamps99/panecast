import type { ConnectionStatus } from '../protocol/connection';
import type { Machine } from '../state/appStore';
import { colors } from './theme';

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
      return status.attempt > 0 ? '重连中…' : '连接中…';
    case 'waiting':
      if (status.reason === 'relay_offline') return '电脑离线';
      return status.reason === 'network' ? '网络断开，稍后自动重试' : '已断开，稍后自动重试';
    case 'auth_failed':
      return guest ? '分享密钥已失效' : '配对已失效';
    case 'idle':
      return '未连接';
  }
}

/** A banner for problems the user has to act on; null when there is nothing to say. */
export function statusBanner(status: ConnectionStatus, guest = false): string | null {
  if (status.state === 'auth_failed') {
    return guest
      ? '这把分享密钥已失效（可能被对方撤销了）。请向分享给你的人要一把新的密钥，再到「设置」里点「粘贴新的分享密钥」。'
      : '这台手机的配对已失效（可能在电脑上被撤销了），请到「设置」里重新配对。';
  }
  if (status.state === 'waiting' && status.reason === 'relay_offline') {
    return guest
      ? '服务器连上了，但对方的电脑现在不在线。等对方的电脑开机、联网后会自动连上。'
      : '服务器连上了，但电脑不在线。请确认电脑开着、没有休眠，并且 Panecast 正在运行（在电脑上运行 panecast status 查看）。';
  }
  return null;
}

/**
 * The workspace list's offline card: what is wrong and whether retrying now
 * could help. Null while connected, and for problems `statusBanner` covers.
 */
export function offlineNotice(status: ConnectionStatus, waitedLong: boolean): string | null {
  if (status.state === 'waiting' && status.reason !== 'relay_offline') {
    return status.reason === 'network'
      ? '连不上服务器，可能是网络断了。网络恢复后会自动重连，也可以现在重试。'
      : '和电脑的连接断开了，稍后会自动重连，也可以现在重试。';
  }
  if ((status.state === 'connecting' || status.state === 'idle') && waitedLong) {
    return '一直连不上电脑。请检查手机网络，并确认电脑开着、没有休眠。';
  }
  return null;
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
