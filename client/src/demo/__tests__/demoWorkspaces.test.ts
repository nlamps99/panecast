import { InboxStore } from '../../session/inboxStore';
import { WorkspaceStore } from '../../session/workspaceStore';
import { DemoChannel } from '../demoChannel';
import { PANE_COLS, visibleWidth } from '../demoText';
import { Mirror, plain, rpc, rpcError } from '../testing/demoHarness';

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

type Workspace = { id: string; title: string; index: number; selected: boolean; ref: string };
type Surface = { id: string; title: string; index: number; focused: boolean; type: string };

const titles = (result: { workspaces: Workspace[] }) => result.workspaces.map((w) => w.title);

describe('DemoChannel windows and workspaces', () => {
  it('lists two windows and scopes workspace.list by window_id like cmux', async () => {
    const channel = new DemoChannel();
    const windows = await rpc<{ windows: unknown[] }>(channel, 'window.list');
    expect(windows.windows).toEqual([
      { id: 'demo-win-1', ref: 'window:1', index: 0, key: true, workspace_count: 3 },
      { id: 'demo-win-2', ref: 'window:2', index: 1, key: false, workspace_count: 2 },
    ]);

    // Without window_id: the key window only.
    const key = await rpc<{ window_id: string; workspaces: Workspace[] }>(channel, 'workspace.list');
    expect(key.window_id).toBe('demo-win-1');
    expect(key.workspaces.map(({ id, title, index, selected }) => ({ id, title, index, selected }))).toEqual([
      { id: 'demo-ws-1', title: 'panecast', index: 0, selected: true },
      { id: 'demo-ws-2', title: 'notes', index: 1, selected: false },
      { id: 'demo-ws-3', title: '天气服务', index: 2, selected: false },
    ]);
    expect(key.workspaces[0]).toMatchObject({ ref: 'workspace:1', current_directory: '/Users/demo/code/panecast' });

    const second = await rpc<{ window_id: string; workspaces: Workspace[] }>(channel, 'workspace.list', { window_id: 'demo-win-2' });
    expect(second.window_id).toBe('demo-win-2');
    expect(second.workspaces.map(({ title, selected }) => [title, selected])).toEqual([
      ['博客', true],
      ['照片整理', false],
    ]);
    expect((await rpcError(channel, 'workspace.list', { window_id: 'nope' })).code).toBe('not_found');

    const surfaces = await rpc<{ surfaces: Surface[]; workspace_id: string }>(channel, 'surface.list', { workspace_id: 'demo-ws-3' });
    expect(surfaces.workspace_id).toBe('demo-ws-3');
    expect(surfaces.surfaces.map(({ id, title, index, focused, type }) => ({ id, title, index, focused, type }))).toEqual([
      { id: 'demo-sf-4', title: '服务日志', index: 0, focused: false, type: 'terminal' },
      { id: 'demo-sf-5', title: '发布助手', index: 1, focused: true, type: 'terminal' },
    ]);
  });

  it('creates, renames, selects and closes workspaces, with a workspace event for each', async () => {
    const channel = new DemoChannel();
    const mirror = new Mirror(channel);

    const created = await rpc<{ workspace_id: string; window_id: string; workspace: Workspace }>(channel, 'workspace.create', {
      title: '新项目',
      window_id: 'demo-win-2',
    });
    expect(created).toMatchObject({ window_id: 'demo-win-2', workspace: { title: '新项目', index: 2, selected: true } });
    expect(created.workspace.id).toBe(created.workspace_id);
    expect(titles(await rpc(channel, 'workspace.list', { window_id: 'demo-win-2' }))).toEqual(['博客', '照片整理', '新项目']);
    // The key window is untouched.
    expect(titles(await rpc(channel, 'workspace.list'))).toEqual(['panecast', 'notes', '天气服务']);

    // The new workspace opens with one shell.
    const shells = await rpc<{ surfaces: Surface[] }>(channel, 'surface.list', { workspace_id: created.workspace_id });
    expect(shells.surfaces).toHaveLength(1);
    expect(shells.surfaces[0]).toMatchObject({ title: 'zsh', focused: true, type: 'terminal' });

    // Without window_id it goes to the key window; without a title it gets a name.
    const untitled = await rpc<{ workspace: Workspace }>(channel, 'workspace.create', {});
    expect(untitled.workspace).toMatchObject({ title: '工作区 7', index: 3 });

    await rpc(channel, 'workspace.rename', { workspace_id: created.workspace_id, title: '  新项目 v2 ' });
    expect(titles(await rpc(channel, 'workspace.list', { window_id: 'demo-win-2' }))[2]).toBe('新项目 v2');
    expect((await rpcError(channel, 'workspace.rename', { workspace_id: created.workspace_id, title: '  ' })).code).toBe('invalid_params');
    expect((await rpcError(channel, 'workspace.rename', { workspace_id: 'nope', title: 'x' })).code).toBe('not_found');

    await rpc(channel, 'workspace.select', { workspace_id: 'demo-ws-5' });
    const afterSelect = await rpc<{ workspaces: Workspace[] }>(channel, 'workspace.list', { window_id: 'demo-win-2' });
    expect(afterSelect.workspaces.filter((w) => w.selected).map((w) => w.id)).toEqual(['demo-ws-5']);

    // Closing the selected workspace selects its neighbour and closes its terminals.
    await rpc(channel, 'workspace.close', { workspace_id: 'demo-ws-5' });
    const afterClose = await rpc<{ workspaces: Workspace[] }>(channel, 'workspace.list', { window_id: 'demo-win-2' });
    expect(afterClose.workspaces.map((w) => [w.title, w.selected])).toEqual([
      ['博客', false],
      ['新项目 v2', true],
    ]);
    expect((await rpcError(channel, 'surface.send_text', { surface_id: 'demo-sf-7', text: 'ls' })).code).toBe('not_found');
    expect((await rpc<{ windows: { workspace_count: number }[] }>(channel, 'window.list')).windows.map((w) => w.workspace_count)).toEqual([4, 2]);

    expect(mirror.eventNames('workspace')).toEqual([
      'workspace.created',
      'workspace.created',
      'workspace.renamed',
      'workspace.selected',
      'workspace.closed',
    ]);
    expect(mirror.events.find((e) => e.name === 'workspace.renamed')?.payload).toEqual({
      workspace_id: created.workspace_id,
      window_id: 'demo-win-2',
      title: '新项目 v2',
    });
    mirror.dispose();
  });

  it('lets the workspace list follow changes through events, as with a real Mac', async () => {
    const channel = new DemoChannel();
    const store = new WorkspaceStore(channel);
    const inbox = new InboxStore(channel);
    const refreshed = store.refresh();
    await jest.advanceTimersByTimeAsync(200);
    await refreshed;
    expect(store.getState().workspaces.map((w) => w.title)).toEqual(['panecast', 'notes', '天气服务']);
    expect(store.getState().surfaces['demo-ws-1'].map((s) => s.title)).toEqual(['zsh — panecast', '自动测试']);

    await rpc(channel, 'workspace.create', { title: '周报' });
    expect(store.getState().workspaces).toHaveLength(3);
    await jest.advanceTimersByTimeAsync(2_000);
    expect(store.getState().workspaces.map((w) => w.title)).toEqual(['panecast', 'notes', '天气服务', '周报']);
    // Workspace events are not notifications.
    expect(inbox.getState().items.every((item) => item.id.startsWith('demo-'))).toBe(true);
    store.dispose();
    inbox.dispose();
  });
});

