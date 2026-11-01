/**
 * Where the phone reaches the relay. Mirrors `RelayEndpoint` in
 * `legacy/android/.../net/Endpoint.kt`.
 *
 * - broker: the self-hosted VPS broker, which multiplexes phones onto the Mac
 *   relay's outbound tunnel. Needs `relay_id` on every request.
 * - direct: the Mac relay itself on a private LAN address (or a tailnet host).
 */
export type RelayEndpoint =
  | { kind: 'broker'; baseUrl: string; relayId: string }
  | { kind: 'direct'; baseUrl: string };

export type EndpointError = 'invalid_url' | 'insecure_url' | 'missing_relay_id';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/**
 * Builds a broker endpoint from the `server` field of a pairing payload.
 * Requires HTTPS except for loopback hosts, as the native clients do.
 */
export function brokerEndpoint(
  serverUrl: string,
  relayId: string,
): { ok: true; endpoint: RelayEndpoint } | { ok: false; error: EndpointError } {
  const trimmedRelay = relayId.trim();
  if (trimmedRelay.length === 0) return { ok: false, error: 'missing_relay_id' };
  const parsed = splitBaseUrl(serverUrl);
  if (!parsed) return { ok: false, error: 'invalid_url' };
  const secure = parsed.scheme === 'https';
  if (!secure && !LOOPBACK_HOSTS.has(parsed.host.toLowerCase())) {
    return { ok: false, error: 'insecure_url' };
  }
  return { ok: true, endpoint: { kind: 'broker', baseUrl: parsed.base, relayId: trimmedRelay } };
}

/** Builds a direct endpoint from a pairing payload's `lan` URL. */
export function directEndpoint(
  lanUrl: string,
): { ok: true; endpoint: RelayEndpoint } | { ok: false; error: EndpointError } {
  const parsed = splitBaseUrl(lanUrl);
  if (!parsed) return { ok: false, error: 'invalid_url' };
  return { ok: true, endpoint: { kind: 'direct', baseUrl: parsed.base } };
}

export function registerUrl(endpoint: RelayEndpoint): string {
  return `${endpoint.baseUrl}/v1/devices/me/register`;
}

export function healthUrl(endpoint: RelayEndpoint): string {
  return `${endpoint.baseUrl}/v1/health`;
}

export function webSocketUrl(endpoint: RelayEndpoint): string {
  const wsBase = endpoint.baseUrl.replace(/^http/, 'ws');
  if (endpoint.kind === 'broker') {
    return `${wsBase}/v1/ws?relay_id=${encodeURIComponent(endpoint.relayId)}`;
  }
  return `${wsBase}/v1/ws`;
}

/**
 * Normalizes `http(s)://` and `ws(s)://` URLs to an `http(s)://host[:port][/path]`
 * base without a trailing slash. Query strings and fragments are rejected: the
 * endpoint paths are appended to the base.
 */
function splitBaseUrl(raw: string): { scheme: 'http' | 'https'; host: string; base: string } | null {
  const match = /^(https?|wss?):\/\/([^/?#\s]+)(\/[^?#\s]*)?$/i.exec(raw.trim());
  if (!match) return null;
  const [, rawScheme, authority, rawPath = ''] = match;
  if (authority.includes('@')) return null;
  const lower = rawScheme.toLowerCase();
  const scheme = lower === 'https' || lower === 'wss' ? 'https' : 'http';
  const host = authority.startsWith('[')
    ? authority.slice(0, authority.indexOf(']') + 1)
    : authority.split(':')[0];
  if (host.length === 0) return null;
  const path = rawPath.replace(/\/+$/, '');
  return { scheme, host, base: `${scheme}://${authority.toLowerCase()}${path}` };
}
