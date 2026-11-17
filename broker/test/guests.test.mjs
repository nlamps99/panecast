import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import test from "node:test";
import { WebSocket } from "ws";
import { createBrokerServer } from "../src/server.mjs";

async function fixture(options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "cmux-broker-guests-"));
  const broker = await createBrokerServer({
    host: "127.0.0.1", port: 0, relayId: "home-mac", relayToken: "relay-token", pairingCode: "pairing-code",
    dataFile: join(directory, "devices.json"), trustProxy: false, heartbeatMs: 60_000, logger: { error() {} }, ...options,
  });
  const address = await broker.listen();
  const baseURL = `http://127.0.0.1:${address.port}`;
  return { directory, baseURL, ws: baseURL.replace("http", "ws"), async close() { await broker.close(); await rm(directory, { recursive: true, force: true }); } };
}

const relayHeaders = { authorization: "Bearer relay-token", "content-type": "application/json" };
const createGuest = (fx, body = { share_id: "share-1", name: "论文" }, headers = relayHeaders) =>
  fetch(`${fx.baseURL}/v1/relay/guests?relay_id=home-mac`, { method: "POST", headers, body: JSON.stringify(body) });

function open(url, options) {
  return new Promise((resolve, reject) => { const socket = new WebSocket(url, options); socket.once("open", () => resolve(socket)); socket.once("error", reject); });
}
function relayFrames(socket) {
  const frames = [];
  socket.on("message", (data) => frames.push(JSON.parse(data.toString())));
  return {
    frames,
    async next(match) {
      for (let i = 0; i < 200; i++) { const found = frames.find(match); if (found) return found; await new Promise((r) => setTimeout(r, 10)); }
      throw new Error("relay frame not received");
    },
  };
}
function rejected(url, options) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, options);
    socket.once("unexpected-response", (_request, response) => { resolve(response.statusCode); response.resume(); });
    socket.once("open", () => reject(new Error("unexpectedly opened")));
    socket.once("error", () => {});
  });
}

test("only the relay's own token can issue, list and revoke guests", async () => {
  const fx = await fixture();
  try {
    assert.equal((await createGuest(fx, undefined, { authorization: "Bearer wrong", "content-type": "application/json" })).status, 401);
    assert.equal((await createGuest(fx, undefined, { authorization: "Bearer pairing-code", "content-type": "application/json" })).status, 401);
    assert.equal((await createGuest(fx, { share_id: "../x", name: "a" })).status, 400);
    const created = await createGuest(fx);
    assert.equal(created.status, 201);
    const guest = await created.json();
    assert.match(guest.token, /^[\w-]{40,}$/);
    const stored = await readFile(join(fx.directory, "guests.json"), "utf8");
    assert.equal(stored.includes(guest.token), false, "only a hash is stored");
    assert.equal((await readFile(join(fx.directory, "devices.json"), "utf8").catch(() => "")).includes(guest.device_id), false, "guests stay out of devices.json");
    const listed = await (await fetch(`${fx.baseURL}/v1/relay/guests?relay_id=home-mac`, { headers: relayHeaders })).json();
    assert.deepEqual(listed.guests.map((g) => [g.device_id, g.share_id, g.name]), [[guest.device_id, "share-1", "论文"]]);
    assert.equal(listed.guests[0].token_hash, undefined);
    assert.equal((await fetch(`${fx.baseURL}/v1/relay/guests/${guest.device_id}?relay_id=home-mac`, { method: "DELETE", headers: { authorization: "Bearer wrong" } })).status, 401);
    assert.equal((await fetch(`${fx.baseURL}/v1/relay/guests/${guest.device_id}?relay_id=home-mac`, { method: "DELETE", headers: relayHeaders })).status, 204);
    assert.equal((await fetch(`${fx.baseURL}/v1/relay/guests/${guest.device_id}?relay_id=home-mac`, { method: "DELETE", headers: relayHeaders })).status, 404);
  } finally { await fx.close(); }
});

