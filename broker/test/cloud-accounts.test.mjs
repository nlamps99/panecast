import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AccountStore } from '../src/accounts.mjs';
import { CloudIdentity } from '../src/cloud-identity.mjs';
import { createBrokerServer } from '../src/server.mjs';

const password = 'a sufficiently long test password';
const PROJECT = 'project-1', PUBLISHABLE = 'pck_public', SERVER = 'ssk_secret';

/** A stand-in for the Stack Auth API behind cmux.drinklake.com. */
async function fakeAccountService(t) {
  const users = new Map(); // email -> { id, password, display_name, selected_team_id }
  const teams = []; // { id, display_name, members: [userId] }
  const calls = [];
  let down = false, openSessions = 0, next = 1;
  const server = http.createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    const h = request.headers;
    const kind = h['x-stack-access-type'];
    calls.push({ method: request.method, url: request.url, kind, serverKey: h['x-stack-secret-server-key'], publishable: h['x-stack-publishable-client-key'] });
    const send = (status, data) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(data)); };
    if (down) return send(502, {});
    // Like Stack Auth: a JSON content type needs a JSON body.
    if (h['content-type'] && !raw) return send(400, { code: 'BODY_PARSING_ERROR' });
    if (h['x-stack-project-id'] !== PROJECT) return send(400, { code: 'PROJECT_NOT_FOUND' });
    if (kind === 'server' && h['x-stack-secret-server-key'] !== SERVER) return send(401, { code: 'INVALID_SERVER_KEY' });
    if (kind === 'client' && h['x-stack-publishable-client-key'] !== PUBLISHABLE) return send(401, { code: 'INVALID_PUBLISHABLE_KEY' });
    const byId = (id) => [...users.entries()].find(([, u]) => u.id === id);
    if (request.method === 'POST' && request.url === '/api/v1/auth/password/sign-in' && kind === 'client') {
      const user = users.get(body.email);
      if (!user || user.password !== body.password) return send(400, { code: 'EMAIL_PASSWORD_MISMATCH' });
      openSessions++;
      return send(200, { access_token: `access-${user.id}`, refresh_token: 'refresh', user_id: user.id });
    }
    if (request.method === 'DELETE' && request.url === '/api/v1/auth/sessions/current') { openSessions--; return send(200, {}); }
    if (request.method === 'POST' && request.url === '/api/v1/users' && kind === 'server') {
      if (users.has(body.primary_email)) return send(409, { code: 'USER_EMAIL_ALREADY_EXISTS' });
      const id = `cloud-${next++}`;
      users.set(body.primary_email, { id, password: body.password, display_name: body.display_name, verified: body.primary_email_verified });
      return send(201, { id });
    }
    if (request.method === 'GET' && request.url?.startsWith('/api/v1/teams?user_id=') && kind === 'server') {
      const userId = decodeURIComponent(request.url.split('=')[1]);
      return send(200, { items: teams.filter((t) => t.members.includes(userId)).map(({ id, display_name }) => ({ id, display_name })) });
    }
    if (request.method === 'POST' && request.url === '/api/v1/teams' && kind === 'server') {
      const team = { id: `team-${next++}`, display_name: body.display_name, members: body.creator_user_id ? [body.creator_user_id] : [] };
      teams.push(team);
      return send(201, { id: team.id, display_name: team.display_name });
    }
    const match = /^\/api\/v1\/users\/([^/]+)$/.exec(request.url ?? '');
    if (match && kind === 'server') {
      const entry = byId(decodeURIComponent(match[1]));
      if (!entry) return send(404, { code: 'USER_NOT_FOUND' });
      if (request.method === 'PATCH') {
        if (body.password !== undefined) entry[1].password = body.password;
        if (body.selected_team_id !== undefined) entry[1].selected_team_id = body.selected_team_id;
        return send(200, { id: entry[1].id });
      }
      if (request.method === 'DELETE') { users.delete(entry[0]); return send(200, { success: true }); }
    }
    send(404, { code: 'ROUTE_NOT_FOUND' });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    users, teams, calls, origin,
    setDown(value) { down = value; },
    get openSessions() { return openSessions; },
    identity: () => new CloudIdentity({ origin, projectId: PROJECT, publishableKey: PUBLISHABLE, serverKey: SERVER, emailDomain: 'users.drinklake.com' }),
  };
}

