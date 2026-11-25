import type { ConnectionStatus } from '../protocol/connection';
import type { SubscriptionState } from '../session/terminalSession';

/** What a button under the message does. */
export type PlaceholderAction = 'reconnect' | 'retryTerminal' | 'retryTarget';

export type TerminalPlaceholder = { text: string; action: PlaceholderAction | null; label: string | null };

const BUTTON_LABEL: Record<PlaceholderAction, string> = { reconnect: '立即重连', retryTerminal: '重试', retryTarget: '重试' };

function placeholder(text: string, action: PlaceholderAction | null = null): TerminalPlaceholder {
  return { text, action, label: action ? BUTTON_LABEL[action] : null };
}

/**
 * The message in the middle of an empty terminal: still connecting, the
 * computer is offline, or the terminal could not be opened, with a button for
 * the last two instead of a message that never changes.
 */
export function terminalPlaceholder(input: {
  status: ConnectionStatus;
  hasTarget: boolean;
  subscription: SubscriptionState;
  subscriptionError: string | null;
  targetError: string | null;
}): TerminalPlaceholder {
  const { status } = input;
  switch (status.state) {
    case 'idle':
    case 'connecting':
      return placeholder('正在连接电脑…');
    case 'waiting':
      return placeholder(status.reason === 'relay_offline' ? '电脑不在线，它上线后会自动连上' : '连不上电脑，稍后会自动重试', 'reconnect');
    case 'auth_failed':
      return placeholder('这台手机的配对已失效');
    case 'open':
      break;
  }
  if (!input.hasTarget) return input.targetError ? placeholder(input.targetError, 'retryTarget') : placeholder('正在查找终端…');
  if (input.subscription === 'error') {
    const reason = input.subscriptionError;
    // The source reconnects by itself; a button would only race it.
    if (reason && /正在重新连接/.test(reason)) return placeholder(reason);
    return placeholder(reason ? `打不开这个终端：${reason}` : '打不开这个终端', 'retryTerminal');
  }
  return placeholder('正在读取终端…');
}

/** The button beside the yellow banner when the terminal shows a cached screen. */
export function bannerAction(input: {
  status: ConnectionStatus;
  subscription: SubscriptionState;
  subscriptionError: string | null;
  targetError: string | null;
}): PlaceholderAction | null {
  if (input.status.state === 'waiting') return 'reconnect';
  if (input.status.state !== 'open') return null;
  if (input.subscription === 'error' && !(input.subscriptionError && /正在重新连接/.test(input.subscriptionError))) return 'retryTerminal';
  if (input.targetError) return 'retryTarget';
  return null;
}

export function placeholderLabel(action: PlaceholderAction): string {
  return BUTTON_LABEL[action];
}
