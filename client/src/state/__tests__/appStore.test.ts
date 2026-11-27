import type { ConnectionStatus } from '../../protocol/connection';
import type { PairingPayload } from '../../protocol/pairing';
import type { StoredComputer } from '../computers';

const mockStore = new Map<string, string>();

jest.mock('expo-secure-store', () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'when-unlocked-this-device-only',
  getItemAsync: jest.fn(async (key: string) => mockStore.get(key) ?? null),
  setItemAsync: jest.fn(async (key: string, value: string) => {
    mockStore.set(key, value);
  }),
  deleteItemAsync: jest.fn(async (key: string) => {
    mockStore.delete(key);
  }),
}));

jest.mock('expo-crypto', () => {
  let n = 0;
  return { randomUUID: () => `uuid-${++n}` };
});

jest.mock('react-native', () => ({ Platform: { OS: 'ios' } }));

/** A stand-in for `ComputerChannel`: records its lifecycle, never connects. */
class MockChannel {
  readonly isOpen = false;
  readonly status: ConnectionStatus = { state: 'idle' };
  readonly transport = 'broker' as const;
  started = false;
  stopped = false;
  constructor(readonly computer: StoredComputer) {}
  call(): Promise<never> {
    return Promise.reject(new Error('not connected'));
  }
  onPush() {
    return () => {};
  }
  onStatus() {
    return () => {};
  }
  onTransport() {
    return () => {};
  }
  woken = 0;
  reconnected = 0;
  start() {
    this.started = true;
  }
  stop() {
    this.stopped = true;
  }
  wake() {
    this.woken++;
  }
  reconnect() {
    this.reconnected++;
  }
}

const mockChannels: MockChannel[] = [];
const mockRegistered: StoredComputer[] = [];

jest.mock('../connect', () => {
  class PairingError extends Error {}
  return {
    PairingError,
    registerComputer: jest.fn(async (payload: PairingPayload): Promise<StoredComputer> => {
      const computer: StoredComputer = {
        id: `new-${mockRegistered.length + 1}`,
        name: payload.relayId,
        broker: { serverUrl: payload.serverUrl, relayId: payload.relayId, deviceId: 'dev-new', token: `token-${payload.pairingCode}` },
        pairedAt: '2026-11-01T00:00:00.000Z',
      };
      mockRegistered.push(computer);
      return computer;
    }),
    createComputerChannel: jest.fn((computer: StoredComputer) => {
      const channel = new MockChannel(computer);
      mockChannels.push(channel);
      return channel;
    }),
  };
});

// Imported after the mocks.
/* eslint-disable import/first */
import { AppStore, PairingError } from '../appStore';
import * as accountApi from '../../account/api';
import { loadComputers, saveComputers } from '../pairingStorage';
/* eslint-enable import/first */

const SERVER = 'https://broker.example/cmux-remote';

function stored(id: string, relayId = `relay-${id}`): StoredComputer {
  return {
    id,
    name: relayId,
    broker: { serverUrl: SERVER, relayId, deviceId: `dev-${id}`, token: `token-${id}` },
    pairedAt: '2026-10-31T00:00:00.000Z',
  };
}

function pairingUrl(relayId: string, code = 'code-1'): string {
  return `cmux://pair?server=${encodeURIComponent(SERVER)}&relay=${relayId}&code=${code}`;
}

async function storeWith(computers: StoredComputer[], selectedId: string | null = computers[0]?.id ?? null): Promise<AppStore> {
  await saveComputers({ version: 2, selectedId, computers });
  const store = new AppStore();
  await store.load();
  return store;
}

const lastChannel = () => mockChannels[mockChannels.length - 1];

beforeEach(() => {
  mockStore.clear();
  mockChannels.length = 0;
  mockRegistered.length = 0;
});

