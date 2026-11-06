import { brokerEndpoint, directEndpoint } from '../protocol/endpoint';
import type { StoredComputer } from '../state/computers';
import type { NotificationPreferences } from './preferences';

/** The relay accepts these two values only (`Routes.registerApns`). */
export type ApnsEnvironment = 'sandbox' | 'prod';

/**
 * Where to send this phone's APNs token for one computer.
 *
 * - `relay`: the Mac relay's own `POST /v1/devices/me/apns`, with the token
 *   the relay issued at LAN pairing. The relay stores it in its DeviceStore,
 *   and `InboxPushFanout` pushes to registered devices there.
 * - `broker`: the broker's `POST /v1/devices/me/apns?relay_id=…`. The broker
 *   keeps only a hash and forwards registration over the authenticated relay
 *   tunnel. New relays confirm registration and report their APNs configuration.
 *   A legacy 204 acknowledgement still registers only with the broker.
 */
export type RegistrationTarget = { via: 'broker' | 'relay'; url: string; bearer: string };

export type RegistrationResult =
  | { ok: true; forwarded?: boolean; pushEnabled?: boolean; preferencesApplied?: boolean }
  | { ok: false; reason: 'unauthorized' | 'rejected' | 'network' | 'timeout' }
  | { ok: false; reason: 'http'; status: number };

export function brokerTarget(computer: StoredComputer): RegistrationTarget | null {
  const endpoint = brokerEndpoint(computer.broker.serverUrl, computer.broker.relayId);
  if (!endpoint.ok || endpoint.endpoint.kind !== 'broker') return null;
  const { baseUrl, relayId } = endpoint.endpoint;
  return {
    via: 'broker',
    url: `${baseUrl}/v1/devices/me/apns?relay_id=${encodeURIComponent(relayId)}`,
    bearer: computer.broker.token,
  };
}

/** Null unless the computer was also paired over the LAN (the relay issued its own token). */
export function relayTarget(computer: StoredComputer): RegistrationTarget | null {
  if (!computer.lan) return null;
  const endpoint = directEndpoint(computer.lan.url);
  if (!endpoint.ok) return null;
  return { via: 'relay', url: `${endpoint.endpoint.baseUrl}/v1/devices/me/apns`, bearer: computer.lan.token };
}

/** Hex, even length: what the relay accepts (`Routes.isAPNsToken`) and what expo-notifications returns on iOS. */
export function isApnsToken(token: unknown): token is string {
  return typeof token === 'string' && token.length > 0 && token.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(token);
}

/**
 * The native client's rule (`RemoteNotificationRegistrar.defaultEnvironment`):
 * debug builds are signed with the development APNs entitlement, release
 * builds with production. A release build installed straight from Xcode
 * (not archived) still has the development entitlement; this rule gets that
 * case wrong, as the native client does.
 */
export function apnsEnvironment(isDev: boolean): ApnsEnvironment {
  return isDev ? 'sandbox' : 'prod';
}

export async function registerApnsToken(
  target: RegistrationTarget,
  token: string,
  env: ApnsEnvironment,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number; preferences?: NotificationPreferences } = {},
): Promise<RegistrationResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000);
  let response: Response;
  try {
    response = await fetchImpl(target.url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${target.bearer}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ apns_token: token, env, ...(options.preferences ? { preferences: options.preferences } : {}) }),
      signal: controller.signal,
    });
  } catch {
    return { ok: false, reason: controller.signal.aborted ? 'timeout' : 'network' };
  } finally {
    clearTimeout(timer);
  }
  if (response.status >= 200 && response.status < 300) {
    if (response.status !== 204) {
      try {
        const body = await response.json();
        if (body.forwarded === true) return { ok: true, forwarded: true, pushEnabled: body.push_enabled === true, ...(body.preferences_applied === true ? { preferencesApplied: true } : {}) };
        if (body.preferences_applied === true) return { ok: true, preferencesApplied: true };
      } catch { /* Older brokers acknowledge without a body. */ }
    }
    return { ok: true };
  }
  if (response.status === 401 || response.status === 403) return { ok: false, reason: 'unauthorized' };
  if (response.status === 400) return { ok: false, reason: 'rejected' };
  return { ok: false, reason: 'http', status: response.status };
}

export function describeRegistrationFailure(result: Exclude<RegistrationResult, { ok: true }>, via: RegistrationTarget['via']): string {
  const peer = via === 'relay' ? '电脑' : '服务器';
  switch (result.reason) {
    case 'unauthorized':
      return '配对已失效，请重新扫码配对';
    case 'rejected':
      return `${peer}拒绝了推送令牌`;
    case 'network':
      return `连不上${peer}`;
    case 'timeout':
      return '连接超时';
    case 'http':
      if (via === 'broker' && result.status === 503) return '服务器暂时无法连接电脑，请确认电脑在线';
      if (via === 'broker' && result.status === 504) return '电脑没有回复推送登记，请确认 relay 在线并已升级';
      return `${peer}返回了错误（HTTP ${result.status}）`;
  }
}
