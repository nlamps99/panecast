import { brokerEndpoint, directEndpoint, healthUrl, registerUrl, webSocketUrl } from '../endpoint';

function broker(server: string, relay = 'mac-1') {
  const result = brokerEndpoint(server, relay);
  if (!result.ok) throw new Error(result.error);
  return result.endpoint;
}

describe('broker endpoint', () => {
  it('builds the register, health and WebSocket URLs under a path prefix', () => {
    const endpoint = broker('https://Example.com/cmux-remote/');
    expect(registerUrl(endpoint)).toBe('https://example.com/cmux-remote/v1/devices/me/register');
    expect(healthUrl(endpoint)).toBe('https://example.com/cmux-remote/v1/health');
    expect(webSocketUrl(endpoint)).toBe('wss://example.com/cmux-remote/v1/ws?relay_id=mac-1');
  });

  it('accepts wss:// server URLs and encodes the relay id', () => {
    const endpoint = broker('wss://example.com', ' my relay ');
    expect(registerUrl(endpoint)).toBe('https://example.com/v1/devices/me/register');
    expect(webSocketUrl(endpoint)).toBe('wss://example.com/v1/ws?relay_id=my%20relay');
  });

  it('requires HTTPS except on loopback', () => {
    expect(brokerEndpoint('http://example.com', 'r')).toEqual({ ok: false, error: 'insecure_url' });
    expect(brokerEndpoint('http://localhost:4398', 'r').ok).toBe(true);
    expect(brokerEndpoint('http://127.0.0.1:4398', 'r').ok).toBe(true);
    const local = broker('http://127.0.0.1:4398');
    expect(webSocketUrl(local)).toBe('ws://127.0.0.1:4398/v1/ws?relay_id=mac-1');
  });

  it('rejects bad input', () => {
    expect(brokerEndpoint('https://example.com', '  ')).toEqual({ ok: false, error: 'missing_relay_id' });
    expect(brokerEndpoint('ftp://example.com', 'r')).toEqual({ ok: false, error: 'invalid_url' });
    expect(brokerEndpoint('https://example.com/?x=1', 'r')).toEqual({ ok: false, error: 'invalid_url' });
    expect(brokerEndpoint('https://user@example.com', 'r')).toEqual({ ok: false, error: 'invalid_url' });
    expect(brokerEndpoint('not a url', 'r')).toEqual({ ok: false, error: 'invalid_url' });
  });
});

describe('direct endpoint', () => {
  it('uses ws:// for a LAN relay', () => {
    const result = directEndpoint('http://192.168.1.5:4399');
    expect(result.ok && webSocketUrl(result.endpoint)).toBe('ws://192.168.1.5:4399/v1/ws');
    expect(result.ok && registerUrl(result.endpoint)).toBe('http://192.168.1.5:4399/v1/devices/me/register');
  });
});
