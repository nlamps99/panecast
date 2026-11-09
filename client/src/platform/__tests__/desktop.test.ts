import { DesktopSocket, serviceFetch, type DesktopBridge } from '../desktop';

function bridge() {
  const listeners = new Set<Parameters<DesktopBridge['onSocket']>[0]>();
  const api: DesktopBridge = {
    version: 1, getSecret: jest.fn(), setSecret: jest.fn(), deleteSecret: jest.fn(), request: jest.fn(), abortRequest: jest.fn(),
    connectSocket: jest.fn().mockResolvedValue(undefined), sendSocket: jest.fn(), closeSocket: jest.fn(), dialog: jest.fn(),
    onSocket: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
  return { api, listeners, emit: (event: Parameters<DesktopBridge['onSocket']>[0] extends (event: infer E) => void ? E : never) => { for (const listener of listeners) listener(event); } };
}

test('desktop sockets preserve hello ordering, send input and report rejected credentials', async () => {
  const fx = bridge();
  const socket = new DesktopSocket(fx.api, 'wss://example.com/v1/ws', ['cmuxremote.v1'], { Authorization: 'Bearer secret' });
  const id = (fx.api.connectSocket as jest.Mock).mock.calls[0][0];
  socket.onopen = () => socket.send('hello');
  const closed = jest.fn(); socket.onclose = closed;
  fx.emit({ id, type: 'open' });
  expect(fx.api.sendSocket).toHaveBeenCalledWith(id, 'hello');
  socket.send('input');
  expect(fx.api.sendSocket).toHaveBeenLastCalledWith(id, 'input');
  fx.emit({ id, type: 'close', code: 1006, reason: 'HTTP 401' });
  expect(closed).toHaveBeenCalledWith({ code: 1006, reason: 'HTTP 401' });
  expect(fx.listeners.size).toBe(0);
});

test('a socket closed during native creation never opens or leaks listeners', async () => {
  const fx = bridge(); let complete!: () => void;
  (fx.api.connectSocket as jest.Mock).mockImplementation(() => new Promise<void>((resolve) => { complete = resolve; }));
  const socket = new DesktopSocket(fx.api, 'wss://example.com/v1/ws', ['cmuxremote.v1'], { Authorization: 'Bearer secret' });
  const id = (fx.api.connectSocket as jest.Mock).mock.calls[0][0];
  const opened = jest.fn(); socket.onopen = opened;
  socket.close(); complete(); await Promise.resolve();
  fx.emit({ id, type: 'open' });
  expect(opened).not.toHaveBeenCalled();
  expect(fx.api.closeSocket).toHaveBeenCalledWith(id);
  expect(fx.listeners.size).toBe(0);
});

test('HTTP forwards authorization to the native transport and accepts an empty logout response', async () => {
  const fx = bridge();
  const old = globalThis.window;
  Object.defineProperty(globalThis, 'window', { value: { panecastDesktop: fx.api }, writable: true, configurable: true });
  (fx.api.request as jest.Mock).mockResolvedValue({ status: 204, body: '' });
  try {
    const result = await serviceFetch('https://example.com/v1/account/logout', { method: 'POST', headers: { Authorization: 'Bearer secret' } });
    expect(result.status).toBe(204);
    expect(fx.api.request).toHaveBeenCalledWith(expect.any(String), 'https://example.com/v1/account/logout', { method: 'POST', authorization: 'Bearer secret', body: undefined });
  } finally { Object.defineProperty(globalThis, 'window', { value: old, writable: true, configurable: true }); }
});
