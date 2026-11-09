import type { ConnectionStatus } from '../../protocol/connection';
import { InboxStore } from '../../session/inboxStore';
import type { RpcChannel } from '../../session/terminalSession';
import type { AppStoreState, Machine } from '../../state/appStore';
import type { ComputerList, StoredComputer } from '../../state/computers';

const mockApi = {
  handler: null as null | { handleNotification: (n: unknown) => Promise<unknown> },
  onResponse: null as null | ((response: unknown) => void),
  onToken: null as null | ((token: { type: string; data: string }) => void),
  lastResponse: null as unknown,
};

jest.mock('expo-notifications', () => ({
  DEFAULT_ACTION_IDENTIFIER: 'expo.modules.notifications.actions.DEFAULT',
  setNotificationHandler: jest.fn((handler) => {
    mockApi.handler = handler;
  }),
  addNotificationResponseReceivedListener: jest.fn((listener) => {
    mockApi.onResponse = listener;
    return { remove: jest.fn() };
  }),
  addPushTokenListener: jest.fn((listener) => {
    mockApi.onToken = listener;
    return { remove: jest.fn() };
  }),
  getLastNotificationResponse: jest.fn(() => mockApi.lastResponse),
  clearLastNotificationResponse: jest.fn(() => {
    mockApi.lastResponse = null;
  }),
  getPermissionsAsync: jest.fn(),
  requestPermissionsAsync: jest.fn(),
  getDevicePushTokenAsync: jest.fn(),
  scheduleNotificationAsync: jest.fn(async () => 'id'),
  getAllScheduledNotificationsAsync: jest.fn(async () => []),
  cancelScheduledNotificationAsync: jest.fn(async () => {}),
  SchedulableTriggerInputTypes: { TIME_INTERVAL: 'timeInterval' },
  setNotificationChannelAsync: jest.fn(async () => null),
}));

// Imported after the mock.
// eslint-disable-next-line import/first
import * as Notifications from 'expo-notifications';
// eslint-disable-next-line import/first
import { NotificationController, pushSummary, type ControllerDeps } from '../controller';

const DEFAULT_ACTION = 'expo.modules.notifications.actions.DEFAULT';
const STORAGE_KEY = 'panecast.notifications.v1';
const RELAY_URL = 'http://192.168.1.5:4399/v1/devices/me/apns';
const BROKER_URL = 'https://example.com/cmux-remote/v1/devices/me/apns?relay_id=mac2';

class FakeChannel implements RpcChannel {
  status: ConnectionStatus = { state: 'open' };
  private pushes = new Set<(frame: never) => void>();
  private statuses = new Set<(status: ConnectionStatus) => void>();
  get isOpen() {
    return this.status.state === 'open';
  }
  async call<T>(): Promise<T> {
    throw new Error('not used');
  }
  onPush(listener: (frame: never) => void) {
    this.pushes.add(listener);
    return () => this.pushes.delete(listener);
  }
  onStatus(listener: (status: ConnectionStatus) => void) {
    this.statuses.add(listener);
    return () => this.statuses.delete(listener);
  }
  setStatus(status: ConnectionStatus) {
    this.status = status;
    for (const listener of this.statuses) listener(status);
  }
}

type Surfaces = Record<string, { id: string; title: string; index: number; focused: boolean; type: string }[]>;

class FakeWorkspaces {
  state = { workspaces: [] as { id: string }[], surfaces: {} as Surfaces, loading: false, loaded: false, error: null };
  private listeners = new Set<() => void>();
  getState = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  refresh = jest.fn(async () => {});
  load(surfaces: Surfaces) {
    this.state = { ...this.state, workspaces: Object.keys(surfaces).map((id) => ({ id })), surfaces, loaded: true };
    for (const listener of this.listeners) listener();
  }
}

type FakeMachine = Machine & { fakeChannel: FakeChannel; fakeWorkspaces: FakeWorkspaces };