describe('DemoChannel terminals', () => {
  it('creates, focuses and closes terminals with surface events, in the legacy result shapes', async () => {
    const channel = new DemoChannel();
    const mirror = new Mirror(channel);

    const created = await rpc<{ surface_id: string; workspace_id: string; type: string }>(channel, 'surface.create', {
      workspace_id: 'demo-ws-2',
      type: 'terminal',
      focus: true,
    });
    // `SurfaceMutationPayload` in the legacy clients reads `surface_id`.
    expect(created).toMatchObject({ workspace_id: 'demo-ws-2', type: 'terminal' });
    expect(created.surface_id).toMatch(/^demo-sf-\d+$/);
    const list = await rpc<{ surfaces: Surface[] }>(channel, 'surface.list', { workspace_id: 'demo-ws-2' });
    expect(list.surfaces.map((s) => [s.id, s.index, s.focused])).toEqual([
      ['demo-sf-3', 0, false],
      [created.surface_id, 1, true],
    ]);
    // Focusing a terminal in another workspace selects that workspace in its window.
    const keyList = await rpc<{ workspaces: Workspace[] }>(channel, 'workspace.list');
    expect(keyList.workspaces.find((w) => w.selected)?.id).toBe('demo-ws-2');

    // The new shell works, in the workspace's directory.
    await rpc(channel, 'surface.subscribe', { workspace_id: 'demo-ws-2', surface_id: created.surface_id, lines: 20 }, 100);
    await rpc(channel, 'surface.send_text', { workspace_id: 'demo-ws-2', surface_id: created.surface_id, text: 'ls\r' }, 100);
    const rows = mirror.rows(created.surface_id);
    expect(rows).toContain('~/notes $ ls');
    expect(rows).toContain('会议记录-周一.md  读书笔记.md  待办.md  sync.sh');

    // surface.focus runs before every key: only a real change raises an event.
    await rpc(channel, 'surface.focus', { workspace_id: 'demo-ws-2', surface_id: 'demo-sf-3' });
    await rpc(channel, 'surface.focus', { workspace_id: 'demo-ws-2', surface_id: 'demo-sf-3' });
    await rpc(channel, 'surface.focus', { workspace_id: 'demo-ws-2', surface_id: 'demo-sf-3' });
    expect(mirror.eventNames('surface')).toEqual(['surface.created', 'surface.focused']);

    // Closing the focused terminal focuses its neighbour; closing the last one closes the workspace.
    await rpc(channel, 'surface.close', { workspace_id: 'demo-ws-2', surface_id: 'demo-sf-3' });
    const remaining = await rpc<{ surfaces: Surface[] }>(channel, 'surface.list', { workspace_id: 'demo-ws-2' });
    expect(remaining.surfaces.map((s) => [s.id, s.focused])).toEqual([[created.surface_id, true]]);
    await rpc(channel, 'surface.close', { workspace_id: 'demo-ws-2', surface_id: created.surface_id });
    expect(titles(await rpc(channel, 'workspace.list'))).toEqual(['panecast', '天气服务']);
    expect(mirror.eventNames('surface')).toEqual(['surface.created', 'surface.focused', 'surface.closed', 'surface.closed']);
    expect(mirror.eventNames('workspace')).toEqual(['workspace.selected', 'workspace.closed']);

    // A closed terminal is gone for every method.
    expect((await rpcError(channel, 'surface.subscribe', { workspace_id: 'demo-ws-2', surface_id: created.surface_id })).code).toBe(
      'not_found',
    );
    expect((await rpcError(channel, 'surface.history', { workspace_id: 'demo-ws-2', surface_id: created.surface_id })).code).toBe(
      'history_unavailable',
    );
    expect((await rpcError(channel, 'surface.create', { workspace_id: 'demo-ws-1', type: 'browser' })).code).toBe('invalid_params');
    mirror.dispose();
  });

  it('raises a notification for notification.create, like cmux', async () => {
    const channel = new DemoChannel();
    const inbox = new InboxStore(channel);
    await rpc(channel, 'notification.create', { workspace_id: 'demo-ws-3', title: '测试通知', body: '从手机发出的测试通知' }, 100);
    expect(inbox.getState().items).toEqual([
      expect.objectContaining({ id: 'demo-n-3', workspaceId: 'demo-ws-3', title: '测试通知', subtitle: '天气服务', body: '从手机发出的测试通知' }),
    ]);
    expect((await rpcError(channel, 'notification.create', { workspace_id: 'demo-ws-3' })).code).toBe('invalid_params');
    inbox.dispose();
  });

  it('keeps every row padded to the pane width in a new terminal too', async () => {
    const channel = new DemoChannel();
    const created = await rpc<{ surface_id: string }>(channel, 'surface.create', { workspace_id: 'demo-ws-1' });
    const text = await rpc<{ text: string }>(channel, 'surface.read_text', { surface_id: created.surface_id, lines: 4 });
    const rows = text.text.split('\n');
    expect(plain(rows)).toEqual(['新终端。输入 help 看看演示模式能做什么。', '~/code/panecast main $', '', '']);
    for (const row of rows) expect(visibleWidth(row)).toBe(PANE_COLS);
  });
});
