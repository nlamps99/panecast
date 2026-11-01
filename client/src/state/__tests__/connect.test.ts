const mockStore = new Map<string, string>();
const mockNetwork = {
  type: 'WIFI' as string,
  listeners: new Set<(state: { type: string; isConnected: boolean }) => void>(),
  throwOnListen: false,
};

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

jest.mock('expo-constants', () => ({ __esModule: true, default: { expoConfig: { version: '9.9.9' } } }));

jest.mock('expo-device', () => ({ deviceName: 'Test iPhone', modelName: 'iPhone' }));

jest.mock('expo-network', () => ({
  getNetworkStateAsync: jest.fn(async () => ({ type: mockNetwork.type, isConnected: mockNetwork.type !== 'NONE' })),
  addNetworkStateListener: jest.fn((listener: (state: { type: string; isConnected: boolean }) => void) => {
    if (mockNetwork.throwOnListen) throw new Error('not available');
    mockNetwork.listeners.add(listener);
    return { remove: () => mockNetwork.listeners.delete(listener) };
  }),
}));

jest.mock('react-native', () => ({ Platform: { OS: 'ios' } }));

// Imported after the mocks.
/* eslint-disable import/first */
import type { SocketLike } from '../../protocol/connection';
import type { PairingPayload } from '../../protocol/pairing';
import type { StoredComputer } from '../computers';
import { createComputerChannel, expoNetworkWatcher, PairingError, probeHealth, registerComputer } from '../connect';
/* eslint-enable import/first */

const BROKER_REGISTER = 'https://broker.example/cmux-remote/v1/devices/me/register';
const LAN_REGISTER = 'http://192.168.1.5:4399/v1/devices/me/register';
const LAN_HEALTH = 'http://192.168.1.5:4399/v1/health';

const PAYLOAD: PairingPayload = {
  serverUrl: 'https://broker.example/cmux-remote',
  relayId: 'mac-1',
  pairingCode: 'broker-code',
  lanUrl: 'http://192.168.1.5:4399',
  lanPairingCode: 'lan-code',
};

type Call = { url: string; init?: RequestInit };
type Handler = (url: string, init?: RequestInit) => Promise<Response>;

let calls: Call[] = [];
let handler: Handler;

function json(status: number, body: unknown): Response {
  return { status, json: async () => body } as Response;
}

/** Broker and LAN both accept by default. */
function defaultHandler(url: string, _init?: RequestInit): Promise<Response> {
  if (url === BROKER_REGISTER) return Promise.resolve(json(200, { device_id: 'broker-dev', token: 'broker-tok' }));
  if (url === LAN_REGISTER) return Promise.resolve(json(200, { device_id: 'lan-dev', token: 'lan-tok' }));
  if (url === LAN_HEALTH) return Promise.resolve(json(200, { ok: true }));
  return Promise.reject(new TypeError(`unexpected ${url}`));
}

const lanCalls = () => calls.filter((c) => c.url === LAN_REGISTER);
const body = (call: Call) => JSON.parse(call.init?.body as string);

let logSpy: jest.SpyInstance;

beforeEach(() => {
  mockStore.clear();
  mockNetwork.type = 'WIFI';
  mockNetwork.listeners.clear();
  mockNetwork.throwOnListen = false;
  calls = [];
  handler = defaultHandler;
  global.fetch = jest.fn((url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return handler(url, init);
  }) as unknown as typeof fetch;
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  // Nothing secret reaches the dev log: no pairing codes, tokens or the LAN address.
  const logged = logSpy.mock.calls.flat().join('\n');
  for (const secret of ['broker-code', 'lan-code', 'broker-tok', 'lan-tok', '192.168.1.5']) {
    expect(logged).not.toContain(secret);
  }
  logSpy.mockRestore();
  jest.useRealTimers();
});

