import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import http from "node:http";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import { AccountStore } from "./accounts.mjs";
import { accountRoute } from "./account-routes.mjs";

const MAX_HTTP_BODY_BYTES = 64 * 1024;
export const MAX_WS_PAYLOAD_BYTES = 32 * 1024 * 1024;

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function secretEquals(left, right) {
  const a = Buffer.from(sha256(left));
  const b = Buffer.from(sha256(right));
  return timingSafeEqual(a, b);
}

function bearerToken(request) {
  const match = /^Bearer\s+(.+)$/i.exec(request.headers.authorization ?? "");
  return match?.[1]?.trim() || null;
}

function sendJSON(response, status, value) {
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": body.length,
    "cache-control": "no-store",
  });
  response.end(body);
}

function sendEmpty(response, status) {
  response.writeHead(status, { "content-length": "0", "cache-control": "no-store" });
  response.end();
}

async function readJSON(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > MAX_HTTP_BODY_BYTES) {
      const error = new Error("request body too large");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("invalid JSON");
    error.statusCode = 400;
    throw error;
  }
}

function rejectUpgrade(socket, status, reason) {
  const body = Buffer.from(reason);
  const labels = {
    400: "Bad Request",
    401: "Unauthorized",
    404: "Not Found",
    500: "Internal Server Error",
    503: "Service Unavailable",
  };
  socket.end(
    `HTTP/1.1 ${status} ${labels[status] ?? "Error"}\r\n` +
      "Connection: close\r\n" +
      "Content-Type: text/plain; charset=utf-8\r\n" +
      `Content-Length: ${body.length}\r\n\r\n` +
      body,
  );
}

