import { RpcCallError } from '../../protocol/connection';
import { renameTerminal, TERMINAL_NAME_MAX } from '../terminalRename';
import type { RpcChannel } from '../terminalSession';

const target = { workspaceId: 'w', surfaceId: 's' };
function deps(fail?: RpcCallError) {
  const calls: { method: string; params?: Record<string, unknown> }[] = [];
  const refresh = jest.fn(async () => {});
  const channel: RpcChannel = { isOpen: true, onPush: () => () => {}, onStatus: () => () => {}, async call<T>(method: string, params?: Record<string, unknown>): Promise<T> {
    calls.push({ method, params });
    if (fail) throw fail;
    return { title: params?.title } as T;
  } };
  return { calls, refresh, deps: { channel, workspaces: { refresh } } };
}

it('renames with surface.action and refreshes the list', async () => {
  const { calls, refresh, deps: d } = deps();
  await expect(renameTerminal(d, target, '  构建  ')).resolves.toBe('renamed');
  expect(calls).toEqual([{ method: 'surface.action', params: { workspace_id: 'w', surface_id: 's', action: 'rename', title: '构建' } }]);
  expect(refresh).toHaveBeenCalledTimes(1);
});

it('gives the default name back with clear_name', async () => {
  const { calls, deps: d } = deps();
  await renameTerminal(d, target, null);
  expect(calls).toEqual([{ method: 'surface.action', params: { workspace_id: 'w', surface_id: 's', action: 'clear_name' } }]);
});

it('sends nothing for a blank or overlong name', async () => {
  const { calls, deps: d } = deps();
  await expect(renameTerminal(d, target, '   ')).resolves.toBe('unchanged');
  await expect(renameTerminal(d, target, '名'.repeat(TERMINAL_NAME_MAX + 1))).rejects.toThrow('最多 200 个字符');
  await expect(renameTerminal(d, target, '名'.repeat(TERMINAL_NAME_MAX))).resolves.toBe('renamed');
  expect(calls).toHaveLength(1);
});

it('reports older gateways and tmux sources as unsupported, once', async () => {
  for (const code of ['method_not_found', 'invalid_params']) {
    const { calls, refresh, deps: d } = deps(new RpcCallError(code, 'nope'));
    await expect(renameTerminal(d, target, 'x')).resolves.toBe('unsupported');
    expect(calls).toHaveLength(1);
    expect(refresh).not.toHaveBeenCalled();
  }
  const { deps: d } = deps(new RpcCallError('timeout', 'surface.action 超时'));
  await expect(renameTerminal(d, target, 'x')).rejects.toThrow('超时');
});