describe('registerComputer', () => {
  it('registers with the broker first, then with the LAN relay, and stores both', async () => {
    const computer = await registerComputer(PAYLOAD);
    expect(calls.map((c) => c.url)).toEqual([BROKER_REGISTER, LAN_REGISTER]);
    expect(body(calls[0])).toEqual({
      pairing_code: 'broker-code',
      client_id: 'uuid-1',
      device_name: 'Test iPhone',
      relay_id: 'mac-1',
    });
    // Same client id, LAN code, and no relay_id for the direct relay.
    expect(body(calls[1])).toEqual({ pairing_code: 'lan-code', client_id: 'uuid-1', device_name: 'Test iPhone' });
    expect(computer).toMatchObject({
      name: 'mac-1',
      broker: { serverUrl: 'https://broker.example/cmux-remote', relayId: 'mac-1', deviceId: 'broker-dev', token: 'broker-tok' },
      lan: { url: 'http://192.168.1.5:4399', deviceId: 'lan-dev', token: 'lan-tok' },
    });
  });

  it('stores the LAN URL with the default port', async () => {
    const computer = await registerComputer({ ...PAYLOAD, lanUrl: 'http://192.168.1.5' });
    expect(lanCalls()).toHaveLength(1);
    expect(computer.lan?.url).toBe('http://192.168.1.5:4399');
  });

  it('pairs broker-only when the QR has no LAN details', async () => {
    const { lanUrl: _url, lanPairingCode: _code, ...brokerOnly } = PAYLOAD;
    const computer = await registerComputer(brokerOnly);
    expect(calls).toHaveLength(1);
    expect('lan' in computer).toBe(false);
  });

  it('skips LAN when the address is not on a private network', async () => {
    for (const lanUrl of ['http://8.8.8.8:4399', 'http://100.100.1.1:4399', 'not a url']) {
      calls = [];
      const computer = await registerComputer({ ...PAYLOAD, lanUrl });
      expect(calls.map((c) => c.url)).toEqual([BROKER_REGISTER]);
      expect(computer.lan).toBeUndefined();
    }
  });

  it('skips LAN on cellular', async () => {
    mockNetwork.type = 'CELLULAR';
    const computer = await registerComputer(PAYLOAD);
    expect(lanCalls()).toHaveLength(0);
    expect(computer.lan).toBeUndefined();
  });

  it('fails pairing when the broker rejects it, without contacting LAN', async () => {
    handler = (url) => (url === BROKER_REGISTER ? Promise.resolve(json(403, {})) : defaultHandler(url));
    await expect(registerComputer(PAYLOAD)).rejects.toBeInstanceOf(PairingError);
    expect(lanCalls()).toHaveLength(0);
  });

  it('rejects an insecure broker URL', async () => {
    await expect(registerComputer({ ...PAYLOAD, serverUrl: 'http://broker.example' })).rejects.toThrow('https');
    expect(calls).toHaveLength(0);
  });

  it('still pairs when the LAN relay refuses, without retrying', async () => {
    handler = (url) => (url === LAN_REGISTER ? Promise.resolve(json(403, {})) : defaultHandler(url));
    const computer = await registerComputer(PAYLOAD);
    expect(computer.broker.token).toBe('broker-tok');
    expect(computer.lan).toBeUndefined();
    expect(lanCalls()).toHaveLength(1);
  });

  it('retries fast LAN failures, e.g. while iOS shows the local-network prompt', async () => {
    jest.useFakeTimers();
    let lanAttempts = 0;
    handler = (url, init) => {
      if (url === LAN_REGISTER && ++lanAttempts <= 2) return Promise.reject(new TypeError('Network request failed'));
      return defaultHandler(url, init);
    };
    const pairing = registerComputer(PAYLOAD);
    await jest.advanceTimersByTimeAsync(5_000);
    const computer = await pairing;
    expect(lanCalls()).toHaveLength(3);
    expect(computer.lan?.token).toBe('lan-tok');
  });

  it('gives up on LAN within the time budget when it keeps failing fast', async () => {
    jest.useFakeTimers();
    handler = (url, init) =>
      url === LAN_REGISTER ? Promise.reject(new TypeError('Network request failed')) : defaultHandler(url, init);
    const started = Date.now();
    const pairing = registerComputer(PAYLOAD);
    await jest.advanceTimersByTimeAsync(20_000);
    const computer = await pairing;
    expect(computer.lan).toBeUndefined();
    expect(lanCalls().length).toBeGreaterThan(1);
    expect(lanCalls().length).toBeLessThanOrEqual(5);
    expect(Date.now() - started).toBeLessThanOrEqual(20_000);
  });

  it('does not retry when nothing answers at the LAN address', async () => {
    jest.useFakeTimers();
    handler = (url, init) => {
      if (url !== LAN_REGISTER) return defaultHandler(url, init);
      // Hangs until registerDevice aborts it.
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    };
    const pairing = registerComputer(PAYLOAD);
    await jest.advanceTimersByTimeAsync(3_000);
    const computer = await pairing;
    expect(computer.lan).toBeUndefined();
    expect(lanCalls()).toHaveLength(1);
  });

  it('does not retry a slow network error', async () => {
    jest.useFakeTimers();
    handler = (url, init) =>
      url === LAN_REGISTER
        ? new Promise((_resolve, reject) => setTimeout(() => reject(new TypeError('Network request failed')), 2_000))
        : defaultHandler(url, init);
    const pairing = registerComputer(PAYLOAD);
    await jest.advanceTimersByTimeAsync(10_000);
    const computer = await pairing;
    expect(computer.lan).toBeUndefined();
    expect(lanCalls()).toHaveLength(1);
  });
});

