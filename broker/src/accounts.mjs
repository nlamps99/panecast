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

/** Account passwords, token hashes and relay grants. Never stores pairing codes or raw tokens. */
export class AccountStore {
  constructor(path, { now = Date.now, sessionMs = SESSION_MS } = {}) {
    this.path = path;
    this.now = now;
    this.sessionMs = sessionMs;
    this.data = { version: 1, users: [], sessions: [], computers: [] };
    this.operation = Promise.resolve();
  }
  async load() {
    await mkdir(dirname(this.path), { recursive: true });
    try {
      const data = JSON.parse(await readFile(this.path, 'utf8'));
      if (data.version !== 1 || !['users', 'sessions', 'computers'].every((key) => Array.isArray(data[key]))) throw new Error('invalid account database');
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
    username = typeof username === 'string' ? username.trim().toLowerCase() : '';
    if (!/^[a-z0-9][a-z0-9._-]{2,63}$/.test(username)) fail(400, 'invalid_username');
    validatePassword(password);
    return this.write(async (data) => {
      if (data.users.some((u) => u.username === username)) fail(409, 'username_taken');
      const user = { id: randomUUID(), username, password: await passwordHash(password) };
      data.users.push(user);
      return this.issue(data, user, name);
    });
  }
  async login(username, password, name) {
    if (typeof username !== 'string' || typeof password !== 'string' || password.length > 256) fail(400, 'invalid_login');
    return this.write(async (data) => {
      const user = data.users.find((u) => u.username === username.trim().toLowerCase());
      if (!await passwordMatches(password, user?.password) || !user) fail(401, 'invalid_login');
      return this.issue(data, user, name);
    });
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
    return this.write(async (data) => {
      const session = this.requireSession(token, data);
      const user = data.users.find((u) => u.id === session.account_id);
      if (typeof oldPassword !== 'string' || oldPassword.length > 256 || !await passwordMatches(oldPassword, user.password)) fail(403, 'incorrect_password');
      user.password = await passwordHash(password);
      data.sessions = data.sessions.filter((s) => s.account_id !== user.id || s.id === session.id);
    });
  }
  async deleteAccount(token, password) {
    return this.write(async (data) => {
      const session = this.requireSession(token, data);
      const user = data.users.find((u) => u.id === session.account_id);
      if (typeof password !== 'string' || password.length > 256 || !await passwordMatches(password, user.password)) fail(403, 'incorrect_password');
      data.users = data.users.filter((u) => u.id !== user.id);
      data.sessions = data.sessions.filter((s) => s.account_id !== user.id);
      data.computers = data.computers.filter((c) => c.account_id !== user.id);
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
      data.computers = data.computers.filter((c) => c.account_id !== session.account_id || c.relay_id !== relayId);
    });
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
