import type { ConnectionStatus } from '../../protocol/connection';
import type { PushFrame } from '../../protocol/frames';
import { InboxStore } from '../inboxStore';
import type { RpcChannel } from '../terminalSession';
import { WorkspaceStore } from '../workspaceStore';

class FakeChannel implements RpcChannel {
  isOpen = true;
  calls: { method: string; params: Record<string, unknown> }[] = [];
  private push = new Set<(frame: PushFrame) => void>();
  private status = new Set<(status: ConnectionStatus) => void>();

  async call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    this.calls.push({ method, params });
    if (method === 'workspace.list') {
      return {
        workspaces: [
          { id: 'w2', title: 'second', index: 1 },
          { id: 'w1', title: 'first', index: 0, selected: true },
        ],
      } as T;
    }
    if (method === 'surface.list') {
      return {
        surfaces: [
          { id: `${params.workspace_id}-s1`, title: 'zsh', index: 0, focused: true, type: 'terminal' },
          { id: `${params.workspace_id}-b`, title: 'docs', index: 1, type: 'browser' },
        ],
      } as T;
    }
    throw new Error(`unexpected ${method}`);
  }
  onPush(listener: (frame: PushFrame) => void) {
    this.push.add(listener);
    return () => this.push.delete(listener);
  }
  onStatus(listener: (status: ConnectionStatus) => void) {
    this.status.add(listener);
    return () => this.status.delete(listener);
  }
  emit(frame: PushFrame) {
    for (const listener of this.push) listener(frame);
  }
  open() {
    for (const listener of this.status) listener({ state: 'open' });
  }
}

const event = (category: string, name: string, payload: unknown): PushFrame => ({ type: 'event', category, name, payload });

describe('WorkspaceStore', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('loads workspaces in order with their terminals when the connection opens', async () => {
    const channel = new FakeChannel();
    const store = new WorkspaceStore(channel);
    channel.open();
    await jest.advanceTimersByTimeAsync(0);
    const state = store.getState();
    expect(state.workspaces.map((w) => w.id)).toEqual(['w1', 'w2']);
    expect(state.surfaces.w1.map((s) => s.id)).toEqual(['w1-s1']);
    expect(state.loaded).toBe(true);
  });

  it('refreshes once after a burst of workspace events, and ignores agent chatter', async () => {
    const channel = new FakeChannel();
    new WorkspaceStore(channel);
    for (let i = 0; i < 5; i++) channel.emit(event('surface', 'surface.title_changed', {}));
    channel.emit(event('agent', 'tool.used', {}));
    await jest.advanceTimersByTimeAsync(2_000);
    expect(channel.calls.filter((c) => c.method === 'workspace.list')).toHaveLength(1);
    channel.emit(event('agent', 'tool.used', {}));
    await jest.advanceTimersByTimeAsync(2_000);
    expect(channel.calls.filter((c) => c.method === 'workspace.list')).toHaveLength(1);
  });

  it('runs one refresh at a time and one more for requests made meanwhile', async () => {
    const channel = new FakeChannel();
    const store = new WorkspaceStore(channel);
    void store.refresh();
    void store.refresh();
    void store.refresh();
    await jest.advanceTimersByTimeAsync(0);
    expect(channel.calls.filter((c) => c.method === 'workspace.list')).toHaveLength(2);
  });
});

describe('InboxStore', () => {
  it('collects cmux notifications, newest first, and counts unread per workspace', () => {
    const channel = new FakeChannel();
    const inbox = new InboxStore(channel);
    channel.emit(event('notification', 'notification.created', { id: 'n1', workspace_id: 'w1', title: 'Done', body: 'tests pass', ts: 1_700_000_000 }));
    channel.emit(event('notification', 'notification.created', { id: 'n2', workspace_id: 'w1', surface_id: 's', title: 'Input needed' }));
    channel.emit(event('notification', 'notification.created', { id: 'n1', workspace_id: 'w1', title: 'Done' }));
    channel.emit(event('workspace', 'workspace.renamed', { id: 'w1' }));

    let state = inbox.getState();
    expect(state.items.map((i) => i.id)).toEqual(['n2', 'n1']);
    expect(state.items[1].at).toBe(1_700_000_000_000);
    expect(state.unread).toBe(2);
    expect(state.unreadByWorkspace).toEqual({ w1: 2 });

    inbox.markRead('n2');
    expect(inbox.getState().unread).toBe(1);
    inbox.markWorkspaceRead('w1');
    state = inbox.getState();
    expect(state.unread).toBe(0);
    expect(state.unreadByWorkspace).toEqual({});
  });
});
