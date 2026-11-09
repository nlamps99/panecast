import { secureStorage } from '../platform/secureStorage';
import { accountRequest, accountServer, type AccountSession } from './api';

const KEY = 'panecast.account.v1';
export async function loadAccount(): Promise<AccountSession | null> {
  const raw = await secureStorage.get(KEY);
  if (!raw) return null;
  const value = JSON.parse(raw) as AccountSession;
  if (!value.user?.id || !value.user.username || !value.token || !value.serverUrl || !value.expires_at) throw new Error('保存的登录信息无效，请重新登录。');
  return { ...value, serverUrl: accountServer(value.serverUrl) };
}
export async function saveAccount(account: AccountSession | null): Promise<void> {
  if (account) await secureStorage.set(KEY, JSON.stringify(account));
  else await secureStorage.remove(KEY);
}
export async function signIn(serverUrl: string, username: string, password: string, create: boolean): Promise<AccountSession> {
  serverUrl = accountServer(serverUrl);
  const result = await accountRequest<Omit<AccountSession, 'serverUrl'>>(serverUrl, create ? 'register' : 'login', 'POST', { username, password, device_name: 'Panecast' });
  if (!result.user?.id || !result.user.username || !result.token || !result.expires_at) throw new Error('服务器返回的登录信息无效。');
  return { ...result, serverUrl };
}
