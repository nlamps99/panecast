import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WebSocket } from "ws";
import { createBrokerServer } from "../src/server.mjs";
import { shareKeyCredentials } from "../src/task-routes.mjs";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "cmux-broker-tasks-"));
  const broker = await createBrokerServer({
    host: "127.0.0.1", port: 0, relayId: "home-mac", relayToken: "relay-token", pairingCode: "pairing-code",
    dataFile: join(directory, "devices.json"), trustProxy: false, heartbeatMs: 60_000, logger: { error() {} },
  });
  const address = await broker.listen();
  const baseURL = `http://127.0.0.1:${address.port}`;
  const guest = await (await fetch(`${baseURL}/v1/relay/guests?relay_id=home-mac`, { method: "POST", headers: { authorization: "Bearer relay-token", "content-type": "application/json" },
    body: JSON.stringify({ share_id: "st1", name: "任务" }) })).json();
  const key = "pcs1." + Buffer.from(JSON.stringify({ v: 1, s: baseURL, r: "home-mac", d: guest.device_id, t: guest.token, n: "任务" })).toString("base64url");
  return { directory, baseURL, ws: baseURL.replace("http", "ws"), guest, key, async close() { await broker.close(); await rm(directory, { recursive: true, force: true }); } };
}

/** A computer that answers task calls the way the gateway does, recording each session it sees. */
async function relay(fx, answer) {
  const socket = new WebSocket(`${fx.ws}/v1/relay/ws?relay_id=home-mac&features=guest-sessions`, { headers: { authorization: "Bearer relay-token" } });
  await new Promise((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
  const seen = { opened: [], hellos: [], calls: [], closed: [] };
  socket.on("message", async (raw) => {
    const frame = JSON.parse(raw.toString());
    if (frame.type === "session.open") seen.opened.push(frame);
    if (frame.type === "session.close") seen.closed.push(frame.session_id);
    if (frame.type !== "session.text") return;
    const message = JSON.parse(frame.text);
    if (!message.method) { seen.hellos.push(message); return; }
    seen.calls.push(message);
    const reply = await answer(message);
    socket.send(JSON.stringify({ type: "session.text", session_id: frame.session_id, text: JSON.stringify({ id: message.id, ...reply }) }));
  });
  return { socket, seen };
}

test("a share key opens a guest session for each task call and nothing else", async () => {
  const fx = await fixture();
  try {
    const computer = await relay(fx, (message) => {
      if (message.method === "task.submit") return { ok: true, result: { task: { id: "t0000000001", status: "queued" } } };
      if (message.method === "task.get") return { ok: true, result: { task: { id: message.params.task_id, status: "done", result: "好了" } } };
      if (message.method === "task.list") return { ok: true, result: { tasks: [] } };
      return { ok: false, error: { code: "task_not_found", message: "找不到这个任务" } };
    });
    const headers = { authorization: `Bearer ${fx.key}`, "content-type": "application/json" };
    const image = `data:image/png;base64,${Buffer.from("png").toString("base64")}`;
    const submitted = await fetch(`${fx.baseURL}/v1/tasks?wait=5`, { method: "POST", headers, body: JSON.stringify({ text: "看图", images: [{ data: image }], continue: true, other: "dropped" }) });
    assert.equal(submitted.status, 201);
    assert.deepEqual(await submitted.json(), { task: { id: "t0000000001", status: "done", result: "好了" } });
    // One session: opened as the guest of its share, hello first, then submit and the wait.
    assert.deepEqual(computer.seen.opened.map((frame) => [frame.device_id, frame.guest]), [[fx.guest.device_id, { share_id: "st1" }]]);
    assert.equal(computer.seen.hellos[0].protocolVersion, 1);
    assert.deepEqual(computer.seen.calls.map((call) => call.method), ["task.submit", "task.get"]);
    assert.deepEqual(computer.seen.calls[0].params, { text: "看图", attachments: [{ data: image }], continue: true });
    assert.deepEqual(computer.seen.calls[1].params, { task_id: "t0000000001", wait_s: 5 });
    for (let i = 0; i < 50 && computer.seen.closed.length < 1; i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(computer.seen.closed.length, 1, "the session closes after the request");

    // The token alone works with relay_id, as for the app.
    const got = await fetch(`${fx.baseURL}/v1/tasks/t0000000001?relay_id=home-mac&wait=900`, { headers: { authorization: `Bearer ${fx.guest.token}` } });
    assert.equal(got.status, 200);
    assert.equal(computer.seen.calls.at(-1).params.wait_s, 300, "a wait is capped at five minutes");
    assert.equal((await fetch(`${fx.baseURL}/v1/tasks`, { headers })).status, 200);
    const missing = await fetch(`${fx.baseURL}/v1/tasks/tffffffffff/cancel`, { method: "POST", headers });
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), { error: "task_not_found", message: "找不到这个任务" });
    computer.socket.close();
  } finally { await fx.close(); }
});

test("task calls need a guest key of a computer that is online", async () => {
  const fx = await fixture();
  try {
    const headers = { authorization: `Bearer ${fx.key}`, "content-type": "application/json" };
    assert.equal((await fetch(`${fx.baseURL}/v1/tasks`, { method: "POST", headers, body: JSON.stringify({ text: "x" }) })).status, 503);
    assert.equal((await fetch(`${fx.baseURL}/v1/tasks`, { headers: { authorization: "Bearer pcs1.bm9wZQ" } })).status, 401);
    assert.equal((await fetch(`${fx.baseURL}/v1/tasks?relay_id=home-mac`, { headers: { authorization: "Bearer relay-token" } })).status, 401, "the relay token is not a guest key");
    assert.equal((await fetch(`${fx.baseURL}/v1/tasks`)).status, 401);
    // A paired device (the owner's phone) is not a share key either.
    const device = await (await fetch(`${fx.baseURL}/v1/devices/me/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ relay_id: "home-mac", pairing_code: "pairing-code", client_id: "c", device_name: "Mac" }) })).json();
    assert.equal((await fetch(`${fx.baseURL}/v1/tasks?relay_id=home-mac`, { headers: { authorization: `Bearer ${device.token}` } })).status, 401);
    assert.equal((await fetch(`${fx.baseURL}/v1/tasks/a/b/c`, { headers })).status, 404);
    // A computer that answers nothing yet is waited for, then reported.
    const silent = await relay(fx, () => new Promise(() => {}));
    const aborted = await fetch(`${fx.baseURL}/v1/tasks`, { headers, signal: AbortSignal.timeout(300) }).then(() => "answered", (error) => error.name);
    assert.equal(aborted, "TimeoutError");
    silent.socket.close();
    assert.deepEqual(shareKeyCredentials(fx.key), { relayId: "home-mac", token: fx.guest.token });
    assert.equal(shareKeyCredentials("pcs1.%%%"), null);
  } finally { await fx.close(); }
});

test("a computer going offline mid-request ends the request", async () => {
  const fx = await fixture();
  try {
    let computer;
    computer = await relay(fx, () => { computer.socket.close(); return new Promise(() => {}); });
    const response = await fetch(`${fx.baseURL}/v1/tasks/t0000000001?wait=60`, { headers: { authorization: `Bearer ${fx.key}` } });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: "computer_offline" });
  } finally { await fx.close(); }
});
