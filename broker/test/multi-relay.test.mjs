import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { WebSocket } from "ws";
import { configFromEnvironment, createBrokerServer, DeviceStore, parseRelayConfiguration } from "../src/server.mjs";

const definitions = [
  { relay_id: "home-mac", relay_token: "home-relay-secret", pairing_code: "home-pair-secret" },
  { relay_id: "linux-box", relay_token: "linux-relay-secret", pairing_code: "linux-pair-secret" },
];
const silence = { error() {} };
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fixture(options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "panecast-multi-broker-"));
  const broker = await createBrokerServer({
    host: "127.0.0.1", port: 0, relays: definitions,
    dataFile: join(directory, "devices.json"), logger: silence,
    heartbeatMs: 60_000, ...options,
  });
  const address = await broker.listen();
  return { broker, directory, url: `http://127.0.0.1:${address.port}`,
    async close() { await broker.close(); await rm(directory, { recursive: true, force: true }); } };
}
async function pair(fx, index, overrides = {}) {
  return fetch(`${fx.url}/v1/devices/me/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
    relay_id: definitions[index].relay_id, pairing_code: definitions[index].pairing_code,
    client_id: "the-same-phone", device_name: "Test phone", ...overrides,
  }) });
}
function connection(url, token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers: { authorization: `Bearer ${token}` } });
    const messages = [], queued = [], waiters = new Set();
    ws.on("message", (raw) => {
      let frame; try { frame = JSON.parse(raw.toString()); } catch { frame = raw.toString(); }
      messages.push(frame);
      for (const waiter of waiters) {
        if (waiter.predicate(frame)) { waiter.finish(null, frame); return; }
      }
      queued.push(frame);
    });
    const next = (predicate, timeout = 3000) => {
      const at = queued.findIndex(predicate);
      if (at >= 0) return Promise.resolve(queued.splice(at, 1)[0]);
      return new Promise((resolveFrame, rejectFrame) => {
        const waiter = { predicate, finish(error, frame) { clearTimeout(timer); waiters.delete(waiter); if (error) rejectFrame(error); else resolveFrame(frame); } };
        const timer = setTimeout(() => waiter.finish(new Error("frame timed out")), timeout);
        waiters.add(waiter);
      });
    };
    ws.on("error", reject);
    ws.once("open", () => resolve({ ws, messages, next }));
  });
}
const relay = (fx, index) => connection(`${fx.url.replace("http", "ws")}/v1/relay/ws?relay_id=${definitions[index].relay_id}`, definitions[index].relay_token);
const phone = (fx, index, token) => connection(`${fx.url.replace("http", "ws")}/v1/ws?relay_id=${definitions[index].relay_id}`, token);
function rejectedStatus(url, token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers: { authorization: `Bearer ${token}` } });
    ws.once("unexpected-response", (_request, response) => { resolve(response.statusCode); response.resume(); });
    ws.once("open", () => { ws.terminate(); reject(new Error("Unexpected successful upgrade")); });
    ws.on("error", () => {});
  });
}
const postPush = (fx, index, token, body, suffix = "") => fetch(`${fx.url}/v1/devices/me/apns${suffix}?relay_id=${definitions[index].relay_id}`, {
  method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body),
});
function pushReply(link, request, body) { link.ws.send(JSON.stringify({ type: "push.result", session_id: request.session_id, text: JSON.stringify(body) })); }

test("configuration accepts legacy variables and explicit relay JSON without echoing secrets", async () => {
  const legacy = configFromEnvironment({ CMUX_RELAY_ID: "old", CMUX_RELAY_TOKEN: "token", CMUX_PAIRING_CODE: "pair" });
  assert.equal(legacy.relayId, "old"); assert.equal(legacy.relayToken, "token");
  const parsed = configFromEnvironment({ CMUX_RELAYS_JSON: JSON.stringify({ relays: definitions }) });
  assert.deepEqual(parsed.relays.map((r) => r.relayId), ["home-mac", "linux-box"]);
  assert.throws(() => configFromEnvironment({ CMUX_RELAYS_FILE: "config.json", CMUX_RELAYS_JSON: "{}" }), /either/);
  assert.throws(() => parseRelayConfiguration('{"relays":"DO_NOT_ECHO_SECRET"'), (error) => !error.message.includes("DO_NOT_ECHO_SECRET"));
  for (const bad of [[], [definitions[0], definitions[0]], [definitions[0], { ...definitions[1], relay_token: definitions[0].relay_token }], [definitions[0], { ...definitions[1], pairing_code: definitions[0].relay_token }]]) {
    assert.throws(() => parseRelayConfiguration(JSON.stringify({ relays: bad })));
  }
  const directory = await mkdtemp(join(tmpdir(), "panecast-relay-config-"));
  let broker;
  try {
    const file = join(directory, "relays.json"); await writeFile(file, JSON.stringify({ relays: definitions }), { mode: 0o600 });
    const config = configFromEnvironment({ CMUX_RELAYS_FILE: file, CMUX_BROKER_PORT: "0", CMUX_BROKER_DATA_DIR: directory });
    broker = await createBrokerServer({ ...config, logger: silence }); const address = await broker.listen();
    const health = await (await fetch(`http://127.0.0.1:${address.port}/v1/health`)).json();
    assert.equal(health.ok, true); assert.equal("relay_online" in health, false);
  } finally { await broker?.close(); await rm(directory, { recursive: true, force: true }); }
});

