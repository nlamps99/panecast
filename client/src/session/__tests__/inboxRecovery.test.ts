import AsyncStorage from '@react-native-async-storage/async-storage';
import { RpcCallError, type ConnectionStatus } from '../../protocol/connection';
import type { EventFrame, PushFrame } from '../../protocol/frames';
import { InboxStore } from '../inboxStore';
import { cachedRecovery, inboxStorageKey, settleInboxWrites } from '../inboxPersistence';
import { resolutionMatcher } from '../inboxRecovery';
import type { RpcChannel } from '../terminalSession';

class Channel implements RpcChannel {
  isOpen = false;
  frames = new Set<(frame: PushFrame) => void>(); statuses = new Set<(status: ConnectionStatus) => void>();
  handler: (params: Record<string, unknown>) => Promise<unknown> = async () => page([], 0);
  call<T>(_method: string, params: Record<string, unknown> = {}): Promise<T> { return this.handler(params) as Promise<T>; }
  onPush(listener: (frame: PushFrame) => void) { this.frames.add(listener); return () => { this.frames.delete(listener); }; }
  onStatus(listener: (status: ConnectionStatus) => void) { this.statuses.add(listener); return () => { this.statuses.delete(listener); }; }
  emit(frame: EventFrame) { for (const listener of this.frames) listener(frame); }
  open() { this.isOpen = true; for (const listener of this.statuses) listener({ state: 'open' }); }
}
const event = (seq: number, extra: Record<string, unknown> = {}, name = 'notification.created'): EventFrame => ({ type: 'event', category: 'notification', name, payload: { id: `n${seq}`, title: 'Needs input', needs_input: true, workspace_id: 'w', surface_id: 's', task_id: 'task', ts: 1_700_000_000 + seq, panecast_event_id: `epoch:${seq}`, panecast_cursor: `epoch:${seq}`, ...extra } });
const page = (events: EventFrame[], sequence: number, more = false, gap = false) => ({ events, next_cursor: `epoch:${sequence}`, head_cursor: `epoch:${sequence}`, has_more: more, reset: gap });
let counter = 0;
const key = () => inboxStorageKey(`recovery-${++counter}`);
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

it('replays disconnected notifications once, persists its cursor and retains read/handled state', async () => {
  const channel = new Channel(), storageKey = key();
  channel.handler = async (p) => p.cursor ? page([], 2) : page([event(1), event(2, { task_id: 'other' })], 2);
  const inbox = new InboxStore(channel, { storageKey }); await inbox.ready;
  const announced: string[] = []; inbox.onNew((item) => announced.push(item.id));
  channel.open(); await inbox.sync(); await flush();
  expect(inbox.getState().items.map((item) => item.id)).toEqual(['n2', 'n1']);
  expect(announced).toEqual([]);
  inbox.markRead('n1'); inbox.resolve('n1'); await settleInboxWrites();
  expect(cachedRecovery(storageKey).cursor).toBe('epoch:2');
  inbox.dispose();
  const again = new InboxStore(channel, { storageKey }); await again.ready; await again.sync();
  expect(again.getState().items.find((i) => i.id === 'n1')).toMatchObject({ read: true, resolvedAt: expect.any(Number) });
  expect(JSON.parse((await AsyncStorage.getItem(storageKey))!).recovery.cursor).toBe('epoch:2');
  again.dispose();
});

it('orders live completion after an older replayed prompt and preserves its read/reminder metadata', async () => {
  const channel = new Channel(), storageKey = key();
  let reply!: (value: unknown) => void;
  channel.handler = () => new Promise((resolve) => { reply = resolve; });
  const inbox = new InboxStore(channel, { storageKey }); await inbox.ready;
  channel.open(); await flush();
  channel.emit(event(2, { id: undefined, notification_id: 'n1', resolved: true, status: 'completed' }, 'notification.resolved'));
  reply(page([event(1)], 1));
  channel.handler = async () => page([], 2);
  await flush(); await inbox.sync();
  expect(inbox.getState().items.find((i) => i.id === 'n1')).toMatchObject({ resolvedAt: expect.any(Number) });
  expect(inbox.getState().pending).toBe(0); inbox.dispose();
});

it('deduplicates a live event also returned in the same catch-up snapshot', async () => {
  const channel = new Channel(), inbox = new InboxStore(channel, { storageKey: key() }); await inbox.ready;
  let reply!: (value: unknown) => void;
  channel.handler = () => new Promise((resolve) => { reply = resolve; });
  const announced: string[] = []; inbox.onNew((item) => announced.push(item.id));
  channel.open(); await flush(); channel.emit(event(1)); reply(page([event(1)], 1));
  channel.handler = async () => page([], 1);
  await flush(); await inbox.sync();
  expect(inbox.getState().items).toHaveLength(1); expect(announced).toEqual(['n1']); inbox.dispose();
});

it('makes a retention gap explicit while preserving existing local records', async () => {
  const channel = new Channel(), inbox = new InboxStore(channel, { storageKey: key() }); await inbox.ready;
  inbox.ingest({ ...event(0), payload: { id: 'local', title: 'old', status: 'completed' } });
  channel.handler = async () => page([event(10)], 10, false, true);
  channel.open(); await inbox.sync();
  expect(inbox.getState().sync).toMatchObject({ status: 'ready', gap: true });
  expect(inbox.getState().items.some((i) => i.id === 'local')).toBe(true); inbox.dispose();
});

it('keeps old relays usable and does not retry unsupported sync in a loop', async () => {
  const channel = new Channel(), inbox = new InboxStore(channel, { storageKey: key() }); await inbox.ready;
  let calls = 0; channel.handler = async () => { calls++; throw new RpcCallError('method_not_found', 'old'); };
  channel.open(); await inbox.sync(); await flush();
  expect(inbox.getState().sync?.status).toBe('unsupported'); expect(calls).toBeLessThan(3);
  inbox.ingest({ ...event(1), payload: { id: 'online', title: 'new', status: 'completed' } }); expect(inbox.getState().items[0].id).toBe('online'); inbox.dispose();
});

it('requires structured matching IDs for completion and never interprets prose as completion', () => {
  expect(resolutionMatcher({ type: 'event', category: 'agent', name: 'message', payload: { body: 'task complete, no approval required' } })).toBeNull();
  expect(resolutionMatcher({ type: 'event', category: 'agent', name: 'turn/completed', payload: { thread_id: 'thread' } })).toBeNull();
  const matcher = resolutionMatcher(event(2, { task_id: 'task', status: 'completed' }))!;
  expect(matcher({ id: 'n1', taskId: 'different', workspaceId: 'w', surfaceId: 's' } as never)).toBe(false);
});

it('resolves a pending request and announces a structured completion once', () => {
  const channel = new Channel(), inbox = new InboxStore(channel);
  inbox.ingest(event(1));
  inbox.ingest({ type: 'event', category: 'agent', name: 'item/completed', payload: { task_id: 'task', status: 'completed' } });
  expect(inbox.getState().pending).toBe(1);
  const announced: string[] = []; inbox.onNew((item) => announced.push(item.id));
  const completion: EventFrame = { type: 'event', category: 'agent', name: 'task.status', payload: { task_id: 'task', workspace_id: 'w', surface_id: 's', status: { type: 'succeeded' } } };
  inbox.ingest(completion); inbox.ingest(completion);
  expect(inbox.getState().pending).toBe(0);
  expect(announced).toEqual(['task-event:::task:completed']);
  expect(inbox.getState().items).toHaveLength(2);
  inbox.dispose();
});
