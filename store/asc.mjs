import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { createPrivateKey, sign } from 'node:crypto';

// Credentials stay outside the repository. Never log keys or signed tokens.
export const profile = JSON.parse(readFileSync(process.env.ASC_PROFILE_PATH ?? `${homedir()}/.appstoreconnect/profiles/panecast.json`, 'utf8'));
const key = createPrivateKey(readFileSync(profile.privateKeyPath));
const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');

export async function api(path, { method = 'GET', body, query } = {}) {
  const url = new URL(path, 'https://api.appstoreconnect.apple.com');
  if (url.origin !== 'https://api.appstoreconnect.apple.com') throw new Error('Unexpected API origin');
  if (query) for (const [name, value] of Object.entries(query)) url.searchParams.set(name, String(value));
  const now = Math.floor(Date.now() / 1000);
  const payload = { iat: now - 10, exp: now + 300, aud: 'appstoreconnect-v1', ...(profile.type === 'individual' ? { sub: 'user' } : { iss: profile.issuerId }) };
  const unsigned = `${encode({ alg: 'ES256', kid: profile.keyId, typ: 'JWT' })}.${encode(payload)}`;
  const signature = sign('sha256', Buffer.from(unsigned), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  const response = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${unsigned}.${signature}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60_000),
    redirect: 'error',
  });
  const text = await response.text();
  const result = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(`${method} ${url.pathname}: HTTP ${response.status} ${JSON.stringify(result?.errors ?? result)}`);
  return { status: response.status, ...result };
}

export async function list(path, query) {
  let page = await api(path, { query });
  const data = [...page.data];
  while (page.links?.next) { page = await api(page.links.next); data.push(...page.data); }
  return data;
}

export function patch(type, id, attributes, relationships) {
  return api(`/v1/${type}/${id}`, { method: 'PATCH', body: { data: { type, id, ...(attributes ? { attributes } : {}), ...(relationships ? { relationships } : {}) } } });
}
