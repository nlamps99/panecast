import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";

/**
 * Signed transfer tickets for the file service. The broker signs; the file
 * service only checks signatures, so it needs no device or relay database.
 * A ticket is `base64url(JSON).base64url(HMAC-SHA256)`.
 */
export const MAX_FILE_BYTES = 50 * 1024 * 1024;
const ID = /^[A-Za-z0-9_-]{22}$/;
const SHA256 = /^[0-9a-f]{64}$/;

const encode = (value) => Buffer.from(value).toString("base64url");
const mac = (secret, body) => createHmac("sha256", secret).update(body).digest();

export function signTicket(secret, payload) {
  const body = encode(JSON.stringify(payload));
  return `${body}.${mac(secret, body).toString("base64url")}`;
}

/** The payload of a valid, unexpired ticket for `op` and `id`; null otherwise. */
export function verifyTicket(secret, token, { op, id, now = Date.now() }) {
  if (typeof token !== "string" || token.length > 4096) return null;
  const [body, signature, extra] = token.split(".");
  if (!body || !signature || extra !== undefined) return null;
  const expected = mac(secret, body);
  const given = Buffer.from(signature, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  let payload;
  try { payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")); } catch { return null; }
  if (payload?.v !== 1 || payload.op !== op || payload.id !== id || !Number.isFinite(payload.exp) || payload.exp * 1000 <= now) return null;
  return payload;
}

/** A file name safe for a URL path and a Content-Disposition header. */
export function cleanFileName(name) {
  const base = String(name ?? "").split(/[\\/]/).pop() ?? "";
  // eslint-disable-next-line no-control-regex
  const clean = base.replace(/[\u0000-\u001f\u007f-\u009f"]/g, "").replace(/^\.+/, "").trim().slice(0, 160);
  return clean || "file";
}

export const validId = (id) => typeof id === "string" && ID.test(id);
export const validSha256 = (value) => typeof value === "string" && SHA256.test(value);

/** Reads `CMUX_FILES_URL` and the shared secret; null when file links are not configured. */
export function fileLinksFromEnvironment(environment = process.env) {
  const url = environment.CMUX_FILES_URL;
  const secretFile = environment.CMUX_FILES_SECRET_FILE;
  if (!url && !secretFile) return null;
  if (!url || !secretFile) throw new Error("CMUX_FILES_URL and CMUX_FILES_SECRET_FILE must be set together");
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(parsed.hostname)) throw new Error("CMUX_FILES_URL must use HTTPS");
  const secret = readFileSync(secretFile, "utf8").trim();
  if (secret.length < 32) throw new Error("CMUX_FILES_SECRET_FILE must hold at least 32 characters");
  return { url: url.replace(/\/+$/, ""), secret, maxBytes: Number(environment.CMUX_FILES_MAX_BYTES ?? MAX_FILE_BYTES) };
}

/**
 * Issues one upload and one download ticket for a file of known size and hash.
 * The name and type are fixed in the upload ticket, so the uploader cannot
 * change how the file is later served.
 */
export function issueTransfer(files, { name, type, size, sha256 }, { now = Date.now(), uploadSeconds = 600, downloadSeconds = 3600 } = {}) {
  const id = randomBytes(16).toString("base64url");
  const seconds = Math.floor(now / 1000);
  const filename = cleanFileName(name);
  const upload = signTicket(files.secret, { v: 1, op: "put", id, exp: seconds + uploadSeconds, size, sha256, name: filename, type });
  const download = signTicket(files.secret, { v: 1, op: "get", id, exp: seconds + downloadSeconds });
  return {
    id,
    upload_url: `${files.url}/v1/o/${id}?t=${upload}`,
    download_url: `${files.url}/v1/o/${id}/${encodeURIComponent(filename)}?t=${download}`,
    expires_at: new Date((seconds + downloadSeconds) * 1000).toISOString(),
  };
}
