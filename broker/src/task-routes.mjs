/*
 * Tasks for a shared window over plain HTTP, for programs. The caller holds
 * the share's key: either the whole `pcs1.` key or its token with
 * `?relay_id=`. Each request opens a short guest session through the
 * computer's tunnel, exactly as the Panecast app does with that key, calls
 * one task method and closes it. The broker keeps nothing; the computer's
 * gateway queues the tasks (relay-tmux/src/hub/share-tasks.mjs).
 *
 *   POST /v1/tasks[?wait=秒]          {text, attachments:[{name, data_base64}]}  → 201 {task}
 *   GET  /v1/tasks?limit=20                                                     → {tasks}
 *   GET  /v1/tasks/<id>[?wait=秒]                                               → {task}
 *   POST /v1/tasks/<id>/cancel                                                  → {task}
 */

/** Text plus up to 20 MB of files, base64 in JSON, under the 32 MiB tunnel frame. */
export const MAX_TASK_BODY_BYTES = 28 * 1024 * 1024;
export const MAX_TASK_WAIT_SECONDS = 300;
const KEY_PREFIX = "pcs1.";

/** The relay and guest token inside a share key, or null. */
export function shareKeyCredentials(text) {
  if (typeof text !== "string" || !text.startsWith(KEY_PREFIX) || text.length > 4096) return null;
  try {
    const key = JSON.parse(Buffer.from(text.slice(KEY_PREFIX.length), "base64url").toString("utf8"));
    if (key?.v !== 1 || typeof key.r !== "string" || !key.r || typeof key.t !== "string" || !key.t) return null;
    return { relayId: key.r, token: key.t };
  } catch { return null; }
}

const STATUS = { invalid_params: 400, too_large: 413, task_not_found: 404, tasks_disabled: 403, forbidden: 403, share_revoked: 401, not_found: 404 };

async function readBody(request, limit) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > limit) throw Object.assign(new Error("request body too large"), { statusCode: 413 });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw Object.assign(new Error("invalid JSON"), { statusCode: 400 }); }
}

const waitSeconds = (url) => {
  const value = Number(url.searchParams.get("wait") ?? 0);
  return Number.isFinite(value) && value > 0 ? Math.min(Math.floor(value), MAX_TASK_WAIT_SECONDS) : 0;
};

export async function taskRoute(request, response, url, { authenticateGuest, openRelaySession, sendJSON, bearerToken, limit }) {
  if (url.pathname !== "/v1/tasks" && !url.pathname.startsWith("/v1/tasks/")) return false;
  const given = bearerToken(request);
  const key = shareKeyCredentials(given);
  const relayId = key?.relayId ?? url.searchParams.get("relay_id") ?? "";
  if (!limit(relayId)) { sendJSON(response, 429, { error: "too_many_requests" }); return true; }
  const guest = given ? await authenticateGuest(key?.token ?? given, relayId) : null;
  if (!guest) { sendJSON(response, 401, { error: "unauthorized" }); return true; }
  const rest = url.pathname.slice("/v1/tasks".length).split("/").filter(Boolean);
  if (rest.some((part) => !/^[\w-]{1,64}$/.test(part)) || rest.length > 2 || (rest.length === 2 && rest[1] !== "cancel")) {
    sendJSON(response, 404, { error: "not_found" });
    return true;
  }
  let calls;
  const wait = waitSeconds(url);
  if (rest.length === 0 && request.method === "POST") {
    const body = await readBody(request, MAX_TASK_BODY_BYTES);
    if (!body || typeof body !== "object" || Array.isArray(body)) { sendJSON(response, 400, { error: "invalid_task" }); return true; }
    const text = typeof body.text === "string" ? body.text : body.prompt;
    const attachments = body.attachments ?? body.images ?? body.files ?? [];
    calls = [["task.submit", { text, attachments }]];
  } else if (rest.length === 0 && request.method === "GET") calls = [["task.list", { limit: Number(url.searchParams.get("limit") ?? 20) }]];
  else if (rest.length === 1 && request.method === "GET") calls = [["task.get", { task_id: rest[0], wait_s: wait }]];
  else if (rest.length === 2 && request.method === "POST") calls = [["task.cancel", { task_id: rest[0] }]];
  else { sendJSON(response, 405, { error: "method_not_allowed" }); return true; }

  let session;
  try { session = openRelaySession(relayId, guest); }
  catch (error) { sendJSON(response, error.statusCode ?? 503, { error: error.message }); return true; }
  // A caller that hangs up stops waiting here too.
  response.on("close", () => session.close());
  try {
    const [method, params] = calls[0];
    let result = await session.call(method, params, method === "task.get" ? (wait + 30) * 1000 : 120_000);
    // Submit and wait in one request: the same session then waits for the result.
    if (method === "task.submit" && wait) result = await session.call("task.get", { task_id: result.task.id, wait_s: wait }, (wait + 30) * 1000);
    sendJSON(response, method === "task.submit" ? 201 : 200, result);
  } catch (error) {
    const status = error.statusCode ?? STATUS[error.code] ?? 502;
    sendJSON(response, status, { error: error.code ?? error.message, ...(error.code && error.message ? { message: error.message } : {}) });
  } finally { session.close(); }
  return true;
}