function requiredString(value, maxLength = 256) {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

export class DeviceStore {
  constructor(path) {
    this.path = path;
    this.devices = [];
    this.operation = Promise.resolve();
  }

  async load() {
    return this.runExclusive(() => this.loadUnlocked());
  }

  async loadUnlocked() {
    await mkdir(dirname(this.path), { recursive: true });
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8"));
      this.devices = Array.isArray(parsed.devices) ? parsed.devices : [];
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      this.devices = [];
    }
  }

  async saveUnlocked() {
    const temporaryPath = `${this.path}.${process.pid}.tmp`;
    const data = `${JSON.stringify({ version: 1, devices: this.devices }, null, 2)}\n`;
    await writeFile(temporaryPath, data, { mode: 0o600 });
    await rename(temporaryPath, this.path);
  }

  async register({ relayId, clientId, deviceName }) {
    return this.runExclusive(async () => {
      await this.loadUnlocked();
      const deviceId = randomUUID();
      const token = randomBytes(32).toString("base64url");
      this.devices = this.devices.filter(
        (device) => !(device.relay_id === relayId && device.client_id === clientId),
      );
      this.devices.push({
        device_id: deviceId,
        relay_id: relayId,
        client_id: clientId,
        device_name: deviceName,
        token_hash: sha256(token),
        registered_at: new Date().toISOString(),
      });
      await this.saveUnlocked();
      return { deviceId, token };
    });
  }

  async authenticate(token, relayId) {
    if (!token) return null;
    return this.runExclusive(async () => {
      // Device management runs in a separate process inside the container.
      // Reload before every new authentication so a revoke takes effect on
      // the next HTTP request or WebSocket reconnect without a broker restart.
      await this.loadUnlocked();
      const tokenHash = sha256(token);
      return (
        this.devices.find(
          (device) =>
            device.relay_id === relayId && secretEquals(device.token_hash, tokenHash),
        ) ?? null
      );
    });
  }

  async updateAPNs(deviceId, payload, relayId) {
    return this.runExclusive(async () => {
      await this.loadUnlocked();
      const device = this.devices.find((candidate) => candidate.device_id === deviceId && (relayId === undefined || candidate.relay_id === relayId));
      if (!device) return;
      device.apns_token_hash = sha256(payload.apns_token);
      device.apns_env = payload.env;
      await this.saveUnlocked();
    });
  }

  allDevices(relayId) {
    return this.devices.filter((device) => relayId === undefined || device.relay_id === relayId)
      .map(({ token_hash, apns_token_hash, ...device }) => device);
  }

  async revoke(deviceId, relayId) {
    return this.runExclusive(async () => {
      await this.loadUnlocked();
      const before = this.devices.length;
      this.devices = this.devices.filter((device) => device.device_id !== deviceId || (relayId !== undefined && device.relay_id !== relayId));
      if (this.devices.length === before) return false;
      await this.saveUnlocked();
      return true;
    });
  }

  runExclusive(operation) {
    const result = this.operation.then(operation, operation);
    this.operation = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

class SlidingWindowRateLimiter {
  constructor(limit, windowMs, sweepIntervalMs = windowMs) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.sweepIntervalMs = sweepIntervalMs;
    this.attempts = new Map();
    this.lastSweep = 0;
  }

  allow(key, now = Date.now()) {
    this.sweep(now);
    const cutoff = now - this.windowMs;
    const recent = (this.attempts.get(key) ?? []).filter((value) => value > cutoff);
    if (recent.length >= this.limit) {
      this.attempts.set(key, recent);
      return false;
    }
    recent.push(now);
    this.attempts.set(key, recent);
    return true;
  }

  // Periodically drop keys whose buckets have fully expired so the map stays
  // bounded even for keys that are never revisited.
  sweep(now = Date.now()) {
    if (now - this.lastSweep < this.sweepIntervalMs) return;
    this.lastSweep = now;
    const cutoff = now - this.windowMs;
    for (const [key, timestamps] of this.attempts) {
      if (!timestamps.some((value) => value > cutoff)) {
        this.attempts.delete(key);
      }
    }
  }
}

function remoteIP(request, trustProxy) {
  if (trustProxy) {
    const forwarded = request.headers["x-forwarded-for"];
    if (typeof forwarded === "string" && forwarded.length > 0) {
      // X-Forwarded-For is a client-controlled, comma-separated chain. Only the
      // last entry is written by our trusted reverse proxy (e.g. nginx's
      // $proxy_add_x_forwarded_for appends the immediate peer); earlier entries
      // can be spoofed to rotate the rate-limit key. Trust the last hop only.
      const hops = forwarded.split(",").map((value) => value.trim()).filter(Boolean);
      if (hops.length > 0) return hops[hops.length - 1];
    }
  }
  return request.socket.remoteAddress ?? "unknown";
}

export function configFromEnvironment(environment = process.env) {
  const config = {
    host: environment.CMUX_BROKER_HOST ?? "127.0.0.1",
    port: Number(environment.CMUX_BROKER_PORT ?? 4398),
    relayId: environment.CMUX_RELAY_ID ?? "",
    relayToken: environment.CMUX_RELAY_TOKEN ?? "",
    pairingCode: environment.CMUX_PAIRING_CODE ?? "",
    dataFile: resolve(environment.CMUX_BROKER_DATA_DIR ?? "./data", "devices.json"),
    trustProxy: environment.CMUX_TRUST_PROXY === "1",
  };
  const file = environment.CMUX_RELAYS_FILE;
  const inline = environment.CMUX_RELAYS_JSON;
  if (file && inline) throw new Error("Use either CMUX_RELAYS_FILE or CMUX_RELAYS_JSON, not both");
  if (file) {
    config.relaysFile = resolve(file);
  } else if (inline) {
    config.relays = parseRelayConfiguration(inline, "CMUX_RELAYS_JSON");
  } else {
    if (!requiredString(config.relayId) || !requiredString(config.relayToken, 4096)) {
      throw new Error("CMUX_RELAY_ID and CMUX_RELAY_TOKEN are required");
    }
    if (!requiredString(config.pairingCode, 4096)) throw new Error("CMUX_PAIRING_CODE is required");
  }
  if (!Number.isInteger(config.port) || config.port < 0 || config.port > 65535) {
    throw new Error("CMUX_BROKER_PORT must be a valid TCP port");
  }
  return config;
}

/** Only the schema name is included in errors: JSON parse errors can expose secret values. */
export function parseRelayConfiguration(text, source = "relay configuration") {
  let value;
  try { value = JSON.parse(text); }
  catch { throw new Error(`${source} must contain valid JSON`); }
  if (!value || typeof value !== "object" || !Array.isArray(value.relays)) {
    throw new Error(`${source} must be an object containing a relays array`);
  }
  return normalizeRelays(value.relays);
}

function normalizeRelays(entries) {
  if (!Array.isArray(entries) || entries.length === 0 || entries.length > 256) {
    throw new Error("Configure between 1 and 256 relays");
  }
  const ids = new Set(), secrets = new Set();
  return entries.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("Invalid relay configuration entry");
    const relayId = entry.relay_id ?? entry.relayId;
    const relayToken = entry.relay_token ?? entry.relayToken;
    const pairingCode = entry.pairing_code ?? entry.pairingCode;
    if (!requiredString(relayId) || relayId.trim() !== relayId || /[\u0000-\u001f\u007f]/.test(relayId)) throw new Error("Each relay requires a nonempty relay_id without control characters");
    if (!requiredString(relayToken, 4096) || !requiredString(pairingCode, 4096)) throw new Error("Each relay requires relay_token and pairing_code");
    if (ids.has(relayId)) throw new Error("Duplicate relay_id in relay configuration");
    ids.add(relayId);
    for (const secret of [relayToken, pairingCode]) {
      const fingerprint = sha256(secret);
      if (secrets.has(fingerprint)) throw new Error("Every relay token and pairing code must be distinct");
      secrets.add(fingerprint);
    }
    return { relayId, relayToken, pairingCode };
  });
}

