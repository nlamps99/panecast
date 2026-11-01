import { RpcCallError, type ConnectionStatus } from '../../protocol/connection';
import type { PushFrame } from '../../protocol/frames';
import {
  canCloseSurface,
  fallbackSurface,
  parseCreatedSurfaceId,
  SurfaceActions,
} from '../surfaceActions';
import type { SurfaceInfo } from '../surfaces';
import { TerminalSession, type RpcChannel } from '../terminalSession';
import { WorkspaceStore } from '../workspaceStore';

/** A Mac with one workspace whose terminals can be created and closed. */
class FakeMac implements RpcChannel {
  isOpen = true;
  calls: { method: string; params: Record<string, unknown> }[] = [];
  terminals: string[] = ['s1', 's2', 's3'];
  nextId = 4;
  /** Overrides the `surface.create` result. */
  createResult: ((id: string) => unknown) | null = null;
  fail: Partial<Record<string, Error>> = {};
  /** Resolves pending `surface.create` / `surface.close` calls when set. */
  gate: Promise<void> | null = null;

  async call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    this.calls.push({ method, params });
    const failure = this.fail[method];
    if (failure) throw failure;
    switch (method) {
      case 'workspace.list':
        return { workspaces: [{ id: 'w1', title: 'main', index: 0, selected: true }] } as T;
      case 'surface.list':
        return {
          surfaces: this.terminals.map((id, index) => ({ id, title: `zsh ${id}`, index, type: 'terminal' })),
        } as T;
      case 'surface.create': {
        if (this.gate) await this.gate;
        const id = `s${this.nextId++}`;
        this.terminals.push(id);
        return (this.createResult ? this.createResult(id) : { surface_id: id, workspace_id: params.workspace_id }) as T;
      }
      case 'surface.close':
        if (this.gate) await this.gate;
        this.terminals = this.terminals.filter((id) => id !== params.surface_id);
        return {} as T;
      case 'surface.subscribe':
      case 'surface.unsubscribe':
        return {} as T;
      default:
        throw new Error(`unexpected ${method}`);
    }
  }
  onPush(_listener: (frame: PushFrame) => void) {
    return () => {};
  }
  onStatus(_listener: (status: ConnectionStatus) => void) {
    return () => {};
  }
  count(method: string): number {
    return this.calls.filter((c) => c.method === method).length;
  }
}

async function setup(open = 's2') {
  const channel = new FakeMac();
  const session = new TerminalSession(channel);
  const workspaces = new WorkspaceStore(channel);
  await workspaces.refresh();
  session.setTarget({ workspaceId: 'w1', surfaceId: open });
  const actions = new SurfaceActions({ channel, session, workspaces });
  const ids = () => (workspaces.getState().surfaces.w1 ?? []).map((s) => s.id);
  return { channel, session, workspaces, actions, ids };
}

const surfaces = (...ids: string[]): SurfaceInfo[] =>
  ids.map((id, index) => ({ id, title: id, index, focused: false, type: 'terminal' }));

describe('parseCreatedSurfaceId', () => {
  it('reads surface_id, then id', () => {
    expect(parseCreatedSurfaceId({ surface_id: 'a', id: 'b' })).toBe('a');
    expect(parseCreatedSurfaceId({ id: 'b' })).toBe('b');
    expect(parseCreatedSurfaceId({ surfaceId: 'c' })).toBe('c');
  });

  it('returns null without an id', () => {
    expect(parseCreatedSurfaceId({})).toBeNull();
    expect(parseCreatedSurfaceId({ surface_id: '' })).toBeNull();
    expect(parseCreatedSurfaceId(null)).toBeNull();
    expect(parseCreatedSurfaceId(['a'])).toBeNull();
    expect(parseCreatedSurfaceId('a')).toBeNull();
  });
});

describe('fallbackSurface', () => {
  it('picks the right neighbour, or the left one for the last chip', () => {
    expect(fallbackSurface(surfaces('a', 'b', 'c'), 'b')?.id).toBe('c');
    expect(fallbackSurface(surfaces('a', 'b', 'c'), 'a')?.id).toBe('b');
    expect(fallbackSurface(surfaces('a', 'b', 'c'), 'c')?.id).toBe('b');
  });

  it('falls back to the first other terminal when the closed one is not listed', () => {
    expect(fallbackSurface(surfaces('a', 'b'), 'x')?.id).toBe('a');
  });

  it('has nothing to offer for a lone terminal', () => {
    expect(fallbackSurface(surfaces('a'), 'a')).toBeNull();
    expect(fallbackSurface([], 'a')).toBeNull();
  });
});

describe('canCloseSurface', () => {
  it('keeps the last terminal of a workspace', () => {
    expect(canCloseSurface(surfaces('a'))).toBe(false);
    expect(canCloseSurface(surfaces('a', 'b'))).toBe(true);
  });
});

