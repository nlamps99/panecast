import { RpcCallError, type ConnectionStatus } from '../../protocol/connection';
import type { PushFrame } from '../../protocol/frames';
import { TerminalSession, type RpcChannel } from '../terminalSession';
import { ECHO_EXPIRY_MS, ECHO_WAIT_MS, mergeTerminalItems, settleSubmissions, TerminalConversationStore, type TerminalChatSubmission } from '../terminalConversation';
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
  expect((await store.send('请检查这个项目，保留中文')).status).toBe('sent');
  const sends = channel.calls.filter(call => ['surface.input', 'surface.send_text', 'surface.send_key'].includes(call.method));
  expect(sends).toEqual([{ method: 'surface.input', params: { workspace_id: 'workspace', surface_id: 'surface', items: [{ text: '请检查这个项目，保留中文' }, { key: 'enter' }] } }]);
  expect(channel.calls.some(call => call.method.startsWith('agent.'))).toBe(false);
  await store.refresh();
  channel.snapshot = { ...channel.snapshot, revision: 'r2', items: [message('echo', 101, '请检查这个项目，保留中文')] };
  await store.refresh(); expect(store.getState().submissions).toHaveLength(0); expect(store.getState().items).toHaveLength(1);
});

it('preserves a multi-line draft on older gateways instead of submitting each line separately', async () => {
  const receipt = await store.send('first line\nsecond line');
  expect(receipt.status).toBe('not_sent'); expect(receipt.message).toContain('版本较旧');
  expect(channel.calls.some(c => ['terminal.paste', 'surface.send_text', 'surface.send_key'].includes(c.method))).toBe(false);
});

it('tells a plain shell to send one line at a time instead of suggesting an update', async () => {
  channel.snapshot = { available: false, conversation_id: null, provider: 'terminal', items: [] }; await store.refresh();
  const receipt = await store.send('first line\nsecond line');
  expect(receipt.status).toBe('not_sent'); expect(receipt.message).toContain('一次只能发一行'); expect(receipt.message).not.toContain('更新');
});

it('keeps only the latest command in a plain shell and stops polling quickly once it is delivered', async () => {
  channel.snapshot = { available: false, conversation_id: null, provider: 'terminal', items: [] }; await store.refresh();
  const timers = jest.spyOn(global, 'setTimeout');
  try {
    expect((await store.send('ls')).status).toBe('sent'); await store.refresh();
    expect((await store.send('pwd')).status).toBe('sent'); await store.refresh();
    expect(store.getState().submissions.map(item => item.text)).toEqual(['pwd']);
    expect(timers.mock.calls.at(-1)?.[1]).toBe(5000);
  } finally { timers.mockRestore(); }
});

it('polls quickly only while a conversation message waits for its echo', async () => {
  const timers = jest.spyOn(global, 'setTimeout');
  const now = jest.spyOn(Date, 'now');
  try {
    now.mockReturnValue(1_000_000);
    expect((await store.send('hello')).status).toBe('sent'); await store.refresh();
    expect(timers.mock.calls.at(-1)?.[1]).toBe(1200);
    now.mockReturnValue(1_000_000 + ECHO_WAIT_MS + 1); await store.refresh();
    expect(timers.mock.calls.at(-1)?.[1]).toBe(5000);
    expect(store.getState().submissions).toHaveLength(1);
  } finally { timers.mockRestore(); now.mockRestore(); }
});

