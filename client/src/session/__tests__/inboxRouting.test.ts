import { inboxTarget, isShowingItem, shouldAnnounce } from '../inboxRouting';
import type { SurfaceInfo } from '../surfaces';

const surface = (id: string, focused = false): SurfaceInfo => ({ id, title: id, index: 0, focused, type: 'terminal' });

describe('inboxTarget', () => {
  const surfaces = { w1: [surface('s1'), surface('s2', true)], w2: [surface('t1'), surface('t2')], empty: [] };

  it('opens the item’s own surface', () => {
    expect(inboxTarget({ workspaceId: 'w1', surfaceId: 's1' }, surfaces)).toEqual({ workspaceId: 'w1', surfaceId: 's1' });
    // Even one the list does not know yet: it may be in another cmux window.
    expect(inboxTarget({ workspaceId: 'w9', surfaceId: 'x' }, surfaces)).toEqual({ workspaceId: 'w9', surfaceId: 'x' });
  });

  it('falls back to the workspace’s focused, then first terminal', () => {
    expect(inboxTarget({ workspaceId: 'w1', surfaceId: null }, surfaces)?.surfaceId).toBe('s2');
    expect(inboxTarget({ workspaceId: 'w2', surfaceId: null }, surfaces)?.surfaceId).toBe('t1');
  });

  it('has nowhere to go without a workspace or a terminal', () => {
    expect(inboxTarget({ workspaceId: null, surfaceId: 's1' }, surfaces)).toBeNull();
    expect(inboxTarget({ workspaceId: 'empty', surfaceId: null }, surfaces)).toBeNull();
    expect(inboxTarget({ workspaceId: 'unknown-ws', surfaceId: null }, surfaces)).toBeNull();
  });
});

describe('isShowingItem / shouldAnnounce', () => {
  const target = { workspaceId: 'w1', surfaceId: 's1' };

  it('treats the item’s terminal, open on the terminal tab, as already seen', () => {
    const item = { workspaceId: 'w1', surfaceId: 's1' };
    expect(isShowingItem(item, '/terminal', target)).toBe(true);
    expect(shouldAnnounce(item, '/terminal', target)).toBe(false);
  });

  it('counts any terminal of the workspace when the item names no surface', () => {
    expect(shouldAnnounce({ workspaceId: 'w1', surfaceId: null }, '/terminal', target)).toBe(false);
    expect(shouldAnnounce({ workspaceId: 'w2', surfaceId: null }, '/terminal', target)).toBe(true);
  });

  it('announces items for another terminal, or while on another tab', () => {
    expect(shouldAnnounce({ workspaceId: 'w1', surfaceId: 's2' }, '/terminal', target)).toBe(true);
    expect(shouldAnnounce({ workspaceId: 'w1', surfaceId: 's1' }, '/', target)).toBe(true);
    expect(shouldAnnounce({ workspaceId: 'w1', surfaceId: 's1' }, '/settings', target)).toBe(true);
    expect(shouldAnnounce({ workspaceId: 'w1', surfaceId: 's1' }, '/terminal', null)).toBe(true);
    expect(shouldAnnounce({ workspaceId: null, surfaceId: null }, '/terminal', target)).toBe(true);
  });

  it('stays quiet on the inbox, where the item shows up on top', () => {
    expect(shouldAnnounce({ workspaceId: 'w2', surfaceId: 's9' }, '/inbox', target)).toBe(false);
  });
});
