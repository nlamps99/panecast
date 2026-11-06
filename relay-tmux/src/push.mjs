import { createPrivateKey, sign } from 'node:crypto';
import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import http2 from 'node:http2';
import { notificationAllowed, notificationGroup, notificationPreferences } from './notification-policy.mjs';
import { notificationSignal } from './notification-signal.mjs';

export async function writeJSON(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
  await rename(temporary, path);
}
export class PushService {
  constructor({ path, relayId, config = {}, send = sendAPNs, now = Date.now }) {
    this.path = path; this.relayId = relayId; this.config = config; this.send = send; this.now = now;
    this.devices = {}; this.allowed = new Set(); this.validUntil = 0; this.writes = Promise.resolve();
    this.alerts = new Map();
    this.identities = new Set();
    this.inFlight = new Set();
  }
  async load() {
    try {
      const value = JSON.parse(await readFile(this.path, 'utf8'));
      if (value && typeof value === 'object' && !Array.isArray(value)) this.devices = Object.fromEntries(Object.entries(value).filter(([, d]) => d && typeof d.token === 'string' && ['prod', 'sandbox'].includes(d.env)));
    } catch { this.devices = {}; }
  }
  save() { const value = { ...this.devices }; this.writes = this.writes.catch(() => {}).then(() => writeJSON(this.path, value)); return this.writes; }
  suspend() { this.validUntil = 0; this.allowed.clear(); }
  configured(env) { const c = this.config; return Boolean(c.key_path && c.key_id && c.team_id && c.topic && c.env === env); }
  async receive(envelope) {
    if (envelope.type === 'push.sync') {
      const ids = JSON.parse(envelope.text);
      if (!Array.isArray(ids) || ids.length > 5000 || ids.some((id) => typeof id !== 'string')) return;
      this.allowed = new Set(ids); this.validUntil = this.now() + 45_000;
      for (const id of Object.keys(this.devices)) if (!this.allowed.has(id)) delete this.devices[id];
      await this.save(); return;
    }
    const id = envelope.device_id;
    if (!this.allowed.has(id) || this.now() >= this.validUntil) return { ok: false, error: 'device_not_authorized' };
    if (envelope.type === 'push.register') {
      const body = JSON.parse(envelope.text);
      if (typeof body.apns_token !== 'string' || !/^(?:[0-9a-f]{2}){1,256}$/i.test(body.apns_token) || !['prod', 'sandbox'].includes(body.env)) return { ok: false, error: 'invalid_apns_registration' };
      this.devices[id] = { token: body.apns_token, env: body.env, preferences: notificationPreferences(body.preferences) }; await this.save();
      return { ok: true, forwarded: true, push_enabled: this.configured(body.env), preferences_applied: true };
    }
    if (envelope.type === 'push.test') {
      const device = this.devices[id];
      if (!device) return { ok: false, error: 'push_not_registered' };
      return this.deliverTo(id, device, { id: 'panecast-test', workspace_id: 'unknown', thread_id: 'panecast-test' });
    }
  }
  async deliverTo(id, device, notification) {
    if (!this.configured(device.env)) return { ok: false, error: 'apns_not_configured' };
    try {
      const result = await this.send(this.config, device, notification, this.relayId);
      if (result.status === 200) return { ok: true, accepted: true };
      if (result.status === 410 || ['BadDeviceToken', 'Unregistered', 'DeviceTokenNotForTopic'].includes(result.reason)) { delete this.devices[id]; await this.save(); }
      return { ok: false, error: result.reason ?? 'apns_rejected', status: result.status };
    } catch { return { ok: false, error: 'apns_request_failed_check_relay_config' }; }
  }
  async notify(notification) {
    const sent = new Set();
    for (const [key, at] of this.alerts) if (at < this.now() - 3600_000) this.alerts.delete(key);
    for (const [id, device] of Object.entries(this.devices)) {
      if (this.now() >= this.validUntil || !this.allowed.has(id) || sent.has(device.token)) continue;
      const preferences = notificationPreferences(device.preferences);
      if (!notificationAllowed(preferences, notification, this.now())) continue;
      const identity = JSON.stringify([device.token, notification.id ?? notification.notification_id ?? notificationGroup(notification), notification.needs_input === true]);
      if (this.identities.has(identity) || this.inFlight.has(identity)) continue;
      const key = `${id}|${notificationGroup(notification)}`;
      if (preferences.dedupe_seconds && this.now() - (this.alerts.get(key) ?? -Infinity) < preferences.dedupe_seconds * 1000) continue;
      this.alerts.set(key, this.now());
      this.inFlight.add(identity);
      try {
        if ((await this.deliverTo(id, device, notification)).ok) {
          sent.add(device.token);
          if (notification.id || notification.notification_id) this.identities.add(identity);
          if (this.identities.size > 2000) this.identities.delete(this.identities.values().next().value);
        }
      } finally {
        this.inFlight.delete(identity);
      }
    }
  }
}

export async function sendAPNs(config, device, notification, relayId) {
  const header = Buffer.from(JSON.stringify({ alg: 'ES256', kid: config.key_id })).toString('base64url');
  const body = Buffer.from(JSON.stringify({ iss: config.team_id, iat: Math.floor(Date.now() / 1000) })).toString('base64url');
  const data = `${header}.${body}`;
  const key = createPrivateKey(await readFile(config.key_path));
  const signature = sign('sha256', Buffer.from(data), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  const needsInput = notificationSignal({ category: 'notification', name: 'notification.created', payload: notification }) === 'attention';
  const title = notification.id === 'panecast-test' ? 'Panecast · 测试通知' : needsInput ? 'Panecast · 需要你处理' : 'Panecast · 任务已完成';
  const payload = JSON.stringify({ aps: { alert: { title, body: '打开 Panecast 查看详情。' }, sound: 'default', 'thread-id': notification.thread_id ?? notification.workspace_id }, workspace_id: notification.workspace_id, surface_id: notification.surface_id, notification_id: notification.id ?? notification.notification_id, source_id: notification.source_id, thread_id: notification.thread_id, needs_input: needsInput, relay_id: relayId });
  return new Promise((resolveRequest, reject) => {
    const connection = http2.connect(device.env === 'prod' ? 'https://api.push.apple.com' : 'https://api.sandbox.push.apple.com');
    let finished = false;
    const finish = (error, result) => { if (finished) return; finished = true; clearTimeout(timer); connection.destroy(); if (error) reject(error); else resolveRequest(result); };
    const timer = setTimeout(() => finish(new Error('APNs timeout')), 8000);
    connection.on('error', (error) => finish(error));
    const request = connection.request({ ':method': 'POST', ':path': `/3/device/${device.token}`, authorization: `bearer ${data}.${signature}`, 'apns-topic': config.topic, 'apns-push-type': 'alert', 'apns-priority': '10' });
    let status = 0, response = '';
    request.on('response', (headers) => { status = Number(headers[':status']); });
    request.on('data', (chunk) => { response += chunk; if (response.length > 16_384) finish(new Error('APNs response too large')); });
    request.on('error', (error) => finish(error));
    request.on('end', () => { let reason; try { reason = JSON.parse(response).reason; } catch {} finish(null, { status, reason }); });
    request.end(payload);
  });
}
