import type { RpcChannel, SurfaceTarget } from './terminalSession';

export type WorkspaceInfo = { id: string; title: string; index: number; selected: boolean };
export type SurfaceInfo = { id: string; title: string; index: number; focused: boolean; type: string };
/** A cmux window. `key` is cmux's key (frontmost) window. */
export type WindowInfo = { id: string; ref: string; index: number; workspaceCount: number | null; key: boolean };
/** One window's workspaces; `windowId` is the window cmux says it listed, when it says. */
export type WorkspaceListing = { windowId: string | null; workspaces: WorkspaceInfo[] };

/**
 * cmux's windows, in order. Older cmux builds do not implement `window.list`;
 * the call then rejects and callers fall back to the key window.
 */
export async function listWindows(channel: RpcChannel): Promise<WindowInfo[]> {
  const result = await channel.call('window.list', {});
  return arrayField(result, 'windows')
    .map((item, position): WindowInfo | null => {
      if (!isObject(item)) return null;
      const id = stringField(item, 'id') ?? stringField(item, 'window_id');
      if (!id) return null;
      return {
        id,
        ref: stringField(item, 'ref') ?? id,
        index: numberField(item, 'index') ?? position,
        workspaceCount: numberField(item, 'workspace_count') ?? numberField(item, 'workspaceCount') ?? null,
        // cmux calls it `key`, as in key window, not `is_key`.
        key: item.key === true,
      };
    })
    .filter((w): w is WindowInfo => w !== null)
    .sort((a, b) => a.index - b.index);
}

/**
 * `workspace.list` covers one cmux window: `windowId`'s, or the key window's
 * without it. Field names follow `docs/specs/cmux-payload-samples/`.
 */
export async function listWorkspaces(channel: RpcChannel, windowId?: string | null): Promise<WorkspaceInfo[]> {
  return (await listWorkspacesIn(channel, windowId)).workspaces;
}

/** Like `listWorkspaces`, plus the window cmux reports having listed. */
export async function listWorkspacesIn(channel: RpcChannel, windowId?: string | null): Promise<WorkspaceListing> {
  const result = await channel.call('workspace.list', windowId ? { window_id: windowId } : {});
  return {
    windowId: isObject(result) ? (stringField(result, 'window_id') ?? null) : null,
    workspaces: parseWorkspaces(result),
  };
}

/** cmux windows have no names; `window:2` becomes 窗口 2. */
export function windowLabel(window: WindowInfo): string {
  const match = /^window:(.+)$/.exec(window.ref);
  if (match) return `窗口 ${match[1]}`;
  return window.ref === window.id ? `窗口 ${window.index + 1}` : window.ref;
}

function parseWorkspaces(result: unknown): WorkspaceInfo[] {
  const raw = arrayField(result, 'workspaces');
  return raw
    .map((item, position): WorkspaceInfo | null => {
      if (!isObject(item)) return null;
      const id = stringField(item, 'id') ?? stringField(item, 'workspace_id');
      if (!id) return null;
      return {
        id,
        title: stringField(item, 'title') ?? stringField(item, 'name') ?? id,
        index: numberField(item, 'index') ?? position,
        selected: item.selected === true,
      };
    })
    .filter((w): w is WorkspaceInfo => w !== null)
    .sort((a, b) => a.index - b.index);
}

export async function listSurfaces(channel: RpcChannel, workspaceId: string): Promise<SurfaceInfo[]> {
  const result = await channel.call('surface.list', { workspace_id: workspaceId });
  const raw = arrayField(result, 'surfaces');
  return raw
    .map((item, position): SurfaceInfo | null => {
      if (!isObject(item)) return null;
      const id = stringField(item, 'id') ?? stringField(item, 'surface_id');
      if (!id) return null;
      return {
        id,
        title: stringField(item, 'title') ?? id,
        index: numberField(item, 'index') ?? position,
        focused: item.focused === true,
        type: stringField(item, 'type') ?? 'terminal',
      };
    })
    .filter((s): s is SurfaceInfo => s !== null && s.type === 'terminal')
    .sort((a, b) => a.index - b.index);
}

/** The workspace cmux has selected and its focused terminal, falling back to the first of each. */
export async function pickDefaultTarget(channel: RpcChannel): Promise<SurfaceTarget | null> {
  const workspaces = await listWorkspaces(channel);
  const ordered = [...workspaces.filter((w) => w.selected), ...workspaces.filter((w) => !w.selected)];
  for (const workspace of ordered) {
    const surfaces = await listSurfaces(channel, workspace.id);
    const surface = surfaces.find((s) => s.focused) ?? surfaces[0];
    if (surface) return { workspaceId: workspace.id, surfaceId: surface.id };
  }
  return null;
}

function arrayField(value: unknown, key: string): unknown[] {
  if (!isObject(value)) return [];
  const field = value[key];
  return Array.isArray(field) ? field : [];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(value: Record<string, unknown>, key: string): string | undefined {
  const field = value[key];
  return typeof field === 'string' && field.length > 0 ? field : undefined;
}

function numberField(value: Record<string, unknown>, key: string): number | undefined {
  const field = value[key];
  return typeof field === 'number' && Number.isFinite(field) ? field : undefined;
}
