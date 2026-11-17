import { parseUpdateStatus, updateLabel } from '../desktopUpdate';

it('reads every state the native updater sends and refuses malformed ones', () => {
  expect(parseUpdateStatus({ current: '0.2.10', state: 'downloading', version: '0.2.11', downloaded: 5, total: 10 }))
    .toEqual({ current: '0.2.10', state: 'downloading', version: '0.2.11', downloaded: 5, total: 10 });
  expect(parseUpdateStatus({ current: '0.2.10', state: 'ready', version: '0.2.11', notes: null }))
    .toEqual({ current: '0.2.10', state: 'ready', version: '0.2.11', notes: null });
  expect(parseUpdateStatus({ current: '0.2.10', state: 'latest', checked_at: 100 })).toEqual({ current: '0.2.10', state: 'latest', checkedAt: 100 });
  expect(parseUpdateStatus({ current: '0.2.10', state: 'failed', message: '无法连接' })).toMatchObject({ state: 'failed', message: '无法连接' });
  expect(parseUpdateStatus({ current: '0.2.10', state: 'ready' })).toBeNull();
  expect(parseUpdateStatus({ state: 'idle' })).toBeNull();
  expect(parseUpdateStatus({ current: '0.2.10', state: 'unknown' })).toBeNull();
  expect(parseUpdateStatus('ready')).toBeNull();
});

it('describes each state in one line', () => {
  const now = 1_000_000_000;
  expect(updateLabel({ current: '1', state: 'latest', checkedAt: now / 1000 - 30 }, now)).toBe('已是最新版本 · 刚刚检查');
  expect(updateLabel({ current: '1', state: 'latest', checkedAt: now / 1000 - 7200 }, now)).toBe('已是最新版本 · 2 小时前检查');
  expect(updateLabel({ current: '1', state: 'downloading', version: '2', downloaded: 1, total: 4 })).toBe('正在下载 2（25%）…');
  expect(updateLabel({ current: '1', state: 'downloading', version: '2', downloaded: 1, total: null })).toBe('正在下载 2…');
  expect(updateLabel({ current: '1', state: 'ready', version: '2', notes: null })).toBe('2 已安装，重启后生效');
});
