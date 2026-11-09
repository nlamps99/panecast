/** Uses the same relay identities and proof of access as the existing pairing API. */
export async function accountRoute(request, response, url, context) {
  if (!url.pathname.startsWith('/v1/account/')) return false;
  const { accounts, relays, relayConnections, store, readJSON, sendJSON, sendEmpty, bearerToken, secretEquals, limit, sync } = context;
  const route = url.pathname.slice('/v1/account/'.length);
  const method = request.method;
  const token = bearerToken(request);
  const fail = (status, error) => { sendJSON(response, status, { error }); return true; };
  if (method !== 'GET' && !limit()) return fail(429, 'too_many_account_attempts');
  const body = ['POST', 'PATCH', 'DELETE'].includes(method) ? await readJSON(request) : {};
  if (!body || typeof body !== 'object' || Array.isArray(body)) return fail(400, 'invalid_request');
  if (method === 'POST' && ['register', 'login'].includes(route)) {
    if (typeof body.device_name !== 'string' || !body.device_name.trim() || body.device_name.length > 256) return fail(400, 'invalid_request');
    const result = await accounts[route](body.username, body.password, body.device_name.trim());
    sendJSON(response, route === 'register' ? 201 : 200, result);
    return true;
  }
  const user = accounts.authenticate(token);
  if (!user) return fail(401, 'account_unauthorized');
  if (route === 'me' && method === 'GET') {
    sendJSON(response, 200, { user: { id: user.id, username: user.username } });
  } else if (route === 'logout' && method === 'POST') {
    await accounts.logout(token);
    await sync();
    sendEmpty(response, 204);
  } else if (route === 'password' && method === 'POST') {
    await accounts.changePassword(token, body.old_password, body.password);
    await sync();
    sendEmpty(response, 204);
  } else if (route === 'me' && method === 'DELETE') {
    await accounts.deleteAccount(token, body.password);
    await sync();
    sendEmpty(response, 204);
  } else if (route === 'computers' && method === 'GET') {
    sendJSON(response, 200, { computers: accounts.computers(token).filter((c) => relays.has(c.relay_id)).map((c) => ({ ...c, online: relayConnections.has(c.relay_id) })) });
  } else if (route === 'computers' && method === 'POST') {
    const relay = relays.get(body.relay_id);
    const pairedDevice = relay && typeof body.device_token === 'string' && await store.authenticate(body.device_token, body.relay_id);
    const validCode = relay && typeof body.pairing_code === 'string' && body.pairing_code.length <= 4096 && secretEquals(body.pairing_code, relay.pairingCode);
    if (!pairedDevice && !validCode) return fail(403, 'pairing_rejected');
    const name = typeof body.name === 'string' ? body.name.trim().slice(0, 60) : '';
    await accounts.bind(token, body.relay_id, name || body.relay_id);
    sendEmpty(response, 204);
  } else if (route === 'computers' && ['PATCH', 'DELETE'].includes(method)) {
    const relayId = url.searchParams.get('relay_id');
    if (!relayId) return fail(400, 'invalid_request');
    if (method === 'PATCH') {
      if (typeof body.name !== 'string' || !body.name.trim() || body.name.length > 60) return fail(400, 'invalid_request');
      await accounts.updateComputer(token, relayId, body.name.trim());
    } else {
      await accounts.unbind(token, relayId);
      await sync();
    }
    sendEmpty(response, 204);
  } else return fail(404, 'not_found');
  return true;
}
