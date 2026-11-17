import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createBrokerServer, configFromEnvironment } from "../src/server.mjs";
import { createFileServer, Pace } from "../src/files-server.mjs";
import { cleanFileName, issueTransfer, signTicket, verifyTicket } from "../src/file-links.mjs";

const SECRET = "s".repeat(48);
const sha = (data) => createHash("sha256").update(data).digest("hex");
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

async function files(options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "panecast-files-"));
  const { server, sweep } = await createFileServer({ secret: SECRET, directory, prefix: "/panecast-files", ...options });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}/panecast-files`;
  return { directory, url, sweep, links: { url, secret: SECRET }, async close() { await new Promise((r) => server.close(r)); await rm(directory, { recursive: true, force: true }); } };
}

async function put(transfer, data) {
  return fetch(transfer.upload_url, { method: "PUT", body: data, headers: { "content-type": "application/octet-stream" } });
}

test("tickets are bound to their operation, object and lifetime", () => {
  const token = signTicket(SECRET, { v: 1, op: "get", id: "a".repeat(22), exp: 2000 });
  assert.ok(verifyTicket(SECRET, token, { op: "get", id: "a".repeat(22), now: 1_000_000 }));
  assert.equal(verifyTicket(SECRET, token, { op: "put", id: "a".repeat(22), now: 1_000_000 }), null);
  assert.equal(verifyTicket(SECRET, token, { op: "get", id: "b".repeat(22), now: 1_000_000 }), null);
  assert.equal(verifyTicket(SECRET, token, { op: "get", id: "a".repeat(22), now: 2_000_000 }), null, "expired");
  assert.equal(verifyTicket("x".repeat(48), token, { op: "get", id: "a".repeat(22), now: 1_000_000 }), null, "other secret");
  const [body] = token.split(".");
  const forged = Buffer.from(JSON.stringify({ v: 1, op: "get", id: "a".repeat(22), exp: 9e9 })).toString("base64url");
  assert.equal(verifyTicket(SECRET, `${forged}.${token.split(".")[1]}`, { op: "get", id: "a".repeat(22), now: 1_000_000 }), null);
  assert.ok(body);
  assert.equal(cleanFileName("../../etc/pass\nwd\".docx"), "pass wd.docx".replace(" ", ""));
  assert.equal(cleanFileName(".hidden"), "hidden");
});

test("an uploaded file downloads once with its ticket, and only as uploaded", async () => {
  const fx = await files();
  try {
    const data = Buffer.from("论文正文\n".repeat(1000));
    const transfer = issueTransfer(fx.links, { name: "论文.docx", type: DOCX, size: data.length, sha256: sha(data) });
    assert.equal((await fetch(transfer.download_url)).status, 404, "nothing before the upload");
    assert.equal((await put(transfer, data)).status, 201);
    assert.equal((await put(transfer, data)).status, 409, "a ticket uploads once");
    const response = await fetch(transfer.download_url);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), DOCX);
    assert.match(response.headers.get("content-disposition"), /^inline; .*filename\*=UTF-8''%E8%AE%BA%E6%96%87\.docx$/);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.match(response.headers.get("content-security-policy"), /sandbox/);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), data);
    const forced = await fetch(`${transfer.download_url}&download=1`);
    assert.match(forced.headers.get("content-disposition"), /^attachment;/);
    await forced.arrayBuffer();
    const bad = transfer.download_url.replace(/t=.*/, "t=" + signTicket("y".repeat(48), { v: 1, op: "get", id: transfer.id, exp: 9e9 }));
    assert.equal((await fetch(bad)).status, 403);
    const upload = transfer.upload_url.replace("/v1/o/", "/v1/o/").replace(/\?t=/, "/x?t=");
    assert.equal((await fetch(upload)).status, 403, "an upload ticket does not download");
  } finally { await fx.close(); }
});

test("the content must match the ticket, and risky types are only downloaded", async () => {
  const fx = await files();
  try {
    const data = Buffer.from("<script>alert(1)</script>");
    const wrong = issueTransfer(fx.links, { name: "a.txt", type: "text/plain", size: data.length, sha256: sha("other") });
    assert.equal((await put(wrong, data)).status, 400);
    const short = issueTransfer(fx.links, { name: "a.txt", type: "text/plain", size: data.length + 1, sha256: sha(data) });
    assert.equal((await put(short, data)).status, 400);
    assert.deepEqual(await readdir(join(fx.directory, "partial")), [], "failed uploads leave nothing");
    const html = issueTransfer(fx.links, { name: "page.html", type: "text/html", size: data.length, sha256: sha(data) });
    assert.equal((await put(html, data)).status, 201);
    const response = await fetch(html.download_url);
    assert.equal(response.headers.get("content-type"), "application/octet-stream");
    assert.match(response.headers.get("content-disposition"), /^attachment;/);
    await response.arrayBuffer();
    const pdf = Buffer.from("%PDF-1.4\n");
    const document = issueTransfer(fx.links, { name: "a.pdf", type: "application/pdf", size: pdf.length, sha256: sha(pdf) });
    assert.equal((await put(document, pdf)).status, 201);
    const shown = await fetch(document.download_url);
    assert.equal(shown.headers.get("content-type"), "application/pdf");
    assert.equal(shown.headers.get("content-security-policy"), null, "browsers refuse sandboxed PDFs");
    await shown.arrayBuffer();
  } finally { await fx.close(); }
});

test("files and download links expire", async () => {
  let clock = Date.now();
  const fx = await files({ now: () => clock, retentionSeconds: 60 });
  try {
    const data = Buffer.from("x");
    const transfer = issueTransfer(fx.links, { name: "a.txt", type: "text/plain", size: 1, sha256: sha(data) }, { now: clock, downloadSeconds: 30 });
    assert.equal((await put(transfer, data)).status, 201);
    clock += 31_000;
    assert.equal((await fetch(transfer.download_url)).status, 403, "link expired");
    clock += 30_000;
    await fx.sweep();
    assert.deepEqual(await readdir(join(fx.directory, "objects")), [], "file removed");
  } finally { await fx.close(); }
});

test("downloads are paced together", async () => {
  const pace = new Pace(1_000_000);
  const started = Date.now();
  await Promise.all([pace.take(100_000), pace.take(100_000), pace.take(100_000)]);
  await pace.take(1);
  assert.ok(Date.now() - started >= 280, "300 KB at 1 MB/s takes about 300 ms");
});

test("the broker issues file links to the relay only when configured", async () => {
  const directory = await mkdtemp(join(tmpdir(), "panecast-file-links-"));
  const fx = await files();
  const base = { host: "127.0.0.1", port: 0, relayId: "home-mac", relayToken: "relay-token", pairingCode: "pairing-code",
    dataFile: join(directory, "devices.json"), trustProxy: false, heartbeatMs: 60_000, logger: { error() {} } };
  const plain = await createBrokerServer(base);
  const configured = await createBrokerServer({ ...base, dataFile: join(directory, "b", "devices.json"), files: { ...fx.links, maxBytes: 1000 } });
  try {
    const plainURL = `http://127.0.0.1:${(await plain.listen()).port}`;
    const url = `http://127.0.0.1:${(await configured.listen()).port}`;
    const ask = (base, body, token = "relay-token") => fetch(`${base}/v1/relay/files?relay_id=home-mac`, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    const file = { name: "论文.docx", type: DOCX, size: 5, sha256: sha("hello") };
    assert.equal((await ask(plainURL, file)).status, 404);
    assert.equal((await (await fetch(`${plainURL}/v1/health`)).json()).file_links, false);
    assert.equal((await (await fetch(`${url}/v1/health`)).json()).file_links, true);
    assert.equal((await ask(url, file, "pairing-code")).status, 401);
    assert.equal((await ask(url, { ...file, sha256: "x" })).status, 400);
    assert.equal((await ask(url, { ...file, size: 1001 })).status, 413);
    const response = await ask(url, file);
    assert.equal(response.status, 201);
    const transfer = await response.json();
    assert.equal((await put(transfer, Buffer.from("hello"))).status, 201);
    assert.equal(await (await fetch(transfer.download_url)).text(), "hello");
  } finally {
    await plain.close(); await configured.close(); await fx.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("file links need both the URL and the secret", async () => {
  const directory = await mkdtemp(join(tmpdir(), "panecast-file-env-"));
  try {
    const key = join(directory, "key");
    await writeFile(key, "k".repeat(40));
    assert.throws(() => configFromEnvironment({ CMUX_FILES_URL: "https://files.example/panecast-files" }), /together/);
    assert.throws(() => configFromEnvironment({ CMUX_FILES_URL: "http://files.example/x", CMUX_FILES_SECRET_FILE: key }), /HTTPS/);
    const config = configFromEnvironment({ CMUX_FILES_URL: "https://files.example/panecast-files/", CMUX_FILES_SECRET_FILE: key });
    assert.equal(config.files.url, "https://files.example/panecast-files");
    assert.equal(configFromEnvironment({}).files, null);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("a forwarding server in front of the proxy does not hide the client", async () => {
  const { remoteIP } = await import("../src/server.mjs");
  const request = (forwarded) => ({ headers: { "x-forwarded-for": forwarded }, socket: { remoteAddress: "10.0.0.2" } });
  const hops = new Set(["175.178.106.217"]);
  assert.equal(remoteIP(request("203.0.113.9"), true, hops), "203.0.113.9");
  assert.equal(remoteIP(request("203.0.113.9, 175.178.106.217"), true, hops), "203.0.113.9", "old address forwarding");
  assert.equal(remoteIP(request("1.1.1.1, 203.0.113.9, 175.178.106.217"), true, hops), "203.0.113.9", "spoofed entries stay ignored");
  assert.equal(remoteIP(request("175.178.106.217"), true, hops), "175.178.106.217");
  assert.equal(remoteIP(request("1.1.1.1, 203.0.113.9"), true), "203.0.113.9");
  assert.equal(remoteIP(request("203.0.113.9"), false), "10.0.0.2");
  const config = configFromEnvironment({ CMUX_TRUST_PROXY: "1", CMUX_TRUSTED_PROXIES: " 175.178.106.217 ,", CMUX_PUBLIC_URL: "https://panecast.drinklake.com/cmux-remote" });
  assert.deepEqual([...config.trustedHops], ["175.178.106.217"]);
  assert.equal(config.publicURL, "https://panecast.drinklake.com/cmux-remote");
});
