import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const sha256 = (value) => createHash("sha256").update(value, "utf8").digest("hex");
const same = (a, b) => timingSafeEqual(Buffer.from(sha256(a)), Buffer.from(sha256(b)));

/** Guest credentials per relay; one shared window can hold several. */
export const MAX_GUESTS_PER_RELAY = 100;

/**
 * Credentials a relay issues for one of its shared windows. They live apart
 * from devices.json on purpose: a broker rolled back to a build without guest
 * support never sees them, so a guest can never fall back to full access.
 */
export class GuestStore {
  constructor(path) {
    this.path = path;
    this.guests = [];
    this.operation = Promise.resolve();
  }

  load() { return this.runExclusive(() => this.loadUnlocked()); }

  async loadUnlocked() {
    await mkdir(dirname(this.path), { recursive: true });
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8"));
      this.guests = Array.isArray(parsed.guests) ? parsed.guests : [];
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      this.guests = [];
    }
  }

  async saveUnlocked() {
    const temporaryPath = `${this.path}.${process.pid}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify({ version: 1, guests: this.guests }, null, 2)}\n`, { mode: 0o600 });
    await rename(temporaryPath, this.path);
  }

  /** Returns null when the relay already holds the maximum number of guests. */
  create({ relayId, shareId, name }) {
    return this.runExclusive(async () => {
      await this.loadUnlocked();
      if (this.guests.filter((guest) => guest.relay_id === relayId).length >= MAX_GUESTS_PER_RELAY) return null;
      const deviceId = randomUUID();
      const token = randomBytes(32).toString("base64url");
      this.guests.push({ device_id: deviceId, relay_id: relayId, share_id: shareId, name, token_hash: sha256(token), created_at: new Date().toISOString() });
      await this.saveUnlocked();
      return { deviceId, token };
    });
  }

  authenticate(token, relayId) {
    if (!token) return Promise.resolve(null);
    return this.runExclusive(async () => {
      // Reload so a revoke from another process applies on the next connection.
      await this.loadUnlocked();
      const tokenHash = sha256(token);
      const guest = this.guests.find((candidate) => candidate.relay_id === relayId && same(candidate.token_hash, tokenHash));
      return guest ? { device_id: guest.device_id, guest: true, share_id: guest.share_id } : null;
    });
  }

  list(relayId) {
    return this.guests.filter((guest) => guest.relay_id === relayId)
      .map(({ token_hash, relay_id, ...guest }) => guest);
  }

  revoke(deviceId, relayId) {
    return this.runExclusive(async () => {
      await this.loadUnlocked();
      const before = this.guests.length;
      this.guests = this.guests.filter((guest) => !(guest.device_id === deviceId && guest.relay_id === relayId));
      if (this.guests.length === before) return false;
      await this.saveUnlocked();
      return true;
    });
  }

  /** Drops every guest of relays that no longer exist. */
  removeRelays(relayIds) {
    const removed = new Set(relayIds);
    return this.runExclusive(async () => {
      await this.loadUnlocked();
      const before = this.guests.length;
      this.guests = this.guests.filter((guest) => !removed.has(guest.relay_id));
      if (this.guests.length !== before) await this.saveUnlocked();
    });
  }

  runExclusive(operation) {
    const result = this.operation.then(operation, operation);
    this.operation = result.then(() => undefined, () => undefined);
    return result;
  }
}
