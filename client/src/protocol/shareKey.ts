/**
 * A shared-window key, made by `panecast share` on the computer that shares
 * the window: `pcs1.` and base64url JSON with the broker, the relay and the
 * guest's own credential. The key is a secret; never log a parsed key.
 */
export type ShareKey = { serverUrl: string; relayId: string; deviceId: string; token: string; name: string };

const PREFIX = 'pcs1.';

export function isShareKey(raw: string): boolean {
  return raw.trim().startsWith(PREFIX);
}

export function parseShareKey(raw: string): ShareKey | null {
  const value = raw.trim();
  if (!value.startsWith(PREFIX)) return null;
  const body = value.slice(PREFIX.length);
  if (!/^[A-Za-z0-9_-]+$/.test(body)) return null;
  try {
    const key = JSON.parse(utf8(atob(body.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (body.length % 4)) % 4)))) as Record<string, unknown>;
    const fields = [key.s, key.r, key.d, key.t];
    if (key.v !== 1 || !fields.every((field) => typeof field === 'string' && field.length > 0)) return null;
    return { serverUrl: key.s as string, relayId: key.r as string, deviceId: key.d as string, token: key.t as string, name: typeof key.n === 'string' ? key.n.slice(0, 100) : '' };
  } catch {
    return null;
  }
}

/** Decodes the binary string `atob` returns as UTF-8, without TextDecoder. */
function utf8(binary: string): string {
  return decodeURIComponent(Array.from(binary, (c) => `%${c.charCodeAt(0).toString(16).padStart(2, '0')}`).join(''));
}