describe('SurfaceActions.create', () => {
  it('creates a focused terminal, opens it and refreshes the list', async () => {
    const { channel, session, actions, ids } = await setup();
    const seen: (string | null)[] = [];
    actions.subscribe(() => seen.push(actions.getState().running));

    await actions.create('w1');

    expect(channel.calls.find((c) => c.method === 'surface.create')?.params).toEqual({
      workspace_id: 'w1',
      type: 'terminal',
      focus: true,
    });
    expect(session.getState().target).toEqual({ workspaceId: 'w1', surfaceId: 's4' });
    expect(ids()).toEqual(['s1', 's2', 's3', 's4']);
    expect(seen[0]).toBe('create');
    expect(actions.getState()).toEqual({ running: null, error: null });
  });

  it('accepts the older `id` result shape', async () => {
    const { channel, session, actions } = await setup();
    channel.createResult = (id) => ({ id });
    await actions.create('w1');
    expect(session.getState().target?.surfaceId).toBe('s4');
  });

  it('leaves the target alone when the user opened another terminal meanwhile', async () => {
    const { channel, session, actions } = await setup();
    let release!: () => void;
    channel.gate = new Promise((resolve) => (release = resolve));
    const pending = actions.create('w1');
    session.setTarget({ workspaceId: 'w1', surfaceId: 's1' });
    release();
    await pending;
    expect(session.getState().target?.surfaceId).toBe('s1');
  });

  it('reports a failure and still refreshes', async () => {
    const { channel, session, actions } = await setup();
    channel.fail['surface.create'] = new RpcCallError('internal_error', 'cmux said no');
    const listsBefore = channel.count('workspace.list');

    await actions.create('w1');

    expect(actions.getState()).toEqual({ running: null, error: '新建终端失败：cmux said no' });
    expect(session.getState().target?.surfaceId).toBe('s2');
    expect(channel.count('workspace.list')).toBe(listsBefore + 1);
  });

  it('reports a result without an id but shows the terminal cmux made', async () => {
    const { channel, session, actions, ids } = await setup();
    channel.createResult = () => ({ ok: true });
    await actions.create('w1');
    expect(actions.getState().error).toBe('新建终端失败：电脑没有返回新终端的编号');
    expect(session.getState().target?.surfaceId).toBe('s2');
    expect(ids()).toContain('s4');
  });

  it('ignores a second action while one runs', async () => {
    const { channel, actions } = await setup();
    let release!: () => void;
    channel.gate = new Promise((resolve) => (release = resolve));
    const first = actions.create('w1');
    void actions.create('w1');
    void actions.close('w1', 's1');
    release();
    await first;
    expect(channel.count('surface.create')).toBe(1);
    expect(channel.count('surface.close')).toBe(0);
  });
});

describe('SurfaceActions.close', () => {
  it('closes the open terminal and switches to its right neighbour', async () => {
    const { channel, session, actions, ids } = await setup('s2');
    await actions.close('w1', 's2');
    expect(channel.calls.find((c) => c.method === 'surface.close')?.params).toEqual({ workspace_id: 'w1', surface_id: 's2' });
    expect(session.getState().target).toEqual({ workspaceId: 'w1', surfaceId: 's3' });
    expect(ids()).toEqual(['s1', 's3']);
    expect(actions.getState()).toEqual({ running: null, error: null });
  });

  it('switches left when closing the last chip', async () => {
    const { session, actions } = await setup('s3');
    await actions.close('w1', 's3');
    expect(session.getState().target?.surfaceId).toBe('s2');
  });

  it('keeps the open terminal when closing another one', async () => {
    const { session, actions, ids } = await setup('s2');
    await actions.close('w1', 's1');
    expect(session.getState().target?.surfaceId).toBe('s2');
    expect(ids()).toEqual(['s2', 's3']);
  });

  it('refuses to close the last terminal without calling the Mac', async () => {
    const { channel, workspaces, actions } = await setup('s1');
    channel.terminals = ['s1'];
    await workspaces.refresh();
    await actions.close('w1', 's1');
    expect(channel.count('surface.close')).toBe(0);
    expect(actions.getState()).toEqual({ running: null, error: '不能关闭工作区里的最后一个终端' });
  });

  it('reports a failure and keeps the open terminal', async () => {
    const { channel, session, actions } = await setup('s2');
    channel.fail['surface.close'] = new RpcCallError('timeout', 'timed out');
    await actions.close('w1', 's2');
    expect(actions.getState()).toEqual({ running: null, error: '关闭终端失败：电脑没有响应，请稍后再试' });
    expect(session.getState().target?.surfaceId).toBe('s2');
  });

  it('clears an error on request and when the next action starts', async () => {
    const { actions } = await setup('s2');
    actions.refuseLastClose();
    actions.clearError();
    expect(actions.getState().error).toBeNull();
    actions.refuseLastClose();
    const pending = actions.close('w1', 's1');
    expect(actions.getState()).toEqual({ running: 'close', error: null });
    await pending;
  });
});
