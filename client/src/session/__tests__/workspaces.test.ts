import { RpcCallError, type ConnectionStatus } from '../../protocol/connection';
import type { PushFrame } from '../../protocol/frames';
import { listWindows, windowLabel, type WindowInfo } from '../surfaces';
import type { RpcChannel, SurfaceTarget } from '../terminalSession';
import { actionErrorText, WorkspaceActions, workspaceActionsFor } from '../workspaceActions';
import { chooseWindow, WorkspaceStore } from '../workspaceStore';

type FakeWindow = { id: string; ref: string; key?: boolean; workspaces: { id: string; title: string }[] };

/**
 * A cmux with several windows. `workspace.list` without `window_id` lists the
 * key window, like cmux. Answers are worked out when the call is made, then
 * optionally held until `release()`.
 */
class CmuxChannel implements RpcChannel {
  isOpen = true;
  calls: { method: string; params: Record<string, unknown> }[] = [];
  windows: FakeWindow[] = [
    { id: 'win-a', ref: 'window:1', workspaces: [{ id: 'a1', title: 'Alpha' }, { id: 'a2', title: 'Beta' }] },
    { id: 'win-b', ref: 'window:2', key: true, workspaces: [{ id: 'b1', title: 'Gamma' }] },
  ];
  supportsWindows = true;
  reportsWindowId = true;
  /** The next call to each of these methods waits for `release()`. */
  holdNext = new Set<string>();
  /** The next call to each of these methods fails. */
  failNext = new Map<string, RpcCallError>();
  private waiting: (() => void)[] = [];

  async call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    this.calls.push({ method, params });
    let answer: unknown;
    let failure: unknown = null;
    try {
      const fail = this.failNext.get(method);
      if (fail) {
        this.failNext.delete(method);
        throw fail;
      }
      answer = this.answer(method, params);
    } catch (error) {
      failure = error;
    }
    if (this.holdNext.has(method)) {
      this.holdNext.delete(method);
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    if (failure) throw failure;
    return answer as T;
  }

  release() {
    const waiting = this.waiting;
    this.waiting = [];
    for (const resolve of waiting) resolve();
  }

  onPush(_listener: (frame: PushFrame) => void) {
    return () => {};
  }
  onStatus(_listener: (status: ConnectionStatus) => void) {
    return () => {};
  }

  listed(method: string) {
    return this.calls.filter((c) => c.method === method).map((c) => c.params);
  }

  private window(params: Record<string, unknown>): FakeWindow {
    const win = params.window_id
      ? this.windows.find((w) => w.id === params.window_id)
      : (this.windows.find((w) => w.key) ?? this.windows[0]);
    if (!win) throw new RpcCallError('not_found', 'Window not found');
    return win;
  }

  private workspace(id: unknown) {
    for (const win of this.windows) {
      const workspace = win.workspaces.find((w) => w.id === id);
      if (workspace) return { win, workspace };
    }
    throw new RpcCallError('not_found', 'Workspace not found');
  }

