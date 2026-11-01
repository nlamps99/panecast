import { RpcCallError } from '../protocol/connection';
import type { SurfaceInfo } from './surfaces';
import { describeError, type RpcChannel, type SurfaceTarget } from './terminalSession';

/**
 * Creating and closing terminals from the terminal header, as the native
 * client does (`legacy/ios/CmuxRemote/Workspace/WorkspaceView.swift`
 * `createSurface` / `closeSurface`).
 */

/**
 * The new surface's id from a `surface.create` result. cmux answers with
 * `surface_id`; older builds used `id`.
 */
export function parseCreatedSurfaceId(result: unknown): string | null {
  if (typeof result !== 'object' || result === null || Array.isArray(result)) return null;
  const record = result as Record<string, unknown>;
  for (const key of ['surface_id', 'surfaceId', 'id']) {
    const value = record[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

/** A workspace keeps at least one terminal; closing the last one is refused. */
export function canCloseSurface(surfaces: readonly SurfaceInfo[]): boolean {
  return surfaces.length > 1;
}

/**
 * The terminal to show after closing `surfaceId`: the next one to the right,
 * or the one to the left when closing the last chip.
 */
export function fallbackSurface(surfaces: readonly SurfaceInfo[], surfaceId: string): SurfaceInfo | null {
  const index = surfaces.findIndex((s) => s.id === surfaceId);
  if (index < 0) return surfaces.find((s) => s.id !== surfaceId) ?? null;
  const candidate = surfaces[index < surfaces.length - 1 ? index + 1 : index - 1];
  if (!candidate) return null;
  return candidate.id === surfaceId ? (surfaces.find((s) => s.id !== surfaceId) ?? null) : candidate;
}

/** Opens a new terminal in `workspaceId` on the Mac and returns its id. */
export async function createTerminal(channel: RpcChannel, workspaceId: string): Promise<string> {
  const result = await channel.call('surface.create', { workspace_id: workspaceId, type: 'terminal', focus: true });
  const id = parseCreatedSurfaceId(result);
  if (!id) throw new RpcCallError('bad_response', '电脑没有返回新终端的编号');
  return id;
}

/** Closes a terminal in cmux on the Mac. */
export async function closeTerminal(channel: RpcChannel, workspaceId: string, surfaceId: string): Promise<void> {
  await channel.call('surface.close', { workspace_id: workspaceId, surface_id: surfaceId });
}

export type SurfaceActionState = {
  /** The action in flight; the header disables its chips while set. */
  running: 'create' | 'close' | null;
  error: string | null;
};

/** What the actions need from a `Machine`. */
export type SurfaceActionDeps = {
  channel: RpcChannel;
  session: { getState(): { target: SurfaceTarget | null }; setTarget(target: SurfaceTarget | null): void };
  workspaces: {
    getState(): { surfaces: Readonly<Record<string, readonly SurfaceInfo[]>> };
    refresh(): Promise<void>;
  };
};

/**
 * One create or close at a time, with its error, for the terminal header.
 * Lists come from `WorkspaceStore`; each action refreshes it afterwards.
 */
export class SurfaceActions {
  private state: SurfaceActionState = { running: null, error: null };
  private listeners = new Set<() => void>();

  constructor(private readonly deps: SurfaceActionDeps) {}

  getState = (): SurfaceActionState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  clearError(): void {
    if (this.state.error) this.update({ error: null });
  }

  /** Shown when the user tries to close a workspace's only terminal. */
  refuseLastClose(): void {
    this.update({ error: '不能关闭工作区里的最后一个终端' });
  }

  /** Creates a terminal in `workspaceId` and opens it, unless the user has since opened another one. */
  async create(workspaceId: string): Promise<void> {
    if (this.state.running) return;
    const before = this.deps.session.getState().target;
    this.update({ running: 'create', error: null });
    let error: string | null = null;
    try {
      const surfaceId = await createTerminal(this.deps.channel, workspaceId);
      if (sameTarget(this.deps.session.getState().target, before)) {
        this.deps.session.setTarget({ workspaceId, surfaceId });
      }
    } catch (failure) {
      error = `新建终端失败：${describeError(failure)}`;
    }
    // Refresh even after a failure: cmux may have created the terminal anyway.
    await this.refresh();
    this.update({ running: null, error });
  }

  /**
   * Closes a terminal. When it is the one on screen, switches to its
   * neighbour in the list the user saw, as the native client does.
   */
  async close(workspaceId: string, surfaceId: string): Promise<void> {
    if (this.state.running) return;
    const surfaces = this.deps.workspaces.getState().surfaces[workspaceId] ?? [];
    if (!canCloseSurface(surfaces)) {
      this.refuseLastClose();
      return;
    }
    const fallback = fallbackSurface(surfaces, surfaceId);
    this.update({ running: 'close', error: null });
    let error: string | null = null;
    try {
      await closeTerminal(this.deps.channel, workspaceId, surfaceId);
      const target = this.deps.session.getState().target;
      if (target?.workspaceId === workspaceId && target.surfaceId === surfaceId) {
        this.deps.session.setTarget(fallback ? { workspaceId, surfaceId: fallback.id } : null);
      }
    } catch (failure) {
      error = `关闭终端失败：${describeError(failure)}`;
    }
    await this.refresh();
    this.update({ running: null, error });
  }

  private async refresh(): Promise<void> {
    try {
      await this.deps.workspaces.refresh();
    } catch {
      // WorkspaceStore records its own errors; the action's outcome stands.
    }
  }

  private update(patch: Partial<SurfaceActionState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
}

function sameTarget(a: SurfaceTarget | null, b: SurfaceTarget | null): boolean {
  return a?.workspaceId === b?.workspaceId && a?.surfaceId === b?.surfaceId;
}
