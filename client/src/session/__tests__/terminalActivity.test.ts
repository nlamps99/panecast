import { RpcCallError, type ConnectionStatus } from '../../protocol/connection';
import { activityKey, compareActivity, TerminalActivityStore, type ActivityTarget } from '../terminalActivity';
import type { RpcChannel } from '../terminalSession';

const a: ActivityTarget = { workspaceId: 'project', surfaceId: 'a', title: 'Claude', workspaceTitle: '项目', windowId: 'window' };
const b: ActivityTarget = { ...a, surfaceId: 'b' };
const user = (id: string) => ({ id, type: 'userMessage' });
const final = (id: string) => ({ id, type: 'agentMessage', phase: 'final', text: '测试通过' });
const snapshot = (active: boolean, items: unknown[] = [], extra = {}) => ({ available: true, conversation_id: 'chat', generation: 'epoch', revision: String(items.length), active, items, ...extra });
class Channel implements RpcChannel {
  isOpen = true;
  responses = new Map<string, unknown>();
  statuses = new Set<(status: ConnectionStatus) => void>();
  rpc = jest.fn(async (_method: string, params: Record<string, unknown>) => {
    const response = this.responses.get(String(params.surface_id));
    if (response instanceof Error) throw response;
    return response;
  });
  async call<T>(method: string, params: Record<string, unknown> = {}) { return await this.rpc(method, params) as T; }
  onPush() { return () => {}; }
  onStatus(listener: (status: ConnectionStatus) => void) { this.statuses.add(listener); return () => { this.statuses.delete(listener); }; }
  status(status: ConnectionStatus) { this.isOpen = status.state === 'open'; for (const listener of this.statuses) listener(status); }
}
let channel: Channel, store: TerminalActivityStore, targets: ActivityTarget[];
const onActivity = jest.fn(), onComplete = jest.fn();
beforeEach(() => {
  jest.useFakeTimers(); jest.clearAllMocks(); channel = new Channel(); targets = [a, b];
  store = new TerminalActivityStore(channel, { targets: () => targets, onActivity, onComplete });
});
afterEach(() => { store.dispose(); jest.useRealTimers(); });

it('tracks multiple terminals, promotes active conversations and emits each final reply once', async () => {
  channel.responses.set('a', snapshot(false, [final('old')]));
  channel.responses.set('b', snapshot(true, [user('question')]));
  await store.refresh(); expect(onComplete).not.toHaveBeenCalled();
  const order = [a, b].sort((a, b) => compareActivity(store.getState()[activityKey(a)], store.getState()[activityKey(b)]));
  expect(order[0]).toEqual(b); expect(store.getState()[activityKey(b)].status).toBe('running');
  channel.responses.set('b', snapshot(false, [user('question'), final('answer')]));
  await store.refresh(); await store.refresh();
  expect(store.getState()[activityKey(b)].status).toBe('completed');
  expect(onComplete).toHaveBeenCalledTimes(1); expect(onComplete).toHaveBeenCalledWith(b, 'terminal-complete:chat:answer', '测试通过');
  channel.responses.set('b', snapshot(true, [final('answer'), user('next')])); await store.refresh();
  expect(store.getState()[activityKey(b)].status).toBe('running');
});

it('detects a whole short turn between polls without announcing old history on startup', async () => {
  channel.responses.set('a', snapshot(false, [final('old')])); await store.refresh();
  expect(onComplete).not.toHaveBeenCalled();
  channel.responses.set('a', snapshot(false, [user('new'), final('new-final')])); await store.refresh();
  expect(onComplete).toHaveBeenCalledTimes(1);
});

it.each([
  { available: false },
  snapshot(false, [user('question')]), // aborted, without a final reply
  snapshot(false, [final('other')], { conversation_id: 'another-chat' }),
  snapshot(false, [final('other')], { generation: 'replaced-file' }),
  snapshot(false, [final('other')], { reset: true }),
  new RpcCallError('source_revoked', 'revoked'),
])('never reports a cancellation, inaccessible source or replaced conversation as completed: %s', async response => {
  channel.responses.set('a', snapshot(true, [user('question')])); await store.refresh();
  channel.responses.set('a', response); await store.refresh();
  expect(onComplete).not.toHaveBeenCalled(); expect(store.getState()[activityKey(a)].status).not.toBe('running');
});

it('drops in-flight results after disconnect and treats reconnect as a fresh baseline', async () => {
  channel.responses.set('a', snapshot(true)); await store.refresh();
  let finish!: (value: unknown) => void;
  channel.rpc.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const pending = store.refresh();
  channel.status({ state: 'idle' });
  finish(snapshot(false, [final('late')])); await pending;
  expect(store.getState()[activityKey(a)].status).toBe('unknown'); expect(onComplete).not.toHaveBeenCalled();
  channel.responses.set('a', snapshot(false, [final('late')]));
  channel.status({ state: 'open' } as ConnectionStatus); await store.refresh();
  expect(onComplete).not.toHaveBeenCalled();
});

it('stops polling unsupported gateways and removes terminals no longer observed', async () => {
  channel.responses.set('a', snapshot(true)); await store.refresh();
  targets = [b]; await store.refresh(); expect(store.getState()[activityKey(a)]).toBeUndefined();
  targets = [a]; channel.responses.set('a', new RpcCallError('method_not_found', 'old gateway'));
  await store.refresh(); const count = channel.rpc.mock.calls.length;
  await jest.advanceTimersByTimeAsync(60_000); await store.refresh(); expect(channel.rpc).toHaveBeenCalledTimes(count);
});