describe('AppStore with several computers', () => {
  it('connects to the selected computer on load', async () => {
    const store = await storeWith([stored('a'), stored('b')], 'b');
    const { phase, machine } = store.getState();
    expect(phase).toBe('ready');
    expect(machine?.computer?.id).toBe('b');
    expect(lastChannel()).toMatchObject({ started: true, computer: { id: 'b' } });
  });

  it('pairing another computer adds it, switches to it and saves', async () => {
    const store = await storeWith([stored('a')]);
    const first = lastChannel();
    await store.pair(pairingUrl('mac-2'));
    const { machine, computers } = store.getState();
    expect(computers.computers.map((c) => c.broker.relayId)).toEqual(['relay-a', 'mac-2']);
    expect(machine?.computer?.broker.relayId).toBe('mac-2');
    expect(first.stopped).toBe(true);
    expect(lastChannel()).toMatchObject({ started: true, computer: { broker: { relayId: 'mac-2' } } });
    expect((await loadComputers()).selectedId).toBe(machine?.computer?.id);
  });

  it('re-pairing a known relay keeps its id and name and reconnects with the new token', async () => {
    const renamed = { ...stored('a', 'mac-1'), name: '书房 Mac' };
    const store = await storeWith([renamed, stored('b')], 'b');
    await store.pair(pairingUrl('mac-1', 'fresh'));
    const { machine, computers } = store.getState();
    expect(computers.computers.map((c) => c.id)).toEqual(['a', 'b']);
    expect(machine?.computer).toMatchObject({ id: 'a', name: '书房 Mac', broker: { token: 'token-fresh' } });
    expect(lastChannel().computer.broker.token).toBe('token-fresh');
  });

  it('rejects a QR code that is not a pairing URL without registering', async () => {
    const store = await storeWith([stored('a')]);
    await expect(store.pair('https://example.com')).rejects.toBeInstanceOf(PairingError);
    expect(mockRegistered).toHaveLength(0);
  });

  it('removing another computer keeps the current connection', async () => {
    const store = await storeWith([stored('a'), stored('b')], 'a');
    const machine = store.getState().machine;
    await store.remove('b');
    expect(store.getState().machine).toBe(machine);
    expect(lastChannel().stopped).toBe(false);
    expect(store.getState().computers.computers.map((c) => c.id)).toEqual(['a']);
    expect((await loadComputers()).computers.map((c) => c.id)).toEqual(['a']);
  });

  it('removing the current computer switches to the next one', async () => {
    const store = await storeWith([stored('a'), stored('b')], 'b');
    const old = lastChannel();
    await store.remove('b');
    expect(old.stopped).toBe(true);
    expect(store.getState()).toMatchObject({ phase: 'ready', machine: { computer: { id: 'a' } } });
    expect((await loadComputers()).selectedId).toBe('a');
  });

  it('removing the last computer goes back to the pairing screen', async () => {
    const store = await storeWith([stored('a')]);
    await store.remove('a');
    expect(store.getState()).toMatchObject({ phase: 'unpaired', machine: null });
    expect(lastChannel().stopped).toBe(true);
    expect(await loadComputers()).toMatchObject({ selectedId: null, computers: [] });
  });

  it('unpair() still removes the current computer', async () => {
    const store = await storeWith([stored('a'), stored('b')], 'a');
    await store.unpair();
    expect(store.getState().computers.computers.map((c) => c.id)).toEqual(['b']);
    expect(store.getState().machine?.computer?.id).toBe('b');
  });

  it('renaming the current computer updates the machine without reconnecting', async () => {
    const store = await storeWith([stored('a'), stored('b')], 'a');
    const before = store.getState().machine;
    await store.rename('a', '  办公室 Mac ');
    const after = store.getState().machine;
    expect(after?.computer?.name).toBe('办公室 Mac');
    expect(after?.session).toBe(before?.session);
    expect(after?.channel).toBe(before?.channel);
    expect(mockChannels).toHaveLength(1);
    expect((await loadComputers()).computers[0].name).toBe('办公室 Mac');

    await store.rename('b', '');
    expect(store.getState().computers.computers[1].name).toBe('relay-b');
    expect(store.getState().machine?.computer?.name).toBe('办公室 Mac');
  });

  it('ignores selecting the current or an unknown computer', async () => {
    const store = await storeWith([stored('a'), stored('b')], 'a');
    await store.select('a');
    await store.select('zzz');
    expect(mockChannels).toHaveLength(1);
    await store.select('b');
    expect(store.getState().machine?.computer?.id).toBe('b');
    expect(mockChannels).toHaveLength(2);
  });

  it('watches terminal status and keeps a local cache on a phone, slowing down in the background', async () => {
    const store = await storeWith([stored('a')]);
    const machine = store.getState().machine!;
    expect(machine.activity).toBeDefined();
    expect(machine.terminalRepository).toBeDefined();
    const activity = jest.spyOn(machine.activity!, 'setBackground');
    const workspaces = jest.spyOn(machine.workspaces, 'setBackground');
    store.sleep();
    expect(activity).toHaveBeenLastCalledWith(true);
    expect(workspaces).toHaveBeenLastCalledWith(true);
    store.wake();
    expect(activity).toHaveBeenLastCalledWith(false);
    expect(workspaces).toHaveBeenLastCalledWith(false);
  });

  it('a hidden desktop window keeps watching every terminal', async () => {
    const store = await storeWith([stored('a')]);
    const activity = jest.spyOn(store.getState().machine!.activity!, 'setBackground');
    const host = globalThis as { window?: { panecastDesktop?: unknown } };
    const hadWindow = 'window' in host;
    host.window ??= {};
    host.window.panecastDesktop = { version: 1 };
    try {
      store.sleep();
      expect(activity).not.toHaveBeenCalled();
    } finally {
      delete host.window!.panecastDesktop;
      if (!hadWindow) delete host.window;
    }
  });

  describe('in the demo', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => {
      jest.clearAllTimers();
      jest.useRealTimers();
    });

    it('selecting a computer leaves the demo for it', async () => {
      const store = await storeWith([stored('a'), stored('b')], 'a');
      store.enterDemo();
      expect(store.getState().machine?.mode).toBe('demo');
      await store.select('a');
      expect(store.getState().machine).toMatchObject({ mode: 'relay', computer: { id: 'a' } });
    });

    it('removing a computer keeps the demo running', async () => {
      const store = await storeWith([stored('a')]);
      store.enterDemo();
      const demo = store.getState().machine;
      await store.remove('a');
      expect(store.getState()).toMatchObject({ phase: 'ready', machine: demo });
      expect(store.getState().computers.computers).toEqual([]);
      store.exitDemo();
      expect(store.getState().phase).toBe('unpaired');
    });
  });
});

