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

export function statusLabel(status: ConnectionStatus): string {
  switch (status.state) {
    case 'open':
      return '已连接';
    case 'connecting':
      return status.attempt > 0 ? '重连中…' : '连接中…';
    case 'waiting':
      return status.reason === 'relay_offline' ? '电脑离线' : '已断开，稍后重试';
    case 'auth_failed':
      return '配对已失效';
    case 'idle':
      return '未连接';
  }
}

/** A banner for problems the user has to act on; null when there is nothing to say. */
export function statusBanner(status: ConnectionStatus): string | null {
  if (status.state === 'auth_failed') return '这台手机的配对已失效（可能在电脑上被撤销了），请到「设置」里重新配对。';
  if (status.state === 'waiting' && status.reason === 'relay_offline') {
    return '服务器连上了，但电脑上的 relay 不在线。请确认 Mac 上的 cmux-relay 正在运行。';
  }
  return null;
}

/** What to call the Mac: the broker host and relay id, or "演示电脑". */
export function machineLabel(machine: Machine): { name: string; detail: string } {
  if (machine.mode === 'demo' || !machine.pairing) return { name: '演示电脑', detail: '演示数据，不会连接真实电脑' };
  const host = machine.pairing.serverUrl.replace(/^https?:\/\//, '');
  return { name: machine.pairing.relayId, detail: host };
}