test("pairing codes, relay tokens and phone credentials are isolated by relay", async () => {
  const fx = await fixture();
  try {
    assert.equal((await pair(fx, 1, { pairing_code: definitions[0].pairing_code })).status, 403);
    const a = await (await pair(fx, 0)).json(), b = await (await pair(fx, 1)).json();
    assert.notEqual(a.device_id, b.device_id);
    const wsBase = fx.url.replace("http", "ws");
    assert.equal(await rejectedStatus(`${wsBase}/v1/relay/ws?relay_id=linux-box`, definitions[0].relay_token), 401);
    assert.equal(await rejectedStatus(`${wsBase}/v1/ws?relay_id=linux-box`, a.token), 401);
    assert.equal(await rejectedStatus(`${wsBase}/v1/ws?relay_id=home-mac`, b.token), 401);
    assert.equal((await postPush(fx, 1, a.token, { apns_token: "aabb", env: "prod" })).status, 401);
    assert.equal((await fetch(`${fx.url}/v1/devices/me?relay_id=linux-box`, { method: "DELETE", headers: { authorization: `Bearer ${a.token}` } })).status, 401);
    const store = new DeviceStore(join(fx.directory, "devices.json")); await store.load();
    assert.equal(store.allDevices().length, 2);
    assert.equal((await store.authenticate(b.token, "linux-box")).device_id, b.device_id);
    assert.equal(await store.revoke(a.device_id, "linux-box"), false);
    assert.equal((await store.authenticate(a.token, "home-mac")).device_id, a.device_id);
  } finally { await fx.close(); }
});

test("health is scoped by authenticated relay and never lists other relays", async () => {
  const fx = await fixture();
  try {
    const a = await (await pair(fx, 0)).json(), b = await (await pair(fx, 1)).json();
    await relay(fx, 0);
    const publicHealth = await (await fetch(`${fx.url}/v1/health`)).json();
    assert.equal("relay_online" in publicHealth, false);
    assert.equal(JSON.stringify(publicHealth).includes("home-mac"), false);
    assert.equal(JSON.stringify(publicHealth).includes("linux-box"), false);
    const own = await (await fetch(`${fx.url}/v1/health?relay_id=home-mac`, { headers: { authorization: `Bearer ${a.token}` } })).json();
    assert.equal(own.relay_online, true);
    const other = await (await fetch(`${fx.url}/v1/health?relay_id=linux-box`, { headers: { authorization: `Bearer ${b.token}` } })).json();
    assert.equal(other.relay_online, false);
    for (const id of ["home-mac", "unknown"]) assert.equal((await fetch(`${fx.url}/v1/health?relay_id=${id}`)).status, 401);
    assert.equal((await fetch(`${fx.url}/v1/health?relay_id=linux-box`, { headers: { authorization: `Bearer ${a.token}` } })).status, 401);
  } finally { await fx.close(); }
});

