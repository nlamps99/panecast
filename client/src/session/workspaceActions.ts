import { describeError, type RpcChannel, type SurfaceTarget } from './terminalSession';
import type { WorkspaceState } from './workspaceStore';

export type WorkspaceActionKind = 'create' | 'rename' | 'close';

/** The last action that failed. `workspaceId` is null for `create`. */
export type WorkspaceActionError = { kind: WorkspaceActionKind; workspaceId: string | null; message: string };

export type WorkspaceActionsState = {
  creating: boolean;
  /** Workspaces with a rename or close running, until the list has been refreshed. */
  pending: Readonly<Record<string, 'rename' | 'close'>>;
  error: WorkspaceActionError | null;
};

/** What the actions need from a `Machine`; `Machine` satisfies it. */
export type WorkspaceActionDeps = {
  channel: RpcChannel;
  workspaces: { getState(): WorkspaceState; refresh(): Promise<void> };
  session: { getState(): { target: SurfaceTarget | null }; setTarget(target: SurfaceTarget | null): void };
};

/** Without `window_id`, cmux creates the workspace in its key window, not necessarily the one listed. */
export function createWorkspace(channel: RpcChannel, title: string, windowId: string | null): Promise<unknown> {
  return channel.call('workspace.create', windowId ? { title, window_id: windowId } : { title });
}

export function renameWorkspace(channel: RpcChannel, workspaceId: string, title: string): Promise<unknown> {
  return channel.call('workspace.rename', { workspace_id: workspaceId, title });
}

export function closeWorkspace(channel: RpcChannel, workspaceId: string): Promise<unknown> {
  return channel.call('workspace.close', { workspace_id: workspaceId });
}

/**
 * Create, rename and close workspaces in cmux. Each action refreshes the list
 * afterwards, whether it worked or not, and keeps its card marked busy until
 * then. Methods resolve to whether the action succeeded; failures land in
 * `error` for the screen to show next to the workspace.
 */
export class WorkspaceActions {
  private state: WorkspaceActionsState = { creating: false, pending: {}, error: null };
  private listeners = new Set<() => void>();

  constructor(private readonly deps: WorkspaceActionDeps) {}

  getState = (): WorkspaceActionsState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Creates a workspace in the listed window. Empty titles are ignored. */
  async create(title: string): Promise<boolean> {
    const name = title.trim();
    if (!name || this.state.creating) return false;
    this.update({ creating: true, error: null });
    let ok = true;
    try {
      await createWorkspace(this.deps.channel, name, this.deps.workspaces.getState().selectedWindowId);
    } catch (error) {
      ok = false;
      this.update({ error: { kind: 'create', workspaceId: null, message: describeError(error) } });
    }
    await this.refreshList();
    this.update({ creating: false });
    return ok;
  }

  /** Renames a workspace. Empty titles are ignored; an unchanged title succeeds without a call. */
  async rename(workspaceId: string, title: string): Promise<boolean> {
    const name = title.trim();
    if (!name || this.state.pending[workspaceId]) return false;
    const current = this.deps.workspaces.getState().workspaces.find((w) => w.id === workspaceId);
    if (current?.title === name) return true;
    return this.run(workspaceId, 'rename', () => renameWorkspace(this.deps.channel, workspaceId, name));
  }

  /**
   * Closes a workspace in cmux on the Mac, terminals and all. If the open
   * terminal was in it, the terminal tab lets go of it rather than keep
   * resubscribing to a surface that no longer exists.
   */
  async close(workspaceId: string): Promise<boolean> {
    if (this.state.pending[workspaceId]) return false;
    return this.run(workspaceId, 'close', async () => {
      await closeWorkspace(this.deps.channel, workspaceId);
      if (this.deps.session.getState().target?.workspaceId === workspaceId) this.deps.session.setTarget(null);
    });
  }

  dismissError(): void {
    if (this.state.error) this.update({ error: null });
  }

  private async run(workspaceId: string, kind: 'rename' | 'close', action: () => Promise<unknown>): Promise<boolean> {
    this.update({ pending: { ...this.state.pending, [workspaceId]: kind }, error: null });
    let ok = true;
    try {
      await action();
    } catch (error) {
      ok = false;
      this.update({ error: { kind, workspaceId, message: describeError(error) } });
    }
    await this.refreshList();
    this.update({ pending: without(this.state.pending, workspaceId) });
    return ok;
  }

  /** The list store records its own errors; an action only waits for it. */
  private refreshList(): Promise<void> {
    return this.deps.workspaces.refresh().catch(() => {});
  }

  private update(patch: Partial<WorkspaceActionsState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
}

const FAILED: Record<WorkspaceActionKind, string> = { create: '新建工作区失败', rename: '重命名失败', close: '关闭失败' };

/** The line shown for a failed action, e.g. 重命名失败：没有连上电脑. */
export function actionErrorText(error: WorkspaceActionError): string {
  return `${FAILED[error.kind]}：${error.message}`;
}

const actionsByStore = new WeakMap<object, WorkspaceActions>();

/**
 * The actions for one connected Mac (or the demo), created on first use and
 * dropped with its workspace store. Keyed by the store so the busy state
 * survives leaving and re-entering the tab but not a switch of computer.
 */
export function workspaceActionsFor(deps: WorkspaceActionDeps): WorkspaceActions {
  let actions = actionsByStore.get(deps.workspaces);
  if (!actions) {
    actions = new WorkspaceActions(deps);
    actionsByStore.set(deps.workspaces, actions);
  }
  return actions;
}

function without<T>(record: Readonly<Record<string, T>>, key: string): Record<string, T> {
  const next = { ...record };
  delete next[key];
  return next;
}
