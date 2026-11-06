import type { ConnectionStatus } from '../protocol/connection';
import { describeError, type RpcChannel } from './terminalSession';
import {
  listSurfaces,
  listWindows,
  listWorkspacesIn,
  type SurfaceInfo,
  type WindowInfo,
  type WorkspaceInfo,
  type WorkspaceListing,
} from './surfaces';

export type WorkspaceState = {
  workspaces: readonly WorkspaceInfo[];
  /** Terminals per workspace id. */
  surfaces: Readonly<Record<string, readonly SurfaceInfo[]>>;
  /**
   * cmux's windows. Empty when cmux has no `window.list` (older builds); the
   * list then covers the key window, as it did before windows were supported.
   */
  windows: readonly WindowInfo[];
  /** The window `workspaces` belong to; null means cmux's key window, unscoped. */
  selectedWindowId: string | null;
  /**
   * Every workspace and terminal seen on this connection, in any window, so
   * an open terminal keeps its titles after the list switches windows.
   */
  known: { workspaces: Readonly<Record<string, WorkspaceInfo>>; surfaces: Readonly<Record<string, readonly SurfaceInfo[]>> };
  loading: boolean;
  /** Set once a refresh has finished, successfully or not; cleared while switching windows. */
  loaded: boolean;
  error: string | null;
};

/** Workspace and surface changes from cmux; `agent` and `hook` events fire far too often to refetch on. */
const REFRESH_CATEGORIES = new Set(['workspace', 'surface', 'source']);
const EVENT_DEBOUNCE_MS = 1_500;

/**
 * Which window to list: the one asked for while it still exists, else cmux's
 * key window (what the user sees on the Mac), else the window cmux listed by
 * default, else the first. Null when cmux reported no windows.
 */
export function chooseWindow(windows: readonly WindowInfo[], requested: string | null, reported: string | null): string | null {
  if (windows.length === 0) return null;
  if (requested && windows.some((w) => w.id === requested)) return requested;
  return (windows.find((w) => w.key) ?? windows.find((w) => w.id === reported) ?? windows[0]).id;
}

/**
 * The Mac's workspaces and their terminals, for the list screen and the
 * terminal header. Lists one cmux window at a time (cmux scopes
 * `workspace.list` to a window), the key window unless another is selected.
 * Refreshes when the connection opens, when cmux reports a workspace or
 * surface change, and on request (pull to refresh, screen focus).
 */
export class WorkspaceStore {
  private state: WorkspaceState = {
    workspaces: [],
    surfaces: {},
    windows: [],
    selectedWindowId: null,
    known: { workspaces: {}, surfaces: {} },
    loading: false,
    loaded: false,
    error: null,
  };
  private listeners = new Set<() => void>();
  private disposers: (() => void)[] = [];
  private inFlight: Promise<void> | null = null;
  private queued: Promise<void> | null = null;
  private debounce: ReturnType<typeof setTimeout> | null = null;
  /** Bumped when the listed window changes; a load started before that is dropped. */
  private generation = 0;

  constructor(private readonly channel: RpcChannel, initialWindowId: string | null = null) {
    this.state = { ...this.state, selectedWindowId: initialWindowId };
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
    this.generation++;
    this.listeners.clear();
  }

  /**
   * One refresh at a time. Requests made during a refresh share one more run
   * afterwards, and their promise settles when that run has finished.
   */
  refresh(): Promise<void> {
    if (this.inFlight) {
      const rerun = () => {
        this.queued = null;
        return this.refresh();
      };
      this.queued ??= this.inFlight.then(rerun, rerun);
      return this.queued;
    }
    const load = this.load().finally(() => {
      this.inFlight = null;
    });
    this.inFlight = load;
    return load;
  }

  /**
   * Lists another cmux window's workspaces. Workspace ids belong to their
   * window, so the old list goes at once instead of showing under the new
   * window's chip.
   */
  selectWindow(windowId: string): Promise<void> {
    if (windowId === this.state.selectedWindowId) return Promise.resolve();
    if (!this.state.windows.some((w) => w.id === windowId)) return Promise.resolve();
    this.generation++;
    this.update({ selectedWindowId: windowId, workspaces: [], surfaces: {}, loaded: false, error: null });
    return this.refresh();
  }

  private refreshSoon(): void {
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => {
      this.debounce = null;
      void this.refresh();
    }, EVENT_DEBOUNCE_MS);
  }

  private async load(): Promise<void> {
    if (!this.channel.isOpen) {
      if (this.state.loading) this.update({ loading: false });
      return;
    }
    const generation = this.generation;
    const requested = this.state.selectedWindowId;
    this.update({ loading: true });
    // The window list and the current window's workspaces in one round trip.
    const [windowsResult, listingResult] = await Promise.allSettled([
      listWindows(this.channel),
      listWorkspacesIn(this.channel, requested),
    ]);
    if (generation !== this.generation) return;
    // A failed `window.list` is not fatal: older cmux has none, and the list
    // then covers the key window as before. Keep what an earlier refresh found.
    const windows = windowsResult.status === 'fulfilled' ? windowsResult.value : this.state.windows;
    const listed = listingResult.status === 'fulfilled' ? listingResult.value : null;
    const selectedWindowId = chooseWindow(windows, requested, listed?.windowId ?? null);
    try {
      let listing: WorkspaceListing | null =
        listed && (selectedWindowId === requested || listed.windowId === selectedWindowId) ? listed : null;
      if (!listing) {
        if (selectedWindowId === requested && listingResult.status === 'rejected') throw listingResult.reason;
        // The window to list changed (first load, or the listed window was closed).
        listing = await listWorkspacesIn(this.channel, selectedWindowId);
        if (generation !== this.generation) return;
      }
      const { workspaces } = listing;
      const lists = await Promise.all(
        workspaces.map((workspace) => listSurfaces(this.channel, workspace.id).catch(() => [] as SurfaceInfo[])),
      );
      if (generation !== this.generation) return;
      const surfaces: Record<string, readonly SurfaceInfo[]> = {};
      workspaces.forEach((workspace, i) => {
        surfaces[workspace.id] = lists[i];
      });
      const known = {
        workspaces: { ...this.state.known.workspaces, ...Object.fromEntries(workspaces.map((w) => [w.id, w])) },
        surfaces: { ...this.state.known.surfaces, ...surfaces },
      };
      this.update({ windows, selectedWindowId, workspaces, surfaces, known, loading: false, loaded: true, error: null });
    } catch (error) {
      if (generation !== this.generation) return;
      this.update({ loading: false, loaded: true, error: describeError(error) });
    }
  }

  private update(patch: Partial<WorkspaceState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
}