it('settles sent messages by echo, expiry, retry and shell output', () => {
  const sent = (id: string, text: string, extra: Partial<TerminalChatSubmission> = {}): TerminalChatSubmission => ({ id, text, status: 'sent', at: 0, base: 100, kind: 'conversation', ...extra });
  const items = [message('echo', 101, 'hello')];
  expect(settleSubmissions([sent('a', 'hello'), sent('b', 'later')], { conversation: true, items, active: false, now: 1 }).map(item => item.id)).toEqual(['b']);
  expect(settleSubmissions([sent('a', 'hello', { base: 200 })], { conversation: true, items, active: false, now: 1 })).toHaveLength(1);
  expect(settleSubmissions([sent('a', 'waiting')], { conversation: true, items: [], active: false, now: ECHO_EXPIRY_MS + 1 })).toHaveLength(0);
  expect(settleSubmissions([sent('a', 'waiting')], { conversation: true, items: [], active: true, now: ECHO_EXPIRY_MS + 1 })).toHaveLength(1);
  expect(settleSubmissions([sent('a', 'failed', { status: 'not_sent' })], { conversation: true, items: [], active: false, now: ECHO_EXPIRY_MS + 1 })).toHaveLength(1);
  // A shell command never appears in a transcript that starts later.
  expect(settleSubmissions([sent('a', 'claude', { kind: 'terminal' }), sent('b', 'go', { status: 'sending' })], { conversation: true, items: [], active: false, now: 1 }).map(item => item.id)).toEqual(['b']);
  expect(settleSubmissions([sent('a', 'ls', { kind: 'terminal' }), sent('b', 'pwd', { kind: 'terminal' }), sent('c', 'cd', { kind: 'terminal', status: 'sending' })], { conversation: false, items: [], active: false, now: 1 }).map(item => item.id)).toEqual(['b', 'c']);
});

it('replaces a failed message when it is sent again', async () => {
  channel.isOpen = false;
  expect((await store.send('retry me')).status).toBe('not_sent');
  channel.isOpen = true;
  expect((await store.send('retry me')).status).toBe('sent');
  expect(store.getState().submissions.map(item => item.status)).toEqual(['sent']);
});

it('sends multi-line chat as one bracketed paste when the host advertises support', async () => {
  channel.snapshot = { ...channel.snapshot, input_method: 'terminal.paste' }; await store.refresh();
  expect((await store.send('first line\nsecond line')).status).toBe('sent');
  expect(channel.calls.filter(c => ['terminal.paste', 'surface.send_text', 'surface.send_key'].includes(c.method))).toEqual([
    { method: 'terminal.paste', params: { workspace_id: 'workspace', surface_id: 'surface', text: 'first line\nsecond line', submit_key: 'return' } },
  ]);
});

it('keeps free text out of a live choice dialog and preserves it as a draft', async () => {
  for (const push of channel.pushes) push({ type: 'screen.full', surfaceId: 'surface', rev: 1, rows: ['Choose environment:', '› 1. Staging', '  2. Production', 'Enter to select · Esc to cancel'], cols: 80, rowsCount: 4, cursor: { x: 0, y: 0 } });
  expect((await store.send('my draft')).status).toBe('not_sent');
  expect(channel.calls.some(c => ['terminal.paste', 'surface.send_text', 'surface.send_key'].includes(c.method))).toBe(false);
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
  let attempts = 0;
  channel.call = async <T,>(method: string, params?: Record<string, unknown>) => {
    if (method === 'surface.input') { attempts++; throw new RpcCallError('timeout', 'no acknowledgement'); }
    return await original<T>(method, params);
  };
  expect((await store.send('only once')).status).toBe('unknown'); await store.refresh(); await store.refresh();
  expect(store.getState().submissions[0].status).toBe('unknown');
  expect(attempts).toBe(1); expect(channel.calls.filter(call => call.method.startsWith('surface.send'))).toHaveLength(0);
});

it('shows ordinary terminal output on an older relay and clears inaccessible transcript data', async () => {
  channel.snapshot = { ...channel.snapshot, items: [message('old', 10, 'previous transcript')] }; await store.refresh();
  channel.snapshot = { available: false, conversation_id: 'one', provider: 'terminal', items: [] }; await store.refresh();
  expect(store.getState().items).toEqual([]); expect(store.getState().cursor).toBeNull();
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
