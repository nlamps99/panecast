import { classifyClose, RelayConnection, RpcCallError, type ConnectionStatus, type SocketLike } from '../connection';
import type { PushFrame } from '../frames';

class FakeSocket implements SocketLike {
  readyState = 0;
  onopen: SocketLike['onopen'] = null;
  onmessage: SocketLike['onmessage'] = null;
  onerror: SocketLike['onerror'] = null;
  onclose: SocketLike['onclose'] = null;
  sent: string[] = [];
  closed: { code?: number; reason?: string } | null = null;

  constructor(
    readonly url: string,
    readonly protocols: string[],
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
  // Test drivers
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  receive(value: unknown) {
    this.onmessage?.({ data: typeof value === 'string' ? value : JSON.stringify(value) });
  }
  serverClose(code: number, reason = '') {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
  json(index: number) {
    return JSON.parse(this.sent[index]);
  }
}

function setup(overrides: Partial<ConstructorParameters<typeof RelayConnection>[0]> = {}) {
  const sockets: FakeSocket[] = [];
  const statuses: ConnectionStatus[] = [];
  const connection = new RelayConnection({
    url: 'wss://example.com/v1/ws?relay_id=r',
    token: 'secret-token',
    deviceId: 'device-1',
    appVersion: '0.1.0',
    createSocket: (url, protocols, headers) => {
      const socket = new FakeSocket(url, protocols, headers);
      sockets.push(socket);
      return socket;
    },
    ...overrides,
  });
  connection.onStatus((status) => statuses.push(status));
  const latest = () => sockets[sockets.length - 1];
  return { connection, sockets, statuses, latest };
}

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

describe('RelayConnection', () => {
  it('authenticates the upgrade and sends the hello as the first frame on open', () => {
    const { connection, latest } = setup();
    connection.start();
    const socket = latest();
    expect(socket.url).toBe('wss://example.com/v1/ws?relay_id=r');
    expect(socket.protocols).toEqual(['cmuxremote.v1']);
    expect(socket.headers).toEqual({ Authorization: 'Bearer secret-token' });
    expect(connection.status.state).toBe('connecting');

    socket.open();
    expect(socket.sent).toHaveLength(1);
    expect(socket.json(0)).toEqual({ deviceId: 'device-1', appVersion: '0.1.0', protocolVersion: 1 });
    expect(connection.status.state).toBe('open');
  });

  it('matches responses to requests by id, in any order', async () => {
    const { connection, latest } = setup();
    connection.start();
    latest().open();
    const first = connection.call('workspace.list');
    const second = connection.call('surface.list', { workspace_id: 'w' });
    const [, a, b] = [0, 1, 2].map((i) => latest().json(i));
    expect(a).toEqual({ id: a.id, method: 'workspace.list', params: {} });
    expect(b).toEqual({ id: b.id, method: 'surface.list', params: { workspace_id: 'w' } });
    expect(a.id).not.toBe(b.id);

    latest().receive({ id: b.id, ok: true, result: 'second' });
    latest().receive({ id: a.id, result: 'first' });
    await expect(first).resolves.toBe('first');
    await expect(second).resolves.toBe('second');
  });

  it('rejects with the relay error', async () => {
    const { connection, latest } = setup();
    connection.start();
    latest().open();
    const call = connection.call('surface.subscribe', {});
    latest().receive({ id: latest().json(1).id, ok: false, error: { code: 'invalid_params', message: 'missing ids' } });
    await expect(call).rejects.toMatchObject({ code: 'invalid_params', message: 'missing ids' });
  });

  it('rejects calls while not connected and on timeout', async () => {
    const { connection, latest } = setup({ rpcTimeoutMs: 1_000 });
    await expect(connection.call('x')).rejects.toMatchObject({ code: 'not_connected' });
    connection.start();
    latest().open();
    const call = connection.call('slow');
    jest.advanceTimersByTime(1_000);
    await expect(call).rejects.toMatchObject({ code: 'timeout' });
  });

  it('fails pending calls on close and reconnects with backoff', async () => {
    const { connection, sockets, latest } = setup({ backoffBaseMs: 1_000 });
    connection.start();
    latest().open();
    const call = connection.call('surface.list');
    latest().serverClose(1006, 'Software caused connection abort');
    await expect(call).rejects.toMatchObject({ code: 'closed' });
    expect(connection.status).toMatchObject({ state: 'waiting', attempt: 1, reason: 'network' });

    jest.advanceTimersByTime(999);
    expect(sockets).toHaveLength(1);
    jest.advanceTimersByTime(1);
    expect(sockets).toHaveLength(2);

    // A connection that never opens doubles the delay.
    latest().serverClose(1006, 'timed out');
    jest.advanceTimersByTime(1_999);
    expect(sockets).toHaveLength(2);
    jest.advanceTimersByTime(1);
    expect(sockets).toHaveLength(3);
  });

  it('resets the backoff after a connection that stayed up', () => {
    const { connection, latest } = setup({ backoffBaseMs: 1_000, stableAfterMs: 5_000 });
    connection.start();
    latest().serverClose(1006);
    jest.advanceTimersByTime(1_000);
    latest().serverClose(1006);
    expect(connection.status).toMatchObject({ attempt: 2 });
    jest.advanceTimersByTime(2_000);
    latest().open();
    jest.advanceTimersByTime(6_000);
    latest().serverClose(1006);
    expect(connection.status).toMatchObject({ state: 'waiting', attempt: 1 });
  });

  it('stops for good when the token is rejected', () => {
    const { connection, sockets, latest } = setup();
    connection.start();
    latest().serverClose(1006, "Expected HTTP 101 response but was '401 Unauthorized'");
    expect(connection.status).toEqual({ state: 'auth_failed' });
    jest.advanceTimersByTime(120_000);
    expect(sockets).toHaveLength(1);
  });

  it('stops immediately when an already connected device is revoked', () => {
    const { connection, sockets, latest } = setup();
    connection.start(); latest().open();
    latest().serverClose(4003, '');
    expect(connection.status).toEqual({ state: 'auth_failed' });
    jest.advanceTimersByTime(120_000);
    expect(sockets).toHaveLength(1);
  });

  it('keeps retrying while the Mac relay is offline', () => {
    const { connection, sockets, latest } = setup();
    connection.start();
    latest().serverClose(1006, 'Received bad response code from server: 503.');
    expect(connection.status).toMatchObject({ state: 'waiting', reason: 'relay_offline' });
    jest.advanceTimersByTime(1_000);
    expect(sockets).toHaveLength(2);
    latest().open();
    latest().serverClose(1013, 'Mac relay offline');
    expect(connection.status).toMatchObject({ state: 'waiting', reason: 'relay_offline' });
  });

  it('delivers push frames and answers pings', () => {
    const { connection, latest } = setup();
    const frames: PushFrame[] = [];
    connection.onPush((frame) => frames.push(frame));
    connection.start();
    latest().open();
    latest().receive({ type: 'screen.checksum', surface_id: 's', rev: 1, hash: 'h' });
    latest().receive({ type: 'ping', ts: 7 });
    latest().receive('garbage');
    expect(frames).toEqual([{ type: 'screen.checksum', surfaceId: 's', rev: 1, hash: 'h' }]);
    expect(latest().json(1)).toEqual({ type: 'pong', ts: 7 });
  });

  it('probes an idle connection and reconnects if the probe goes unanswered', async () => {
    const { connection, sockets, latest } = setup({ idleProbeMs: 20_000, probeTimeoutMs: 5_000 });
    connection.start();
    latest().open();
    jest.advanceTimersByTime(20_000);
    const probe = latest().json(1);
    expect(probe.method).toBe('host.battery');

    await jest.advanceTimersByTimeAsync(5_000);
    expect(sockets[0].closed).not.toBeNull();
    expect(connection.status.state).toBe('waiting');
    jest.advanceTimersByTime(1_000);
    expect(sockets).toHaveLength(2);
  });

  it('treats any traffic as proof of life', () => {
    const { connection, latest } = setup({ idleProbeMs: 20_000 });
    connection.start();
    latest().open();
    for (let i = 0; i < 10; i++) {
      jest.advanceTimersByTime(5_000);
      latest().receive({ type: 'screen.checksum', surface_id: 's', rev: 1, hash: 'h' });
    }
    expect(latest().sent).toHaveLength(1);
  });

  it('wake() skips the remaining backoff', () => {
    const { connection, sockets, latest } = setup({ backoffBaseMs: 10_000 });
    connection.start();
    latest().serverClose(1006);
    connection.wake();
    expect(sockets).toHaveLength(2);
  });

  it('stop() closes the socket and does not reconnect', async () => {
    const { connection, sockets, latest } = setup();
    connection.start();
    latest().open();
    const call = connection.call('x');
    connection.stop();
    await expect(call).rejects.toBeInstanceOf(RpcCallError);
    expect(sockets[0].closed).toEqual({ code: 1000, reason: 'client stopped' });
    expect(connection.status).toEqual({ state: 'idle' });
    jest.advanceTimersByTime(60_000);
    expect(sockets).toHaveLength(1);
  });
});

describe('classifyClose', () => {
  it.each([
    [false, 1006, "Expected HTTP 101 response but was '401 Unauthorized'", 'auth_failed'],
    [false, 1006, 'Received bad response code from server: 403.', 'auth_failed'],
    [false, 1006, 'Received bad response code from server: 404.', 'auth_failed'],
    [false, 1006, "Expected HTTP 101 response but was '503 Service Unavailable'", 'relay_offline'],
    [false, 1006, 'failed to connect to /192.168.1.5 (port 4399)', 'network'],
    [false, 1006, 'The Internet connection appears to be offline.', 'network'],
    [true, 1013, 'Mac relay offline', 'relay_offline'],
    [true, 4003, '', 'auth_failed'],
    [true, 1000, 'closed by relay', 'closed_by_server'],
    [true, 1006, '', 'network'],
  ] as const)('opened=%s code=%s %s', (opened, code, reason, expected) => {
    expect(classifyClose(opened, code, reason)).toBe(expected);
  });
});
