import { RpcCallError, type ConnectionStatus } from '../../protocol/connection';
import type { PushFrame } from '../../protocol/frames';
import { SourceStore, type SourceInfo } from '../sourceStore';
import type { RpcChannel } from '../terminalSession';

const source: SourceInfo = { id: 'codex', name: 'Codex', type: 'codex', access: 'control', enabled: true, status: 'online', mode: 'attach', capabilities: { read: true, control: true, realtime: true, create: true } };

class Channel implements RpcChannel {
  isOpen = true;
  pushes = new Set<(frame: PushFrame) => void>();
  statuses = new Set<(status: ConnectionStatus) => void>();
  requests: { method: string; params: Record<string, unknown> }[] = [];
  handler: (method: string, params: Record<string, unknown>) => unknown = (method, params) => {
    if (method === 'source.list') return { sources: [source, { ...source, id: 'other' }] };
    if (method === 'agent.threads') return { threads: [{ id: 'thread', name: 'Task', cwd: '/project' }], next_cursor: null };
    if (method === 'agent.pending') return { requests: [] };
    if (method === 'agent.read') return { thread: { id: params.thread_id, name: 'Task', cwd: '/project' }, turns: [{ id: 'turn', status: 'inProgress', items: [] }], next_cursor: 'older' };
    return {};
  };
  async call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> { this.requests.push({ method, params }); return await this.handler(method, params) as T; }
  onPush(listener: (frame: PushFrame) => void) { this.pushes.add(listener); return () => this.pushes.delete(listener); }
  onStatus(listener: (status: ConnectionStatus) => void) { this.statuses.add(listener); return () => this.statuses.delete(listener); }
  push(sourceId: string, delta: string) { for (const listener of this.pushes) listener({ type: 'event', category: 'agent', name: 'item/agentMessage/delta', payload: { source_id: sourceId, threadId: 'thread', turnId: 'turn', itemId: 'message', delta } }); }
}

test('legacy relays remain usable without a source API', async () => {
  const channel = new Channel(); channel.handler = () => { throw new RpcCallError('method_not_found', 'old relay'); };
  const store = new SourceStore(channel);
  await store.refresh(); expect(store.getState().supported).toBe(false); expect(store.getState().error).toBeNull(); store.dispose();
});

test('streamed replies stay scoped to their source and conversation', async () => {
  const channel = new Channel(), store = new SourceStore(channel);
  await store.refresh(); await store.selectSource('codex'); await store.openThread('thread');
  channel.push('other', 'must not appear'); channel.push('codex', '你好'); channel.push('codex', '，世界');
  expect(store.getState().turns[0].items[0].text).toBe('你好，世界');
  expect(store.getState().historyCursor).toBe('older'); store.dispose();
});

test('late history responses cannot replace a newly selected source', async () => {
  const channel = new Channel(), store = new SourceStore(channel);
  await store.refresh(); await store.selectSource('codex');
  let finish: (value: unknown) => void = () => {};
  const initial = channel.handler;
  channel.handler = (method, params) => method === 'agent.read' ? new Promise((resolve) => { finish = resolve; }) : initial(method, params);
  const opening = store.openThread('thread');
  await Promise.resolve(); await Promise.resolve();
  await store.selectSource('other');
  finish({ thread: { id: 'thread', name: 'old', cwd: '/' }, turns: [], next_cursor: null }); await opening;
  expect(store.getState().sourceId).toBe('other'); expect(store.getState().thread).toBeNull(); store.dispose();
});

test('source revocation clears loaded conversation data and pending actions', async () => {
  const channel = new Channel(), store = new SourceStore(channel);
  await store.refresh(); await store.selectSource('codex'); await store.openThread('thread');
  channel.handler = () => ({ sources: [{ ...source, enabled: false, status: 'revoked' }] });
  await store.refresh(); expect(store.getState().thread).toBeNull(); expect(store.getState().turns).toEqual([]); expect(store.getState().error).toContain('撤销'); store.dispose();
});

test('an uncertain send fails visibly and is never retried automatically', async () => {
  const channel = new Channel(), store = new SourceStore(channel);
  await store.refresh(); await store.selectSource('codex'); await store.openThread('thread');
  channel.handler = () => { throw new RpcCallError('timeout', '结果未知，请刷新'); };
  expect(await store.action('agent.send', { text: 'run tests' })).toBe(false);
  expect(channel.requests.filter((r) => r.method === 'agent.send')).toHaveLength(1);
  expect(store.getState().error).toContain('结果未知'); expect(store.getState().busy).toBe(false); store.dispose();
});

