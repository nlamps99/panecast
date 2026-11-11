import { serviceFetch } from '../platform/desktop';
import { brokerEndpoint } from '../protocol/endpoint';

export type AccountSession = { serverUrl: string; token: string; expires_at: string; user: { id: string; username: string } };
export type AccountComputer = { relay_id: string; name: string; online: boolean; device_id: string; paired_at: string };
const errors: Record<string, string> = {
  invalid_username: '用户名需为 3–64 位字母、数字、点、下划线或短横线，以字母或数字开头。',
  password_length: '密码需要 12–256 个字符。', username_taken: '这个用户名已被使用。', invalid_login: '用户名或密码不正确。',
  account_unauthorized: '登录已失效，请重新登录。', incorrect_password: '当前密码不正确。',
  too_many_account_attempts: '操作过于频繁，请一分钟后重试。', pairing_rejected: '配对凭据无效，请在目标电脑上重新生成配对链接。',
  not_found: '服务器尚未支持账号，请升级服务器。', computer_not_found: '这台电脑已解除绑定，请刷新列表。',
  account_service_unavailable: '账号服务暂时无法连接，请稍后再试。', account_rejected: '账号服务拒绝了这个请求，请检查用户名和密码后重试。',
};
export class AccountError extends Error { constructor(readonly status: number, code: string) { super(errors[code] ?? `请求失败（HTTP ${status}）`); } }
export function accountServer(raw: string): string {
  const endpoint = brokerEndpoint(raw.trim(), 'account');
  if (!endpoint.ok) throw new Error('请输入有效的 HTTPS 服务器地址。');
  return endpoint.endpoint.baseUrl;
}
export async function accountRequest<T>(serverUrl: string, route: string, method = 'GET', body?: unknown, token?: string): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await serviceFetch(`${accountServer(serverUrl)}/v1/account/${route}`, {
      method, signal: controller.signal, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (response.status === 204) return undefined as T;
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new AccountError(response.status, data.error ?? 'unknown');
    return data as T;
  } catch (error) {
    if (error instanceof AccountError) throw error;
    throw new Error(controller.signal.aborted ? '连接服务器超时。' : '无法连接服务器，请检查地址和网络。');
  } finally { clearTimeout(timeout); }
}
