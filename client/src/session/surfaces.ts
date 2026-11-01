import type { RpcChannel, SurfaceTarget } from './terminalSession';

export type WorkspaceInfo = { id: string; title: string; index: number; selected: boolean };
export type SurfaceInfo = { id: string; title: string; index: number; focused: boolean; type: string };

/**
 * `workspace.list` without params covers cmux's key window only; that is
 * enough for the prototype. Field names follow
 * `docs/specs/cmux-payload-samples/`.
 */
export async function listWorkspaces(channel: RpcChannel): Promise<WorkspaceInfo[]> {
  const result = await channel.call('workspace.list', {});
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
