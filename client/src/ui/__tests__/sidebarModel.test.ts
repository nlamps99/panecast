import { menuPosition } from '../ContextMenu';
import { sidebarEmptyText, sidebarWorkspaces } from '../sidebarModel';

const workspace = (id: string, index: number, title = id) => ({ id, title, index, selected: false });

describe('sidebar order', () => {
  const workspaces = [workspace('c', 2), workspace('a', 0), workspace('b', 1, 'api server')];
  const surfaces = { a: [{ id: 's1', title: 'vim', index: 0, focused: false, type: 'terminal' }] };

  it('keeps the computer’s order, pinned workspaces first', () => {
    expect(sidebarWorkspaces(workspaces, surfaces, []).map((w) => w.id)).toEqual(['a', 'b', 'c']);
    expect(sidebarWorkspaces(workspaces, surfaces, ['c']).map((w) => w.id)).toEqual(['c', 'a', 'b']);
    // Among pinned ones the computer's order still decides, not the order they were pinned in.
    expect(sidebarWorkspaces(workspaces, surfaces, ['c', 'b']).map((w) => w.id)).toEqual(['b', 'c', 'a']);
  });

  it('filters by workspace or terminal title without reordering', () => {
    expect(sidebarWorkspaces(workspaces, surfaces, ['c'], ' VIM ').map((w) => w.id)).toEqual(['a']);
    expect(sidebarWorkspaces(workspaces, surfaces, [], 'server').map((w) => w.id)).toEqual(['b']);
  });

  it('falls back to the listed order when indexes tie', () => {
    expect(sidebarWorkspaces([workspace('y', 0), workspace('x', 0)], {}, []).map((w) => w.id)).toEqual(['y', 'x']);
  });
});

describe('sidebar empty text', () => {
  it('says loading or not connected rather than "no match" when nothing is listed yet', () => {
    expect(sidebarEmptyText({ status: { state: 'open' }, loaded: false, total: 0, shown: 0 })).toBe('正在加载…');
    expect(sidebarEmptyText({ status: { state: 'connecting', attempt: 0 }, loaded: false, total: 0, shown: 0 })).toBe('正在加载…');
    expect(sidebarEmptyText({ status: { state: 'connecting', attempt: 2 }, loaded: false, total: 0, shown: 0 })).toBe('未连接');
    expect(sidebarEmptyText({ status: { state: 'waiting', attempt: 1, retryAt: 0, reason: 'relay_offline' }, loaded: true, total: 0, shown: 0 })).toBe('未连接');
    expect(sidebarEmptyText({ status: { state: 'idle' }, loaded: false, total: 0, shown: 0 })).toBe('未连接');
    expect(sidebarEmptyText({ status: { state: 'open' }, loaded: true, total: 0, shown: 0 })).toBe('没有工作区');
  });

  it('says "no match" only for a filter that hides every workspace', () => {
    expect(sidebarEmptyText({ status: { state: 'open' }, loaded: true, total: 3, shown: 0 })).toBe('没有匹配的工作区');
    expect(sidebarEmptyText({ status: { state: 'idle' }, loaded: true, total: 3, shown: 0 })).toBe('没有匹配的工作区');
    expect(sidebarEmptyText({ status: { state: 'open' }, loaded: true, total: 3, shown: 1 })).toBeNull();
  });
});

describe('context menu placement', () => {
  const items = [{ label: '重命名…', onPress() {} }, 'separator' as const, { label: '关闭工作区…', onPress() {} }];
  it('opens at the pointer and stays inside the window', () => {
    expect(menuPosition({ x: 100, y: 120 }, items, { width: 1200, height: 800 })).toEqual({ left: 100, top: 120 });
    // 200 wide; 4 + 28 + 9 + 28 + 4 = 73 tall; 8 from the edges.
    expect(menuPosition({ x: 1150, y: 790 }, items, { width: 1200, height: 800 })).toEqual({ left: 992, top: 719 });
    expect(menuPosition({ x: -5, y: -5 }, items, { width: 1200, height: 800 })).toEqual({ left: 8, top: 8 });
  });
});
