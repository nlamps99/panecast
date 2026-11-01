import { brokerEndpoint, directEndpoint, type RelayEndpoint } from '../endpoint';
import { registerDevice, RegisterFailure } from '../register';

function endpointOf(result: ReturnType<typeof brokerEndpoint>): RelayEndpoint {
  if (!result.ok) throw new Error(result.error);
  return result.endpoint;
}

const broker = endpointOf(brokerEndpoint('https://example.com/cmux-remote', 'mac-1'));

function fakeFetch(status: number, body: unknown) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = jest.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return {
      status,
      json: async () => {
        if (body instanceof Error) throw body;
        return body;
      },
    } as Response;
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

async function failureOf(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (error instanceof RegisterFailure) return error.error;
    throw error;
  }
  throw new Error('expected a failure');
}

describe('registerDevice', () => {
  it('posts the broker body and returns the credentials', async () => {
    const { impl, calls } = fakeFetch(200, { device_id: 'dev-1', token: 'tok' });
    const credentials = await registerDevice({
      endpoint: broker,
      pairingCode: 'secret',
      clientId: 'client-1',
      deviceName: 'iPhone',
      fetchImpl: impl,
    });
    expect(credentials).toEqual({ deviceId: 'dev-1', token: 'tok' });
    expect(calls[0].url).toBe('https://example.com/cmux-remote/v1/devices/me/register');
    expect(calls[0].init.method).toBe('POST');
    expect(JSON.parse(calls[0].init.body as string)).toEqual({
      relay_id: 'mac-1',
      pairing_code: 'secret',
      client_id: 'client-1',
      device_name: 'iPhone',
    });
  });

  it('omits relay_id for a direct relay and falls back to a device name', async () => {
    const direct = directEndpoint('http://192.168.1.5:4399');
    if (!direct.ok) throw new Error('bad endpoint');
    const { impl, calls } = fakeFetch(200, { device_id: 'd', token: 't' });
    await registerDevice({ endpoint: direct.endpoint, pairingCode: 'p', clientId: 'c', deviceName: '  ', fetchImpl: impl });
    expect(JSON.parse(calls[0].init.body as string)).toEqual({
      pairing_code: 'p',
      client_id: 'c',
      device_name: 'Panecast',
    });
  });

  it('maps broker statuses to errors', async () => {
    const cases: [number, string][] = [
      [403, 'pairing_rejected'],
      [429, 'rate_limited'],
      [400, 'invalid_request'],
      [500, 'http'],
    ];
    for (const [status, kind] of cases) {
      const { impl } = fakeFetch(status, { error: 'x' });
      const error = await failureOf(
        registerDevice({ endpoint: broker, pairingCode: 'p', clientId: 'c', deviceName: 'n', fetchImpl: impl }),
      );
      expect(error.kind).toBe(kind);
    }
  });

  it('rejects malformed responses', async () => {
    for (const body of [{ device_id: 'd' }, { device_id: '', token: 't' }, new Error('not json'), null]) {
      const { impl } = fakeFetch(200, body);
      const error = await failureOf(
        registerDevice({ endpoint: broker, pairingCode: 'p', clientId: 'c', deviceName: 'n', fetchImpl: impl }),
      );
      expect(error.kind).toBe('bad_response');
    }
  });

  it('reports network errors and timeouts', async () => {
    const failing = (async () => {
      throw new TypeError('Network request failed');
    }) as unknown as typeof fetch;
    const network = await failureOf(
      registerDevice({ endpoint: broker, pairingCode: 'p', clientId: 'c', deviceName: 'n', fetchImpl: failing }),
    );
    expect(network).toEqual({ kind: 'network', message: 'Network request failed' });

    const hanging = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      })) as unknown as typeof fetch;
    const timeout = await failureOf(
      registerDevice({ endpoint: broker, pairingCode: 'p', clientId: 'c', deviceName: 'n', fetchImpl: hanging, timeoutMs: 10 }),
    );
    expect(timeout.kind).toBe('timeout');
  });
});
