import { registerUrl, type RelayEndpoint } from './endpoint';

/** Bearer token and device id issued by `POST /v1/devices/me/register`. */
export type DeviceCredentials = { deviceId: string; token: string };

export type RegisterError =
  | { kind: 'pairing_rejected' } // 403: wrong pairing code or relay id
  | { kind: 'rate_limited' } // 429: the broker allows 5 attempts per minute per IP
  | { kind: 'invalid_request'; status: number } // 400 / 413
  | { kind: 'http'; status: number }
  | { kind: 'bad_response' }
  | { kind: 'network'; message: string }
  | { kind: 'timeout' };

export class RegisterFailure extends Error {
  constructor(readonly error: RegisterError) {
    super(describeRegisterError(error));
    this.name = 'RegisterFailure';
  }
}

export type RegisterRequest = {
  endpoint: RelayEndpoint;
  pairingCode: string;
  /** Stable per install, so re-pairing replaces this phone's entry on the broker. */
  clientId: string;
  deviceName: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

/** The broker and relay reject fields longer than this. */
const MAX_FIELD_LENGTH = 256;

export async function registerDevice(request: RegisterRequest): Promise<DeviceCredentials> {
  const { endpoint, pairingCode, clientId } = request;
  const fetchImpl = request.fetchImpl ?? fetch;
  const deviceName = clampField(request.deviceName.trim() || 'Panecast');
  const body: Record<string, string> = {
    pairing_code: pairingCode,
    client_id: clampField(clientId),
    device_name: deviceName,
  };
  if (endpoint.kind === 'broker') body.relay_id = endpoint.relayId;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), request.timeoutMs ?? 15_000);
  let response: Response;
  try {
    response = await fetchImpl(registerUrl(endpoint), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted) throw new RegisterFailure({ kind: 'timeout' });
    throw new RegisterFailure({ kind: 'network', message: errorMessage(error) });
  } finally {
    clearTimeout(timer);
  }

  if (response.status !== 200) throw new RegisterFailure(statusError(response.status));

  let json: unknown;
  try {
    json = await response.json();
  } catch {
    throw new RegisterFailure({ kind: 'bad_response' });
  }
  if (
    typeof json !== 'object' ||
    json === null ||
    typeof (json as Record<string, unknown>).device_id !== 'string' ||
    typeof (json as Record<string, unknown>).token !== 'string'
  ) {
    throw new RegisterFailure({ kind: 'bad_response' });
  }
  const { device_id: deviceId, token } = json as { device_id: string; token: string };
  if (deviceId.length === 0 || token.length === 0) throw new RegisterFailure({ kind: 'bad_response' });
  return { deviceId, token };
}

function statusError(status: number): RegisterError {
  if (status === 403) return { kind: 'pairing_rejected' };
  if (status === 429) return { kind: 'rate_limited' };
  if (status === 400 || status === 413) return { kind: 'invalid_request', status };
  return { kind: 'http', status };
}

export function describeRegisterError(error: RegisterError): string {
  switch (error.kind) {
    case 'pairing_rejected':
      return '配对码不对，或者二维码已经过期。请在电脑上重新生成二维码。';
    case 'rate_limited':
      return '尝试次数太多，请一分钟后再试。';
    case 'invalid_request':
      return `服务器拒绝了这次配对请求（HTTP ${error.status}）。`;
    case 'http':
      return `服务器返回了错误（HTTP ${error.status}）。`;
    case 'bad_response':
      return '服务器返回的内容无法识别。';
    case 'network':
      return `连不上服务器：${error.message}`;
    case 'timeout':
      return '连接服务器超时。';
  }
}

function clampField(value: string): string {
  return value.length > MAX_FIELD_LENGTH ? value.slice(0, MAX_FIELD_LENGTH) : value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
