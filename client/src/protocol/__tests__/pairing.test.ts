import { parsePairingUrl } from '../pairing';

describe('parsePairingUrl', () => {
  it('parses a broker-only payload', () => {
    const result = parsePairingUrl('cmux://pair?server=https://example.com/cmux-remote&relay=mac-1&code=abc123');
    expect(result).toEqual({
      ok: true,
      payload: { serverUrl: 'https://example.com/cmux-remote', relayId: 'mac-1', pairingCode: 'abc123' },
    });
  });

  it('decodes percent-encoded values the way Swift URLComponents writes them', () => {
    // URLComponents encodes ":" "/" in query values only partially and never uses "+" for spaces.
    const result = parsePairingUrl(
      'cmux://pair?server=https://example.com/a%20b&relay=r%2F1&code=a+b%26c%3D',
    );
    expect(result.ok && result.payload).toEqual({
      serverUrl: 'https://example.com/a b',
      relayId: 'r/1',
      pairingCode: 'a+b&c=',
    });
  });

  it('keeps LAN fields only when both are present', () => {
    const both = parsePairingUrl(
      'cmux://pair?server=https://s&relay=r&code=c&lan=http://192.168.1.5:4399&lancode=l',
    );
    expect(both.ok && both.payload.lanUrl).toBe('http://192.168.1.5:4399');
    expect(both.ok && both.payload.lanPairingCode).toBe('l');

    const urlOnly = parsePairingUrl('cmux://pair?server=https://s&relay=r&code=c&lan=http://192.168.1.5:4399');
    expect(urlOnly.ok && urlOnly.payload).toEqual({ serverUrl: 'https://s', relayId: 'r', pairingCode: 'c' });

    const codeOnly = parsePairingUrl('cmux://pair?server=https://s&relay=r&code=c&lancode=l');
    expect(codeOnly.ok && codeOnly.payload.lanPairingCode).toBeUndefined();
  });

  it('accepts case variations, surrounding whitespace and a trailing slash', () => {
    const result = parsePairingUrl('  CMUX://Pair/?server=https://s&relay=r&code=c\n');
    expect(result.ok).toBe(true);
  });

  it('reports the first missing field', () => {
    expect(parsePairingUrl('cmux://pair?relay=r&code=c')).toEqual({
      ok: false,
      error: { kind: 'missing_field', field: 'server' },
    });
    expect(parsePairingUrl('cmux://pair?server=https://s&code=c')).toEqual({
      ok: false,
      error: { kind: 'missing_field', field: 'relay' },
    });
    expect(parsePairingUrl('cmux://pair?server=https://s&relay=r&code=')).toEqual({
      ok: false,
      error: { kind: 'missing_field', field: 'code' },
    });
  });

  it('rejects other schemes, hosts and malformed URLs', () => {
    for (const raw of [
      'https://pair?server=https://s&relay=r&code=c',
      'cmux://other?server=https://s&relay=r&code=c',
      'cmux://pair/extra?server=https://s&relay=r&code=c',
      'cmux://pair?server=%E0%A4%A&relay=r&code=c',
      'hello world',
      '',
    ]) {
      expect(parsePairingUrl(raw)).toEqual({ ok: false, error: { kind: 'not_a_pairing_url' } });
    }
  });

  it('uses the first value of a repeated key', () => {
    const result = parsePairingUrl('cmux://pair?server=https://s&relay=r&code=first&code=second');
    expect(result.ok && result.payload.pairingCode).toBe('first');
  });
});
