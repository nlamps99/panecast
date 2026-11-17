/**
 * A shared window end to end: the real broker, the real hub and its share
 * store, with a stand-in cmux. Requires `npm ci` in relay-tmux/.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import test from "node:test";
import { WebSocketServer } from "ws";
import { createBrokerServer } from "../src/server.mjs";

const tmuxRoot = new URL("../../relay-tmux/", import.meta.url);
const missing = existsSync(new URL("node_modules/ws/package.json", tmuxRoot)) ? false : "Run npm ci in relay-tmux/ before integration tests";
const load = (path) => import(new URL(path, tmuxRoot));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function cmux(t) {
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(server, "listening");
  t.after(async () => { for (const ws of server.clients) ws.terminate(); await new Promise((resolve) => server.close(resolve)); });
  const calls = [];
  server.on("connection", (ws) => ws.on("message", (raw) => {
    const m = JSON.parse(raw); if (!m.method) return;
    calls.push(m);
    let result = {};
    if (m.method === "workspace.list") result = { workspaces: [{ id: "$0", title: "private" }, { id: "$1", title: "paper" }] };
    if (m.method === "surface.list") result = { surfaces: [{ id: m.params.workspace_id === "$1" ? "%1" : "%0", type: "terminal" }] };
    ws.send(JSON.stringify({ id: m.id, ok: true, result }));
  }));
  return { calls, url: `ws://127.0.0.1:${server.address().port}` };
}

test("a share key reaches exactly one window through the real broker and stops on revoke", { skip: missing, timeout: 20_000 }, async (t) => {
  const { createHub } = await load("src/hub/server.mjs");
  const { RpcPeer } = await load("src/hub/rpc.mjs");
  const { scoped } = await load("src/hub/ids.mjs");
  const { BrokerGuests, ShareStore, encodeShareKey, decodeShareKey } = await load("src/hub/share.mjs");
  const directory = await mkdtemp(join(tmpdir(), "panecast-share-e2e-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const broker = await createBrokerServer({ host: "127.0.0.1", port: 0, relayId: "home-mac", relayToken: "relay-token", pairingCode: "pairing-code",
    dataFile: join(directory, "broker", "devices.json"), trustProxy: false, heartbeatMs: 60_000, logger: { error() {} } });
  const address = await broker.listen(); t.after(() => broker.close());
  const baseURL = `http://127.0.0.1:${address.port}`;
  const upstream = await cmux(t);
  const brokerConfig = { url: baseURL, relay_id: "home-mac", relay_token: "relay-token" };
  const hub = await createHub({ state_directory: join(directory, "hub"), port: 0, broker: brokerConfig,
    sources: [{ id: "cmux", type: "cmux", name: "cmux", url: upstream.url, token: "fixture-only", device_id: "hub" }] });
  await hub.start(); t.after(() => hub.close());
  for (let i = 0; i < 200 && !(await (await fetch(`${baseURL}/v1/health`)).json()).relay_online; i++) await delay(10);

  // What `panecast share create` records, against the real broker.
  const guests = new BrokerGuests(brokerConfig);
  const issued = await guests.create("s1", "论文");
  await new ShareStore(join(directory, "hub", "shares", "shares.json")).write([{ id: "s1", name: "论文", directory: "/tmp/paper", source_id: "cmux",
    workspace_id: "$1", surface_id: "%1", created_at: "", revoked_at: null, guests: [{ device_id: issued.deviceId, label: "", created_at: "", revoked_at: null }] }]);
  const key = decodeShareKey(encodeShareKey({ serverUrl: baseURL, relayId: "home-mac", deviceId: issued.deviceId, token: issued.token, name: "论文" }));

  const guest = new RpcPeer({ url: `${key.serverUrl.replace("http", "ws")}/v1/ws?relay_id=${key.relayId}`, token: key.token, protocols: ["cmuxremote.v1"],
    hello: { deviceId: key.deviceId, protocolVersion: 1, appVersion: "test" } });
  await guest.connect(); t.after(() => guest.close());
  const own = { workspace_id: scoped("cmux", "$1"), surface_id: scoped("cmux", "%1") };
  assert.deepEqual((await guest.call("workspace.list", {})).workspaces.map((w) => w.id), [own.workspace_id]);
  await assert.rejects(guest.call("surface.list", { workspace_id: scoped("cmux", "$0") }), { code: "forbidden" });
  await assert.rejects(guest.call("surface.send_text", { ...own, text: "!cat ~/.ssh/id_rsa" }), { code: "guest_shell" });
  await guest.call("surface.send_text", { ...own, text: "请润色摘要" });
  assert.deepEqual(upstream.calls.filter((c) => c.method === "surface.send_text").map((c) => [c.params.surface_id, c.params.text]), [["%1", "请润色摘要"]]);

  // The owner's own pairing keeps full access on the same relay.
  const owner = await (await fetch(`${baseURL}/v1/devices/me/register`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ relay_id: "home-mac", pairing_code: "pairing-code", client_id: "owner", device_name: "Mac" }) })).json();
  const ownerPeer = new RpcPeer({ url: `${baseURL.replace("http", "ws")}/v1/ws?relay_id=home-mac`, token: owner.token, protocols: ["cmuxremote.v1"],
    hello: { deviceId: owner.device_id, protocolVersion: 1, appVersion: "test" } });
  await ownerPeer.connect(); t.after(() => ownerPeer.close());
  assert.equal((await ownerPeer.call("workspace.list", {})).workspaces.length, 2);

  const closed = new Promise((resolve) => guest.socket?.once?.("close", resolve) ?? resolve());
  await guests.revoke(issued.deviceId);
  await Promise.race([closed, delay(3000)]);
  await assert.rejects(guest.call("workspace.list", {}));
  assert.deepEqual(await guests.list(), []);
});

test("a guest gets a working download link for a shared file through the real broker and file relay", { skip: missing, timeout: 20_000 }, async (t) => {
  const { createHub } = await load("src/hub/server.mjs");
  const { RpcPeer } = await load("src/hub/rpc.mjs");
  const { BrokerGuests, ShareStore } = await load("src/hub/share.mjs");
  const { createFileServer } = await import("../src/files-server.mjs");
  const { writeFile, mkdir, realpath } = await import("node:fs/promises");
  const directory = await realpath(await mkdtemp(join(tmpdir(), "panecast-share-files-e2e-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const secret = "f".repeat(48);
  const files = await createFileServer({ secret, directory: join(directory, "relay"), prefix: "/panecast-files" });
  await new Promise((resolve) => files.server.listen(0, "127.0.0.1", resolve)); t.after(() => new Promise((r) => files.server.close(r)));
  const filesURL = `http://127.0.0.1:${files.server.address().port}/panecast-files`;
  const broker = await createBrokerServer({ host: "127.0.0.1", port: 0, relayId: "home-mac", relayToken: "relay-token", pairingCode: "pairing-code",
    dataFile: join(directory, "broker", "devices.json"), trustProxy: false, heartbeatMs: 60_000, logger: { error() {} }, files: { url: filesURL, secret } });
  const baseURL = `http://127.0.0.1:${(await broker.listen()).port}`; t.after(() => broker.close());
  const upstream = await cmux(t);
  const brokerConfig = { url: baseURL, relay_id: "home-mac", relay_token: "relay-token" };
  const hub = await createHub({ state_directory: join(directory, "hub"), port: 0, broker: brokerConfig,
    sources: [{ id: "cmux", type: "cmux", name: "cmux", url: upstream.url, token: "fixture-only", device_id: "hub" }] });
  await hub.start(); t.after(() => hub.close());
  for (let i = 0; i < 200 && !(await (await fetch(`${baseURL}/v1/health`)).json()).relay_online; i++) await delay(10);
  const shared = join(directory, "paper");
  await mkdir(shared);
  await writeFile(join(shared, "论文-修改版.docx"), "修改后的论文");
  const issued = await new BrokerGuests(brokerConfig).create("s1", "论文");
  await new ShareStore(join(directory, "hub", "shares", "shares.json")).write([{ id: "s1", name: "论文", directory: shared, source_id: "cmux",
    workspace_id: "$1", surface_id: "%1", created_at: "", revoked_at: null, guests: [{ device_id: issued.deviceId, label: "", created_at: "", revoked_at: null }] }]);
  const guest = new RpcPeer({ url: `${baseURL.replace("http", "ws")}/v1/ws?relay_id=home-mac`, token: issued.token, protocols: ["cmuxremote.v1"],
    hello: { deviceId: issued.deviceId, protocolVersion: 1, appVersion: "test" } });
  await guest.connect(); t.after(() => guest.close());
  const { files: listed } = await guest.call("share.files.list", {});
  assert.deepEqual(listed.map((f) => f.path), ["论文-修改版.docx"]);
  const link = await guest.call("share.file.link", { path: join(shared, "论文-修改版.docx") });
  assert.equal(link.name, "论文-修改版.docx");
  assert.ok(link.url.startsWith(`${filesURL}/v1/o/`));
  const response = await fetch(link.url);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "修改后的论文");
  assert.match(response.headers.get("content-disposition"), /filename\*=UTF-8''/);
  await assert.rejects(guest.call("share.file.link", { path: "/etc/hosts" }), { code: "forbidden" });
});
