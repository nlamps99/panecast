/**
 * The `cmux://pair?...` payload carried by the relay's pairing QR code.
 * Mirrors `relay/Sources/SharedKit/PairingPayload.swift`.
 *
 * The payload contains pairing codes in the clear, so the QR code itself is a
 * secret. Never log a parsed payload.
 */
export type PairingPayload = {
  serverUrl: string;
  relayId: string;
  pairingCode: string;
  /** Present only together with `lanPairingCode`. */
  lanUrl?: string;
  lanPairingCode?: string;
};

export type PairingParseError =
  | { kind: 'not_a_pairing_url' }
  | { kind: 'missing_field'; field: 'server' | 'relay' | 'code' };

export type PairingParseResult =
  | { ok: true; payload: PairingPayload }
  | { ok: false; error: PairingParseError };

const SCHEME = 'cmux';
const HOST = 'pair';

/**
 * Parses a scanned pairing URL.
 *
 * Swift's `URLComponents` writes the query with percent-encoding and does not
 * treat `+` as a space, so neither do we: `URLSearchParams` would turn a `+` in
 * a pairing code into a space and the relay would reject it.
 */
export function parsePairingUrl(raw: string): PairingParseResult {
  const match = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)\/?(?:\?([^#]*))?(?:#.*)?$/i.exec(raw.trim());
  if (!match) return notAPairingUrl();
  const [, scheme, host, query = ''] = match;
  if (scheme.toLowerCase() !== SCHEME || host.toLowerCase() !== HOST) return notAPairingUrl();

  const params = parseQuery(query);
  if (!params) return notAPairingUrl();

  const serverUrl = params.get('server');
  if (!serverUrl) return missing('server');
  const relayId = params.get('relay');
  if (!relayId) return missing('relay');
  const pairingCode = params.get('code');
  if (!pairingCode) return missing('code');

  const payload: PairingPayload = { serverUrl, relayId, pairingCode };
  // Both LAN fields or neither: half of them cannot pair, and keeping it would
  // surface later as a confusing pairing failure.
  const lanUrl = params.get('lan');
  const lanPairingCode = params.get('lancode');
  if (lanUrl && lanPairingCode) {
    payload.lanUrl = lanUrl;
    payload.lanPairingCode = lanPairingCode;
  }
  return { ok: true, payload };
}

/** First value wins for repeated keys; empty values count as absent. */
function parseQuery(query: string): Map<string, string> | null {
  const params = new Map<string, string>();
  if (query.length === 0) return params;
  for (const part of query.split('&')) {
    if (part.length === 0) continue;
    const eq = part.indexOf('=');
    const rawKey = eq === -1 ? part : part.slice(0, eq);
    const rawValue = eq === -1 ? '' : part.slice(eq + 1);
    let key: string;
    let value: string;
    try {
      key = decodeURIComponent(rawKey);
      value = decodeURIComponent(rawValue);
    } catch {
      return null;
    }
    if (value.length > 0 && !params.has(key)) params.set(key, value);
  }
  return params;
}

function notAPairingUrl(): PairingParseResult {
  return { ok: false, error: { kind: 'not_a_pairing_url' } };
}

function missing(field: 'server' | 'relay' | 'code'): PairingParseResult {
  return { ok: false, error: { kind: 'missing_field', field } };
}
