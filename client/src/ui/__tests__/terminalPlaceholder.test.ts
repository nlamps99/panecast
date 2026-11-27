import { bannerAction, clockTime, staleScreenNotice, terminalPlaceholder } from '../terminalPlaceholder';

const open = { state: 'open' } as const;
const base = { status: open, hasTarget: true, subscription: 'live' as const, subscriptionError: null, targetError: null };

it('keeps the loading messages while things are on their way', () => {
  expect(terminalPlaceholder({ ...base, status: { state: 'connecting', attempt: 0 } })).toEqual({ text: '正在连接电脑…', action: null, label: null });
  expect(terminalPlaceholder({ ...base, hasTarget: false }).text).toBe('正在查找终端…');
  expect(terminalPlaceholder({ ...base, subscription: 'subscribing' }).text).toBe('正在读取终端…');
});

it('says the computer is offline instead of spinning, with a reconnect button', () => {
  const offline = terminalPlaceholder({ ...base, status: { state: 'waiting', attempt: 2, retryAt: 0, reason: 'relay_offline' } });
  expect(offline).toEqual({ text: '电脑不在线，它上线后会自动连上', action: 'reconnect', label: '重新连接' });
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

it('blames this computer\'s own gateway on the desktop beside it, and says what to do when the pairing failed', () => {
  const local = terminalPlaceholder({ ...base, status: { state: 'waiting', attempt: 1, retryAt: 0, reason: 'relay_offline', local: true } });
  expect(local).toMatchObject({ action: 'reconnect' });
  expect(local.text).toContain('本机的 Panecast 网关');
  expect(terminalPlaceholder({ ...base, status: { state: 'auth_failed' }, desktop: true }).text).toBe('配对已失效，请到「设置」里重新配对');
  expect(terminalPlaceholder({ ...base, status: { state: 'auth_failed' }, desktop: false }).text).toContain('这台手机');
  expect(terminalPlaceholder({ ...base, status: { state: 'auth_failed' }, guest: true }).text).toContain('分享密钥');
});

describe('a screen shown while disconnected', () => {
  const at = new Date(2026, 10, 26, 9, 5).getTime();
  const now = new Date(2026, 10, 26, 10, 0).getTime();
  const waiting = (reason: 'network' | 'relay_offline', local = false) => ({ state: 'waiting' as const, attempt: 1, retryAt: 0, reason, ...(local ? { local: true } : {}) });

  it('is dated and offers to reconnect', () => {
    expect(staleScreenNotice({ status: waiting('network'), hasScreen: true, screenAt: at, now })).toEqual({ text: '已断开 · 显示的是 09:05 的画面', action: 'reconnect' });
    expect(staleScreenNotice({ status: waiting('relay_offline'), hasScreen: true, screenAt: at, now })?.text).toBe('电脑不在线 · 显示的是 09:05 的画面');
    expect(staleScreenNotice({ status: waiting('relay_offline', true), hasScreen: true, screenAt: at, now })?.text).toBe('本机网关未响应 · 显示的是 09:05 的画面');
    expect(staleScreenNotice({ status: { state: 'connecting', attempt: 2 }, hasScreen: true, screenAt: null, now })).toEqual({ text: '正在重新连接 · 显示的是之前的画面', action: null });
  });

  it('says nothing while live, with nothing on screen, or when the pairing failed (its own banner says what to do)', () => {
    expect(staleScreenNotice({ status: open, hasScreen: true, screenAt: at, now })).toBeNull();
    expect(staleScreenNotice({ status: waiting('network'), hasScreen: false, screenAt: at, now })).toBeNull();
    expect(staleScreenNotice({ status: { state: 'auth_failed' }, hasScreen: true, screenAt: at, now })).toBeNull();
  });

  it('waits out a brief reconnect, but shows a real outage at once', () => {
    const early = { hasScreen: true, screenAt: at, now, settled: false };
    expect(staleScreenNotice({ ...early, status: waiting('network') })).toBeNull();
    expect(staleScreenNotice({ ...early, status: { state: 'connecting', attempt: 1 } })).toBeNull();
    expect(staleScreenNotice({ ...early, status: waiting('relay_offline') })?.text).toBe('电脑不在线 · 显示的是 09:05 的画面');
    expect(staleScreenNotice({ ...early, status: waiting('network', true) })?.text).toBe('本机网关未响应 · 显示的是 09:05 的画面');
    expect(staleScreenNotice({ ...early, settled: true, status: waiting('network') })?.text).toBe('已断开 · 显示的是 09:05 的画面');
  });

  it('names the day for a screen from another day', () => {
    expect(clockTime(new Date(2026, 10, 24, 23, 59).getTime(), now)).toBe('11月24日 23:59');
    expect(clockTime(at, now)).toBe('09:05');
  });
});
