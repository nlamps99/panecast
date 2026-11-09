import { isIP } from 'node:net';
import { resolve, sep } from 'node:path';

export const APP_URL = 'panecast-app://desktop';
export function appFrame(url) {
  try { const parsed = new URL(url); return parsed.protocol === 'panecast-app:' && parsed.hostname === 'desktop'; }
  catch { return false; }
}
function privateHost(host) {
  if (['localhost', '127.0.0.1', '[::1]'].includes(host) || host.endsWith('.local')) return true;
  if (isIP(host) !== 4) return false;
  const [a, b] = host.split('.').map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}
/** The desktop bridge only speaks Panecast's protocol; it cannot read arbitrary files or follow redirects. */
export function serviceUrl(raw, socket = false) {
  const url = new URL(raw);
  const secure = socket ? 'wss:' : 'https:', plain = socket ? 'ws:' : 'http:';
  if (url.username || url.password || url.hash || (url.protocol !== secure && !(url.protocol === plain && privateHost(url.hostname)))) throw new Error('Invalid service address');
  const allowed = socket ? /\/v1\/ws$/ : /\/v1\/(health|devices\/me(?:\/register|\/apns(?:\/test)?)?|account\/(register|login|me|logout|password|computers))$/;
  if (!allowed.test(url.pathname)) throw new Error('Invalid service endpoint');
  return url.href;
}
export function storageKey(key) {
  if (!['panecast.computers.v2', 'panecast.pairing.v1', 'panecast.clientId', 'panecast.account.v1'].includes(key)) throw new Error('Invalid storage key');
  return key;
}
export function assetPath(root, raw) {
  const url = new URL(raw);
  if (!appFrame(raw)) throw new Error('Invalid app origin');
  const pathname = decodeURIComponent(url.pathname);
  if (pathname.includes('\0') || pathname.includes('\\')) throw new Error('Invalid asset path');
  const path = resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`);
  if (!path.startsWith(`${resolve(root)}${sep}`)) throw new Error('Invalid asset path');
  return path;
}