describe('account computers', () => {
  const account = { user: { id: 'account-1', username: 'alice' }, token: 'account-token', expires_at: '2099-01-01T00:00:00Z' };
  const remote = { relay_id: 'mac-1', device_id: 'account-device', name: 'Home Mac', online: true, paired_at: '2026-11-09T00:00:00Z' };
  let request: jest.SpyInstance;
  beforeEach(() => {
    request = jest.spyOn(accountApi, 'accountRequest').mockImplementation(async (_server, route) => {
      if (route === 'login') return account as never;
      if (route === 'computers') return { computers: [remote] } as never;
      return undefined as never;
    });
  });
  afterEach(() => request.mockRestore());

  it('loads the same remote computers after login and removes account access on logout', async () => {
    const store = await storeWith([stored('manual')]);
    await store.login(SERVER, 'alice', 'long password', false);
    const computer = store.getState().computers.computers.find((c) => c.accountId);
    expect(computer).toMatchObject({ accountId: 'account-1', name: 'Home Mac', online: true, broker: { token: 'account-token' } });
    await store.select(computer!.id);
    const active = lastChannel();
    await store.logout();
    expect(active.stopped).toBe(true);
    expect(store.getState().account).toBeNull();
    expect(store.getState().computers.computers.map((c) => c.id)).toEqual(['manual']);
    expect(mockStore.has('panecast.account.v1')).toBe(false);
    expect((await loadComputers()).computers.some((c) => c.accountId)).toBe(false);
  });

  it('keeps a local computer identity when migrating its existing pairing into the account', async () => {
    const store = await storeWith([stored('existing-id', 'mac-1')]);
    await store.login(SERVER, 'alice', 'long password', false);
    expect(store.getState().computers.computers).toHaveLength(1);
    expect(store.getState().computers.computers[0]).toMatchObject({ id: 'existing-id', accountId: 'account-1' });
  });

  it('ignores a device-list response that arrives after logout', async () => {
    const store = await storeWith([]);
    await store.login(SERVER, 'alice', 'long password', false);
    let resolve!: (value: unknown) => void;
    request.mockImplementation(async (_server, route) => {
      if (route === 'computers') return new Promise((done) => { resolve = done; });
      return undefined;
    });
    const refresh = store.refreshAccount();
    await store.logout();
    resolve({ computers: [remote] });
    await refresh;
    expect(store.getState().account).toBeNull();
    expect(store.getState().computers.computers).toEqual([]);
    expect((await loadComputers()).computers).toEqual([]);
  });

  it('an expired account removes its credentials and stops the active connection', async () => {
    const store = await storeWith([]);
    await store.login(SERVER, 'alice', 'long password', false);
    const active = lastChannel();
    request.mockRejectedValue(new accountApi.AccountError(401, 'account_unauthorized'));
    await expect(store.refreshAccount()).rejects.toThrow('登录已失效');
    expect(store.getState().account).toBeNull();
    expect(active.stopped).toBe(true);
    expect((await loadComputers()).computers).toEqual([]);
    // The next screen says why, until dismissed or the user signs in again.
    expect(store.getState().signedOut).toContain('alice');
    store.dismissSignedOut();
    expect(store.getState().signedOut).toBeNull();
  });

  it('signing in again clears the expired-session notice', async () => {
    const store = await storeWith([]);
    await store.login(SERVER, 'alice', 'long password', false);
    request.mockRejectedValueOnce(new accountApi.AccountError(401, 'account_unauthorized'));
    await expect(store.refreshAccount()).rejects.toThrow();
    expect(store.getState().signedOut).toBeTruthy();
    await store.login(SERVER, 'alice', 'long password', false);
    expect(store.getState().signedOut).toBeNull();
  });

  it('a logout the user asked for shows no notice', async () => {
    const store = await storeWith([]);
    await store.login(SERVER, 'alice', 'long password', false);
    await store.logout();
    expect(store.getState().signedOut ?? null).toBeNull();
  });
});

