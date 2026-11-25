jest.mock('../theme', () => ({ colors: {} }));
/* eslint-disable import/first */
import type { ConnectionStatus } from '../../protocol/connection';
import { isGuest, offlineNotice, statusBanner, statusLabel } from '../status';

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