  private answer(method: string, params: Record<string, unknown>): unknown {
    switch (method) {
      case 'window.list':
        if (!this.supportsWindows) throw new RpcCallError('method_not_found', 'Unknown method');
        return {
          windows: this.windows.map((w, index) => ({ id: w.id, ref: w.ref, index, workspace_count: w.workspaces.length, key: w.key === true })),
        };
      case 'workspace.list': {
        const win = this.window(params);
        const workspaces = win.workspaces.map((w, index) => ({ ...w, index, selected: index === 0 }));
        return this.reportsWindowId ? { window_id: win.id, window_ref: win.ref, workspaces } : { workspaces };
      }
      case 'surface.list':
        return { surfaces: [{ id: `${params.workspace_id}-s1`, title: 'zsh', index: 0, focused: true, type: 'terminal' }] };
      case 'workspace.create': {
        const win = this.window(params);
        win.workspaces.push({ id: `new-${win.workspaces.length}`, title: String(params.title) });
        return {};
      }
      case 'workspace.rename':
        this.workspace(params.workspace_id).workspace.title = String(params.title);
        return {};
      case 'workspace.close': {
        const { win } = this.workspace(params.workspace_id);
        win.workspaces = win.workspaces.filter((w) => w.id !== params.workspace_id);
        return {};
      }
      default:
        throw new RpcCallError('method_not_found', 'Unknown method');
    }
  }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const titles = (store: WorkspaceStore) => store.getState().workspaces.map((w) => w.title);
const win = (id: string, key = false): WindowInfo => ({ id, ref: id, index: 0, workspaceCount: null, key });

describe('window parsing', () => {
  it('reads window.list in order and skips entries without an id', async () => {
    const channel = {
      call: async () => ({
        windows: [
          { id: 'w2', ref: 'window:2', index: 1, key: true },
          { ref: 'window:9' },
          { id: 'w1', ref: 'window:1', index: 0, workspace_count: 3 },
        ],
      }),
    } as unknown as RpcChannel;
    expect(await listWindows(channel)).toEqual([
      { id: 'w1', ref: 'window:1', index: 0, workspaceCount: 3, key: false },
      { id: 'w2', ref: 'window:2', index: 1, workspaceCount: null, key: true },
    ]);
  });

  it('labels windows by their window:N reference', () => {
    expect(windowLabel({ ...win('x'), ref: 'window:2' })).toBe('窗口 2');
    expect(windowLabel({ ...win('x'), index: 2 })).toBe('窗口 3');
    expect(windowLabel({ ...win('x'), ref: 'main' })).toBe('main');
  });

  it('chooses the requested window, else the key window, else the one cmux listed, else the first', () => {
    const windows = [win('a'), win('b', true), win('c')];
    expect(chooseWindow(windows, 'c', null)).toBe('c');
    expect(chooseWindow(windows, 'gone', null)).toBe('b');
    expect(chooseWindow([win('a'), win('c')], null, 'c')).toBe('c');
    expect(chooseWindow([win('a'), win('c')], null, null)).toBe('a');
    expect(chooseWindow([], 'a', 'a')).toBeNull();
  });
});

describe('WorkspaceStore windows', () => {
  it("defaults to cmux's key window and scopes later lists to it", async () => {
    const channel = new CmuxChannel();
    const store = new WorkspaceStore(channel);
    await store.refresh();
    expect(store.getState().windows.map((w) => w.ref)).toEqual(['window:1', 'window:2']);
    expect(store.getState().windows.map((w) => w.workspaceCount)).toEqual([2, 1]);
    expect(store.getState().selectedWindowId).toBe('win-b');
    expect(titles(store)).toEqual(['Gamma']);
    // The unscoped list already named its window, so one call was enough.
    expect(channel.listed('workspace.list')).toEqual([{}]);

    await store.refresh();
    expect(channel.listed('workspace.list')[1]).toEqual({ window_id: 'win-b' });
  });

  it('lists the key window again by id when cmux does not say which window it listed', async () => {
    const channel = new CmuxChannel();
    channel.reportsWindowId = false;
    const store = new WorkspaceStore(channel);
    await store.refresh();
    expect(channel.listed('workspace.list')).toEqual([{}, { window_id: 'win-b' }]);
    expect(titles(store)).toEqual(['Gamma']);
  });

  it('switches windows, dropping the old list at once', async () => {
    const channel = new CmuxChannel();
    const store = new WorkspaceStore(channel);
    await store.refresh();

    const switching = store.selectWindow('win-a');
    expect(store.getState()).toMatchObject({ selectedWindowId: 'win-a', workspaces: [], surfaces: {}, loaded: false });
    await switching;
    expect(titles(store)).toEqual(['Alpha', 'Beta']);
    expect(store.getState().surfaces.a1.map((s) => s.id)).toEqual(['a1-s1']);
    expect(channel.listed('workspace.list').at(-1)).toEqual({ window_id: 'win-a' });
  });

  it('ignores selecting the listed window or one cmux did not report', async () => {
    const channel = new CmuxChannel();
    const store = new WorkspaceStore(channel);
    await store.refresh();
    const before = channel.calls.length;
    await store.selectWindow('win-b');
    await store.selectWindow('nope');
    expect(channel.calls.length).toBe(before);
    expect(titles(store)).toEqual(['Gamma']);
  });

  it('keeps listing the key window, unscoped, when cmux has no window.list', async () => {
    const channel = new CmuxChannel();
    channel.supportsWindows = false;
    const store = new WorkspaceStore(channel);
    await store.refresh();
    expect(store.getState()).toMatchObject({ windows: [], selectedWindowId: null, error: null, loaded: true });
    expect(titles(store)).toEqual(['Gamma']);
    expect(channel.listed('workspace.list')).toEqual([{}]);
  });

  it('goes back to the key window when the listed window was closed on the Mac', async () => {
    const channel = new CmuxChannel();
    const store = new WorkspaceStore(channel);
    await store.refresh();
    await store.selectWindow('win-a');
    channel.windows = channel.windows.filter((w) => w.id !== 'win-a');

    await store.refresh();
    expect(store.getState()).toMatchObject({ selectedWindowId: 'win-b', error: null });
    expect(titles(store)).toEqual(['Gamma']);
  });

  it('keeps the windows it knows when one window.list fails', async () => {
    const channel = new CmuxChannel();
    const store = new WorkspaceStore(channel);
    await store.refresh();
    await store.selectWindow('win-a');
    channel.failNext.set('window.list', new RpcCallError('timeout', 'timed out'));

    await store.refresh();
    expect(store.getState().windows).toHaveLength(2);
    expect(store.getState().selectedWindowId).toBe('win-a');
    expect(titles(store)).toEqual(['Alpha', 'Beta']);
  });

  it('drops a load that finishes after the window was switched', async () => {
    const channel = new CmuxChannel();
    const store = new WorkspaceStore(channel);
    await store.refresh();
    channel.holdNext.add('workspace.list');
    void store.refresh();
    await flush();

    const seen: string[][] = [];
    store.subscribe(() => seen.push(titles(store)));
    const switching = store.selectWindow('win-a');
    channel.release();
    await switching;
    expect(seen.flat()).not.toContain('Gamma');
    expect(titles(store)).toEqual(['Alpha', 'Beta']);
  });

  it('settles a refresh asked for mid-load only after the follow-up load', async () => {
    const channel = new CmuxChannel();
    const store = new WorkspaceStore(channel);
    await store.refresh();
    channel.holdNext.add('workspace.list');
    void store.refresh();
    await flush();
    channel.windows[1].workspaces[0].title = 'Gamma 2';
    const again = store.refresh();
    channel.release();
    await again;
    expect(titles(store)).toEqual(['Gamma 2']);
  });
});

function setup(target: SurfaceTarget | null = null) {
  const channel = new CmuxChannel();
  const workspaces = new WorkspaceStore(channel);
  const session = {
    target,
    getState() {
      return { target: this.target };
    },
    setTarget: jest.fn(function (this: { target: SurfaceTarget | null }, next: SurfaceTarget | null) {
      this.target = next;
    }),
  };
  const actions = new WorkspaceActions({ channel, workspaces, session });
  return { channel, workspaces, session, actions };
}

describe('WorkspaceActions', () => {
  it('creates a workspace in the listed window, then refreshes', async () => {
    const { channel, workspaces, actions } = setup();
    await workspaces.refresh();
    await workspaces.selectWindow('win-a');
    channel.holdNext.add('workspace.create');

    const creating = actions.create('  Delta ');
    expect(actions.getState().creating).toBe(true);
    expect(await actions.create('again')).toBe(false);
    channel.release();
    expect(await creating).toBe(true);

    expect(channel.listed('workspace.create')).toEqual([{ title: 'Delta', window_id: 'win-a' }]);
    expect(actions.getState().creating).toBe(false);
    expect(titles(workspaces)).toEqual(['Alpha', 'Beta', 'Delta']);
  });

  it('creates in the key window without window_id when cmux has no window.list', async () => {
    const { channel, workspaces, actions } = setup();
    channel.supportsWindows = false;
    await workspaces.refresh();
    await actions.create('Delta');
    expect(channel.listed('workspace.create')).toEqual([{ title: 'Delta' }]);
  });

  it('ignores empty names', async () => {
    const { channel, actions } = setup();
    expect(await actions.create('   ')).toBe(false);
    expect(await actions.rename('b1', '')).toBe(false);
    expect(channel.calls).toEqual([]);
  });

  it('renames, keeping the card busy until the list is refreshed', async () => {
    const { channel, workspaces, actions } = setup();
    await workspaces.refresh();
    channel.holdNext.add('workspace.list');

    const renaming = actions.rename('b1', ' Omega ');
    await flush();
    expect(channel.listed('workspace.rename')).toEqual([{ workspace_id: 'b1', title: 'Omega' }]);
    expect(actions.getState().pending).toEqual({ b1: 'rename' });
    expect(await actions.rename('b1', 'Other')).toBe(false);
    channel.release();
    expect(await renaming).toBe(true);
    expect(actions.getState().pending).toEqual({});
    expect(titles(workspaces)).toEqual(['Omega']);
  });

  it('skips the call when the name did not change', async () => {
    const { channel, workspaces, actions } = setup();
    await workspaces.refresh();
    expect(await actions.rename('b1', 'Gamma ')).toBe(true);
    expect(channel.listed('workspace.rename')).toEqual([]);
  });

  it('closes a workspace and lets go of its open terminal', async () => {
    const { channel, workspaces, session, actions } = setup({ workspaceId: 'a1', surfaceId: 'a1-s1' });
    await workspaces.refresh();
    await workspaces.selectWindow('win-a');

    expect(await actions.close('a1')).toBe(true);
    expect(channel.listed('workspace.close')).toEqual([{ workspace_id: 'a1' }]);
    expect(session.setTarget).toHaveBeenCalledWith(null);
    expect(titles(workspaces)).toEqual(['Beta']);
  });

  it('keeps the open terminal when another workspace is closed', async () => {
    const { workspaces, session, actions } = setup({ workspaceId: 'b1', surfaceId: 'b1-s1' });
    await workspaces.refresh();
    await workspaces.selectWindow('win-a');
    await actions.close('a2');
    expect(session.setTarget).not.toHaveBeenCalled();
    expect(session.target).toEqual({ workspaceId: 'b1', surfaceId: 'b1-s1' });
  });

  it('reports a failure against its workspace, still refreshes, and clears it on the next action', async () => {
    const { channel, workspaces, session, actions } = setup({ workspaceId: 'b1', surfaceId: 'b1-s1' });
    await workspaces.refresh();
    channel.failNext.set('workspace.close', new RpcCallError('not_found', 'Workspace not found'));
    const lists = channel.listed('workspace.list').length;

    expect(await actions.close('b1')).toBe(false);
    const { error, pending } = actions.getState();
    expect(error).toEqual({ kind: 'close', workspaceId: 'b1', message: 'Workspace not found' });
    expect(actionErrorText(error!)).toBe('关闭失败：Workspace not found');
    expect(pending).toEqual({});
    expect(session.setTarget).not.toHaveBeenCalled();
    expect(channel.listed('workspace.list').length).toBe(lists + 1);

    await actions.rename('b1', 'Omega');
    expect(actions.getState().error).toBeNull();
  });

  it('describes a lost connection in Chinese and can dismiss the error', async () => {
    const { channel, actions } = setup();
    channel.failNext.set('workspace.create', new RpcCallError('not_connected', 'offline'));
    await actions.create('Delta');
    expect(actionErrorText(actions.getState().error!)).toBe('新建工作区失败：没有连上电脑');
    actions.dismissError();
    expect(actions.getState().error).toBeNull();
  });

  it('keeps one actions object per workspace store', () => {
    const a = setup();
    const b = setup();
    const first = workspaceActionsFor(a);
    expect(workspaceActionsFor({ ...a })).toBe(first);
    expect(workspaceActionsFor(b)).not.toBe(first);
  });
});
