/**
 * Local failure-injection integration tests. Requires Node 22.13+, tmux and
 * `npm ci` in both broker/ and relay-tmux/. No real computers, tokens or Apple
 * services are used. Every tmux server has a dedicated random socket name.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import * as module from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WebSocket, WebSocketServer } from "ws";
import { createBrokerServer } from "../src/server.mjs";

const root = new URL("../../", import.meta.url);
const appRoot = new URL("client/src/", root).href;
const tmuxRoot = new URL("relay-tmux/", root);
const missing = typeof module.stripTypeScriptTypes !== "function" ? "Requires Node 22.13+ for the actual client TypeScript modules"
  : !existsSync(new URL("node_modules/ws/package.json", tmuxRoot)) ? "Run npm ci in relay-tmux/ before integration tests"
    : spawnSync("tmux", ["-V"]).status !== 0 ? "Install tmux to run integration fault tests" : false;
let TmuxBackend, createTmuxRelay, PushService, RelayConnection, TerminalSession, AutoChannel, InboxStore;
if (!missing) {
  // Load the actual transport/session code instead of recreating its retry logic.
  module.register("data:text/javascript," + encodeURIComponent(`
    import { readFile } from 'node:fs/promises';
    import { stripTypeScriptTypes } from 'node:module';
    let root;
    export function initialize(data) { root = data.root; }
    export async function resolve(specifier, context, next) {
      try { return await next(specifier, context); }
      catch (error) {
        if (specifier.startsWith('.') && context.parentURL?.startsWith(root) && !/\\.[cm]?[jt]s$/.test(specifier)) return next(specifier + '.ts', context);
        throw error;
      }
    }
    export async function load(url, context, next) {
      if (url.startsWith(root) && url.endsWith('.ts')) return { format: 'module', source: stripTypeScriptTypes(await readFile(new URL(url), 'utf8'), { mode: 'transform' }), shortCircuit: true };
      return next(url, context);
    }
  `), { parentURL: import.meta.url, data: { root: appRoot } });
  const storage = new Map();
  globalThis.__DEV__ = false;
  globalThis.require = (name) => {
    assert.equal(name, "@react-native-async-storage/async-storage");
    return { default: { getItem: async (key) => storage.get(key) ?? null, setItem: async (key, value) => { storage.set(key, value); }, removeItem: async (key) => { storage.delete(key); } } };
  };
  ({ TmuxBackend } = await import(new URL("src/tmux.mjs", tmuxRoot)));
  ({ createTmuxRelay } = await import(new URL("src/server.mjs", tmuxRoot)));
  ({ PushService } = await import(new URL("src/push.mjs", tmuxRoot)));
  ({ RelayConnection } = await import(appRoot + "protocol/connection.ts"));
  ({ TerminalSession } = await import(appRoot + "session/terminalSession.ts"));
  ({ AutoChannel } = await import(appRoot + "state/autoChannel.ts"));
  ({ InboxStore } = await import(appRoot + "session/inboxStore.ts"));
}
const integration = (name, fn) => test(name, { skip: missing, timeout: 25_000 }, fn);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate, label, timeout = 6500) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const result = await predicate(); if (result) return result; await delay(20); }
  throw new Error(`Timed out: ${label}`);
}
function snapshotFrame(data) { try { return JSON.parse(data.toString()); } catch { return null; } }

/** Proxies only authenticated relay tunnels; phones connect to the real broker. */
async function faultProxy(brokerURL) {
  const server = http.createServer((_request, response) => { response.writeHead(404); response.end(); });
  const wss = new WebSocketServer({ noServer: true });
  const tunnels = new Set(), blocked = new Set(), rules = [], dropped = [];
  server.on("upgrade", (request, socket, head) => {
    const relayId = new URL(request.url, "http://localhost").searchParams.get("relay_id");
    if (blocked.has(relayId)) { socket.end("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n"); return; }
    const upstream = new WebSocket(brokerURL.replace("http", "ws") + request.url, { headers: { authorization: request.headers.authorization } });
    const tunnel = { relayId, upstream, downstream: null, requests: new Map() };
    tunnels.add(tunnel);
    const queued = [];
    upstream.on("message", (data) => {
      const envelope = snapshotFrame(data);
      if (envelope?.type === "session.text") {
        const payload = snapshotFrame(envelope.text);
        if (payload?.method) tunnel.requests.set(`${envelope.session_id}|${payload.id}`, payload);
      }
      if (tunnel.downstream?.readyState === WebSocket.OPEN) tunnel.downstream.send(data.toString()); else queued.push(data.toString());
    });
    upstream.on("error", () => { socket.destroy(); tunnel.downstream?.terminate(); });
    upstream.on("close", () => { tunnels.delete(tunnel); tunnel.downstream?.terminate(); });
    upstream.once("open", () => {
      if (socket.destroyed) { upstream.terminate(); return; }
      wss.handleUpgrade(request, socket, head, (downstream) => {
        tunnel.downstream = downstream;
        downstream.on("error", () => upstream.terminate());
        downstream.on("close", () => { tunnels.delete(tunnel); upstream.terminate(); });
        downstream.on("message", (data) => {
          const envelope = snapshotFrame(data), payload = envelope?.type === "session.text" ? snapshotFrame(envelope.text) : null;
          const original = payload?.id ? tunnel.requests.get(`${envelope.session_id}|${payload.id}`) : null;
          const context = { relayId, envelope, payload, request: original };
          const index = rules.findIndex((rule) => rule(context));
          if (index >= 0) { rules.splice(index, 1); dropped.push(context); return; }
          if (upstream.readyState === WebSocket.OPEN) upstream.send(data.toString());
        });
        for (const data of queued) downstream.send(data);
      });
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`, dropped,
    dropNext(rule) { rules.push(rule); },
    cut(relayId) { blocked.add(relayId); for (const tunnel of tunnels) if (tunnel.relayId === relayId) { tunnel.upstream.terminate(); tunnel.downstream?.terminate(); } },
    release(relayId) { blocked.delete(relayId); },
    async close() { for (const tunnel of tunnels) { tunnel.upstream.terminate(); tunnel.downstream?.terminate(); } wss.close(); await new Promise((resolve) => server.close(resolve)); },
  };
}

async function fixture(t, count = 2) {
  const directory = await mkdtemp(join(tmpdir(), "panecast-faults-"));
  const relays = Array.from({ length: count }, (_, i) => ({ relay_id: `computer-${i}`, relay_token: `relay-secret-${i}`, pairing_code: `pair-secret-${i}` }));
  const broker = await createBrokerServer({ host: "127.0.0.1", port: 0, relays, dataFile: join(directory, "broker-devices.json"), logger: { error() {} }, pushSyncMs: 100 });
  const address = await broker.listen(), url = `http://127.0.0.1:${address.port}`;
  const proxy = await faultProxy(url), nodes = [], clients = [], pushes = [];
  t.after(async () => {
    for (const client of clients) { client.session?.dispose(); client.inbox?.dispose(); client.channel.stop(); }
    for (const node of nodes) await node.runtime.close();
    await proxy.close(); await broker.close();
    for (const node of nodes) await node.native.tmux(["kill-server"]).catch(() => {});
    await rm(directory, { recursive: true, force: true });
  });
  for (let index = 0; index < count; index++) {
    const config = { broker: { url: proxy.url, ...relays[index] }, state_directory: join(directory, `relay-${index}`),
      notify_socket: join(directory, `notify-${index}.sock`), lan: { pairing_code: `lan-pair-${index}` }, host: "127.0.0.1", port: 0, poll_ms: 100 };
    const native = new TmuxBackend({ socketName: `panecast-test-${randomUUID()}`, configFile: "/dev/null" }), sent = [];
    const backend = {
      surface: (p) => native.surface(p), capture: (p, lines) => native.capture(p, lines),
      dispatch: async (method, params) => { if (method.startsWith("surface.send")) sent.push({ method, params }); return native.dispatch(method, params); },
    };
    // These transport tests need a ready shell, not the user's login profile.
    // A new tmux pane can accept paste/Enter while zsh is still initializing
    // and subsequently flush that input, producing unrelated timing failures.
    const workspace_id = (await native.tmux(['new-session', '-d', '-P', '-F', '#{session_id}', '-s', `fault-${index}`, '--', '/usr/bin/env', 'ENV=', 'PS1=PANECAST-READY> ', '/bin/sh', '-i'])).trim();
    const surface_id = (await native.surfaces(workspace_id))[0].id;
    await until(async () => (await native.capture({ workspace_id, surface_id }, 30)).rows.some((row) => row.includes('PANECAST-READY>')), 'isolated shell ready');
    const node = { native, backend, sent, config, target: { workspaceId: workspace_id, surfaceId: surface_id }, ids: { workspace_id, surface_id } };
    node.start = async () => {
      const push = new PushService({ path: join(config.state_directory, "push-test.json"), relayId: relays[index].relay_id,
        config: { key_path: "fake", key_id: "fake", team_id: "fake", topic: "fake", env: "prod" },
        now: () => Date.UTC(2026, 10, 4, 23), send: async (_config, device, notification, relayId) => { pushes.push({ token: device.token, id: notification.id, relayId }); return { status: 200 }; } });
      node.runtime = await createTmuxRelay(config, { backend, push });
      node.address = await node.runtime.start();
    };
    await node.start(); nodes.push(node);
  }
  async function pair(index, clientId = randomUUID()) {
    const response = await fetch(`${url}/v1/devices/me/register`, { method: "POST", body: JSON.stringify({ relay_id: relays[index].relay_id, pairing_code: relays[index].pairing_code, client_id: clientId, device_name: "Isolated integration phone" }) });
    assert.equal(response.status, 200); return response.json();
  }
  async function online(index, credentials) {
    return until(async () => (await (await fetch(`${url}/v1/health?relay_id=${relays[index].relay_id}`, { headers: { authorization: `Bearer ${credentials.token}` } })).json()).relay_online, `relay ${index} online`);
  }
  function connection(index, credentials, overrides = {}) {
    return new RelayConnection({ url: `${url.replace("http", "ws")}/v1/ws?relay_id=${relays[index].relay_id}`, token: credentials.token, deviceId: credentials.device_id,
      appVersion: "fault-integration", createSocket: (url, protocols, headers) => new WebSocket(url, protocols, { headers }), rpcTimeoutMs: 700,
      backoffBaseMs: 60, backoffMaxMs: 200, idleProbeMs: 20_000, ...overrides });
  }
  async function client(index, credentials = null) {
    credentials ??= await pair(index); await online(index, credentials);
    const channel = connection(index, credentials), session = new TerminalSession(channel);
    const item = { channel, session, credentials }; clients.push(item);
    session.setTarget(nodes[index].target); channel.start();
    await until(() => channel.isOpen && session.getState().subscription === "live", "phone terminal subscription");
    return item;
  }
  return { directory, url, proxy, nodes, relays, clients, pushes, pair, client, connection, online };
}

integration("real tunnels: offline events recover after reconnect and restart without interrupting another computer", async (t) => {
  const fx = await fixture(t), a = await fx.client(0), b = await fx.client(1), node = fx.nodes[0];
  a.inbox = new InboxStore(a.channel, { storageKey: `fault-inbox-${randomUUID()}` });
  await until(() => a.inbox.getState().sync?.status === "ready", "initial inbox sync");
  await node.runtime.notify({ id: "prompt-1", ...node.ids, needs_input: true, title: "needs input", request_id: "request-1" });
  await until(() => a.inbox.getState().items.some((item) => item.id === "prompt-1"), "live prompt");
  a.inbox.markRead("prompt-1");
  const before = await a.channel.call("inbox.sync");
  fx.proxy.cut("computer-0"); await until(() => !a.channel.isOpen && node.runtime.sessions.size === 0, "tunnel disconnected");
  assert.equal((await b.session.submitLine("printf 'other-computer-still-live\\n'")).status, "sent");
  await node.runtime.notify({ id: "offline-1", ...node.ids, title: "offline result one" });
  await node.runtime.notify({ id: "offline-2", ...node.ids, title: "offline result two" });
  await node.runtime.ingestEvent({ type: "event", category: "agent", name: "serverRequest/resolved", payload: { ...node.ids, request_id: "request-1", resolved: true } });
  fx.proxy.release("computer-0"); await fx.online(0, a.credentials);
  await until(() => a.channel.isOpen && a.inbox.getState().sync?.status === "ready" && a.inbox.getState().items.some((item) => item.id === "offline-2"), "recovered notifications");
  assert.equal(a.inbox.getState().items.filter((item) => item.id === "prompt-1").length, 1);
  const prompt = a.inbox.getState().items.find((item) => item.id === "prompt-1");
  assert.equal(prompt.read, true); assert.ok(prompt.resolvedAt);
  assert.equal(b.channel.isOpen, true);
  const catchup = await a.channel.call("inbox.sync", { cursor: before.next_cursor });
  assert.deepEqual(catchup.events.slice(0, 2).map((event) => event.payload.id), ["offline-1", "offline-2"]);
  await node.runtime.close(); await node.start(); await fx.online(0, a.credentials);
  await until(() => a.channel.isOpen, "reconnected after relay process restart");
  const persisted = await a.channel.call("inbox.sync", { cursor: before.next_cursor });
  assert.equal(persisted.reset, false); assert.equal(persisted.head_cursor, catchup.head_cursor);
  assert.equal(persisted.events.length, 3);
});

for (const stage of ["surface.send_text", "surface.send_key"]) integration(`real client never replays a command after losing its ${stage} acknowledgement`, async (t) => {
  const fx = await fixture(t, 1), phone = await fx.client(0), node = fx.nodes[0];
  const path = join(fx.directory, "executions.txt");
  fx.proxy.dropNext((frame) => frame.relayId === "computer-0" && frame.request?.method === stage);
  const receipt = await phone.session.submitLine(`printf 'once\\n' >> '${path}'`);
  assert.equal(receipt.status, "unknown"); assert.equal(fx.proxy.dropped.length, 1);
  const before = node.sent.length;
  if (stage === "surface.send_key") await until(async () => (await readFile(path, "utf8").catch(() => "")) === "once\n", "command executed once");
  else assert.equal(existsSync(path), false);
  fx.proxy.cut("computer-0"); await until(() => !phone.channel.isOpen, "phone detects missing tunnel");
  fx.proxy.release("computer-0"); await fx.online(0, phone.credentials);
  await until(() => phone.channel.isOpen && phone.session.getState().subscription === "live", "terminal restored");
  await phone.channel.call("workspace.list");
  assert.equal(node.sent.length, before, "reconnecting must not replay text or Enter");
  assert.equal(stage === "surface.send_key" ? await readFile(path, "utf8") : existsSync(path), stage === "surface.send_key" ? "once\n" : false);
});

integration("actual LAN/broker connections switch on network reports and foreground wake without replaying input", async (t) => {
  const fx = await fixture(t, 1), credentials = await fx.pair(0), node = fx.nodes[0]; await fx.online(0, credentials);
  const directURL = `http://127.0.0.1:${node.address.port}`;
  const lan = await (await fetch(`${directURL}/v1/devices/me/register`, { method: "POST", body: JSON.stringify({ pairing_code: "lan-pair-0", client_id: "lan-phone", device_name: "LAN phone" }) })).json();
  let kind = "cellular", healthy = true; const watchers = new Set();
  const channel = new AutoChannel({ preference: "auto", hasLan: true,
    network: { current: async () => kind, watch: (listener) => { watchers.add(listener); return () => watchers.delete(listener); } },
    connect: (transport) => transport === "broker" ? fx.connection(0, credentials) : fx.connection(0, lan, { url: directURL.replace("http", "ws") + "/v1/ws" }),
    probeLan: async () => healthy && (await (await fetch(`${directURL}/v1/health`)).json()).ok,
    networkDebounceMs: 10, lanRetryMinMs: 300, lanRetryMaxMs: 1000, lanConnectTimeoutMs: 1000,
  });
  const session = new TerminalSession(channel); fx.clients.push({ channel, session }); session.setTarget(node.target); channel.start();
  await until(() => channel.isOpen && channel.transport === "broker" && session.getState().subscription === "live", "initial broker path");
  assert.equal((await session.submitLine("printf 'before-handoff\\n'")).status, "sent"); const sent = node.sent.length;
  kind = "lan"; channel.wake();
  await until(() => channel.isOpen && channel.transport === "lan" && session.getState().subscription === "live", "wake upgrades to LAN");
  healthy = false; channel.wake();
  await until(() => channel.isOpen && channel.transport === "broker" && session.getState().subscription === "live", "unreachable LAN falls back");
  healthy = true; kind = "lan"; channel.wake();
  await until(() => channel.transport === "lan" && session.getState().subscription === "live", "return to LAN");
  kind = "cellular"; for (const listener of watchers) listener(kind);
  await until(() => channel.transport === "broker" && session.getState().subscription === "live", "cellular uses broker");
  assert.equal(node.sent.length, sent, "transport changes never replay acknowledged input");
});

integration("multiple phones keep push preferences and revocation isolated through the real relay policy", async (t) => {
  const fx = await fixture(t), first = await fx.client(0), second = await fx.client(0), other = await fx.client(1);
  const register = async (index, phone, token, preferences) => {
    const response = await fetch(`${fx.url}/v1/devices/me/apns?relay_id=computer-${index}`, { method: "POST", headers: { authorization: `Bearer ${phone.credentials.token}` }, body: JSON.stringify({ apns_token: token, env: "prod", preferences }) });
    assert.equal(response.status, 200); assert.equal((await response.json()).preferences_applied, true);
  };
  await register(0, first, "aabb", { muted_workspaces: [fx.nodes[0].ids.workspace_id], dedupe_seconds: 0 });
  await register(0, second, "ccdd", { needs_input_only: true, dedupe_seconds: 60 });
  await register(1, other, "aabb", { dedupe_seconds: 0 });
  await fx.nodes[0].runtime.notify({ id: "normal-a", ...fx.nodes[0].ids, title: "completed" });
  assert.equal(fx.pushes.length, 0);
  await fx.nodes[1].runtime.notify({ id: "normal-b", ...fx.nodes[1].ids, title: "completed" });
  assert.deepEqual(fx.pushes, [{ relayId: "computer-1", token: "aabb", id: "normal-b" }]);
  await fx.nodes[0].runtime.notify({ id: "needs-a", ...fx.nodes[0].ids, title: "needs input", needs_input: true });
  await fx.nodes[0].runtime.notify({ id: "duplicate-a", ...fx.nodes[0].ids, title: "needs input", needs_input: true });
  assert.deepEqual(fx.pushes.at(-1), { relayId: "computer-0", token: "ccdd", id: "needs-a" }); assert.equal(fx.pushes.length, 2);
  await register(0, first, "aabb", { quiet_hours: { enabled: true, start_minutes: 22 * 60, end_minutes: 8 * 60, time_zone: "UTC" }, dedupe_seconds: 0 });
  const revoked = await fetch(`${fx.url}/v1/devices/me?relay_id=computer-0`, { method: "DELETE", headers: { authorization: `Bearer ${second.credentials.token}` } }); assert.equal(revoked.status, 204);
  await until(() => second.channel.status.state === "auth_failed", "revoked phone fails authentication");
  await fx.nodes[0].runtime.notify({ id: "quiet-a", ...fx.nodes[0].ids, title: "another needs input", needs_input: true });
  assert.equal(fx.pushes.length, 2);
  assert.equal(first.channel.isOpen, true); assert.equal(other.channel.isOpen, true);
  assert.equal((await other.channel.call("relay.diagnostics")).backend, "tmux");
});

integration("a missing terminal diff is repaired by the next live revision", async (t) => {
  const fx = await fixture(t, 1), node = fx.nodes[0];
  const script = join(fx.directory, "screen.cjs");
  await writeFile(script, "process.stdin.setRawMode(true); process.stdout.write('\\x1b[2J\\x1b[HROW0=before\\nROW1=before\\nREADY'); process.stdin.on('data', data => { if(data.includes(97)) process.stdout.write('\\x1b[1;1HROW0=after '); if(data.includes(98)) process.stdout.write('\\x1b[2;1HROW1=after '); });");
  const pane = (await node.native.tmux(["new-window", "-d", "-P", "-F", "#{pane_id}", "-t", node.ids.workspace_id, "--", process.execPath, script])).trim();
  node.ids.surface_id = pane; node.target.surfaceId = pane;
  const phone = await fx.client(0);
  await until(() => phone.session.getState().screen.rows.join("\n").includes("ROW0=before"), "screen initialized");
  fx.proxy.dropNext((frame) => frame.payload?.type === "screen.diff" && frame.payload.ops.some((op) => op.text?.includes("ROW0=after")));
  await phone.channel.call("surface.send_text", { ...node.ids, text: "a" });
  await until(() => fx.proxy.dropped.length === 1, "injected dropped diff");
  await phone.channel.call("surface.send_text", { ...node.ids, text: "b" });
  await until(() => phone.session.getState().screen.rows.join("\n").includes("ROW1=after"), "later diff arrived");
  await until(() => phone.session.getState().screen.rows.join("\n").includes("ROW0=after"), "repair missing diff", 1500);
});

integration("history pages stay ordered through a fast output burst and recover expired snapshots after reconnect", async (t) => {
  const fx = await fixture(t, 1), phone = await fx.client(0), node = fx.nodes[0];
  const command = (start, end) => `panecast_line=${start}; while [ "$panecast_line" -le ${end} ]; do printf 'HISTORY-%04d\\n' "$panecast_line"; panecast_line=$((panecast_line+1)); done`;
  assert.equal((await phone.session.submitLine(command(1, 300))).status, "sent");
  await until(() => phone.session.getState().screen.rows.some((row) => row.includes("HISTORY-0300")), "first history batch displayed");
  phone.session.startBrowsing();
  assert.equal((await phone.session.submitLine(command(301, 900))).status, "sent");
  await until(() => phone.session.getState().screen.rows.some((row) => row.includes("HISTORY-0900")), "newer burst displayed behind frozen history");
  for (let page = 0; page < 20 && !phone.session.getState().browse.exhausted; page++) await phone.session.loadOlder();
  let browse = phone.session.getState().browse;
  assert.equal(browse.error, null); assert.equal(browse.exhausted, true);
  const history = [...browse.olderRows, ...browse.frozenRows].map((row) => row.replace(/\x1b\[[0-9;]*m/g, '').trim()).filter((row) => /^HISTORY-\d{4}$/.test(row));
  assert.deepEqual(history, Array.from({ length: 300 }, (_, i) => `HISTORY-${String(i + 1).padStart(4, '0')}`));
  phone.session.resumeLive(); phone.session.startBrowsing(); await phone.session.loadOlder();
  const oldCursor = phone.session.getState().browse.cursor;
  assert.ok(oldCursor);
  fx.proxy.cut('computer-0'); await until(() => !phone.channel.isOpen && node.runtime.sessions.size === 0, 'history session disconnected');
  fx.proxy.release('computer-0'); await fx.online(0, phone.credentials);
  await until(() => phone.channel.isOpen && phone.session.getState().subscription === 'live', 'history session reconnected');
  await phone.session.loadOlder();
  assert.equal(phone.session.getState().browse.restartRequired, true);
  await phone.session.loadOlder({ retry: true });
  browse = phone.session.getState().browse;
  assert.equal(browse.error, null); assert.notEqual(browse.cursor, oldCursor);
});
