import { useEffect, useState } from 'react';

import type { ConnectionStatus } from '../protocol/connection';
import { desktopBridge } from '../platform/desktop';
import type { SubscriptionState } from '../session/terminalSession';

/** What a button under the message does. */
export type PlaceholderAction = 'reconnect' | 'retryTerminal' | 'retryTarget';

export type TerminalPlaceholder = { text: string; action: PlaceholderAction | null; label: string | null };

const BUTTON_LABEL: Record<PlaceholderAction, string> = { reconnect: '重新连接', retryTerminal: '重试', retryTarget: '重试' };

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
  /** A shared window: its key, not a pairing, is what failed. */
  guest?: boolean;
  desktop?: boolean;
}): TerminalPlaceholder {
  const { status } = input;
  switch (status.state) {
    case 'idle':
    case 'connecting':
      return placeholder(status.state === 'connecting' && status.local ? '正在连接本机网关…' : '正在连接电脑…');
    case 'waiting':
      if (status.local) return placeholder('本机的 Panecast 网关没有响应，正在自动重试', 'reconnect');
      return placeholder(status.reason === 'relay_offline' ? '电脑不在线，它上线后会自动连上' : '连不上电脑，稍后会自动重试', 'reconnect');
    case 'auth_failed':
      if (input.guest) return placeholder('这把分享密钥已失效，请向分享者要一把新的，再到「设置」里粘贴');
      return placeholder(`${(input.desktop ?? desktopBridge() !== null) ? '配对' : '这台手机的配对'}已失效，请到「设置」里重新配对`);
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

/** A drop shorter than this is usually a blip that reconnects at once: the screen is not called stale yet. */
export const STALE_AFTER_MS = 2_000;

/** True once the connection has not been open for `delayMs`; false again the moment it opens. */
export function useOfflineFor(open: boolean, delayMs = STALE_AFTER_MS): boolean {
  const [long, setLong] = useState(false);
  useEffect(() => {
    if (open) return;
    const timer = setTimeout(() => setLong(true), delayMs);
    return () => {
      clearTimeout(timer);
      setLong(false);
    };
  }, [open, delayMs]);
  return !open && long;
}

/**
 * The banner over a screen that is not live: what is shown is the last one
 * received (or the local cache), dated so it is not mistaken for the current
 * one, with a button to reconnect now. Null while connected, with nothing on
 * screen (the placeholder speaks then), and for a rejected credential, whose
 * own banner says what to do. `settled` (see `useOfflineFor`): the
 * connection has been down for a while; before that only a real outage (the
 * computer or this Mac's gateway not answering) shows, so a brief reconnect
 * does not flash the banner.
 */
export function staleScreenNotice(input: {
  status: ConnectionStatus;
  hasScreen: boolean;
  screenAt: number | null | undefined;
  settled?: boolean;
  now?: number;
}): { text: string; action: PlaceholderAction | null } | null {
  const { status } = input;
  if (!input.hasScreen || status.state === 'open' || status.state === 'auth_failed') return null;
  const outage = status.state === 'waiting' && (status.local === true || status.reason === 'relay_offline');
  if (input.settled === false && !outage) return null;
  const when = input.screenAt ? clockTime(input.screenAt, input.now ?? Date.now()) : null;
  const shown = when ? `显示的是 ${when} 的画面` : '显示的是之前的画面';
  if (status.state === 'idle' || status.state === 'connecting') return { text: `${status.state === 'connecting' && status.attempt === 0 && !status.local ? '正在连接' : '正在重新连接'} · ${shown}`, action: null };
  const why = status.local ? '本机网关未响应' : status.reason === 'relay_offline' ? '电脑不在线' : '已断开';
  return { text: `${why} · ${shown}`, action: 'reconnect' };
}

/** `HH:MM` today, `M月D日 HH:MM` on another day. */
export function clockTime(at: number, now: number): string {
  const date = new Date(at), today = new Date(now);
  const time = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  const sameDay = date.getFullYear() === today.getFullYear() && date.getMonth() === today.getMonth() && date.getDate() === today.getDate();
  return sameDay ? time : `${date.getMonth() + 1}月${date.getDate()}日 ${time}`;
}
