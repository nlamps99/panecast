import { createHash, randomBytes, randomUUID, scrypt as deriveKey, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { promisify } from 'node:util';

const scrypt = promisify(deriveKey);
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const hash = (value) => createHash('sha256').update(value).digest('hex');
const fail = (statusCode, message) => { throw Object.assign(new Error(message), { statusCode }); };
const publicUser = ({ id, username }) => ({ id, username });
const deviceId = (session, relayId) => `account-${session.id}-${hash(relayId).slice(0, 16)}`;
const hashMatches = (value, expected) => typeof value === 'string' && value.length > 0 && value.length <= 4096 &&
  timingSafeEqual(Buffer.from(hash(value)), Buffer.from(expected));
// Removing an enrolled relay also removes every binding to it, including other accounts'.
function dropRelays(data, relayIds) {
  const removed = new Set(relayIds);
  data.relays = data.relays.filter((r) => !removed.has(r.relay_id));
  data.computers = data.computers.filter((c) => !removed.has(c.relay_id));
  return [...removed];
}

async function passwordHash(password, salt = randomBytes(16).toString('hex')) {
  const key = await scrypt(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return { salt, hash: key.toString('hex') };
}
async function passwordMatches(password, stored) {
  // Unknown usernames still pay the same password-derivation cost.
  const expected = stored ?? { salt: '0'.repeat(32), hash: '0'.repeat(128) };
  const actual = await passwordHash(password, expected.salt);
  return timingSafeEqual(Buffer.from(actual.hash, 'hex'), Buffer.from(expected.hash, 'hex'));
}
function validatePassword(password) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 256) fail(400, 'password_length');
}
const normalizeUsername = (username) => (typeof username === 'string' ? username.trim().toLowerCase() : '');
const validUsername = (username) => /^[a-z0-9][a-z0-9._-]{2,63}$/.test(username);

/**
 * Accounts, token hashes, relay grants and enrolled relays. Never stores pairing codes, relay tokens or raw login tokens.
 *
 * With `cloud` (a CloudIdentity), accounts are shared with cmux cloud: passwords live only in the account
 * service and each user keeps its `cloud_id`. Accounts created before sharing move there with the same
 * password on their first sign-in, after which the local password hash is removed.
 */
