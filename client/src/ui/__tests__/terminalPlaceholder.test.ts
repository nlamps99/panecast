import { bannerAction, terminalPlaceholder } from '../terminalPlaceholder';

const open = { state: 'open' } as const;
const base = { status: open, hasTarget: true, subscription: 'live' as const, subscriptionError: null, targetError: null };

it('keeps the loading messages while things are on their way', () => {
  expect(terminalPlaceholder({ ...base, status: { state: 'connecting', attempt: 0 } })).toEqual({ text: '正在连接电脑…', action: null, label: null });
  expect(terminalPlaceholder({ ...base, hasTarget: false }).text).toBe('正在查找终端…');
  expect(terminalPlaceholder({ ...base, subscription: 'subscribing' }).text).toBe('正在读取终端…');
});

it('says the computer is offline instead of spinning, with a reconnect button', () => {
  const offline = terminalPlaceholder({ ...base, status: { state: 'waiting', attempt: 2, retryAt: 0, reason: 'relay_offline' } });
  expect(offline).toEqual({ text: '电脑不在线，它上线后会自动连上', action: 'reconnect', label: '立即重连' });
  expect(terminalPlaceholder({ ...base, status: { state: 'waiting', attempt: 1, retryAt: 0, reason: 'network' } }).text).toBe('连不上电脑，稍后会自动重试');
  expect(terminalPlaceholder({ ...base, status: { state: 'auth_failed' } }).action).toBeNull();
});

it('turns a failed subscription into a message with a retry button', () => {
  expect(terminalPlaceholder({ ...base, subscription: 'error', subscriptionError: 'surface.subscribe 超时' }))
    .toEqual({ text: '打不开这个终端：surface.subscribe 超时', action: 'retryTerminal', label: '重试' });
  // The source reconnects by itself.
  expect(terminalPlaceholder({ ...base, subscription: 'error', subscriptionError: '终端来源已断开，正在重新连接…' }).action).toBeNull();
  expect(terminalPlaceholder({ ...base, hasTarget: false, targetError: '电脑上没有打开的终端' })).toMatchObject({ text: '电脑上没有打开的终端', action: 'retryTarget' });
});

it('offers the same fixes beside the banner when a cached screen is showing', () => {
  expect(bannerAction({ ...base, status: { state: 'waiting', attempt: 1, retryAt: 0, reason: 'relay_offline' } })).toBe('reconnect');
  expect(bannerAction({ ...base, subscription: 'error', subscriptionError: 'boom' })).toBe('retryTerminal');
  expect(bannerAction({ ...base, targetError: 'x' })).toBe('retryTarget');
  expect(bannerAction(base)).toBeNull();
  expect(bannerAction({ ...base, status: { state: 'auth_failed' } })).toBeNull();
});
