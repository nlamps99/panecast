import type { StoredComputer } from '../../state/computers';
import { apnsEnvironment, brokerTarget, isApnsToken, registerApnsToken, relayTarget } from '../registration';

const computer: StoredComputer = {
  id: 'c1',
  name: 'mac',
  broker: { serverUrl: 'https://example.com/cmux-remote/', relayId: 'home mac', deviceId: 'd1', token: 'broker-secret' },
  pairedAt: '2026-10-31T00:00:00.000Z',
};

function respond(status: number) {
  return jest.fn(async () => ({ status }) as Response);
}

describe('registration targets', () => {
  it('sends the broker its relay id, as the native client does', () => {
    expect(brokerTarget(computer)).toEqual({
      via: 'broker',
      url: 'https://example.com/cmux-remote/v1/devices/me/apns?relay_id=home%20mac',
      bearer: 'broker-secret',
    });
  });

  it('reaches the relay itself only with a LAN pairing', () => {
    expect(relayTarget(computer)).toBeNull();
    const lan = { ...computer, lan: { url: 'http://192.168.1.5:4399', deviceId: 'd2', token: 'lan-secret' } };
    expect(relayTarget(lan)).toEqual({ via: 'relay', url: 'http://192.168.1.5:4399/v1/devices/me/apns', bearer: 'lan-secret' });
  });
});

describe('registerApnsToken', () => {
  const target = { via: 'relay' as const, url: 'http://192.168.1.5:4399/v1/devices/me/apns', bearer: 'lan-secret' };

  it('posts the token and env with the bearer', async () => {
    const fetchImpl = respond(204);
    expect(await registerApnsToken(target, '00ff10', 'sandbox', { fetchImpl })).toEqual({ ok: true });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(target.url);
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ Authorization: 'Bearer lan-secret', 'Content-Type': 'application/json' });
    expect(JSON.parse(init.body as string)).toEqual({ apns_token: '00ff10', env: 'sandbox' });
  });

  it('classifies failures', async () => {
    expect(await registerApnsToken(target, 'aa', 'prod', { fetchImpl: respond(401) })).toEqual({ ok: false, reason: 'unauthorized' });
    expect(await registerApnsToken(target, 'aa', 'prod', { fetchImpl: respond(400) })).toEqual({ ok: false, reason: 'rejected' });
    expect(await registerApnsToken(target, 'aa', 'prod', { fetchImpl: respond(502) })).toEqual({ ok: false, reason: 'http', status: 502 });
    const offline = jest.fn(async () => {
      throw new TypeError('Network request failed');
    });
    expect(await registerApnsToken(target, 'aa', 'prod', { fetchImpl: offline })).toEqual({ ok: false, reason: 'network' });
  });

  it('times out', async () => {
    const hang = jest.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(new Error('aborted')))),
    );
    expect(await registerApnsToken(target, 'aa', 'prod', { fetchImpl: hang as unknown as typeof fetch, timeoutMs: 5 })).toEqual({
      ok: false,
      reason: 'timeout',
    });
  });
});

describe('helpers', () => {
  it('accepts hex APNs tokens only', () => {
    expect(isApnsToken('00ff10')).toBe(true);
    expect(isApnsToken('0ff')).toBe(false);
    expect(isApnsToken('zz')).toBe(false);
    expect(isApnsToken({})).toBe(false);
  });

  it('picks the APNs environment the way the native client does', () => {
    expect(apnsEnvironment(true)).toBe('sandbox');
    expect(apnsEnvironment(false)).toBe('prod');
  });
});
