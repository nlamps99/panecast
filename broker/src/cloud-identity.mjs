import { readFileSync } from 'node:fs';

const fail = (statusCode, message) => { throw Object.assign(new Error(message), { statusCode }); };

/**
 * Accounts shared with cmux cloud, the self-hosted Stack Auth project behind
 * cmux DR2. One username and password signs in to both. Usernames map to a
 * fixed address (`lesley` → `lesley@<emailDomain>`) that never receives mail,
 * so people only ever type the username. The broker keeps no passwords for
 * these accounts: sign-in, registration, password changes and deletion all go
 * to the account service, using the server key only for administration.
 */
export class CloudIdentity {
  constructor({ origin, projectId, publishableKey, serverKey, emailDomain, fetch: request = fetch, timeoutMs = 15_000 }) {
    const url = new URL(origin);
    if (url.protocol !== 'https:' && !['127.0.0.1', 'localhost'].includes(url.hostname)) throw new Error('CMUX_ACCOUNT_ORIGIN must use HTTPS');
    if (!projectId || !publishableKey || !serverKey) throw new Error('Shared accounts need the project ID, publishable key and server key');
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(emailDomain ?? '')) throw new Error('CMUX_ACCOUNT_EMAIL_DOMAIN must be a domain name');
    Object.assign(this, { origin: url.href.replace(/\/$/, ''), projectId, publishableKey, serverKey, emailDomain, request, timeoutMs });
  }

  /** Reads CMUX_ACCOUNT_* settings; returns null when shared accounts are not configured. */
  static fromEnvironment(environment, options = {}) {
    if (!environment.CMUX_ACCOUNT_ORIGIN) return null;
    const serverKey = environment.CMUX_ACCOUNT_SERVER_KEY_FILE
      ? readFileSync(environment.CMUX_ACCOUNT_SERVER_KEY_FILE, 'utf8').trim()
      : environment.CMUX_ACCOUNT_SERVER_KEY;
    return new CloudIdentity({
      origin: environment.CMUX_ACCOUNT_ORIGIN,
      projectId: environment.CMUX_ACCOUNT_PROJECT_ID,
      publishableKey: environment.CMUX_ACCOUNT_PUBLISHABLE_KEY,
      serverKey,
      emailDomain: environment.CMUX_ACCOUNT_EMAIL_DOMAIN,
      ...options,
    });
  }

  email(username) { return `${username}@${this.emailDomain}`; }

  async call(method, path, { body, server = false, accessToken } = {}) {
    const headers = { 'content-type': 'application/json', 'x-stack-project-id': this.projectId,
      ...(server
        ? { 'x-stack-access-type': 'server', 'x-stack-secret-server-key': this.serverKey }
        : { 'x-stack-access-type': 'client', 'x-stack-publishable-client-key': this.publishableKey }),
      ...(accessToken ? { 'x-stack-access-token': accessToken } : {}) };
    let response;
    try {
      response = await this.request(`${this.origin}${path}`, { method, headers, signal: AbortSignal.timeout(this.timeoutMs),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    } catch { fail(503, 'account_service_unavailable'); }
    const data = await response.json().catch(() => ({}));
    if (response.status >= 500) fail(503, 'account_service_unavailable');
    return { status: response.status, data };
  }

  /** Returns the account ID when the username and password are right, otherwise null. */
  async verify(username, password) {
    const { status, data } = await this.call('POST', '/api/v1/auth/password/sign-in', { body: { email: this.email(username), password } });
    if (status !== 200 || typeof data.user_id !== 'string') return null;
    // The check opened a session in the account service; close it again.
    if (typeof data.access_token === 'string') {
      await this.call('DELETE', '/api/v1/auth/sessions/current', { accessToken: data.access_token }).catch(() => {});
    }
    return data.user_id;
  }

  /** Creates the shared account; fails with username_taken when the name exists. */
  async create(username, password) {
    const { status, data } = await this.call('POST', '/api/v1/users', { server: true, body: {
      primary_email: this.email(username), primary_email_verified: true, primary_email_auth_enabled: true,
      password, display_name: username } });
    if (status === 409 || /ALREADY_EXISTS/.test(String(data.code ?? ''))) fail(409, 'username_taken');
    if (status >= 400 || typeof data.id !== 'string') fail(400, data.code === 'PASSWORD_TOO_SHORT' ? 'password_length' : 'account_rejected');
    return data.id;
  }

  async setPassword(id, password) {
    const { status } = await this.call('PATCH', `/api/v1/users/${encodeURIComponent(id)}`, { server: true, body: { password } });
    if (status >= 400) fail(400, 'account_rejected');
  }

  async remove(id) {
    const { status } = await this.call('DELETE', `/api/v1/users/${encodeURIComponent(id)}`, { server: true });
    if (status >= 400 && status !== 404) fail(400, 'account_rejected');
  }
}
