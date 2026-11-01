import type { ConnectionStatus } from '../protocol/connection';
import { describeError, type RpcChannel } from './terminalSession';
import { listSurfaces, listWorkspaces, type SurfaceInfo, type WorkspaceInfo } from './surfaces';

export type WorkspaceState = {
  workspaces: readonly WorkspaceInfo[];
  /** Terminals per workspace id. */
  surfaces: Readonly<Record<string, readonly SurfaceInfo[]>>;
  loading: boolean;
  /** Set once the first refresh has finished, successfully or not. */
  loaded: boolean;
  error: string | null;
};

/** Workspace and surface changes from cmux; `agent` and `hook` events fire far too often to refetch on. */
const REFRESH_CATEGORIES = new Set(['workspace', 'surface']);
const EVENT_DEBOUNCE_MS = 1_500;

/**
 * The Mac's workspaces and their terminals, for the list screen and the
 * terminal header. Refreshes when the connection opens, when cmux reports a
 * workspace or surface change, and on request (pull to refresh, screen focus).
 */
export class WorkspaceStore {
  private state: WorkspaceState = { workspaces: [], surfaces: {}, loading: false, loaded: false, error: null };
  private listeners = new Set<() => void>();
  private disposers: (() => void)[] = [];
  private inFlight: Promise<void> | null = null;
  private again = false;
  private debounce: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly channel: RpcChannel) {
    this.disposers.push(
      channel.onStatus((status: ConnectionStatus) => {
        if (status.state === 'open') void this.refresh();
      }),
      channel.onPush((frame) => {
        if (frame.type === 'event' && REFRESH_CATEGORIES.has(frame.category)) this.refreshSoon();
        if (frame.type === 'event' && frame.category === 'system' && frame.name === 'cmux.reset') this.refreshSoon();
      }),
    );
  }

  getState = (): WorkspaceState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  dispose(): void {
    for (const dispose of this.disposers) dispose();
    this.disposers = [];
    if (this.debounce) clearTimeout(this.debounce);
    this.listeners.clear();
  }

  /** One refresh at a time; a request during a refresh runs once more afterwards. */
  refresh(): Promise<void> {
    if (this.inFlight) {
      this.again = true;
      return this.inFlight;
    }
    this.inFlight = this.load().finally(() => {
      this.inFlight = null;
      if (this.again) {
        this.again = false;
        void this.refresh();
      }
    });
    return this.inFlight;
  }

  private refreshSoon(): void {
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => {
      this.debounce = null;
      void this.refresh();
    }, EVENT_DEBOUNCE_MS);
  }

  private async load(): Promise<void> {
    if (!this.channel.isOpen) return;
    this.update({ loading: true });
    try {
      const workspaces = await listWorkspaces(this.channel);
      const lists = await Promise.all(
        workspaces.map((workspace) => listSurfaces(this.channel, workspace.id).catch(() => [] as SurfaceInfo[])),
      );
      const surfaces: Record<string, readonly SurfaceInfo[]> = {};
      workspaces.forEach((workspace, i) => {
        surfaces[workspace.id] = lists[i];
      });
      this.update({ workspaces, surfaces, loading: false, loaded: true, error: null });
    } catch (error) {
      this.update({ loading: false, loaded: true, error: describeError(error) });
    }
  }

  private update(patch: Partial<WorkspaceState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
}