describe('probeHealth', () => {
  const probe = (status: number, payload: unknown) => {
    handler = () => Promise.resolve(json(status, payload));
    return probeHealth(LAN_HEALTH, 1_500);
  };

  it('accepts only the relay health answer', async () => {
    expect(await probe(200, { ok: true })).toBe(true);
    expect(await probe(200, { ok: false })).toBe(false);
    expect(await probe(200, { status: 'ok' })).toBe(false);
    expect(await probe(200, null)).toBe(false);
    expect(await probe(404, { ok: true })).toBe(false);
    expect(await probe(503, {})).toBe(false);
  });

  it('sends a plain GET to the health path', async () => {
    await probe(200, { ok: true });
    expect(calls[0].url).toBe(LAN_HEALTH);
    expect(calls[0].init?.method).toBe('GET');
  });

  it('treats network errors, bad JSON and timeouts as unreachable', async () => {
    handler = () => Promise.reject(new TypeError('Network request failed'));
    expect(await probeHealth(LAN_HEALTH, 1_500)).toBe(false);

    handler = () =>
      Promise.resolve({
        status: 200,
        json: async () => {
          throw new SyntaxError('bad json');
        },
      } as unknown as Response);
    expect(await probeHealth(LAN_HEALTH, 1_500)).toBe(false);

    jest.useFakeTimers();
    handler = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    const pending = probeHealth(LAN_HEALTH, 1_500);
    await jest.advanceTimersByTimeAsync(1_500);
    expect(await pending).toBe(false);
  });
});