test("a busy pairing bucket for one relay does not block another relay", async () => {
  const fx = await fixture({ pairingLimit: 1 });
  try {
    assert.equal((await pair(fx, 0, { pairing_code: "wrong" })).status, 403);
    assert.equal((await pair(fx, 0)).status, 429);
    assert.equal((await pair(fx, 1)).status, 200);
  } finally { await fx.close(); }
});

test("session frames cannot cross relays and replacing one tunnel only reconnects its phones", async () => {
  const fx = await fixture();
  try {
    const a = await (await pair(fx, 0)).json(), b = await (await pair(fx, 1)).json();
    const ra = await relay(fx, 0), rb = await relay(fx, 1);
    const pa = await phone(fx, 0, a.token), pb = await phone(fx, 1, b.token);
    const sa = await ra.next((f) => f.type === "session.open"), sb = await rb.next((f) => f.type === "session.open");
    pa.ws.send('{"from":"phone-a"}'); pb.ws.send('{"from":"phone-b"}');
    assert.equal((await ra.next((f) => f.type === "session.text")).text, '{"from":"phone-a"}');
    assert.equal((await rb.next((f) => f.type === "session.text")).text, '{"from":"phone-b"}');
    rb.ws.send(JSON.stringify({ type: "session.text", session_id: sa.session_id, text: '{"forged":true}' }));
    rb.ws.send(JSON.stringify({ type: "session.close", session_id: sa.session_id }));
    await assert.rejects(pa.next((f) => f.forged, 60), /timed out/);
    assert.equal(pa.ws.readyState, WebSocket.OPEN);
    const closedA = once(pa.ws, "close", { signal: AbortSignal.timeout(3000) });
    const newA = await relay(fx, 0);
    assert.equal((await closedA)[0], 1013);
    assert.equal(pb.ws.readyState, WebSocket.OPEN); assert.equal(rb.ws.readyState, WebSocket.OPEN);
    pb.ws.send('{"after":"replacement"}');
    assert.equal((await rb.next((f) => f.type === "session.text")).session_id, sb.session_id);
    const reconnectedA = await phone(fx, 0, a.token);
    const fresh = await newA.next((f) => f.type === "session.open"); assert.notEqual(fresh.session_id, sa.session_id);
    newA.ws.send(JSON.stringify({ type: "session.text", session_id: fresh.session_id, text: '{"new_relay":true}' }));
    assert.equal((await reconnectedA.next((f) => f.new_relay)).new_relay, true);
    const lostA = once(reconnectedA.ws, "close", { signal: AbortSignal.timeout(3000) }); newA.ws.close();
    assert.equal((await lostA)[0], 1013); assert.equal(pb.ws.readyState, WebSocket.OPEN);
  } finally { await fx.close(); }
});