async function configuredRelays(config) {
  if (config.relaysFile && config.relays !== undefined) throw new Error("Configure relays or relaysFile, not both");
  if (config.relaysFile) {
    let text;
    try { text = await readFile(config.relaysFile, "utf8"); }
    catch (error) { throw new Error(`Could not read CMUX_RELAYS_FILE (${error.code ?? "read_failed"})`); }
    return parseRelayConfiguration(text, "CMUX_RELAYS_FILE");
  }
  if (config.relays !== undefined) return normalizeRelays(config.relays);
  // Existing single-relay deployments keep their exact credential semantics.
  if (!requiredString(config.relayId) || !requiredString(config.relayToken, 4096) || !requiredString(config.pairingCode, 4096)) {
    throw new Error("A relay id, relay token and pairing code are required");
  }
  return [{ relayId: config.relayId, relayToken: config.relayToken, pairingCode: config.pairingCode }];
}

export async function createBrokerServer(options) {
  const config = { ...options };
  const relays = new Map((await configuredRelays(config)).map((relay) => [relay.relayId, relay]));
  const defaultRelayId = relays.size === 1 ? relays.keys().next().value : undefined;
  const logger = config.logger ?? console;
  const store = new DeviceStore(config.dataFile);
  await store.load();
  const accounts = new AccountStore(config.accountFile ?? resolve(dirname(config.dataFile), 'accounts.json'));
  await accounts.load();
  const accountLimiter = new SlidingWindowRateLimiter(config.accountLimit ?? 15, 60_000);
  const accountTotalLimiter = new SlidingWindowRateLimiter(config.accountTotalLimit ?? 120, 60_000);
  const rateLimiter = new SlidingWindowRateLimiter(config.pairingLimit ?? 5, 60_000);
  const totalPairingLimiter = new SlidingWindowRateLimiter(config.totalPairingLimit ?? 30, 60_000);
  const relayConnections = new Map();
  const phoneSessions = new Map();
  const pushRequests = new Map();
  const pushLimiter = new SlidingWindowRateLimiter(12, 60_000);

  async function syncPushDevices(relayId) {
    await store.load();
    const deviceIds = [...store.allDevices(relayId).map((d) => d.device_id), ...accounts.deviceIds(relayId)];
    const allowed = new Set(deviceIds);
    for (const [sessionId, session] of phoneSessions) {
      if (session.relayId === relayId && !allowed.has(session.deviceId)) {
        closePhoneSession(sessionId);
        session.socket.close(4003, "device authorization revoked");
      }
    }
    sendToRelay(relayId, { type: "push.sync", session_id: "push-sync", text: JSON.stringify(deviceIds) });
  }

  function requestPush(relayId, type, deviceId, body) {
    const relay = relayConnections.get(relayId);
    if (relay?.readyState !== WebSocket.OPEN) return Promise.reject(Object.assign(new Error("relay_offline"), { statusCode: 503 }));
    const relayPending = [...pushRequests.values()].filter((pending) => pending.relayId === relayId).length;
    if (pushRequests.size >= 512 || relayPending >= (config.maxPendingPushPerRelay ?? 128)) return Promise.reject(Object.assign(new Error("push_busy"), { statusCode: 429 }));
    const id = randomUUID();
    return new Promise((resolveRequest, reject) => {
      const timer = setTimeout(() => {
        pushRequests.delete(id);
        reject(Object.assign(new Error("push_relay_timeout_or_upgrade_required"), { statusCode: 504 }));
      }, config.pushTimeoutMs ?? 7000);
      pushRequests.set(id, { relay, relayId, resolve: resolveRequest, reject, timer });
      relay.send(JSON.stringify({ type, session_id: id, device_id: deviceId, text: JSON.stringify(body) }));
    });
  }

  const authenticatePhone = async (request, relayId) =>
    relays.has(relayId) ? (await store.authenticate(bearerToken(request), relayId)) ?? accounts.authenticateDevice(bearerToken(request), relayId) : null;

  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (await accountRoute(request, response, url, {
        accounts, relays, relayConnections, store, readJSON, sendJSON, sendEmpty, bearerToken, secretEquals,
        limit: () => accountTotalLimiter.allow('all') && accountLimiter.allow(remoteIP(request, config.trustProxy)),
        sync: () => Promise.all([...relays.keys()].map(syncPushDevices)),
      })) return;
      if (request.method === "GET" && url.pathname === "/v1/health") {
        const relayId = url.searchParams.has("relay_id") ? url.searchParams.get("relay_id") : defaultRelayId;
        if (url.searchParams.has("relay_id") && !await authenticatePhone(request, relayId)) {
          sendJSON(response, 401, { error: "unauthorized" });
          return;
        }
        sendJSON(response, 200, {
          ok: true,
          ...(relayId === undefined ? {} : { relay_online: relayConnections.has(relayId) }),
          version: "0.1.0",
          push_forwarding: true,
          relay_scoped_health: true,
          accounts: true,
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/v1/devices/me/register") {
        const ip = remoteIP(request, config.trustProxy);
        if (!totalPairingLimiter.allow(ip)) {
          sendJSON(response, 429, { error: "too_many_pairing_attempts" });
          return;
        }
        const body = await readJSON(request);
        if (!body || typeof body !== "object" || Array.isArray(body)) {
          sendJSON(response, 400, { error: "invalid_registration" });
          return;
        }
        if (
          !requiredString(body.relay_id) ||
          !requiredString(body.pairing_code, 4096) ||
          !requiredString(body.client_id) ||
          !requiredString(body.device_name)
        ) {
          sendJSON(response, 400, { error: "invalid_registration" });
          return;
        }
        if (!rateLimiter.allow(`${body.relay_id}\0${ip}`)) {
          sendJSON(response, 429, { error: "too_many_pairing_attempts" });
          return;
        }
        const relay = relays.get(body.relay_id);
        if (!relay || !secretEquals(body.pairing_code, relay.pairingCode)) {
          sendJSON(response, 403, { error: "pairing_rejected" });
          return;
        }
        const registered = await store.register({
          relayId: body.relay_id,
          clientId: body.client_id,
          deviceName: body.device_name,
        });
        await syncPushDevices(body.relay_id);
        sendJSON(response, 200, {
          device_id: registered.deviceId,
          token: registered.token,
        });
        return;
      }

      if (request.method === "POST" && ["/v1/devices/me/apns", "/v1/devices/me/apns/test"].includes(url.pathname)) {
        const relayId = url.searchParams.get("relay_id") ?? defaultRelayId;
        const device = await authenticatePhone(request, relayId);
        if (!device) {
          sendJSON(response, 401, { error: "unauthorized" });
          return;
        }
        if (!pushLimiter.allow(`${relayId}\0${device.device_id}`)) { sendJSON(response, 429, { error: "push_rate_limited" }); return; }
        const body = await readJSON(request);
        const testing = url.pathname.endsWith("/test");
        if (!testing && (!body || !requiredString(body.apns_token, 512) || body.apns_token.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(body.apns_token) || !["sandbox", "prod"].includes(body.env))) {
          sendJSON(response, 400, { error: "invalid_apns_registration" });
          return;
        }
        await syncPushDevices(relayId);
        const result = await requestPush(relayId, testing ? "push.test" : "push.register", device.device_id, testing ? {} : body);
        if (!testing && result.ok) await store.updateAPNs(device.device_id, body, relayId);
        sendJSON(response, result.ok ? 200 : 502, result);
        return;
      }

      if (request.method === "DELETE" && url.pathname === "/v1/devices/me") {
        const relayId = url.searchParams.get("relay_id") ?? defaultRelayId;
        const device = await authenticatePhone(request, relayId);
        if (!device) { sendJSON(response, 401, { error: "unauthorized" }); return; }
        await store.revoke(device.device_id, relayId);
        await syncPushDevices(relayId);
        sendEmpty(response, 204);
        return;
      }

      sendJSON(response, 404, { error: "not_found" });
    } catch (error) {
      logger.error?.("broker request failed", error);
      sendJSON(response, error.statusCode ?? 500, {
        error: error.statusCode ? error.message : "internal_error",
      });
    }
  });

  const relayWSS = new WebSocketServer({ noServer: true, maxPayload: MAX_WS_PAYLOAD_BYTES });
  const phoneWSS = new WebSocketServer({ noServer: true, maxPayload: MAX_WS_PAYLOAD_BYTES });

  function sendToRelay(relayId, envelope) {
    const relay = relayConnections.get(relayId);
    if (relay?.readyState !== WebSocket.OPEN) return false;
    relay.send(JSON.stringify(envelope));
    return true;
  }

  function closePhoneSession(sessionId, notifyRelay = true) {
    const session = phoneSessions.get(sessionId);
    if (!session) return;
    phoneSessions.delete(sessionId);
    if (notifyRelay) {
      sendToRelay(session.relayId, { type: "session.close", session_id: sessionId });
    }
  }

  function disconnectRelayPhones(relayId, reason) {
    for (const [sessionId, session] of phoneSessions) {
      if (session.relayId !== relayId) continue;
      closePhoneSession(sessionId, false);
      session.socket.close(1013, reason);
    }
  }

  function rejectRelayPushes(socket) {
    for (const [id, pending] of pushRequests) {
      if (pending.relay !== socket) continue;
      clearTimeout(pending.timer);
      pushRequests.delete(id);
      pending.reject(Object.assign(new Error("relay_offline"), { statusCode: 503 }));
    }
  }

  relayWSS.on("connection", (socket, request, context) => {
    const previous = relayConnections.get(context.relayId);
    if (previous && previous !== socket) {
      // A new tunnel has no state for old session IDs. Make just these phones
      // reconnect so each receives a fresh session.open/hello on the new relay.
      disconnectRelayPhones(context.relayId, "relay connection replaced; reconnect required");
      rejectRelayPushes(previous);
      previous.close(4001, "replaced by a new relay connection");
    }
    relayConnections.set(context.relayId, socket);
    void syncPushDevices(context.relayId).catch(() => {});
    socket.isAlive = true;
    socket.on("pong", () => {
      socket.isAlive = true;
    });
    socket.on("message", (data, isBinary) => {
      if (relayConnections.get(context.relayId) !== socket) return;
      if (isBinary) return socket.close(1003, "text messages required");
      let envelope;
      try {
        envelope = JSON.parse(data.toString());
      } catch {
        return socket.close(1007, "invalid JSON");
      }
      if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) return socket.close(1008, "invalid envelope");
      if (envelope.type === "push.result") {
        const pending = pushRequests.get(envelope.session_id);
        if (!pending || pending.relay !== socket) return;
        clearTimeout(pending.timer);
        pushRequests.delete(envelope.session_id);
        try {
          const result = JSON.parse(envelope.text);
          if (typeof result?.ok !== "boolean") throw new Error("invalid push response");
          pending.resolve(result);
        } catch { pending.reject(Object.assign(new Error("invalid_push_response"), { statusCode: 502 })); }
        return;
      }
      if (
        !requiredString(envelope.session_id) ||
        !["session.text", "session.close"].includes(envelope.type)
      ) {
        return socket.close(1008, "invalid envelope");
      }
      const session = phoneSessions.get(envelope.session_id);
      if (!session || session.relayId !== context.relayId || session.relay !== socket) return;
      if (envelope.type === "session.close") {
        session.socket.close(1000, "closed by relay");
        closePhoneSession(envelope.session_id, false);
        return;
      }
      if (typeof envelope.text !== "string") return socket.close(1008, "missing text");
      if (session.socket.readyState === WebSocket.OPEN) session.socket.send(envelope.text);
    });
    socket.on("close", () => {
      rejectRelayPushes(socket);
      if (relayConnections.get(context.relayId) !== socket) return;
      relayConnections.delete(context.relayId);
      disconnectRelayPhones(context.relayId, "relay offline");
    });
  });

  phoneWSS.on("connection", (socket, request, context) => {
    const relay = relayConnections.get(context.relayId);
    if (relay?.readyState !== WebSocket.OPEN) {
      socket.close(1013, "Mac relay offline");
      return;
    }
    const sessionId = randomUUID();
    phoneSessions.set(sessionId, {
      socket,
      relayId: context.relayId,
      relay,
      deviceId: context.device.device_id,
    });
    socket.isAlive = true;
    socket.on("pong", () => {
      socket.isAlive = true;
    });
    sendToRelay(context.relayId, {
      type: "session.open",
      session_id: sessionId,
      device_id: context.device.device_id,
    });
    socket.on("message", (data, isBinary) => {
      if (!phoneSessions.has(sessionId)) return;
      if (relayConnections.get(context.relayId) !== relay) {
        closePhoneSession(sessionId, false);
        socket.close(1013, "relay connection changed; reconnect required");
        return;
      }
      if (isBinary) return socket.close(1003, "text messages required");
      if (
        !sendToRelay(context.relayId, {
          type: "session.text",
          session_id: sessionId,
          text: data.toString(),
        })
      ) {
        socket.close(1013, "Mac relay offline");
      }
    });
    socket.on("close", () => closePhoneSession(sessionId));
  });

  async function handleUpgrade(request, socket, head) {
    let url;
    try {
      url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    } catch {
      rejectUpgrade(socket, 400, "invalid URL");
      return;
    }
    const relayId = url.searchParams.get("relay_id") ?? "";
    if (url.pathname === "/v1/relay/ws") {
      const token = bearerToken(request);
      const relay = relays.get(relayId);
      if (
        !relay ||
        !token ||
        !secretEquals(token, relay.relayToken)
      ) {
        rejectUpgrade(socket, 401, "invalid relay credentials");
        return;
      }
      relayWSS.handleUpgrade(request, socket, head, (webSocket) => {
        relayWSS.emit("connection", webSocket, request, { relayId });
      });
      return;
    }
    if (url.pathname === "/v1/ws") {
      const device = await authenticatePhone(request, relayId);
      if (!device) {
        rejectUpgrade(socket, 401, "invalid device credentials");
        return;
      }
      if (relayConnections.get(relayId)?.readyState !== WebSocket.OPEN) {
        rejectUpgrade(socket, 503, "Mac relay offline");
        return;
      }
      phoneWSS.handleUpgrade(request, socket, head, (webSocket) => {
        phoneWSS.emit("connection", webSocket, request, { relayId, device });
      });
      return;
    }
    rejectUpgrade(socket, 404, "not found");
  }

  server.on("upgrade", (request, socket, head) => {
    handleUpgrade(request, socket, head).catch((error) => {
      logger.error?.("broker upgrade failed", error);
      if (!socket.destroyed) rejectUpgrade(socket, 500, "internal error");
    });
  });

  const heartbeat = setInterval(() => {
    for (const webSocketServer of [relayWSS, phoneWSS]) {
      for (const socket of webSocketServer.clients) {
        if (socket.isAlive === false) {
          socket.terminate();
          continue;
        }
        socket.isAlive = false;
        socket.ping();
      }
    }
  }, config.heartbeatMs ?? 30_000);
  heartbeat.unref();
  // Refresh the allow-list even when a device was revoked by the separate CLI.
  const pushSync = setInterval(() => { for (const id of relayConnections.keys()) void syncPushDevices(id).catch(() => {}); }, config.pushSyncMs ?? 15_000);
  pushSync.unref();

  return {
    server,
    async listen() {
      await new Promise((resolveListen, rejectListen) => {
        server.once("error", rejectListen);
        server.listen(config.port, config.host, () => {
          server.off("error", rejectListen);
          resolveListen();
        });
      });
      return server.address();
    },
    async close() {
      clearInterval(heartbeat);
      clearInterval(pushSync);
      for (const pending of pushRequests.values()) {
        clearTimeout(pending.timer);
        pending.reject(Object.assign(new Error("broker_stopped"), { statusCode: 503 }));
      }
      pushRequests.clear();
      for (const webSocketServer of [relayWSS, phoneWSS]) {
        for (const socket of webSocketServer.clients) socket.terminate();
        webSocketServer.close();
      }
      if (server.listening) {
        await new Promise((resolveClose) => server.close(resolveClose));
      }
    },
  };
}

async function main() {
  const config = configFromEnvironment();
  const broker = await createBrokerServer(config);
  const address = await broker.listen();
  console.log(`cmux broker listening on ${address.address}:${address.port}`);
  const stop = async () => {
    await broker.close();
    process.exit(0);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

const invokedDirectly =
  process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
