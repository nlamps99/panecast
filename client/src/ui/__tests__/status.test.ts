jest.mock('../theme', () => ({ colors: {} }));
/* eslint-disable import/first */
import type { ConnectionStatus } from '../../protocol/connection';
import { connectionAction, isGuest, isLocalOutage, offlineNotice, statusBanner, statusLabel } from '../status';

const waiting = (reason: 'relay_offline' | 'network' | 'closed_by_server'): ConnectionStatus => ({ state: 'waiting', attempt: 1, retryAt: 0, reason });

it('tells a guest to ask for a new share key instead of re-pairing', () => {
  expect(statusBanner({ state: 'auth_failed' }, true)).toContain('新的密钥');
  expect(statusBanner({ state: 'auth_failed' }, true)).not.toContain('配对');
  expect(statusBanner({ state: 'auth_failed' })).toContain('重新配对');
  expect(statusLabel({ state: 'auth_failed' }, true)).toBe('分享密钥已失效');
});

it('explains an offline computer without relay jargon', () => {
  for (const guest of [false, true]) {
    const text = statusBanner(waiting('relay_offline'), guest) ?? '';
    expect(text).toContain('不在线');
    expect(text).not.toMatch(/relay/i);
  }
  expect(statusBanner(waiting('relay_offline'))).toContain('panecast status');
});

it('offers a retry for a dropped connection and for a connection that never comes up', () => {
  expect(offlineNotice(waiting('network'), false)).toContain('网络');
  expect(offlineNotice(waiting('closed_by_server'), false)).toContain('重试');
  expect(offlineNotice(waiting('relay_offline'), true)).toBeNull();
  expect(offlineNotice({ state: 'connecting', attempt: 0 }, false)).toBeNull();
  expect(offlineNotice({ state: 'connecting', attempt: 0 }, true)).toContain('一直连不上');
  expect(offlineNotice({ state: 'open' }, true)).toBeNull();
});

it('recognises a shared window by its stored share', () => {
  expect(isGuest({ computer: null })).toBe(false);
  expect(isGuest({ computer: { share: { name: 'x' } } as never })).toBe(true);
});

it('never calls the desktop app a phone', () => {
  const statuses: ConnectionStatus[] = [{ state: 'auth_failed' }, waiting('relay_offline'), waiting('network'), { state: 'connecting', attempt: 3 }, { state: 'idle' }];
  for (const status of statuses) {
    expect(statusBanner(status, false, true) ?? '').not.toContain('手机');
    expect(offlineNotice(status, true, true) ?? '').not.toContain('手机');
  }
  expect(statusBanner({ state: 'auth_failed' }, false, true)).toContain('重新配对');
  expect(statusBanner({ state: 'auth_failed' }, false, false)).toContain('这台手机');
  expect(offlineNotice({ state: 'connecting', attempt: 0 }, true, false)).toContain('手机网络');
});

it('says that this computer\'s own gateway is not answering, and that it keeps retrying', () => {
  const local: ConnectionStatus = { state: 'waiting', attempt: 2, retryAt: 0, reason: 'relay_offline', local: true };
  expect(isLocalOutage(local)).toBe(true);
  expect(isLocalOutage(waiting('relay_offline'))).toBe(false);
  expect(statusLabel(local)).toBe('本机网关未响应，正在重试');
  expect(statusLabel({ state: 'connecting', attempt: 2, local: true })).toBe('重连本机网关…');
  const banner = statusBanner(local, false, true) ?? '';
  expect(banner).toContain('本机的 Panecast 网关没有响应');
  expect(banner).toContain('正在自动重试');
  expect(banner).not.toContain('电脑不在线');
  expect(offlineNotice(local, true, true)).toBeNull();
  expect(offlineNotice({ state: 'connecting', attempt: 1, local: true }, true, true)).toContain('本机的 Panecast 网关');
});

it('offers to reconnect while disconnected, and to fix the pairing when it was rejected', () => {
  expect(connectionAction(waiting('network'))).toBe('reconnect');
  expect(connectionAction({ state: 'idle' })).toBe('reconnect');
  expect(connectionAction({ state: 'auth_failed' })).toBe('repair');
  expect(connectionAction({ state: 'connecting', attempt: 0 })).toBeNull();
  expect(connectionAction({ state: 'open' })).toBeNull();
});
