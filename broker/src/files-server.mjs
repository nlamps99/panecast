#!/usr/bin/env node
import { createHash, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream, readFileSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import { join } from "node:path";
import { once } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";

import { MAX_FILE_BYTES, cleanFileName, validId, validSha256, verifyTicket } from "./file-links.mjs";

/**
 * A small file relay for shared windows. The gateway uploads a file it was
 * asked for with a ticket the broker signed; the guest downloads it with the
 * matching download ticket. Files are kept for a short time and then removed.
 */

// Shown in the browser. Office files are not rendered by browsers, so iOS
// hands them to Quick Look; everything else is downloaded as opaque bytes.
const SERVED = new Map([
  ["application/pdf", "application/pdf"],
  ["image/png", "image/png"],
  ["image/jpeg", "image/jpeg"],
  ["image/gif", "image/gif"],
  ["image/webp", "image/webp"],
  ["image/heic", "image/heic"],
  ["text/plain", "text/plain; charset=utf-8"],
  ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  ["application/vnd.openxmlformats-officedocument.presentationml.presentation", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
  ["application/msword", "application/msword"],
  ["application/vnd.ms-excel", "application/vnd.ms-excel"],
  ["application/vnd.ms-powerpoint", "application/vnd.ms-powerpoint"],
]);
const CHUNK = 64 * 1024;

/** Paces all downloads together, so the relay leaves bandwidth for the other services on its server. */
export class Pace {
  constructor(bytesPerSecond) { this.rate = bytesPerSecond; this.next = 0; }
  async take(bytes) {
    if (!(this.rate > 0)) return;
    const now = Date.now();
    const start = Math.max(now, this.next);
    this.next = start + (bytes / this.rate) * 1000;
    if (start > now) await sleep(start - now);
  }
}

function disposition(kind, name) {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/[\\"]/g, "_");
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

function send(response, status, body) {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" });
  response.end(JSON.stringify(body));
}

export function configFromEnvironment(environment = process.env) {
  const secretFile = environment.PANECAST_FILES_SECRET_FILE;
  if (!secretFile) throw new Error("PANECAST_FILES_SECRET_FILE is required");
  const secret = readFileSync(secretFile, "utf8").trim();
  if (secret.length < 32) throw new Error("PANECAST_FILES_SECRET_FILE must hold at least 32 characters");
  return {
    secret,
    directory: environment.PANECAST_FILES_DIR ?? "/data",
    host: environment.PANECAST_FILES_HOST ?? "0.0.0.0",
    port: Number(environment.PANECAST_FILES_PORT ?? 4410),
    prefix: (environment.PANECAST_FILES_PREFIX ?? "/panecast-files").replace(/\/+$/, ""),
    bytesPerSecond: Number(environment.PANECAST_FILES_RATE ?? 2 * 1024 * 1024),
    maxBytes: Number(environment.PANECAST_FILES_MAX_BYTES ?? MAX_FILE_BYTES),
    maxTotalBytes: Number(environment.PANECAST_FILES_MAX_TOTAL ?? 8 * 1024 * 1024 * 1024),
    retentionSeconds: Number(environment.PANECAST_FILES_RETENTION ?? 7200),
  };
}

export async function createFileServer(options) {
  const config = { bytesPerSecond: 0, maxBytes: MAX_FILE_BYTES, maxTotalBytes: 8 * 1024 ** 3, retentionSeconds: 7200, prefix: "", ...options };
  const objects = join(config.directory, "objects");
  const partial = join(config.directory, "partial");
  await mkdir(objects, { recursive: true });
  await mkdir(partial, { recursive: true });
  const pace = new Pace(config.bytesPerSecond);
  const now = () => (config.now ? config.now() : Date.now());
  let stored = 0;

  async function sweep() {
    let total = 0;
    for (const name of await readdir(objects).catch(() => [])) {
      if (!name.endsWith(".json")) continue;
      const id = name.slice(0, -5);
      const meta = await readFile(join(objects, name), "utf8").then(JSON.parse).catch(() => null);
      if (!meta || meta.expires_at * 1000 <= now()) {
        await rm(join(objects, id), { force: true });
        await rm(join(objects, name), { force: true });
      } else total += meta.size;
    }
    // Objects without metadata, and uploads that never finished.
    const stale = async (path) => {
      const info = await stat(path).catch(() => null);
      return info !== null && now() - info.mtimeMs > 3_600_000;
    };
    for (const name of await readdir(objects).catch(() => [])) {
      if (name.endsWith(".json") || await stat(join(objects, `${name}.json`)).then(() => true, () => false)) continue;
      if (await stale(join(objects, name))) await rm(join(objects, name), { force: true });
    }
    for (const name of await readdir(partial).catch(() => [])) {
      if (await stale(join(partial, name))) await rm(join(partial, name), { force: true });
    }
    stored = total;
  }

  async function upload(request, response, id, ticket) {
    if (!validSha256(ticket.sha256) || !Number.isInteger(ticket.size) || ticket.size < 0 || ticket.size > config.maxBytes) return send(response, 413, { error: "too_large" });
    const declared = request.headers["content-length"];
    if (declared !== undefined && Number(declared) !== ticket.size) return send(response, 400, { error: "size_mismatch" });
    if (await stat(join(objects, `${id}.json`)).then(() => true, () => false)) return send(response, 409, { error: "exists" });
    if (stored + ticket.size > config.maxTotalBytes) return send(response, 507, { error: "storage_full" });
    const temporary = join(partial, `${id}.${randomBytes(6).toString("hex")}`);
    const hash = createHash("sha256");
    const output = createWriteStream(temporary, { mode: 0o600 });
    let received = 0;
    try {
      for await (const chunk of request) {
        received += chunk.length;
        if (received > ticket.size) throw Object.assign(new Error("too_large"), { status: 413 });
        hash.update(chunk);
        if (!output.write(chunk)) await once(output, "drain");
      }
      output.end();
      await once(output, "finish");
      if (received !== ticket.size || hash.digest("hex") !== ticket.sha256) throw Object.assign(new Error("content_mismatch"), { status: 400 });
      const meta = { id, name: cleanFileName(ticket.name), type: typeof ticket.type === "string" ? ticket.type.slice(0, 200) : "", size: received,
        sha256: ticket.sha256, created_at: Math.floor(now() / 1000), expires_at: Math.floor(now() / 1000) + config.retentionSeconds };
      await rename(temporary, join(objects, id));
      await writeFile(join(objects, `${id}.json`), JSON.stringify(meta), { mode: 0o600, flag: "wx" }).catch((error) => {
        if (error.code !== "EEXIST") throw error;
      });
      stored += received;
      send(response, 201, { id, size: received });
    } catch (error) {
      output.destroy();
      await rm(temporary, { force: true });
      if (!response.headersSent) send(response, error.status ?? 500, { error: error.status ? error.message : "upload_failed" });
      request.resume();
    }
  }

  async function download(request, response, id, query) {
    const meta = await readFile(join(objects, `${id}.json`), "utf8").then(JSON.parse).catch(() => null);
    if (!meta || meta.expires_at * 1000 <= now()) return send(response, 404, { error: "not_found" });
    const file = join(objects, id);
    const info = await stat(file).catch(() => null);
    if (!info || info.size !== meta.size) return send(response, 404, { error: "not_found" });
    const type = SERVED.get(meta.type);
    const inline = type && query.get("download") !== "1";
    const headers = {
      "content-type": type ?? "application/octet-stream",
      "content-length": String(info.size),
      "content-disposition": disposition(inline ? "inline" : "attachment", meta.name),
      "cache-control": "private, max-age=3600",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    };
    // Browsers refuse to show a PDF in a sandboxed document; nothing else needs scripts.
    if (meta.type !== "application/pdf") headers["content-security-policy"] = "sandbox; default-src 'none'; img-src 'self'; style-src 'unsafe-inline'";
    response.writeHead(200, headers);
    if (request.method === "HEAD") return response.end();
    const input = createReadStream(file, { highWaterMark: CHUNK });
    response.on("close", () => input.destroy());
    try {
      for await (const chunk of input) {
        await pace.take(chunk.length);
        if (response.destroyed) break;
        if (!response.write(chunk)) await once(response, "drain");
      }
      response.end();
    } catch {
      response.destroy();
    }
  }

  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (!url.pathname.startsWith(`${config.prefix}/v1/`)) return send(response, 404, { error: "not_found" });
      const path = url.pathname.slice(config.prefix.length + 4).split("/");
      if (path.length === 1 && path[0] === "health" && request.method === "GET") return send(response, 200, { ok: true });
      if (path[0] !== "o" || !validId(path[1])) return send(response, 404, { error: "not_found" });
      const id = path[1];
      if (request.method === "PUT" && path.length === 2) {
        const ticket = verifyTicket(config.secret, url.searchParams.get("t"), { op: "put", id, now: now() });
        if (!ticket) { request.resume(); return send(response, 403, { error: "invalid_ticket" }); }
        return await upload(request, response, id, ticket);
      }
      if ((request.method === "GET" || request.method === "HEAD") && path.length === 3) {
        if (!verifyTicket(config.secret, url.searchParams.get("t"), { op: "get", id, now: now() })) return send(response, 403, { error: "link_expired" });
        return await download(request, response, id, url.searchParams);
      }
      send(response, 405, { error: "method_not_allowed" });
    } catch {
      if (!response.headersSent) send(response, 500, { error: "internal_error" });
      else response.destroy();
    }
  });
  server.headersTimeout = 20_000;
  server.requestTimeout = 600_000;
  await sweep();
  const timer = setInterval(() => void sweep().catch(() => {}), 600_000);
  timer.unref();
  server.on("close", () => clearInterval(timer));
  return { server, sweep };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const config = configFromEnvironment();
  const { server } = await createFileServer(config);
  server.listen(config.port, config.host, () => console.log(`panecast files listening on ${config.host}:${config.port}${config.prefix}`));
  for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => server.close(() => process.exit(0)));
}