function makeMachine(computer: StoredComputer | null, target: { workspaceId: string; surfaceId: string } | null = null): FakeMachine {
  const channel = new FakeChannel();
  const workspaces = new FakeWorkspaces();
  const machine = {
    mode: computer ? 'relay' : 'demo',
    computer,
    channel,
    session: { getState: () => ({ target }) },
    workspaces,
    inbox: new InboxStore(channel),
    fakeChannel: channel,
    fakeWorkspaces: workspaces,
  };
  return machine as unknown as FakeMachine;
}

function computer(id: string, relayId: string, lan = false): StoredComputer {
  return {
    id,
    name: relayId,
    broker: { serverUrl: 'https://example.com/cmux-remote', relayId, deviceId: `d-${id}`, token: `broker-${id}` },
    ...(lan ? { lan: { url: 'http://192.168.1.5:4399', deviceId: `l-${id}`, token: `lan-${id}` } } : {}),
    pairedAt: '2026-10-31T00:00:00.000Z',
  };
}

class FakeStore {
  state: AppStoreState = { phase: 'loading', account: null, accountError: null, computers: { version: 2, selectedId: null, computers: [] }, machine: null };
  machines = new Map<string, FakeMachine>();
  private listeners = new Set<() => void>();
  getState = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  select = jest.fn(async (id: string) => {
    this.set({ computers: { ...this.state.computers, selectedId: id }, machine: this.machines.get(id) ?? null });
  });
  set(patch: Partial<AppStoreState>) {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
  /** Paired with these computers, connected to the first. */
  ready(computers: StoredComputer[], machine?: FakeMachine): FakeMachine {
    for (const c of computers) if (!this.machines.has(c.id)) this.machines.set(c.id, makeMachine(c));
    const current = machine ?? this.machines.get(computers[0].id)!;
    if (current.computer) this.machines.set(current.computer.id, current);
    const list: ComputerList = { version: 2, selectedId: current.computer?.id ?? null, computers };
    this.set({ phase: 'ready', computers: list, machine: current });
    return current;
  }
}

class FakeAppState {
  currentState = 'active';
  private listeners = new Set<(state: string) => void>();
  addEventListener(_type: 'change', listener: (state: string) => void) {
    this.listeners.add(listener);
    return { remove: () => this.listeners.delete(listener) };
  }
  set(state: string) {
    this.currentState = state;
    for (const listener of this.listeners) listener(state);
  }
}

const TOKEN = 'a1b2c3d4';
const granted = { status: 'granted', granted: true, canAskAgain: true, expires: 'never', ios: { status: 2 } };
const undetermined = { status: 'undetermined', granted: false, canAskAgain: true, expires: 'never', ios: { status: 0 } };
const androidGranted = { status: 'granted', granted: true, canAskAgain: true, expires: 'never' };
const androidUndetermined = { status: 'undetermined', granted: false, canAskAgain: true, expires: 'never' };

const api = jest.mocked(Notifications);

function harness(options: { os?: string; storage?: Map<string, string>; fetchImpl?: typeof fetch } = {}) {
  const store = new FakeStore();
  const appState = new FakeAppState();
  const storage = options.storage ?? new Map<string, string>();
  const fetchImpl = options.fetchImpl ?? (jest.fn(async () => ({ status: 204 }) as Response) as unknown as typeof fetch);
  const deps = {
    os: options.os ?? 'ios',
    isDev: true,
    store,
    appState,
    storage: {
      getItem: async (key: string) => storage.get(key) ?? null,
      setItem: async (key: string, value: string) => {
        storage.set(key, value);
      },
    },
    fetchImpl,
    confirm: jest.fn(),
    openSettings: jest.fn(async () => {}),
    openSurface: jest.fn(),
    navigate: jest.fn(),
  } satisfies ControllerDeps;
  const controller = new NotificationController(deps);
  return { controller, store, appState, storage, deps, fetch: jest.mocked(fetchImpl) };
}

function fetchedUrls(fetchImpl: jest.Mock): string[] {
  return fetchImpl.mock.calls.map((call) => call[0] as string);
}

/** Lets chained promises (storage, permission, token, fetch) settle. */
async function settle() {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

function event(payload: Record<string, unknown>) {
  return { type: 'event' as const, category: 'notification', name: 'notification.created', payload: { state: payload.title === 'needs input' ? 'needs input' : 'completed', ...payload } };
}

function remote(payload: Record<string, unknown>, identifier = 'apns-1') {
  return {
    date: 1000,
    request: {
      identifier,
      content: { title: 'cmux needs attention', subtitle: null, body: '', categoryIdentifier: null, sound: 'default' },
      trigger: { type: 'push', payload: { aps: {}, ...payload } },
    },
  };
}

function tap(notification: unknown) {
  return { actionIdentifier: DEFAULT_ACTION, notification };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockApi.lastResponse = null;
  api.getPermissionsAsync.mockResolvedValue(granted as never);
  api.requestPermissionsAsync.mockResolvedValue(granted as never);
  api.getDevicePushTokenAsync.mockResolvedValue({ type: 'ios', data: TOKEN });
});

describe('APNs registration (iOS)', () => {
  it('recognizes broker forwarding and tests the authenticated end-to-end push route', async () => {
    const fetchImpl = jest.fn(async (url: string) => ({ status: 200, ok: true, json: async () => url.includes('/apns/test') ? { ok: true, accepted: true } : { ok: true, forwarded: true, push_enabled: true } }) as Response);
    const h = harness({ fetchImpl: fetchImpl as unknown as typeof fetch });
    h.store.ready([computer('c1', 'mac2')]); h.controller.start(); await settle();
    expect(pushSummary(h.controller.getState(), 'ios', 'c1')).toEqual({ kind: 'broker_relay', configured: true });
    await expect(h.controller.testPush()).resolves.toContain('Apple 已接收');
    expect(fetchImpl.mock.calls.at(-1)?.[0]).toContain('/v1/devices/me/apns/test?relay_id=mac2');
    h.controller.stop();
  });
  it('schedules a reminder with a stable ID and original terminal routing', async () => {
    const h = harness(); const machine = h.store.ready([computer('c1', 'mac2')]);
    h.controller.start(); await settle();
    machine.inbox.ingest(event({ id: 'n', workspace_id: 'w', surface_id: 's', title: 'needs input' }));
    await h.controller.remindLater(machine.inbox.getState().items[0], 'c1');
    expect(api.scheduleNotificationAsync).toHaveBeenLastCalledWith(expect.objectContaining({ identifier: 'reminder.c1.n', content: expect.objectContaining({ data: expect.objectContaining({ workspace_id: 'w', surface_id: 's', reminder: 'true' }) }), trigger: expect.objectContaining({ seconds: 900 }) }));
    await h.controller.cancelReminder('reminder.c1.n');
    expect(api.cancelScheduledNotificationAsync).toHaveBeenCalledWith('reminder.c1.n');
    h.controller.stop();
  });
  it('registers the token with the broker; without a LAN pairing push stays broker-only', async () => {
    const h = harness();
    const mac = computer('c1', 'mac2');
    h.store.ready([mac]);
    h.controller.start();
    await settle();
    expect(fetchedUrls(h.fetch)).toEqual([BROKER_URL]);
    const [, init] = h.fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toMatchObject({ apns_token: TOKEN, env: 'sandbox', preferences: { needs_input_only: false, muted_workspaces: [] } });
    expect(pushSummary(h.controller.getState(), 'ios', 'c1')).toEqual({ kind: 'broker_only', lanFailed: null });
    h.controller.stop();
  });

  it('registers with the relay itself when paired over the LAN, and remembers it without the token', async () => {
    const h = harness();
    h.store.ready([computer('c1', 'mac2', true)]);
    h.controller.start();
    await settle();
    expect(fetchedUrls(h.fetch).sort()).toEqual([BROKER_URL, RELAY_URL].sort());
    expect(pushSummary(h.controller.getState(), 'ios', 'c1')).toMatchObject({ kind: 'relay', remembered: false });
    const stored = h.storage.get(STORAGE_KEY)!;
    expect(stored).not.toContain(TOKEN);
    expect(JSON.parse(stored).relay.c1.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    h.controller.stop();
  });

  it('away from the Mac, trusts a relay that took this same token before', async () => {
    const storage = new Map<string, string>();
    const first = harness({ storage });
    first.store.ready([computer('c1', 'mac2', true)]);
    first.controller.start();
    await settle();
    first.controller.stop();

    const offline = jest.fn(async (url: string) => {
      if (url === RELAY_URL) throw new TypeError('Network request failed');
      return { status: 204 } as Response;
    });
    const second = harness({ storage, fetchImpl: offline as unknown as typeof fetch });
    second.store.ready([computer('c1', 'mac2', true)]);
    second.controller.start();
    await settle();
    expect(pushSummary(second.controller.getState(), 'ios', 'c1')).toMatchObject({ kind: 'relay', remembered: true });
    second.controller.stop();

    // A different token is news to the relay.
    api.getDevicePushTokenAsync.mockResolvedValue({ type: 'ios', data: 'ffee' });
    const third = harness({ storage, fetchImpl: offline as unknown as typeof fetch });
    third.store.ready([computer('c1', 'mac2', true)]);
    third.controller.start();
    await settle();
    expect(pushSummary(third.controller.getState(), 'ios', 'c1')).toEqual({ kind: 'broker_only', lanFailed: '连不上电脑' });
    third.controller.stop();
  });

  it('re-registers when APNs rolls the token and when another computer is paired', async () => {
    const h = harness();
    const a = computer('c1', 'mac2');
    h.store.ready([a]);
    h.controller.start();
    await settle();
    expect(h.fetch).toHaveBeenCalledTimes(1);

    mockApi.onToken!({ type: 'ios', data: 'beef' });
    await settle();
    expect(h.fetch).toHaveBeenCalledTimes(2);
    expect(JSON.parse((h.fetch.mock.calls[1] as unknown as [string, RequestInit])[1].body as string).apns_token).toBe('beef');

    // Same token again: nothing to do.
    mockApi.onToken!({ type: 'ios', data: 'beef' });
    await settle();
    expect(h.fetch).toHaveBeenCalledTimes(2);

    h.store.ready([a, computer('c2', 'air')], h.store.state.machine as FakeMachine);
    await settle();
    expect(fetchedUrls(h.fetch)[2]).toContain('relay_id=air');
    h.controller.stop();
  });

  it('retries a failed registration when the socket reopens', async () => {
    let fail = true;
    const flaky = jest.fn(async () => {
      if (fail) throw new TypeError('Network request failed');
      return { status: 204 } as Response;
    });
    const h = harness({ fetchImpl: flaky as unknown as typeof fetch });
    const machine = h.store.ready([computer('c1', 'mac2')]);
    h.controller.start();
    await settle();
    expect(pushSummary(h.controller.getState(), 'ios', 'c1')).toEqual({ kind: 'failed', message: '连不上服务器' });

    fail = false;
    machine.fakeChannel.setStatus({ state: 'open' });
    await settle();
    expect(pushSummary(h.controller.getState(), 'ios', 'c1').kind).toBe('broker_only');
    h.controller.stop();
  });

  it('waits for the pairing list before registering, and forgets unpaired computers', async () => {
    const storage = new Map([[STORAGE_KEY, JSON.stringify({ version: 1, offered: true, relay: { gone: { fingerprint: 'x', at: 1 } } })]]);
    const h = harness({ storage });
    h.controller.start();
    await settle();
    expect(h.fetch).not.toHaveBeenCalled();
    h.store.ready([computer('c1', 'mac2')]);
    await settle();
    expect(h.fetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(storage.get(STORAGE_KEY)!).relay).toEqual({});
    h.controller.stop();
  });
});

describe('asking for permission', () => {
  it('does not ask at launch; offers once after the first inbox notification, not on the terminal', async () => {
    api.getPermissionsAsync.mockResolvedValue(undetermined as never);
    const storage = new Map<string, string>();
    const h = harness({ storage });
    const machine = h.store.ready([computer('c1', 'mac2')]);
    h.controller.setRoute('/terminal');
    h.controller.start();
    await settle();
    expect(api.requestPermissionsAsync).not.toHaveBeenCalled();
    expect(api.getDevicePushTokenAsync).not.toHaveBeenCalled();
    expect(h.deps.confirm).not.toHaveBeenCalled();

    machine.inbox.ingest(event({ id: 'n1', workspace_id: 'w1', title: '测试通过' }));
    expect(h.deps.confirm).not.toHaveBeenCalled();
    h.controller.setRoute('/');
    expect(h.deps.confirm).toHaveBeenCalledTimes(1);

    const buttons = h.deps.confirm.mock.calls[0][2] as { text: string; onPress?: () => void }[];
    buttons.find((b) => b.text === '开启')!.onPress!();
    await settle();
    expect(api.requestPermissionsAsync).toHaveBeenCalledTimes(1);
    expect(api.getDevicePushTokenAsync).toHaveBeenCalledTimes(1);
    expect(h.controller.getState().permission.status).toBe('granted');
    h.controller.stop();

    // Never again, even after a relaunch.
    api.getPermissionsAsync.mockResolvedValue(undetermined as never);
    const again = harness({ storage });
    const m2 = again.store.ready([computer('c1', 'mac2')]);
    again.controller.start();
    await settle();
    m2.inbox.ingest(event({ id: 'n2', workspace_id: 'w1', title: 'x' }));
    expect(again.deps.confirm).not.toHaveBeenCalled();
    again.controller.stop();
  });

  it('sends the user to system settings once iOS has said no', async () => {
    api.getPermissionsAsync.mockResolvedValue({ ...undetermined, status: 'denied', canAskAgain: false, ios: { status: 1 } } as never);
    const h = harness();
    h.store.ready([computer('c1', 'mac2')]);
    h.controller.start();
    await settle();
    expect(h.controller.getState().permission).toEqual({ status: 'denied', canAskAgain: false });
    await h.controller.enable();
    expect(h.deps.openSettings).toHaveBeenCalled();
    expect(api.requestPermissionsAsync).not.toHaveBeenCalled();
    h.controller.stop();
  });
});

describe('local notifications for the inbox', () => {
  it('posts a question and one completion, while ignoring progress and resolved approvals', async () => {
    api.getPermissionsAsync.mockResolvedValue(androidGranted as never);
    const h = harness({ os: 'android' });
    const machine = h.store.ready([computer('c1', 'mac2')]);
    h.controller.start(); await settle(); h.appState.set('background');
    machine.inbox.ingest(event({ id: 'noise', state: 'running', title: 'Working' }));
    machine.inbox.ingest({ type: 'event', category: 'agent', name: 'item/completed', payload: { status: 'completed' } });
    machine.inbox.ingest(event({ id: 'question', state: 'needs input', needs_input: true, title: '确认执行', task_id: 'task' }));
    await settle();
    const completed = { type: 'event' as const, category: 'agent', name: 'task.completed', payload: { task_id: 'task', title: '确认执行' } };
    machine.inbox.ingest(completed);
    machine.inbox.ingest(completed);
    machine.inbox.ingest({ type: 'event', category: 'notification', name: 'notification.resolved', payload: { notification_id: 'question' } });
    await settle();
    expect(api.scheduleNotificationAsync).toHaveBeenCalledTimes(2);
    expect(machine.inbox.getState().items).toHaveLength(2);
    expect(machine.inbox.getState().pending).toBe(0);
    expect(api.scheduleNotificationAsync.mock.calls[1][0].content.data?.notification_id).toBe('task-event:::task:completed');
    h.controller.stop();
  });

  it('Android: no APNs; posts new inbox items only while in the background', async () => {
    api.getPermissionsAsync.mockResolvedValue(androidGranted as never);
    const h = harness({ os: 'android' });
    const machine = h.store.ready([computer('c1', 'mac2')]);
    machine.inbox.ingest(event({ id: 'old', workspace_id: 'w1', title: '旧的' }));
    h.controller.start();
    await settle();
    expect(api.getDevicePushTokenAsync).not.toHaveBeenCalled();
    expect(api.addPushTokenListener).not.toHaveBeenCalled();
    expect(h.fetch).not.toHaveBeenCalled();

    machine.inbox.ingest(event({ id: 'n1', workspace_id: 'w1', title: '在前台' }));
    await settle();
    expect(api.scheduleNotificationAsync).not.toHaveBeenCalled();

    h.appState.set('background');
    machine.inbox.ingest(event({ id: 'n2', workspace_id: 'w1', surface_id: 's1', title: '测试通过', body: '99 passed' }));
    await settle();
    expect(api.setNotificationChannelAsync).toHaveBeenCalledWith('inbox', expect.objectContaining({ name: '收件箱通知' }));
    expect(api.scheduleNotificationAsync).toHaveBeenCalledTimes(1);
    const request = api.scheduleNotificationAsync.mock.calls[0][0];
    expect(request).toMatchObject({
      identifier: 'inbox.c1.n2',
      content: { title: '测试通过', body: '99 passed', data: { computer_id: 'c1', workspace_id: 'w1', surface_id: 's1', notification_id: 'n2' } },
      trigger: { channelId: 'inbox' },
    });
    h.controller.stop();
  });

  it('Android: without permission, nothing is posted', async () => {
    api.getPermissionsAsync.mockResolvedValue(androidUndetermined as never);
    const h = harness({ os: 'android' });
    const machine = h.store.ready([computer('c1', 'mac2')]);
    h.appState.currentState = 'background';
    h.controller.start();
    await settle();
    machine.inbox.ingest(event({ id: 'n1', workspace_id: 'w1', title: 'x' }));
    await settle();
    expect(api.scheduleNotificationAsync).not.toHaveBeenCalled();
    h.controller.stop();
  });

  it('iOS: posts in the background unless the relay will push the same item', async () => {
    const h = harness();
    const machine = h.store.ready([computer('c1', 'mac2')]);
    h.controller.start();
    await settle();
    h.appState.set('background');
    machine.inbox.ingest(event({ id: 'n1', workspace_id: 'w1', title: 'x' }));
    await settle();
    expect(api.scheduleNotificationAsync).toHaveBeenCalledTimes(1);
    expect(api.scheduleNotificationAsync.mock.calls[0][0].trigger).toBeNull();
    h.controller.stop();

    jest.clearAllMocks();
    const lan = harness();
    const m2 = lan.store.ready([computer('c1', 'mac2', true)]);
    lan.controller.start();
    await settle();
    lan.appState.set('background');
    m2.inbox.ingest(event({ id: 'n1', workspace_id: 'w1', title: 'x' }));
    await settle();
    expect(api.scheduleNotificationAsync).not.toHaveBeenCalled();
    lan.controller.stop();
  });

  it('the demo neither prompts nor posts', async () => {
    api.getPermissionsAsync.mockResolvedValue(undetermined as never);
    const h = harness();
    const demo = makeMachine(null);
    h.store.set({ phase: 'ready', machine: demo });
    h.controller.start();
    await settle();
    h.appState.set('background');
    demo.inbox.ingest(event({ id: 'demo-n-1', workspace_id: 'demo-ws-1', title: 'x' }));
    await settle();
    expect(h.deps.confirm).not.toHaveBeenCalled();
    expect(api.scheduleNotificationAsync).not.toHaveBeenCalled();
    h.controller.stop();
  });
});

describe('tapping a notification', () => {
  it('opens the terminal a relay push names, once per response', async () => {
    const h = harness();
    const machine = h.store.ready([computer('c1', 'mac2')]);
    machine.inbox.ingest(event({ id: 'n1', workspace_id: 'w1', title: 'x' }));
    h.controller.start();
    const response = tap(remote({ workspace_id: 'w1', surface_id: 's1', notification_id: 'n1' }));
    mockApi.onResponse!(response);
    mockApi.onResponse!(response);
    expect(h.deps.openSurface).toHaveBeenCalledTimes(1);
    expect(h.deps.openSurface).toHaveBeenCalledWith(machine, 'w1', 's1');
    expect(machine.inbox.getState().items[0].read).toBe(true);
    h.controller.stop();
  });

  it('ignores other actions, and opens the inbox when no workspace is named', () => {
    const h = harness();
    h.store.ready([computer('c1', 'mac2')]);
    h.controller.start();
    mockApi.onResponse!({ actionIdentifier: 'com.apple.UNNotificationDismissActionIdentifier', notification: remote({ workspace_id: 'w1' }) });
    expect(h.deps.openSurface).not.toHaveBeenCalled();
    mockApi.onResponse!(tap(remote({ workspace_id: 'unknown' }, 'apns-2')));
    expect(h.deps.navigate).toHaveBeenCalledWith('/inbox');
    h.controller.stop();
  });

  it('switches to the computer a local notification came from, then opens its terminal', () => {
    const h = harness();
    const a = computer('c1', 'mac2');
    const b = computer('c2', 'air');
    h.store.ready([a, b]);
    const other = h.store.machines.get('c2')!;
    other.fakeWorkspaces.load({ w9: [{ id: 's9', title: 'zsh', index: 0, focused: true, type: 'terminal' }] });
    h.controller.start();
    mockApi.onResponse!(
      tap({
        date: 5,
        request: { identifier: 'inbox.c2.n1', content: { data: { source: 'panecast.inbox', computer_id: 'c2', workspace_id: 'w9', notification_id: 'n1' } }, trigger: null },
      }),
    );
    expect(h.store.select).toHaveBeenCalledWith('c2');
    expect(h.deps.openSurface).not.toHaveBeenCalled();
    // The root layout flushes after the render that switched machines.
    h.controller.flushTap();
    expect(h.deps.openSurface).toHaveBeenCalledWith(other, 'w9', 's9');
    h.controller.stop();
  });

  it('drops a tap for a computer that is no longer paired', () => {
    const h = harness();
    h.store.ready([computer('c1', 'mac2')]);
    h.controller.start();
    mockApi.onResponse!(tap(remote({ workspace_id: 'w1', relay_id: 'sold-mac' })));
    h.controller.flushTap();
    expect(h.store.select).not.toHaveBeenCalled();
    expect(h.deps.openSurface).not.toHaveBeenCalled();
    h.controller.stop();
  });

  it('cold start: holds the launch tap until paired, connected and the workspace list names a terminal', () => {
    const h = harness();
    mockApi.lastResponse = tap(remote({ workspace_id: 'w1' }));
    h.controller.start();
    h.controller.flushTap();
    expect(h.deps.openSurface).not.toHaveBeenCalled();
    expect(api.clearLastNotificationResponse).toHaveBeenCalled();

    const machine = h.store.ready([computer('c1', 'mac2')]);
    h.controller.flushTap();
    expect(h.deps.openSurface).not.toHaveBeenCalled();
    machine.fakeWorkspaces.load({
      w1: [
        { id: 's0', title: 'a', index: 0, focused: false, type: 'terminal' },
        { id: 's1', title: 'b', index: 1, focused: true, type: 'terminal' },
      ],
    });
    expect(h.deps.openSurface).toHaveBeenCalledWith(machine, 'w1', 's1');
    h.controller.stop();
  });
});

describe('foreground presentation', () => {
  it('hides a push for the terminal on screen and nudges for another one', async () => {
    const h = harness();
    const mac = computer('c1', 'mac2');
    const machine = makeMachine(mac, { workspaceId: 'w1', surfaceId: 's1' });
    machine.fakeWorkspaces.load({ w1: [], w2: [] });
    h.store.ready([mac], machine);
    h.controller.setRoute('/terminal');
    h.controller.start();
    const handle = (payload: Record<string, unknown>) => mockApi.handler!.handleNotification(remote(payload));

    expect(await handle({ workspace_id: 'w1', surface_id: 's1' })).toMatchObject({ shouldShowBanner: false, shouldShowList: false });
    expect(await handle({ workspace_id: 'w2', surface_id: 's5' })).toMatchObject({ shouldShowBanner: true, shouldShowList: false });
    // A workspace this computer does not have: from another Mac, so show it in full.
    expect(await handle({ workspace_id: 'elsewhere' })).toMatchObject({ shouldShowBanner: true, shouldShowList: true });

    machine.fakeChannel.setStatus({ state: 'waiting', attempt: 1, retryAt: 0, reason: 'network' });
    expect(await handle({ workspace_id: 'w1', surface_id: 's1' })).toMatchObject({ shouldShowList: true });
    h.controller.stop();
    expect(api.setNotificationHandler).toHaveBeenLastCalledWith(null);
  });
});
