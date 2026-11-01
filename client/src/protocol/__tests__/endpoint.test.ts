import {
  brokerEndpoint,
  directEndpoint,
  healthUrl,
  isPrivateLanHost,
  lanEndpoint,
  registerUrl,
  webSocketUrl,
} from '../endpoint';

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

describe('LAN endpoint', () => {
  function lan(url: string) {
    const result = lanEndpoint(url);
    if (!result.ok) throw new Error(result.error);
    return result.endpoint;
  }

  it('builds the relay URLs for a private LAN address', () => {
    const endpoint = lan('http://192.168.1.5:4399');
    expect(endpoint).toEqual({ kind: 'direct', baseUrl: 'http://192.168.1.5:4399' });
    expect(registerUrl(endpoint)).toBe('http://192.168.1.5:4399/v1/devices/me/register');
    expect(healthUrl(endpoint)).toBe('http://192.168.1.5:4399/v1/health');
    expect(webSocketUrl(endpoint)).toBe('ws://192.168.1.5:4399/v1/ws');
  });

  it('adds the default relay port and normalizes the host', () => {
    expect(lan('http://10.0.0.7').baseUrl).toBe('http://10.0.0.7:4399');
    expect(lan(' http://My-Mac.LOCAL/ ').baseUrl).toBe('http://my-mac.local:4399');
    expect(lan('http://172.20.1.1:8080').baseUrl).toBe('http://172.20.1.1:8080');
  });

  it('keeps https as wss', () => {
    expect(webSocketUrl(lan('https://192.168.1.5:4399'))).toBe('wss://192.168.1.5:4399/v1/ws');
  });

  it('rejects hosts that are not on the local network', () => {
    for (const url of [
      'http://8.8.8.8:4399',
      'http://100.101.102.103:4399', // Tailscale CGNAT
      'http://127.0.0.1:4399',
      'http://example.com:4399',
      'http://[fe80::1]:4399',
      'http://172.32.0.1:4399',
    ]) {
      expect(lanEndpoint(url)).toEqual({ ok: false, error: 'not_private_host' });
    }
  });

  it('rejects malformed URLs and ports', () => {
    for (const url of ['192.168.1.5:4399', 'http://192.168.1.5:abc', 'http://192.168.1.5:0', 'http://192.168.1.5:70000', 'http://192.168.1.5:4399?x=1']) {
      expect(lanEndpoint(url)).toEqual({ ok: false, error: 'invalid_url' });
    }
  });
});

describe('isPrivateLanHost', () => {
  it('accepts RFC1918, link-local and .local names', () => {
    for (const host of ['10.0.0.1', '10.255.255.255', '172.16.0.1', '172.31.255.1', '192.168.0.10', '169.254.3.4', 'mac.local', ' Mac.Local ']) {
      expect(isPrivateLanHost(host)).toBe(true);
    }
  });

  it('rejects everything else', () => {
    for (const host of [
      '',
      '.local',
      '172.15.0.1',
      '172.32.0.1',
      '192.169.0.1',
      '169.253.0.1',
      '100.64.0.1',
      '127.0.0.1',
      '8.8.8.8',
      '010.0.0.1',
      '10.0.0',
      '10.0.0.256',
      '10.0.0.1.5',
      'localhost',
      'example.com',
      '[::1]',
    ]) {
      expect(isPrivateLanHost(host)).toBe(false);
    }
  });
});
