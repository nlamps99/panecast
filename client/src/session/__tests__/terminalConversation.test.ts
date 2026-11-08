import { RpcCallError, type ConnectionStatus } from '../../protocol/connection';
import type { PushFrame } from '../../protocol/frames';
import { TerminalSession, type RpcChannel } from '../terminalSession';
import { mergeTerminalItems, TerminalConversationStore } from '../terminalConversation';
import { terminalPrompt } from '../terminalPrompt';

class Channel implements RpcChannel {
  isOpen = true;
  snapshot: Record<string, unknown> = { available: true, conversation_id: 'one', generation: 'epoch', revision: 'r1', items: [], next_cursor: 'older', head_sequence: 100 };
  handler: ((params: Record<string, unknown>) => Promise<unknown>) | null = null;
  calls: { method: string; params: Record<string, unknown> }[] = [];
  pushes = new Set<(frame: PushFrame) => void>();
  statuses = new Set<(status: ConnectionStatus) => void>();
  async call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    this.calls.push({ method, params });
    if (method === 'terminal.conversation') return await (this.handler ? this.handler(params) : Promise.resolve(this.snapshot)) as T;
    return {} as T;
  }
  onPush(listener: (frame: PushFrame) => void) { this.pushes.add(listener); return () => { this.pushes.delete(listener); }; }
  onStatus(listener: (status: ConnectionStatus) => void) { this.statuses.add(listener); return () => { this.statuses.delete(listener); }; }
}
const target = { workspaceId: 'workspace', surfaceId: 'surface' };
const message = (id: string, sequence: number, text: string) => ({ id, sequence, type: 'userMessage', content: [{ type: 'text', text }] });
let channel: Channel, terminal: TerminalSession, store: TerminalConversationStore;
beforeEach(async () => { channel = new Channel(); terminal = new TerminalSession(channel); terminal.setTarget(target); store = new TerminalConversationStore(channel, terminal); store.start(); await store.refresh(); });
afterEach(() => { store.dispose(); terminal.dispose(); });

it('sends exact Chinese text and Enter through the selected terminal, then reconciles its real transcript echo', async () => {
  expect((await store.send('请检查这个项目\n保留中文')).status).toBe('sent');
  const sends = channel.calls.filter(call => ['surface.send_text', 'surface.send_key'].includes(call.method));
  expect(sends).toEqual([{ method: 'surface.send_text', params: { workspace_id: 'workspace', surface_id: 'surface', text: '请检查这个项目\n保留中文' } },
    { method: 'surface.send_key', params: { workspace_id: 'workspace', surface_id: 'surface', key: 'enter' } }]);
  expect(channel.calls.some(call => call.method.startsWith('agent.'))).toBe(false);
  await store.refresh();
  channel.snapshot = { ...channel.snapshot, revision: 'r2', items: [message('echo', 101, '请检查这个项目\n保留中文')] };
  await store.refresh(); expect(store.getState().submissions).toHaveLength(0); expect(store.getState().items).toHaveLength(1);
});

it('retains older pages and does not reload exhausted history on a head poll', async () => {
  channel.handler = async params => params.cursor ? { ...channel.snapshot, items: [message('old', 1, 'older')], next_cursor: null } : channel.snapshot;
  await store.loadOlder(); expect(store.getState().cursor).toBeNull();
  channel.snapshot = { ...channel.snapshot, revision: 'r2', items: [message('new', 200, 'newer')] };
  await store.refresh(); expect(store.getState().items.map(item => item.id)).toEqual(['old', 'new']); expect(store.getState().cursor).toBeNull();
});

it('discards late reads from another terminal even when both share a workspace', async () => {
  let resolve!: (value: unknown) => void;
  channel.handler = () => new Promise(answer => { resolve = answer; }); const old = store.refresh();
  const complete = resolve;
  terminal.setTarget({ ...target, surfaceId: 'second' });
  channel.handler = null; complete({ ...channel.snapshot, items: [message('wrong', 200, 'wrong terminal')] }); await old;
  expect(store.getState().target?.surfaceId).toBe('second'); expect(store.getState().items).toEqual([]);
});

it('keeps an unconfirmed send visible and never retries it automatically', async () => {
  const original = channel.call.bind(channel);
  channel.call = async <T,>(method: string, params?: Record<string, unknown>) => {
    if (method === 'surface.send_key') throw new RpcCallError('timeout', 'no acknowledgement');
    return await original<T>(method, params);
  };
  expect((await store.send('only once')).status).toBe('unknown'); await store.refresh(); await store.refresh();
  expect(store.getState().submissions[0].status).toBe('unknown'); expect(channel.calls.filter(call => call.method === 'surface.send_text')).toHaveLength(1);
});

it('shows ordinary terminal output on an older relay and clears inaccessible transcript data', async () => {
  channel.handler = async () => { throw new RpcCallError('method_not_found', 'old relay'); };
  await store.refresh(); expect(store.getState().available).toBe(false); expect(store.getState().error).toBeNull();
  channel.handler = async () => { throw new RpcCallError('source_revoked', 'revoked'); };
  await store.refresh(); expect(store.getState().blocked).toBe(true); expect((await store.send('no')).status).toBe('not_sent');
});

it('replaces stale branches while retaining file details from older tool calls', async () => {
  channel.snapshot = { ...channel.snapshot, items: [message('abandoned', 10, 'old branch')] }; await store.refresh();
  channel.snapshot = { ...channel.snapshot, reset: true, items: [message('current', 20, 'new branch')] }; await store.refresh();
  expect(store.getState().items.map(item => item.id)).toEqual(['current']);
  const items = mergeTerminalItems([{ id: 'edit', type: 'fileChange', sequence: 10, changes: [{ path: 'a.ts' }], status: 'inProgress' }], [{ id: 'edit', type: 'toolExecution', sequence: 20, updatedSequence: 20, changes: [], status: 'completed', text: 'done' }]);
  expect(items[0]).toMatchObject({ type: 'fileChange', sequence: 10, changes: [{ path: 'a.ts' }], status: 'completed' });
});

it('retains explicit terminal approvals while ignoring normal prose', () => {
  expect(terminalPrompt(['Would you like to run the following command?', '$ npm test', '1. Yes, proceed', '2. No, and tell the agent'])).toContain('npm test');
  expect(terminalPrompt(['The tool returned yes. Task done.'])).toBeNull();
});
