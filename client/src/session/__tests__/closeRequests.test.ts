import { requestTerminalClose, requestWorkspaceClose } from '../closeRequests';
import { SurfaceActions } from '../surfaceActions';
import { canCloseTerminal } from '../surfaces';
import { WorkspaceStore } from '../workspaceStore';
import type { RpcChannel, SurfaceTarget } from '../terminalSession';

async function fixture(count = 2, access: 'control' | 'shared' = 'control') {
  let terminals = Array.from({ length: count }, (_, index) => `terminal-${index}`);
  let exists = true, readOnly = false;
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const channel: RpcChannel = {
    isOpen: true, onPush: () => () => {}, onStatus: () => () => {},
    async call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
      calls.push({ method, params });
      if (method === 'workspace.list') return { workspaces: exists ? [{ id: 'workspace', title: 'project', index: 0, selected: true, access: readOnly ? 'read' : access }] : [] } as T;
      if (method === 'surface.list') return { surfaces: terminals.map((id, index) => ({ id, title: id, index, type: 'terminal' })) } as T;
      if (method === 'surface.close') terminals = terminals.filter(id => id !== params.surface_id);
      if (method === 'workspace.close') exists = false;
      return {} as T;
    },
  };
  let target: SurfaceTarget | null = { workspaceId: 'workspace', surfaceId: terminals[0] };
  const session = { getState: () => ({ target }), setTarget: (value: SurfaceTarget | null) => { target = value; } };
  const workspaces = new WorkspaceStore(channel); await workspaces.refresh();
  const deps = { channel, session, workspaces }, actions = new SurfaceActions(deps);
  const workspace = workspaces.getState().workspaces[0], surface = workspaces.getState().surfaces.workspace[0];
  const mutations = () => calls.filter(call => call.method.endsWith('.close'));
  return { deps, actions, workspace, surface, mutations, addTerminal: async () => { terminals.push('new'); await workspaces.refresh(); },
    dropOther: async () => { terminals = terminals.slice(0, 1); await workspaces.refresh(); },
    revoke: async () => { readOnly = true; await workspaces.refresh(); } };
}

it('closes only the confirmed terminal and selects its neighbour', async () => {
  const fx = await fixture(); const confirm = jest.fn(async () => true);
  await requestTerminalClose(fx.deps, fx.actions, fx.workspace, fx.surface, confirm);
  expect(confirm).toHaveBeenCalledWith('关闭终端？', expect.stringContaining('terminal-0'));
  expect(fx.mutations()).toEqual([{ method: 'surface.close', params: { workspace_id: 'workspace', surface_id: 'terminal-0' } }]);
  expect(fx.deps.session.getState().target?.surfaceId).toBe('terminal-1');
});
it('offers an explicit workspace confirmation for the last terminal', async () => {
  const fx = await fixture(1); const confirm = jest.fn(async () => true);
  await requestTerminalClose(fx.deps, fx.actions, fx.workspace, fx.surface, confirm);
  expect(confirm).toHaveBeenCalledWith('关闭最后一个终端？', expect.stringContaining('同时关闭这个工作区'));
  expect(fx.mutations()).toEqual([{ method: 'workspace.close', params: { workspace_id: 'workspace' } }]);
  expect(fx.deps.session.getState().target).toBeNull();
});
it('does not mutate a remote terminal when the dialog is cancelled', async () => {
  const fx = await fixture();
  await requestTerminalClose(fx.deps, fx.actions, fx.workspace, fx.surface, async () => false);
  await requestWorkspaceClose(fx.deps, fx.workspace, async () => false);
  expect(fx.mutations()).toEqual([]);
});
it('does not close newly created terminals while an older dialog is open', async () => {
  const fx = await fixture(1);
  await requestTerminalClose(fx.deps, fx.actions, fx.workspace, fx.surface, async () => { await fx.addTerminal(); return true; });
  expect(fx.mutations().map(call => call.method)).toEqual(['surface.close']);
  expect(fx.deps.workspaces.getState().surfaces.workspace.map(s => s.id)).toEqual(['new']);
  const ws = await fixture();
  await expect(requestWorkspaceClose(ws.deps, ws.workspace, async () => { await ws.addTerminal(); return true; })).rejects.toThrow('新增了终端');
  expect(ws.mutations()).toEqual([]);
});
it('rechecks permission after confirmation and ignores offline clicks', async () => {
  const fx = await fixture();
  await requestTerminalClose(fx.deps, fx.actions, fx.workspace, fx.surface, async () => { await fx.revoke(); return true; });
  expect(fx.mutations()).toEqual([]);
  Object.defineProperty(fx.deps.channel, 'isOpen', { value: false });
  const confirm = jest.fn(async () => true);
  await requestWorkspaceClose(fx.deps, fx.workspace, confirm);
  expect(confirm).not.toHaveBeenCalled();
});
it('a shared window closes its extra terminals but keeps the last one', async () => {
  const fx = await fixture(2, 'shared'); const confirm = jest.fn(async () => true);
  await requestTerminalClose(fx.deps, fx.actions, fx.workspace, fx.surface, confirm);
  expect(confirm).toHaveBeenCalledWith('关闭终端？', expect.stringContaining('terminal-0'));
  expect(fx.mutations()).toEqual([{ method: 'surface.close', params: { workspace_id: 'workspace', surface_id: 'terminal-0' } }]);
  const last = await fixture(1, 'shared'); const asked = jest.fn(async () => true);
  await requestTerminalClose(last.deps, last.actions, last.workspace, last.surface, asked);
  expect(asked).not.toHaveBeenCalled();
  expect(last.mutations()).toEqual([]);
  expect(last.actions.getState().error).toBe('分享窗口至少要留一个终端');
  // Another guest closed the other terminal while the dialog was open.
  const raced = await fixture(2, 'shared');
  await requestTerminalClose(raced.deps, raced.actions, raced.workspace, raced.surface, async () => { await raced.dropOther(); return true; });
  expect(raced.mutations()).toEqual([]);
});
it('decides which terminals may be closed', () => {
  expect(canCloseTerminal({ access: 'control' }, 1)).toBe(true);
  expect(canCloseTerminal({ access: 'shared' }, 2)).toBe(true);
  expect(canCloseTerminal({ access: 'shared' }, 1)).toBe(false);
  expect(canCloseTerminal({ access: 'read' }, 3)).toBe(false);
  expect(canCloseTerminal(null, 3)).toBe(false);
  expect(canCloseTerminal({}, 1)).toBe(true);
});