export class AccountStore {
  constructor(path, { now = Date.now, sessionMs = SESSION_MS, cloud = null } = {}) {
    this.path = path;
    this.now = now;
    this.sessionMs = sessionMs;
    this.cloud = cloud;
    this.data = { version: 1, users: [], sessions: [], computers: [], relays: [] };
    this.operation = Promise.resolve();
  }
  async load() {
    await mkdir(dirname(this.path), { recursive: true });
    try {
      const data = JSON.parse(await readFile(this.path, 'utf8'));
      data.relays ??= [];
      if (data.version !== 1 || !['users', 'sessions', 'computers', 'relays'].every((key) => Array.isArray(data[key]))) throw new Error('invalid account database');
      this.data = data;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  write(operation) {
    const result = this.operation.then(async () => {
      const data = structuredClone(this.data);
      data.sessions = data.sessions.filter((session) => session.expires_at > this.now());
      const result = await operation(data);
      const temporary = `${this.path}.${process.pid}.tmp`;
      await writeFile(temporary, `${JSON.stringify(data)}\n`, { mode: 0o600 });
      await rename(temporary, this.path);
      this.data = data;
      return result;
    });
    this.operation = result.catch(() => {});
    return result;
  }
  session(token, data = this.data) {
    if (typeof token !== 'string' || !token) return null;
    const tokenHash = hash(token);
    return data.sessions.find((s) => s.token_hash === tokenHash && s.expires_at > this.now()) ?? null;
  }
  authenticate(token) {
    const session = this.session(token);
    const user = session && this.data.users.find((u) => u.id === session.account_id);
    return user ? { ...publicUser(user), sessionId: session.id } : null;
  }
  issue(data, user, name) {
    const token = randomBytes(32).toString('base64url');
    const expiresAt = this.now() + this.sessionMs;
    data.sessions.push({ id: randomUUID(), account_id: user.id, token_hash: hash(token), device_name: name, expires_at: expiresAt });
    return { user: publicUser(user), token, expires_at: new Date(expiresAt).toISOString() };
  }
  async register(username, password, name) {
    username = normalizeUsername(username);
    if (!validUsername(username)) fail(400, 'invalid_username');
    validatePassword(password);
    if (this.cloud) {
      if (this.data.users.some((u) => u.username === username)) fail(409, 'username_taken');
      const cloudId = await this.cloud.create(username, password);
      return this.write(async (data) => {
        if (data.users.some((u) => u.username === username)) fail(409, 'username_taken');
        const user = { id: randomUUID(), username, cloud_id: cloudId };
        data.users.push(user);
        await this.ensureTeam(user);
        return this.issue(data, user, name);
      });
    }
    return this.write(async (data) => {
      if (data.users.some((u) => u.username === username)) fail(409, 'username_taken');
      const user = { id: randomUUID(), username, password: await passwordHash(password) };
      data.users.push(user);
      return this.issue(data, user, name);
    });
  }
  async login(username, password, name) {
    if (typeof username !== 'string' || typeof password !== 'string' || password.length > 256) fail(400, 'invalid_login');
    if (this.cloud) return this.cloudLogin(normalizeUsername(username), password, name);
    return this.write(async (data) => {
      const user = data.users.find((u) => u.username === username.trim().toLowerCase());
      if (!await passwordMatches(password, user?.password) || !user) fail(401, 'invalid_login');
      return this.issue(data, user, name);
    });
  }
  async cloudLogin(username, password, name) {
    if (!validUsername(username)) fail(401, 'invalid_login');
    let cloudId = await this.cloud.verify(username, password);
    return this.write(async (data) => {
      let user = data.users.find((u) => u.username === username);
      // First sign-in since accounts were shared: move the account there with the same password.
      if (!cloudId && user?.password && !user.cloud_id && await passwordMatches(password, user.password)) {
        try { cloudId = await this.cloud.create(username, password); }
        catch (error) { if (error.statusCode === 409) fail(401, 'invalid_login'); throw error; }
      }
      if (!cloudId) fail(401, 'invalid_login');
      // An account made in cmux cloud signs in to Panecast too.
      if (!user) { user = { id: randomUUID(), username }; data.users.push(user); }
      user.cloud_id = cloudId;
      delete user.password;
      await this.ensureTeam(user);
      return this.issue(data, user, name);
    });
  }
  /** Gives a shared account its personal team once; sign-in still succeeds if the service refuses. */
  async ensureTeam(user) {
    if (user.team_ready) return;
    try { await this.cloud.ensurePersonalTeam(user.cloud_id, user.username); user.team_ready = true; }
    catch (error) { if (error.statusCode !== 400) throw error; }
  }
  /** The signed-in user, checked against its current password (in the account service once shared). */
  async confirmPassword(token, password) {
    const session = this.requireSession(token, this.data);
    const user = this.data.users.find((u) => u.id === session.account_id);
    if (typeof password !== 'string' || password.length > 256) fail(403, 'incorrect_password');
    const matches = this.cloud && user.cloud_id
      ? await this.cloud.verify(user.username, password) === user.cloud_id
      : await passwordMatches(password, user.password);
    if (!matches) fail(403, 'incorrect_password');
    return { session, user };
  }
  requireSession(token, data) {
    const session = this.session(token, data);
    if (!session) fail(401, 'account_unauthorized');
    return session;
  }
  async logout(token) {
    return this.write((data) => {
      const session = this.requireSession(token, data);
      data.sessions = data.sessions.filter((s) => s.id !== session.id);
    });
  }
  async changePassword(token, oldPassword, password) {
    validatePassword(password);
    const { session, user } = await this.confirmPassword(token, oldPassword);
    let cloudId = user.cloud_id;
    if (this.cloud) {
      if (cloudId) await this.cloud.setPassword(cloudId, password);
      else cloudId = await this.cloud.create(user.username, password);
    }
    const local = this.cloud ? null : await passwordHash(password);
    return this.write((data) => {
      const current = data.users.find((u) => u.id === user.id);
      if (!current) fail(401, 'account_unauthorized');
      if (cloudId) { current.cloud_id = cloudId; delete current.password; } else current.password = local;
      data.sessions = data.sessions.filter((s) => s.account_id !== user.id || s.id === session.id);
    });
  }
  async deleteAccount(token, password) {
    const { user: confirmed } = await this.confirmPassword(token, password);
    // A shared account is one account: deleting it here deletes it in cmux cloud too.
    if (this.cloud && confirmed.cloud_id) await this.cloud.remove(confirmed.cloud_id);
    return this.write(async (data) => {
      const user = data.users.find((u) => u.id === confirmed.id);
      if (!user) fail(401, 'account_unauthorized');
      data.users = data.users.filter((u) => u.id !== user.id);
      data.sessions = data.sessions.filter((s) => s.account_id !== user.id);
      data.computers = data.computers.filter((c) => c.account_id !== user.id);
      return dropRelays(data, data.relays.filter((r) => r.account_id === user.id).map((r) => r.relay_id));
    });
  }
  computers(token) {
    const session = this.requireSession(token, this.data);
    return this.data.computers.filter((c) => c.account_id === session.account_id)
      .map(({ account_id, ...computer }) => ({ ...computer, device_id: deviceId(session, computer.relay_id) }));
  }
  async bind(token, relayId, name) {
    return this.write((data) => {
      const session = this.requireSession(token, data);
      const existing = data.computers.find((c) => c.account_id === session.account_id && c.relay_id === relayId);
      if (!existing) data.computers.push({ account_id: session.account_id, relay_id: relayId, name, paired_at: new Date(this.now()).toISOString() });
    });
  }
  async updateComputer(token, relayId, name) {
    return this.write((data) => {
      const session = this.requireSession(token, data);
      const computer = data.computers.find((c) => c.account_id === session.account_id && c.relay_id === relayId);
      if (!computer) fail(404, 'computer_not_found');
      computer.name = name;
    });
  }
  async unbind(token, relayId) {
    return this.write((data) => {
      const session = this.requireSession(token, data);
      if (data.relays.some((r) => r.relay_id === relayId && r.account_id === session.account_id)) return dropRelays(data, [relayId]);
      data.computers = data.computers.filter((c) => c.account_id !== session.account_id || c.relay_id !== relayId);
      return [];
    });
  }
  /** Assigns a new relay identity to the signed-in account. The raw secrets are returned once and only their hashes are kept. */
  async enrollRelay(token, name, { reservedIds = new Set(), maxPerAccount = 20, maxTotal = 1000 } = {}) {
    return this.write((data) => {
      const session = this.requireSession(token, data);
      if (data.relays.length >= maxTotal || data.relays.filter((r) => r.account_id === session.account_id).length >= maxPerAccount) fail(429, 'relay_limit_reached');
      let relayId;
      do relayId = `pc-${randomBytes(8).toString('hex')}`;
      while (reservedIds.has(relayId) || data.relays.some((r) => r.relay_id === relayId));
      const relayToken = randomBytes(32).toString('base64url');
      const pairingCode = randomBytes(24).toString('base64url');
      const createdAt = new Date(this.now()).toISOString();
      data.relays.push({ relay_id: relayId, account_id: session.account_id, token_hash: hash(relayToken), pairing_code_hash: hash(pairingCode), created_at: createdAt });
      data.computers.push({ account_id: session.account_id, relay_id: relayId, name, paired_at: createdAt });
      return { relay_id: relayId, relay_token: relayToken, pairing_code: pairingCode, name };
    });
  }
  hasRelay(relayId) {
    return this.data.relays.some((r) => r.relay_id === relayId);
  }
  relayIds() {
    return this.data.relays.map((r) => r.relay_id);
  }
  relayTokenMatches(relayId, token) {
    const relay = this.data.relays.find((r) => r.relay_id === relayId);
    return Boolean(relay) && hashMatches(token, relay.token_hash);
  }
  pairingCodeMatches(relayId, code) {
    const relay = this.data.relays.find((r) => r.relay_id === relayId);
    return Boolean(relay) && hashMatches(code, relay.pairing_code_hash);
  }
  authenticateDevice(token, relayId) {
    const session = this.session(token);
    if (!session || !this.data.computers.some((c) => c.account_id === session.account_id && c.relay_id === relayId)) return null;
    return { device_id: deviceId(session, relayId), relay_id: relayId };
  }
  deviceIds(relayId) {
    const owners = new Set(this.data.computers.filter((c) => c.relay_id === relayId).map((c) => c.account_id));
    return this.data.sessions.filter((s) => s.expires_at > this.now() && owners.has(s.account_id)).map((s) => deviceId(s, relayId));
  }
}