describe('createComputerChannel', () => {
  class FakeWebSocket implements SocketLike {
    static all: FakeWebSocket[] = [];
    readyState = 0;
    onopen: SocketLike['onopen'] = null;
    onmessage: SocketLike['onmessage'] = null;
    onerror: SocketLike['onerror'] = null;
    onclose: SocketLike['onclose'] = null;
    sent: string[] = [];
    constructor(
      readonly url: string,
      readonly protocols: string[],
      readonly options?: { headers: Record<string, string> },
    ) {
      FakeWebSocket.all.push(this);
    }
    send(data: string) {
      this.sent.push(data);
    }
    close() {
      this.readyState = 3;
    }
    open() {
      this.readyState = 1;
      this.onopen?.({});
    }
  }

  const realWebSocket = global.WebSocket;
  beforeEach(() => {
    FakeWebSocket.all = [];
    global.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
  });
  afterEach(() => {
    global.WebSocket = realWebSocket;
  });

  const COMPUTER: StoredComputer = {
    id: 'c1',
    name: 'mac-1',
    broker: { serverUrl: 'https://broker.example/cmux-remote', relayId: 'mac-1', deviceId: 'broker-dev', token: 'broker-tok' },
    lan: { url: 'http://192.168.1.5:4399', deviceId: 'lan-dev', token: 'lan-tok' },
    pairedAt: '2026-10-31T00:00:00.000Z',
  };

  async function flush() {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  }

  it('auto: connects to the LAN relay with the LAN token when it answers', async () => {
    const channel = createComputerChannel(COMPUTER, 'auto', () => {});
    if (!channel) throw new Error('no channel');
    channel.start();
    await flush();
    expect(calls.map((c) => c.url)).toEqual([LAN_HEALTH]);
    expect(FakeWebSocket.all).toHaveLength(1);
    const socket = FakeWebSocket.all[0];
    expect(socket.url).toBe('ws://192.168.1.5:4399/v1/ws');
    expect(socket.protocols).toEqual(['cmuxremote.v1']);
    expect(socket.options).toEqual({ headers: { Authorization: 'Bearer lan-tok' } });
    socket.open();
    expect(JSON.parse(socket.sent[0])).toEqual({ deviceId: 'lan-dev', appVersion: '9.9.9', protocolVersion: 1 });
    expect(channel.status.state).toBe('open');
    expect(channel.transport).toBe('lan');
    channel.stop();
    expect(mockNetwork.listeners.size).toBe(0);
  });

  it('auto: uses the broker when the LAN relay does not answer', async () => {
    handler = (url, init) => (url === LAN_HEALTH ? Promise.resolve(json(404, {})) : defaultHandler(url, init));
    const channel = createComputerChannel(COMPUTER, 'auto', () => {});
    channel?.start();
    await flush();
    expect(FakeWebSocket.all.map((s) => s.url)).toEqual(['wss://broker.example/cmux-remote/v1/ws?relay_id=mac-1']);
    expect(FakeWebSocket.all[0].options).toEqual({ headers: { Authorization: 'Bearer broker-tok' } });
    channel?.stop();
  });

  it('broker: never probes LAN', () => {
    const channel = createComputerChannel(COMPUTER, 'broker', () => {});
    channel?.start();
    expect(calls).toHaveLength(0);
    expect(FakeWebSocket.all.map((s) => s.url)).toEqual(['wss://broker.example/cmux-remote/v1/ws?relay_id=mac-1']);
    expect(channel?.transport).toBe('broker');
    channel?.stop();
  });

  it('lan: connects straight to the LAN relay', () => {
    const channel = createComputerChannel(COMPUTER, 'lan', () => {});
    channel?.start();
    expect(FakeWebSocket.all.map((s) => s.url)).toEqual(['ws://192.168.1.5:4399/v1/ws']);
    channel?.stop();
  });

  it('ignores an incomplete or non-private stored LAN entry', async () => {
    const broken = [
      { ...COMPUTER, lan: { url: 'http://8.8.8.8:4399', deviceId: 'd', token: 't' } },
      { ...COMPUTER, lan: { url: 'http://192.168.1.5:4399', deviceId: 'd', token: '' } },
      { ...COMPUTER, lan: { url: 'http://192.168.1.5:4399' } as unknown as StoredComputer['lan'] },
    ];
    for (const computer of broken) {
      FakeWebSocket.all = [];
      const channel = createComputerChannel(computer, 'lan', () => {});
      channel?.start();
      await flush();
      expect(FakeWebSocket.all.map((s) => s.url)).toEqual(['wss://broker.example/cmux-remote/v1/ws?relay_id=mac-1']);
      channel?.stop();
    }
    expect(calls).toHaveLength(0);
  });

  it('returns null for an unusable broker entry', () => {
    expect(createComputerChannel({ ...COMPUTER, broker: { ...COMPUTER.broker, serverUrl: 'http://x.example' } }, 'auto', () => {})).toBeNull();
  });

  it('tags connection logs with the path and keeps tokens out of them', async () => {
    const logs: string[] = [];
    const channel = createComputerChannel(COMPUTER, 'lan', (m) => logs.push(m));
    channel?.start();
    FakeWebSocket.all[0].onclose?.({ code: 1006, reason: 'gone' });
    channel?.stop();
    expect(logs.some((m) => m.startsWith('[lan] socket closed'))).toBe(true);
    expect(logs.join('\n')).not.toMatch(/tok/);
  });
});

describe('expoNetworkWatcher', () => {
  it('maps expo-network reports and unsubscribes', async () => {
    mockNetwork.type = 'CELLULAR';
    expect(await expoNetworkWatcher.current()).toBe('cellular');
    const seen: string[] = [];
    const stop = expoNetworkWatcher.watch((kind) => seen.push(kind));
    for (const listener of mockNetwork.listeners) listener({ type: 'WIFI', isConnected: true });
    stop();
    expect(mockNetwork.listeners.size).toBe(0);
    expect(seen).toEqual(['lan']);
  });

  it('degrades when the listener is not available', () => {
    mockNetwork.throwOnListen = true;
    const stop = expoNetworkWatcher.watch(() => {});
    expect(() => stop()).not.toThrow();
  });
});
