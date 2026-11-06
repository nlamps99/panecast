import { NetworkStateType } from 'expo-network/build/Network.types';

import { RelayConnection, type ConnectionStatus, type SocketLike } from '../../protocol/connection';
import type { PushFrame } from '../../protocol/frames';
import { AutoChannel, networkKindOf, type ActiveTransport, type AutoChannelOptions, type NetworkKind } from '../autoChannel';

class FakeSocket implements SocketLike {
  readyState = 0;
  onopen: SocketLike['onopen'] = null;
  onmessage: SocketLike['onmessage'] = null;
  onerror: SocketLike['onerror'] = null;
  onclose: SocketLike['onclose'] = null;
  sent: string[] = [];
  closed: { code?: number; reason?: string } | null = null;

  constructor(
    readonly transport: ActiveTransport,
    readonly url: string,
    readonly headers: Record<string, string>,
  ) {}

  send(data: string) {
    if (this.readyState !== 1) throw new Error('not open');
    this.sent.push(data);
  }
  close(code?: number, reason?: string) {
    this.closed = { code, reason };
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  receive(value: unknown) {
    this.onmessage?.({ data: JSON.stringify(value) });
  }
  serverClose(code: number, reason = '') {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
}

const URLS: Record<ActiveTransport, string> = {
  broker: 'wss://broker.example/v1/ws?relay_id=mac-1',
  lan: 'ws://192.168.1.5:4399/v1/ws',
};

type Harness = ReturnType<typeof setup>;

function setup(overrides: Partial<AutoChannelOptions> & { kind?: NetworkKind; probe?: boolean } = {}) {
  const { kind: initialKind = 'lan', probe: initialProbe = true, ...options } = overrides;
  const sockets: FakeSocket[] = [];
  const watchers = new Set<(kind: NetworkKind) => void>();
  const probe = { answer: initialProbe, calls: 0 };
  const logs: string[] = [];
  let kind = initialKind;
  const channel = new AutoChannel({
    preference: 'auto',
    hasLan: true,
    connect: (transport) =>
      new RelayConnection({
        url: URLS[transport],
        token: `${transport}-token`,
        deviceId: `${transport}-device`,
        appVersion: '0.1.0',
        // Keep the idle liveness probe out of long fake-time spans.
        idleProbeMs: 24 * 3_600_000,
        createSocket: (url, _protocols, headers) => {
          const socket = new FakeSocket(transport, url, headers);
          sockets.push(socket);
          return socket;
        },
      }),
    probeLan: async () => {
      probe.calls++;
      return probe.answer;
    },
    network: {
      current: async () => kind,
      watch: (listener) => {
        watchers.add(listener);
        return () => watchers.delete(listener);
      },
    },
    log: (message) => logs.push(message),
    ...options,
  });
  /** `state@transport` at the moment each status arrived. */
  const events: string[] = [];
  channel.onStatus((status: ConnectionStatus) => events.push(`${status.state}@${channel.transport}`));
  const transports: ActiveTransport[] = [];
  channel.onTransport((transport) => transports.push(transport));
  const frames: PushFrame[] = [];
  channel.onPush((frame) => frames.push(frame));
  const of = (transport: ActiveTransport) => sockets.filter((s) => s.transport === transport);
  return {
    channel,
    sockets,
    events,
    transports,
    frames,
    probe,
    logs,
    watchers,
    of,
    latest: (transport: ActiveTransport) => {
      const list = of(transport);
      if (list.length === 0) throw new Error(`no ${transport} socket`);
      return list[list.length - 1];
    },
    /** The OS reports a network change. */
    report: (next: NetworkKind) => {
      kind = next;
      for (const listener of [...watchers]) listener(next);
    },
    /** The network changed while the app was suspended (no event delivered). */
    setQuietly: (next: NetworkKind) => {
      kind = next;
    },
  };
}

async function flush() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

async function advance(ms: number) {
  await jest.advanceTimersByTimeAsync(ms);
  await flush();
}

const event = (name: string) => ({ type: 'event', category: 'workspace', name, payload: null });

/** Starts under `auto` on Wi-Fi with the relay answering, and opens the LAN socket. */
async function onLan(h: Harness) {
  h.channel.start();
  await flush();
  const lan = h.latest('lan');
  lan.open();
  return lan;
}

/** Starts under `auto` with LAN not answering, and opens the broker socket. */
async function onBroker(h: Harness) {
  h.channel.start();
  await flush();
  const broker = h.latest('broker');
  broker.open();
  return broker;
}

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

describe('AutoChannel under auto: choosing a path', () => {
  it('uses the LAN relay when on Wi-Fi and it answers the health check', async () => {
    const h = setup();
    expect(h.channel.transport).toBe('broker');
    h.channel.start();
    expect(h.channel.status.state).toBe('connecting');
    await flush();
    expect(h.probe.calls).toBe(1);
    const lan = h.latest('lan');
    expect(lan.url).toBe(URLS.lan);
    expect(lan.headers).toEqual({ Authorization: 'Bearer lan-token' });
    expect(h.of('broker')).toHaveLength(0);

    lan.open();
    expect(JSON.parse(lan.sent[0])).toMatchObject({ deviceId: 'lan-device', protocolVersion: 1 });
    expect(h.channel.status.state).toBe('open');
    expect(h.channel.isOpen).toBe(true);
    expect(h.channel.transport).toBe('lan');
    expect(h.transports).toEqual(['lan']);
    // The transport is already LAN when consumers first see the channel open.
    expect(h.events.filter((e) => e.startsWith('open'))).toEqual(['open@lan']);
  });

  it('goes straight to the broker on cellular, without probing or retrying LAN', async () => {
    const h = setup({ kind: 'cellular' });
    const broker = await onBroker(h);
    expect(broker.url).toBe(URLS.broker);
    expect(broker.headers).toEqual({ Authorization: 'Bearer broker-token' });
    expect(h.channel.transport).toBe('broker');
    expect(h.channel.isOpen).toBe(true);
    await advance(10 * 60_000);
    expect(h.probe.calls).toBe(0);
    expect(h.of('lan')).toHaveLength(0);
  });

  it('probes on an unknown network type (iOS reports one while a VPN is up)', async () => {
    const h = setup({ kind: 'unknown' });
    await onLan(h);
    expect(h.probe.calls).toBe(1);
    expect(h.channel.transport).toBe('lan');
  });

  it('uses the broker when the LAN relay does not answer', async () => {
    const h = setup({ probe: false });
    await onBroker(h);
    expect(h.probe.calls).toBe(1);
    expect(h.of('lan')).toHaveLength(0);
    expect(h.channel.transport).toBe('broker');
    expect(h.channel.status.state).toBe('open');
  });

  it('never probes without LAN credentials', async () => {
    const h = setup({ hasLan: false });
    h.channel.start();
    expect(h.of('broker')).toHaveLength(1);
    h.latest('broker').open();
    await advance(10 * 60_000);
    h.report('cellular');
    h.report('lan');
    await advance(1_000);
    expect(h.probe.calls).toBe(0);
    expect(h.of('lan')).toHaveLength(0);
  });

  it('falls back to the broker when the LAN socket does not open in time', async () => {
    const h = setup();
    h.channel.start();
    await flush();
    const lan = h.latest('lan');
    await advance(4_999);
    expect(h.of('broker')).toHaveLength(0);
    await advance(1);
    expect(lan.closed).not.toBeNull();
    expect(h.channel.transport).toBe('broker');
    h.latest('broker').open();
    expect(h.channel.status.state).toBe('open');
  });

  it('falls back to the broker at once when the LAN socket is refused', async () => {
    const h = setup();
    h.channel.start();
    await flush();
    h.latest('lan').serverClose(1006, 'Connection refused');
    expect(h.channel.transport).toBe('broker');
    expect(h.of('broker')).toHaveLength(1);
    expect(h.events).not.toContain('waiting@lan');
  });

  it('rejects calls while no path is open', async () => {
    const h = setup();
    h.channel.start();
    await expect(h.channel.call('workspace.list')).rejects.toMatchObject({ code: 'not_connected' });
    await flush();
    await expect(h.channel.call('workspace.list')).rejects.toMatchObject({ code: 'not_connected' });
  });
});

describe('AutoChannel under auto: moving from the broker to LAN', () => {
  it('retries LAN in the background and switches only once the LAN socket is open', async () => {
    const h = setup({ probe: false });
    const broker = await onBroker(h);
    broker.receive(event('from-broker'));
    expect(h.frames).toHaveLength(1);

    h.probe.answer = true;
    await advance(15_000);
    expect(h.probe.calls).toBe(2);
    const lan = h.latest('lan');
    // In flight on the broker when the switch happens.
    const pending = h.channel.call('workspace.list');
    expect(JSON.parse(broker.sent[broker.sent.length - 1])).toMatchObject({ method: 'workspace.list' });
    // The broker keeps serving while LAN connects.
    expect(h.channel.status.state).toBe('open');
    expect(h.channel.transport).toBe('broker');
    expect(broker.closed).toBeNull();
    lan.receive(event('early-lan-frame')); // not open yet, so dropped by RelayConnection anyway

    const before = h.events.length;
    lan.open();
    expect(h.channel.transport).toBe('lan');
    expect(h.transports).toEqual(['lan']);
    expect(broker.closed).not.toBeNull();
    // Consumers see a reconnect: non-open, then open, on the new path.
    expect(h.events.slice(before)).toEqual(['connecting@lan', 'open@lan']);
    await expect(pending).rejects.toMatchObject({ code: 'closed' });

    // Push listeners keep working, now fed by LAN only.
    broker.receive(event('stale-broker'));
    lan.receive(event('from-lan'));
    expect(h.frames.map((f) => (f.type === 'event' ? f.name : f.type))).toEqual(['from-broker', 'from-lan']);

    // RPCs go to the LAN socket.
    void h.channel.call('workspace.list').catch(() => {});
    expect(JSON.parse(lan.sent[lan.sent.length - 1])).toMatchObject({ method: 'workspace.list' });
  });

  it('stays on the broker and backs off when the background LAN socket fails', async () => {
    const h = setup({ probe: false });
    const broker = await onBroker(h);
    h.probe.answer = true;
    await advance(15_000);
    const before = h.events.length;
    h.latest('lan').serverClose(1006);
    expect(h.channel.transport).toBe('broker');
    expect(h.channel.status.state).toBe('open');
    expect(h.events.length).toBe(before);
    expect(broker.closed).toBeNull();
    // Backoff doubled: the next try is 30 s later.
    await advance(29_999);
    expect(h.of('lan')).toHaveLength(1);
    await advance(1);
    expect(h.of('lan')).toHaveLength(2);
  });

  it('drops a background LAN socket that never opens', async () => {
    const h = setup({ probe: false });
    await onBroker(h);
    h.probe.answer = true;
    await advance(15_000);
    const lan = h.latest('lan');
    await advance(5_000);
    expect(lan.closed).not.toBeNull();
    expect(h.channel.transport).toBe('broker');
    expect(h.channel.status.state).toBe('open');
  });

  it('probes LAN at once when the broker connection fails', async () => {
    const h = setup({ probe: false });
    const broker = await onBroker(h);
    h.probe.answer = true;
    broker.serverClose(1006);
    expect(h.channel.status.state).toBe('waiting');
    await flush();
    expect(h.probe.calls).toBe(2);
    h.latest('lan').open();
    expect(h.channel.transport).toBe('lan');
    expect(h.channel.status.state).toBe('open');
  });

  it('joins LAN as soon as the phone gets on Wi-Fi', async () => {
    const h = setup({ kind: 'cellular' });
    await onBroker(h);
    h.report('lan');
    await advance(749);
    expect(h.probe.calls).toBe(0);
    await advance(1);
    expect(h.probe.calls).toBe(1);
    h.latest('lan').open();
    expect(h.channel.transport).toBe('lan');
  });

  it('re-decides on wake, e.g. after coming home with the app in the background', async () => {
    const h = setup({ kind: 'cellular' });
    await onBroker(h);
    h.setQuietly('lan');
    h.channel.wake();
    await flush();
    expect(h.probe.calls).toBe(1);
    h.latest('lan').open();
    expect(h.channel.transport).toBe('lan');
  });

  it('honors a cellular report after foreground wake silently discovered Wi-Fi', async () => {
    const h = setup({ kind: 'cellular' });
    await onBroker(h);
    h.setQuietly('lan'); h.channel.wake(); await flush();
    h.latest('lan').open();
    expect(h.channel.transport).toBe('lan');
    h.report('cellular'); await advance(750);
    expect(h.channel.transport).toBe('broker');
    expect(h.latest('lan').closed).not.toBeNull();
  });

  it('does not let an older wake read override a newer OS network report', async () => {
    let report!: (kind: NetworkKind) => void;
    let finishRead!: (kind: NetworkKind) => void;
    const current = jest.fn<Promise<NetworkKind>, []>()
      .mockResolvedValueOnce('lan')
      .mockImplementation(() => new Promise((resolve) => { finishRead = resolve; }));
    const h = setup({ network: { current, watch: (listener) => { report = listener; return () => {}; } } });
    await onLan(h);
    h.channel.wake();
    report('cellular'); await advance(750);
    expect(h.channel.transport).toBe('broker');
    finishRead('lan'); await flush();
    expect(h.channel.transport).toBe('broker');
    expect(h.of('lan')).toHaveLength(1);
  });
});

describe('AutoChannel under auto: when LAN fails', () => {
  it('reconnects on LAN after one drop if the relay still answers', async () => {
    const h = setup();
    await onLan(h);
    h.latest('lan').serverClose(1006);
    expect(h.channel.status.state).toBe('waiting');
    expect(h.channel.transport).toBe('lan');
    await flush();
    expect(h.probe.calls).toBe(2);
    // The answer skipped the reconnect backoff.
    expect(h.of('lan')).toHaveLength(2);
    expect(h.of('broker')).toHaveLength(0);
    h.latest('lan').open();
    expect(h.channel.status.state).toBe('open');
    expect(h.channel.transport).toBe('lan');
  });

  it('switches to the broker when the dropped LAN relay stops answering, then retries LAN', async () => {
    const h = setup();
    await onLan(h);
    h.probe.answer = false;
    h.latest('lan').serverClose(1006);
    await flush();
    expect(h.channel.transport).toBe('broker');
    expect(h.transports).toEqual(['lan', 'broker']);
    h.latest('broker').open();
    expect(h.channel.status.state).toBe('open');

    h.probe.answer = true;
    await advance(15_000);
    h.latest('lan').open();
    expect(h.channel.transport).toBe('lan');
  });

  it('switches to the broker on a second failure before LAN reopens', async () => {
    const h = setup();
    await onLan(h);
    h.latest('lan').serverClose(1006);
    await flush();
    expect(h.of('lan')).toHaveLength(2);
    h.latest('lan').serverClose(1006, 'Connection refused');
    expect(h.channel.transport).toBe('broker');
    expect(h.of('broker')).toHaveLength(1);
  });

  it('switches to the broker when the LAN reconnect hangs', async () => {
    const h = setup();
    await onLan(h);
    h.latest('lan').serverClose(1006);
    await flush();
    await advance(5_000);
    expect(h.channel.transport).toBe('broker');
  });

  it('stops using LAN for good once the relay rejects the LAN token', async () => {
    const h = setup();
    h.channel.start();
    await flush();
    h.latest('lan').serverClose(1006, 'Received bad response code from server: 401.');
    expect(h.channel.transport).toBe('broker');
    expect(h.events).not.toContain('auth_failed@lan');
    h.latest('broker').open();
    expect(h.channel.status.state).toBe('open');
    expect(h.logs.some((m) => m.includes('rejected'))).toBe(true);

    await advance(10 * 60_000);
    h.report('cellular');
    await advance(1_000);
    h.report('lan');
    await advance(1_000);
    h.channel.wake();
    await flush();
    expect(h.probe.calls).toBe(1);
    expect(h.of('lan')).toHaveLength(1);
  });

  it('stops trying LAN when a background LAN socket is rejected', async () => {
    const h = setup({ probe: false });
    await onBroker(h);
    h.probe.answer = true;
    await advance(15_000);
    h.latest('lan').serverClose(1006, "Expected HTTP 101 response but was '401 Unauthorized'");
    expect(h.channel.status.state).toBe('open');
    await advance(10 * 60_000);
    expect(h.of('lan')).toHaveLength(1);
  });

  it('switches to the broker when the phone leaves Wi-Fi', async () => {
    const h = setup();
    const lan = await onLan(h);
    h.report('cellular');
    await advance(750);
    expect(lan.closed).not.toBeNull();
    expect(h.channel.transport).toBe('broker');
    expect(h.of('broker')).toHaveLength(1);
    // No LAN retries while on cellular.
    await advance(10 * 60_000);
    expect(h.of('lan')).toHaveLength(1);
  });

  it('switches to the broker when LAN stops answering after a Wi-Fi change', async () => {
    const h = setup();
    await onLan(h);
    h.probe.answer = false;
    h.report('unknown');
    await advance(750);
    expect(h.channel.transport).toBe('broker');
  });

  it('keeps LAN across a network report when the relay still answers', async () => {
    const h = setup();
    const lan = await onLan(h);
    h.report('unknown');
    await advance(750);
    expect(h.probe.calls).toBe(2);
    expect(lan.closed).toBeNull();
    expect(h.channel.transport).toBe('lan');
  });
});

describe('AutoChannel with a fixed preference', () => {
  it('broker: never touches LAN', async () => {
    const h = setup({ preference: 'broker' });
    h.channel.start();
    const broker = h.latest('broker');
    broker.open();
    broker.serverClose(1006);
    await advance(10 * 60_000);
    h.report('cellular');
    await advance(1_000);
    h.report('lan');
    await advance(1_000);
    h.channel.wake();
    await flush();
    expect(h.probe.calls).toBe(0);
    expect(h.of('lan')).toHaveLength(0);
    expect(h.channel.transport).toBe('broker');
  });

  it('broker: a network change skips the reconnect backoff', async () => {
    const h = setup({ preference: 'broker' });
    h.channel.start();
    await flush();
    h.latest('broker').serverClose(1006); // backoff: retry in 1 s
    expect(h.of('broker')).toHaveLength(1);
    h.report('cellular');
    await advance(750);
    expect(h.of('broker')).toHaveLength(2);
  });

  it('lan: uses LAN only and reports its failures instead of falling back', async () => {
    const h = setup({ preference: 'lan', probe: false });
    expect(h.channel.transport).toBe('lan');
    h.channel.start();
    const lan = h.latest('lan');
    expect(lan.url).toBe(URLS.lan);
    lan.serverClose(1006);
    expect(h.channel.status.state).toBe('waiting');
    await advance(60_000);
    expect(h.of('broker')).toHaveLength(0);
    expect(h.of('lan').length).toBeGreaterThan(1);
    h.latest('lan').serverClose(1006, 'Received bad response code from server: 401.');
    expect(h.channel.status.state).toBe('auth_failed');
    expect(h.of('broker')).toHaveLength(0);
    expect(h.probe.calls).toBe(0);
  });

  it('lan: uses the broker when the computer has no LAN pairing', () => {
    const h = setup({ preference: 'lan', hasLan: false });
    expect(h.channel.transport).toBe('broker');
    h.channel.start();
    expect(h.of('broker')).toHaveLength(1);
    expect(h.of('lan')).toHaveLength(0);
  });
});

describe('AutoChannel network reports', () => {
  it('ignores repeats and acts once per burst', async () => {
    const h = setup();
    await onLan(h);
    expect(h.probe.calls).toBe(1);
    h.report('lan');
    h.report('lan');
    await advance(2_000);
    expect(h.probe.calls).toBe(1);

    h.report('cellular');
    await advance(300);
    h.report('lan');
    await advance(749);
    expect(h.probe.calls).toBe(1);
    await advance(1);
    expect(h.probe.calls).toBe(2);
    expect(h.channel.transport).toBe('lan');
    expect(h.of('broker')).toHaveLength(0);
  });

  it('waits out an offline report on LAN rather than switching', async () => {
    const h = setup();
    const lan = await onLan(h);
    h.report('none');
    await advance(750);
    expect(lan.closed).toBeNull();
    expect(h.channel.transport).toBe('lan');
  });
});

describe('AutoChannel lifecycle', () => {
  it('stop tears everything down, and late results from that run are ignored', async () => {
    let release: (answer: boolean) => void = () => {};
    const h = setup({ probeLan: () => new Promise<boolean>((resolve) => (release = resolve)) });
    h.channel.start();
    await flush();
    h.channel.stop();
    expect(h.channel.status.state).toBe('idle');
    expect(h.watchers.size).toBe(0);
    release(true);
    await flush();
    expect(h.sockets).toHaveLength(0);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('stop closes the active and background sockets and clears timers', async () => {
    const h = setup({ probe: false });
    const broker = await onBroker(h);
    h.probe.answer = true;
    await advance(15_000);
    const lan = h.latest('lan');
    h.channel.stop();
    expect(broker.closed).not.toBeNull();
    expect(lan.closed).not.toBeNull();
    expect(h.channel.isOpen).toBe(false);
    expect(jest.getTimerCount()).toBe(0);
    await expect(h.channel.call('x')).rejects.toMatchObject({ code: 'not_connected' });
  });

  it('can start again after stop', async () => {
    const h = setup();
    await onLan(h);
    h.channel.stop();
    h.channel.start();
    await flush();
    h.latest('lan').open();
    expect(h.channel.status.state).toBe('open');
    expect(h.of('lan')).toHaveLength(2);
  });

  it('keeps delivering frames when one push listener throws', async () => {
    const h = setup();
    h.channel.onPush(() => {
      throw new Error('boom');
    });
    const lan = await onLan(h);
    const later: PushFrame[] = [];
    h.channel.onPush((frame) => later.push(frame));
    lan.receive(event('one'));
    expect(h.frames).toHaveLength(1);
    expect(later).toHaveLength(1);
  });

  it('survives a probe or network read that rejects or hangs', async () => {
    const h = setup({
      probeLan: () => Promise.reject(new Error('fetch blew up')),
      network: { current: () => new Promise<NetworkKind>(() => {}), watch: () => () => {} },
    });
    h.channel.start();
    await advance(1_000); // network read gives up: treated as unknown
    expect(h.channel.transport).toBe('broker');
    expect(h.of('broker')).toHaveLength(1);
  });
});

describe('networkKindOf', () => {
  it('maps expo-network types', () => {
    const kind = (type: NetworkStateType, isConnected = true) => networkKindOf({ type, isConnected });
    expect(kind(NetworkStateType.WIFI)).toBe('lan');
    expect(kind(NetworkStateType.ETHERNET)).toBe('lan');
    expect(kind(NetworkStateType.CELLULAR)).toBe('cellular');
    expect(kind(NetworkStateType.BLUETOOTH)).toBe('cellular');
    expect(kind(NetworkStateType.WIMAX)).toBe('cellular');
    expect(kind(NetworkStateType.NONE, false)).toBe('none');
    expect(kind(NetworkStateType.UNKNOWN)).toBe('unknown');
    expect(kind(NetworkStateType.UNKNOWN, false)).toBe('unknown');
    expect(kind(NetworkStateType.VPN)).toBe('unknown');
    expect(kind(NetworkStateType.OTHER)).toBe('unknown');
    expect(networkKindOf({})).toBe('unknown');
  });
});