test("push forwarding preserves preferences, isolates replies and syncs only each relay's devices", async () => {
  const fx = await fixture({ maxPendingPushPerRelay: 1 });
  try {
    const a = await (await pair(fx, 0)).json(), b = await (await pair(fx, 1)).json();
    const ra = await relay(fx, 0), rb = await relay(fx, 1);
    assert.deepEqual(JSON.parse((await ra.next((f) => f.type === "push.sync")).text), [a.device_id]);
    assert.deepEqual(JSON.parse((await rb.next((f) => f.type === "push.sync")).text), [b.device_id]);
    const preferences = { muted_workspaces: ["workspace-a"], needs_input_only: true, quiet_hours: { time_zone: "America/Los_Angeles" }, dedupe_seconds: 30 };
    let finishedA = false;
    const requestA = postPush(fx, 0, a.token, { apns_token: "aabbccdd", env: "prod", preferences, device_id: b.device_id }).then((r) => { finishedA = true; return r; });
    const ea = await ra.next((f) => f.type === "push.register");
    assert.equal(ea.device_id, a.device_id); assert.deepEqual(JSON.parse(ea.text).preferences, preferences);
    assert.equal((await postPush(fx, 0, a.token, { apns_token: "abcd", env: "prod" })).status, 429);
    pushReply(rb, ea, { ok: true, forwarded: true });
    const requestB = postPush(fx, 1, b.token, { apns_token: "eeff0011", env: "prod" });
    const eb = await rb.next((f) => f.type === "push.register"); assert.equal(eb.device_id, b.device_id);
    pushReply(rb, eb, { ok: true, forwarded: true, push_enabled: true, preferences_applied: true });
    assert.equal((await requestB).status, 200);
    await delay(20); assert.equal(finishedA, false);
    pushReply(ra, ea, { ok: true, forwarded: true, push_enabled: true, preferences_applied: true });
    const resultA = await requestA; assert.equal(resultA.status, 200); assert.equal((await resultA.json()).preferences_applied, true);
    const data = await readFile(join(fx.directory, "devices.json"), "utf8");
    assert.equal(data.includes("aabbccdd"), false); assert.equal(data.includes("eeff0011"), false);
  } finally { await fx.close(); }
});

test("revoking one computer's registration leaves the same phone's other registration active", async () => {
  const fx = await fixture();
  try {
    const a = await (await pair(fx, 0)).json(), b = await (await pair(fx, 1)).json();
    const ra = await relay(fx, 0), rb = await relay(fx, 1);
    const pa = await phone(fx, 0, a.token), pb = await phone(fx, 1, b.token);
    const sa = await ra.next((f) => f.type === "session.open"); await rb.next((f) => f.type === "session.open");
    const closed = once(pa.ws, "close", { signal: AbortSignal.timeout(3000) });
    const response = await fetch(`${fx.url}/v1/devices/me?relay_id=home-mac`, { method: "DELETE", headers: { authorization: `Bearer ${a.token}` } });
    assert.equal(response.status, 204); assert.equal((await closed)[0], 4003);
    assert.equal((await ra.next((f) => f.type === "session.close")).session_id, sa.session_id);
    assert.equal(pb.ws.readyState, WebSocket.OPEN);
    pb.ws.send('{"still":"authorized"}'); assert.equal((await rb.next((f) => f.type === "session.text")).text, '{"still":"authorized"}');
  } finally { await fx.close(); }
});

test("device CLI can list and revoke within a selected relay", async () => {
  const fx = await fixture();
  try {
    const a = await (await pair(fx, 0)).json(), b = await (await pair(fx, 1)).json();
    const script = join(dirname(fileURLToPath(import.meta.url)), "../src/devices.mjs");
    const exec = promisify(execFile), options = { env: { ...process.env, CMUX_BROKER_DATA_DIR: fx.directory } };
    const listing = await exec(process.execPath, [script, "list", "--relay", "linux-box"], options);
    assert.ok(listing.stdout.includes(b.device_id)); assert.equal(listing.stdout.includes(a.device_id), false);
    await assert.rejects(exec(process.execPath, [script, "revoke", a.device_id, "--relay", "linux-box"], options));
    const store = new DeviceStore(join(fx.directory, "devices.json"));
    assert.ok(await store.authenticate(a.token, "home-mac"));
    await exec(process.execPath, [script, "revoke", a.device_id, "--relay", "home-mac"], options);
    assert.equal(await store.authenticate(a.token, "home-mac"), null); assert.ok(await store.authenticate(b.token, "linux-box"));
  } finally { await fx.close(); }
});