describe('AppStore on the desktop', () => {
  const host = globalThis as unknown as { window?: Record<string, unknown> };
  const keepAwake = jest.fn(async (_active: boolean) => {});
  let hadWindow = false;
  beforeEach(() => {
    jest.useFakeTimers();
    hadWindow = 'window' in host;
    host.window ??= {};
    host.window.panecastDesktop = {
      version: 1, keepAwake,
      getSecret: async (key: string) => mockStore.get(key) ?? null,
      setSecret: async (key: string, value: string) => { mockStore.set(key, value); },
      deleteSecret: async (key: string) => { mockStore.delete(key); },
    };
    keepAwake.mockClear();
  });
  afterEach(() => {
    delete host.window!.panecastDesktop;
    if (!hadWindow) delete host.window;
    jest.clearAllTimers();
    jest.useRealTimers();
  });
  const watched = (store: AppStore) => store.watchedInboxes().map((watch) => watch.computer.id);
  const channelFor = (id: string) => mockChannels.filter((channel) => channel.computer.id === id).at(-1)!;

  it('keeps an inbox-only connection to every other paired computer and hands it over on selection', async () => {
    const store = await storeWith([stored('a'), stored('b'), stored('c')], 'a');
    expect(store.getState().machine?.computer?.id).toBe('a');
    expect(watched(store)).toEqual(['b', 'c']);
    const b = channelFor('b');
    expect(b.started).toBe(true);
    await store.select('b');
    // The selected computer's own channel replaces its watch: one live inbox per computer.
    expect(b.stopped).toBe(true);
    expect(store.getState().machine?.channel).not.toBe(b);
    expect(watched(store).sort()).toEqual(['a', 'c']);
  });

  it('reads a watched computer\'s recent terminals at the hidden pace and stops when it is selected', async () => {
    const store = await storeWith([stored('a'), stored('b')], 'a');
    const [watch] = store.watchedInboxes();
    expect((watch.activity as unknown as { hidden: boolean }).hidden).toBe(true);
    const dispose = jest.spyOn(watch.activity, 'dispose');
    await store.select('b');
    expect(dispose).toHaveBeenCalled();
  });

  it('leaves shared windows out, and stops watching a removed computer', async () => {
    const shared = { ...stored('s'), share: { name: '共享' } };
    const store = await storeWith([stored('a'), stored('b'), shared], 'a');
    expect(watched(store)).toEqual(['b']);
    const b = channelFor('b');
    await store.remove('b');
    expect(b.stopped).toBe(true);
    expect(watched(store)).toEqual([]);
  });

  it('reconnects the current computer on request and wakes every watched one', async () => {
    const store = await storeWith([stored('a'), stored('b')], 'a');
    const current = channelFor('a'), other = channelFor('b');
    store.reconnect();
    expect(current.reconnected).toBe(1);
    expect(other.woken).toBe(1);
    store.wake('focus');
    expect(current.woken).toBe(1);
    expect(other.woken).toBe(2);
  });

  it('holds the App Nap guard only while a computer is paired', async () => {
    const store = await storeWith([stored('a')], 'a');
    expect(keepAwake).toHaveBeenLastCalledWith(true);
    const calls = keepAwake.mock.calls.length;
    await store.rename('a', '书房');
    expect(keepAwake).toHaveBeenCalledTimes(calls);
    await store.remove('a');
    expect(keepAwake).toHaveBeenLastCalledWith(false);
  });

  it('slows terminal polling while the window is hidden, also for a computer selected meanwhile', async () => {
    const store = await storeWith([stored('a'), stored('b')], 'a');
    const hidden = jest.spyOn(store.getState().machine!.activity!, 'setHidden');
    store.setWindowHidden(true);
    expect(hidden).toHaveBeenLastCalledWith(true);
    await store.select('b');
    const next = store.getState().machine!.activity! as unknown as { hidden: boolean };
    expect(next.hidden).toBe(true);
    store.setWindowHidden(false);
    expect(next.hidden).toBe(false);
  });
});
