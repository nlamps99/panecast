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

/** The relay's default `listen` port; `cmux-relay pair` always writes it into the `lan` URL. */
export const DEFAULT_RELAY_PORT = 4399;

export type LanEndpointError = 'invalid_url' | 'not_private_host';

/**
 * Builds the direct endpoint for a pairing payload's `lan` URL, which is only
 * usable when it names a private-LAN host: the relay accepts LAN pairing only
 * from RFC1918 / link-local callers, and the path is plain HTTP. Adds the
 * relay's default port when the URL has none, as the Android client does.
 */
export function lanEndpoint(
  lanUrl: string,
): { ok: true; endpoint: RelayEndpoint } | { ok: false; error: LanEndpointError } {
  const parsed = splitBaseUrl(lanUrl);
  if (!parsed) return { ok: false, error: 'invalid_url' };
  if (!isPrivateLanHost(parsed.host)) return { ok: false, error: 'not_private_host' };
  let port = DEFAULT_RELAY_PORT;
  if (parsed.portText.length > 0) {
    if (!/^:\d{1,5}$/.test(parsed.portText)) return { ok: false, error: 'invalid_url' };
    port = Number(parsed.portText.slice(1));
    if (port < 1 || port > 65_535) return { ok: false, error: 'invalid_url' };
  }
  return {
    ok: true,
    endpoint: { kind: 'direct', baseUrl: `${parsed.scheme}://${parsed.host.toLowerCase()}:${port}${parsed.path}` },
  };
}

/**
 * True for hosts reached over the local network: RFC1918, IPv4 link-local
 * (169.254/16) and Bonjour `.local` names. Ports `EndpointPolicy.isPrivateLANHost`
 * (iOS) and `RelayEndpoint.isPrivateLanHost` (Android). Tailscale's
 * 100.64/10, loopback, public addresses and IPv6 are excluded, matching the
 * relay's `PrivateAddress.isPrivateLAN`.
 */
export function isPrivateLanHost(host: string): boolean {
  const trimmed = host.trim().toLowerCase();
  if (trimmed.length === 0) return false;
  if (trimmed.endsWith('.local')) return trimmed.length > '.local'.length;
  const octets = ipv4Octets(trimmed);
  if (!octets) return false;
  switch (octets[0]) {
    case 10:
      return true;
    case 172:
      return octets[1] >= 16 && octets[1] <= 31;
    case 192:
      return octets[1] === 168;
    case 169:
      return octets[1] === 254;
    default:
      return false;
  }
}

/** A bare dotted quad; leading zeros are rejected so `010.0.0.1` cannot be read as octal elsewhere. */
function ipv4Octets(value: string): number[] | null {
  const parts = value.split('.');
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part) || (part.length > 1 && part.startsWith('0'))) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    octets.push(octet);
  }
  return octets;
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
function splitBaseUrl(
  raw: string,
): { scheme: 'http' | 'https'; host: string; portText: string; path: string; base: string } | null {
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
  // Whatever follows the host in the authority, e.g. `:4399`; empty when there is no port.
  const portText = authority.slice(host.length);
  const path = rawPath.replace(/\/+$/, '');
  return { scheme, host, portText, path, base: `${scheme}://${authority.toLowerCase()}${path}` };
}