test("a guest connection is marked for the relay and cannot register push", async () => {
  const fx = await fixture();
  try {
    const guest = await (await createGuest(fx)).json();
    const relaySocket = await open(`${fx.ws}/v1/relay/ws?relay_id=home-mac&features=guest-sessions`, { headers: { authorization: "Bearer relay-token" } });
    const relay = relayFrames(relaySocket);
    const sync = await relay.next((f) => f.type === "push.sync");
    assert.equal(JSON.parse(sync.text).includes(guest.device_id), false, "guests are not push devices");
    const phone = await open(`${fx.ws}/v1/ws?relay_id=home-mac`, { headers: { authorization: `Bearer ${guest.token}` } });
    const opened = await relay.next((f) => f.type === "session.open");
    assert.equal(opened.device_id, guest.device_id);
    assert.deepEqual(opened.guest, { share_id: "share-1" });
    const health = await fetch(`${fx.baseURL}/v1/health?relay_id=home-mac`, { headers: { authorization: `Bearer ${guest.token}` } });
    assert.equal(health.status, 200);
    assert.equal((await health.json()).window_sharing, true);
    const push = await fetch(`${fx.baseURL}/v1/devices/me/apns?relay_id=home-mac`, { method: "POST", headers: { authorization: `Bearer ${guest.token}` }, body: JSON.stringify({ apns_token: "aabb", env: "prod" }) });
    assert.equal(push.status, 403);
    phone.close(); relaySocket.close();
  } finally { await fx.close(); }
});

test("an ordinary paired device is never marked as a guest", async () => {
  const fx = await fixture();
  try {
    const device = await (await fetch(`${fx.baseURL}/v1/devices/me/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ relay_id: "home-mac", pairing_code: "pairing-code", client_id: "c", device_name: "Mac" }) })).json();
    const relaySocket = await open(`${fx.ws}/v1/relay/ws?relay_id=home-mac&features=guest-sessions`, { headers: { authorization: "Bearer relay-token" } });
    const relay = relayFrames(relaySocket);
    const phone = await open(`${fx.ws}/v1/ws?relay_id=home-mac`, { headers: { authorization: `Bearer ${device.token}` } });
    const opened = await relay.next((f) => f.type === "session.open");
    assert.equal(opened.guest, undefined);
    phone.close(); relaySocket.close();
  } finally { await fx.close(); }
});

test("revoking a guest closes its live session and refuses reconnection", async () => {
  const fx = await fixture({ pushSyncMs: 60_000 });
  try {
    const guest = await (await createGuest(fx)).json();
    const relaySocket = await open(`${fx.ws}/v1/relay/ws?relay_id=home-mac&features=guest-sessions`, { headers: { authorization: "Bearer relay-token" } });
    const relay = relayFrames(relaySocket);
    const phone = await open(`${fx.ws}/v1/ws?relay_id=home-mac`, { headers: { authorization: `Bearer ${guest.token}` } });
    const opened = await relay.next((f) => f.type === "session.open");
    const closed = once(phone, "close", { signal: AbortSignal.timeout(3000) });
    assert.equal((await fetch(`${fx.baseURL}/v1/relay/guests/${guest.device_id}?relay_id=home-mac`, { method: "DELETE", headers: relayHeaders })).status, 204);
    assert.equal((await closed)[0], 4003);
    await relay.next((f) => f.type === "session.close" && f.session_id === opened.session_id);
    assert.equal(await rejected(`${fx.ws}/v1/ws?relay_id=home-mac`, { headers: { authorization: `Bearer ${guest.token}` } }), 401);
    relaySocket.close();
  } finally { await fx.close(); }
});

test("a guest can forget itself", async () => {
  const fx = await fixture();
  try {
    const guest = await (await createGuest(fx)).json();
    assert.equal((await fetch(`${fx.baseURL}/v1/devices/me?relay_id=home-mac`, { method: "DELETE", headers: { authorization: `Bearer ${guest.token}` } })).status, 204);
    const listed = await (await fetch(`${fx.baseURL}/v1/relay/guests?relay_id=home-mac`, { headers: relayHeaders })).json();
    assert.deepEqual(listed.guests, []);
  } finally { await fx.close(); }
});

test("a relay that does not confine guests never receives them", async () => {
  const fx = await fixture();
  try {
    const guest = await (await createGuest(fx)).json();
    const oldRelay = await open(`${fx.ws}/v1/relay/ws?relay_id=home-mac`, { headers: { authorization: "Bearer relay-token" } });
    const relay = relayFrames(oldRelay);
    assert.equal(await rejected(`${fx.ws}/v1/ws?relay_id=home-mac`, { headers: { authorization: `Bearer ${guest.token}` } }), 503);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(relay.frames.some((f) => f.type === "session.open"), false);
    oldRelay.close();
  } finally { await fx.close(); }
});