test('a completed turn stops looking active before the history refresh arrives', async () => {
  const channel = new Channel(), store = new SourceStore(channel);
  await store.refresh(); await store.selectSource('codex'); await store.openThread('thread');
  channel.push('codex', 'done');
  for (const listener of channel.pushes) listener({ type: 'event', category: 'agent', name: 'turn/completed', payload: { source_id: 'codex', threadId: 'thread', turn: { id: 'turn', status: 'completed', items: [] } } });
  expect(store.getState().turns[0].status).toBe('completed');
  expect(store.getState().turns[0].items[0].text).toBe('done'); store.dispose();
});

test('continuing a saved conversation enables input only after the server confirms the resume', async () => {
  const channel = new Channel(), store = new SourceStore(channel);
  let live = false;
  const handler = channel.handler;
  channel.handler = (method, params) => {
    if (method === 'agent.resume') { live = true; return { thread: { id: 'thread', name: 'Saved', cwd: '/project', live } }; }
    if (method === 'agent.read') return { thread: { id: 'thread', name: 'Saved', cwd: '/project', live }, turns: [{ id: 'turn', status: 'completed', items: null }], next_cursor: null };
    return handler(method, params);
  };
  await store.refresh(); await store.selectSource('codex'); await store.openThread('thread');
  expect(store.getState().thread?.live).toBe(false);
  expect(await store.action('agent.resume')).toBe(true);
  expect(store.getState().thread?.live).toBe(true); expect(store.getState().turns[0].items).toEqual([]);
  expect(store.getState().busy).toBe(false); store.dispose();
});

test('a steering receipt remains visible until the matching server message is recorded', async () => {
  const channel = new Channel(), store = new SourceStore(channel), handler = channel.handler;
  channel.handler = (method, params) => method === 'agent.steer'
    ? { turnId: 'turn', delivery: { state: 'accepted', mode: 'steer', client_message_id: params.client_message_id, turn_id: 'turn' } }
    : method === 'agent.read' ? { thread: { id: 'thread', name: 'Task', cwd: '/', live: true, status: { type: 'active' } }, turns: [{ id: 'turn', status: 'inProgress', items: [] }], active_turn_id: 'turn', next_cursor: null }
      : handler(method, params);
  await store.refresh(); await store.selectSource('codex'); await store.openThread('thread');
  expect(await store.action('agent.steer', { turn_id: 'turn', text: '请先修复测试' })).toBe(true);
  const submission = store.getState().submissions[0];
  expect(submission.status).toBe('accepted'); expect(submission.text).toBe('请先修复测试');
  for (const listener of channel.pushes) listener({ type: 'event', category: 'agent', name: 'item/completed', payload: { source_id: 'codex', threadId: 'thread', turnId: 'turn', item: { id: 'server-id', clientId: submission.id, type: 'userMessage', content: [{ type: 'text', text: '请先修复测试' }] } } });
  expect(store.getState().submissions).toEqual([]);
  await store.readThread();
  expect(store.getState().turns[0].items.some((item) => item.clientId === submission.id)).toBe(true);
  store.dispose();
});

test('an old in-flight history response cannot undo a live completion', async () => {
  const channel = new Channel(), store = new SourceStore(channel);
  await store.refresh(); await store.selectSource('codex'); await store.openThread('thread');
  let finish: (value: unknown) => void = () => {};
  const handler = channel.handler;
  channel.handler = (method, params) => method === 'agent.read' ? new Promise((resolve) => { finish = resolve; }) : handler(method, params);
  const reading = store.readThread();
  for (const listener of channel.pushes) listener({ type: 'event', category: 'agent', name: 'turn/completed', payload: { source_id: 'codex', threadId: 'thread', turn: { id: 'turn', status: 'completed', items: [] } } });
  finish({ thread: { id: 'thread', name: 'Task', cwd: '/', live: true, status: { type: 'active' } }, turns: [{ id: 'turn', status: 'inProgress', items: [] }], active_turn_id: 'turn', next_cursor: null });
  await reading;
  expect(store.getState().activeTurnId).toBeNull(); expect(store.getState().turns[0].status).toBe('completed');
  store.dispose();
});

test('temporary source failure keeps the conversation mounted to preserve the input draft', async () => {
  const channel = new Channel(), store = new SourceStore(channel);
  await store.refresh(); await store.selectSource('codex'); await store.openThread('thread');
  channel.handler = () => ({ sources: [{ ...source, status: 'offline' }] });
  await store.refresh();
  expect(store.getState().thread?.id).toBe('thread');
  expect(store.getState().activeTurnId).toBeNull();
  expect(store.getState().error).toContain('草稿已保留');
  store.dispose();
});