async function broker(t, cloud, directory) {
  directory ??= await mkdtemp(join(tmpdir(), 'panecast-cloud-accounts-'));
  const server = await createBrokerServer({ host: '127.0.0.1', port: 0, dataFile: join(directory, 'devices.json'),
    relays: [{ relay_id: 'home', relay_token: 'home-tunnel', pairing_code: 'home-pair' }],
    logger: { error() {} }, accountLimit: 100, cloudIdentity: cloud.identity() });
  const address = await server.listen(), base = `http://127.0.0.1:${address.port}`;
  t.after(async () => { await server.close(); await rm(directory, { recursive: true, force: true }); });
  const request = async (route, method = 'GET', body, token) => {
    const response = await fetch(`${base}/v1/account/${route}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: response.status === 204 ? null : await response.json() };
  };
  const accounts = async () => JSON.parse(await readFile(join(directory, 'accounts.json'), 'utf8'));
  return { base, request, accounts, directory };
}

test('a Panecast registration creates one shared account that signs in to both, keyed by username', async (t) => {
  const cloud = await fakeAccountService(t);
  const { request, accounts, base } = await broker(t, cloud);
  const created = await request('register', 'POST', { username: 'Lesley', password, device_name: 'Phone' });
  assert.equal(created.status, 201);
  assert.equal(created.body.user.username, 'lesley');
  const shared = cloud.users.get('lesley@users.drinklake.com');
  assert.equal(shared.password, password, 'the password lives in the account service');
  assert.equal(shared.display_name, 'lesley');
  assert.equal(shared.verified, true, 'the internal address needs no mail');
  const [user] = (await accounts()).users;
  assert.equal(user.cloud_id, shared.id);
  assert.equal(user.password, undefined, 'the broker keeps no password');
  // cmux DR2 registers and discovers devices per team, as for accounts made in the app.
  assert.deepEqual(cloud.teams.map((t) => [t.display_name, t.members]), [["lesley's Team", [shared.id]]]);
  assert.equal(shared.selected_team_id, cloud.teams[0].id);
  assert.equal(user.team_ready, true);

  assert.equal((await request('login', 'POST', { username: ' LESLEY ', password, device_name: 'Tablet' })).status, 200);
  assert.equal(cloud.teams.length, 1, 'signing in again creates no second team');
  assert.equal((await request('login', 'POST', { username: 'lesley', password: 'wrong password, long enough', device_name: 'x' })).status, 401);
  assert.equal(cloud.openSessions, 0, 'checking a password leaves no session open in the account service');
  assert.equal((await request('register', 'POST', { username: 'lesley', password, device_name: 'x' })).status, 409);
  const health = await (await fetch(`${base}/v1/health`)).json();
  assert.equal(health.shared_accounts, true);
  // The server key is used only for administration, never for sign-in.
  for (const call of cloud.calls) {
    if (call.url.startsWith('/api/v1/auth/')) { assert.equal(call.serverKey, undefined); assert.equal(call.kind, 'client'); }
    else { assert.equal(call.kind, 'server'); assert.equal(call.publishable, undefined); }
  }
});

test('an account created in cmux cloud signs in to Panecast without registering', async (t) => {
  const cloud = await fakeAccountService(t);
  await cloud.identity().create('admin-made', password);
  const teamless = cloud.users.get('admin-made@users.drinklake.com');
  // An account that already belongs to a team keeps it.
  await cloud.identity().create('in-team', password);
  const member = cloud.users.get('in-team@users.drinklake.com');
  cloud.teams.push({ id: 'team-existing', display_name: 'Existing', members: [member.id] });
  const { request, accounts } = await broker(t, cloud);
  const login = await request('login', 'POST', { username: 'admin-made', password, device_name: 'Phone' });
  assert.equal(login.status, 200);
  assert.equal((await accounts()).users[0].cloud_id, teamless.id);
  assert.equal(cloud.teams.filter((t) => t.members.includes(teamless.id)).length, 1, 'a team-less account gets its personal team');
  assert.equal((await request('login', 'POST', { username: 'in-team', password, device_name: 'Phone' })).status, 200);
  assert.equal(cloud.teams.filter((t) => t.members.includes(member.id)).length, 1, 'an existing team is kept, not duplicated');
  assert.equal((await request('login', 'POST', { username: 'someone@example.com', password, device_name: 'x' })).status, 401, 'emails are not usernames');
});

test('an account from before sharing moves to the account service with its password on first sign-in', async (t) => {
  const cloud = await fakeAccountService(t);
  const directory = await mkdtemp(join(tmpdir(), 'panecast-cloud-accounts-'));
  // Created by the previous broker, with a local password hash and a bound computer.
  const legacy = new AccountStore(join(directory, 'accounts.json'));
  await legacy.load();
  const old = await legacy.register('lesley', password, 'Setup');
  await legacy.bind(old.token, 'home', 'LesleydeMacBook');
  await legacy.logout(old.token);

  const { request, accounts } = await broker(t, cloud, directory);
  assert.equal((await request('login', 'POST', { username: 'lesley', password: 'not her password at all', device_name: 'x' })).status, 401);
  assert.equal(cloud.users.size, 0, 'a wrong password moves nothing');

  const first = await request('login', 'POST', { username: 'lesley', password, device_name: 'Phone' });
  assert.equal(first.status, 200);
  const shared = cloud.users.get('lesley@users.drinklake.com');
  assert.equal(shared.password, password);
  const [user] = (await accounts()).users;
  assert.equal(user.cloud_id, shared.id);
  assert.equal(user.password, undefined, 'the local hash is gone after the move');
  const computers = await request('computers', 'GET', undefined, first.body.token);
  assert.deepEqual(computers.body.computers.map((c) => c.name), ['LesleydeMacBook'], 'bound computers carry over');
  assert.equal((await request('login', 'POST', { username: 'lesley', password, device_name: 'Again' })).status, 200);
  assert.equal(cloud.users.size, 1, 'later sign-ins use the shared account');
});

test('password changes and account deletion apply to the shared account', async (t) => {
  const cloud = await fakeAccountService(t);
  const { request } = await broker(t, cloud);
  const first = (await request('register', 'POST', { username: 'nzx', password, device_name: 'Mac' })).body;
  const second = (await request('login', 'POST', { username: 'nzx', password, device_name: 'Phone' })).body;
  const next = 'another sufficiently long password';
  assert.equal((await request('password', 'POST', { old_password: 'wrong but long enough', password: next }, first.token)).status, 403);
  assert.equal((await request('password', 'POST', { old_password: password, password: next }, first.token)).status, 204);
  assert.equal(cloud.users.get('nzx@users.drinklake.com').password, next, 'cmux cloud uses the new password too');
  assert.equal((await request('me', 'GET', undefined, second.token)).status, 401, 'other logins end');
  assert.equal((await request('login', 'POST', { username: 'nzx', password, device_name: 'x' })).status, 401);
  assert.equal((await request('me', 'DELETE', { password: 'wrong but long enough' }, first.token)).status, 403);
  assert.equal((await request('me', 'DELETE', { password: next }, first.token)).status, 204);
  assert.equal(cloud.users.has('nzx@users.drinklake.com'), false, 'deleting removes the one shared account');
});

test('when the account service is unreachable, sign-in fails clearly and nothing changes', async (t) => {
  const cloud = await fakeAccountService(t);
  const { request, accounts, directory } = await broker(t, cloud);
  assert.equal((await request('register', 'POST', { username: 'nzx', password, device_name: 'Mac' })).status, 201);
  const before = await readFile(join(directory, 'accounts.json'), 'utf8');
  cloud.setDown(true);
  const login = await request('login', 'POST', { username: 'nzx', password, device_name: 'Phone' });
  assert.equal(login.status, 503);
  assert.equal(login.body.error, 'account_service_unavailable');
  assert.equal((await request('register', 'POST', { username: 'other', password, device_name: 'Mac' })).status, 503);
  assert.equal(await readFile(join(directory, 'accounts.json'), 'utf8'), before);
  assert.equal((await accounts()).users.length, 1);
});

test('shared account settings are read from the environment and validated', () => {
  assert.equal(CloudIdentity.fromEnvironment({}), null);
  const identity = CloudIdentity.fromEnvironment({ CMUX_ACCOUNT_ORIGIN: 'https://cmux.drinklake.com', CMUX_ACCOUNT_PROJECT_ID: PROJECT,
    CMUX_ACCOUNT_PUBLISHABLE_KEY: PUBLISHABLE, CMUX_ACCOUNT_SERVER_KEY: SERVER, CMUX_ACCOUNT_EMAIL_DOMAIN: 'users.drinklake.com' });
  assert.equal(identity.email('lesley'), 'lesley@users.drinklake.com');
  assert.throws(() => CloudIdentity.fromEnvironment({ CMUX_ACCOUNT_ORIGIN: 'http://cmux.drinklake.com', CMUX_ACCOUNT_PROJECT_ID: PROJECT,
    CMUX_ACCOUNT_PUBLISHABLE_KEY: PUBLISHABLE, CMUX_ACCOUNT_SERVER_KEY: SERVER, CMUX_ACCOUNT_EMAIL_DOMAIN: 'users.drinklake.com' }), /HTTPS/);
  assert.throws(() => CloudIdentity.fromEnvironment({ CMUX_ACCOUNT_ORIGIN: 'https://cmux.drinklake.com', CMUX_ACCOUNT_PROJECT_ID: PROJECT,
    CMUX_ACCOUNT_PUBLISHABLE_KEY: PUBLISHABLE, CMUX_ACCOUNT_EMAIL_DOMAIN: 'users.drinklake.com' }), /server key/);
});
