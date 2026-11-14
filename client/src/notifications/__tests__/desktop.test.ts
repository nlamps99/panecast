import { desktopNotifications, watchDesktopNotifications } from '../desktop';
import { InboxStore } from '../../session/inboxStore';
import type { RpcChannel } from '../../session/terminalSession';
import type { Machine } from '../../state/appStore';
import type { DesktopBridge } from '../../platform/desktop';
import { notifications } from '../instance';

jest.mock('../instance', () => ({ notifications: {
  allowsItem: jest.fn(() => true),
  rules: () => ({ load: async () => {}, getState: () => ({ preferences: { dedupe_seconds: 60 } }) }),
} }));
const channel: RpcChannel = { isOpen: true, call: async <T,>() => ({} as T), onPush: () => () => {}, onStatus: () => () => {} };
const event = (id: string, title = '任务完成') => ({ type: 'event' as const, category: 'notification', name: 'notification.created',
  payload: { id, workspace_id: 'project', surface_id: 'surface', title, body: '所有测试通过', state: 'completed' } });
const tick = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
let inbox: InboxStore, machine: Machine, stop: () => void;
const notify = jest.fn(async () => true);
const bridge = { version: 1, notify } as unknown as DesktopBridge;
beforeEach(async () => {
  jest.clearAllMocks(); await desktopNotifications.load(); await desktopNotifications.enable(true);
  jest.mocked(notifications.allowsItem).mockReturnValue(true);
  inbox = new InboxStore(channel);
  machine = { mode: 'relay', computer: { id: 'computer' }, inbox } as Machine;
  stop = () => {};
});
afterEach(() => { stop(); inbox.dispose(); });

it('sends one native alert for new completion with its navigation target, without replaying history', async () => {
  inbox.ingest(event('old'));
  stop = watchDesktopNotifications(machine, bridge);
  await tick(); expect(notify).not.toHaveBeenCalled();
  inbox.ingest(event('new')); await tick(); inbox.ingest(event('new')); await tick();
  expect(notify).toHaveBeenCalledTimes(1);
  expect(notify).toHaveBeenCalledWith(expect.objectContaining({ title: '任务完成', computerId: 'computer', notificationId: 'new', workspaceId: 'project', surfaceId: 'surface' }));
});
it('respects disabled notifications, quiet rules and machine disposal', async () => {
  stop = watchDesktopNotifications(machine, bridge);
  await desktopNotifications.enable(false); inbox.ingest(event('disabled')); await tick();
  await desktopNotifications.enable(true); jest.mocked(notifications.allowsItem).mockReturnValue(false);
  inbox.ingest(event('muted')); await tick();
  jest.mocked(notifications.allowsItem).mockReturnValue(true);
  inbox.ingest(event('late')); stop(); await tick();
  expect(notify).not.toHaveBeenCalled();
});
it('does not notify for demo sessions or recovered inbox entries', async () => {
  stop = watchDesktopNotifications({ ...machine, mode: 'demo' }, bridge);
  inbox.ingest(event('demo')); await tick(); expect(notify).not.toHaveBeenCalled(); stop();
  stop = watchDesktopNotifications(machine, bridge);
  inbox.ingest(event('replay'), true); await tick(); expect(notify).not.toHaveBeenCalled();
});
