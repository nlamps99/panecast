import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

const decode = row => row ? JSON.parse(row.data) : null;

/** The task ledger survives the manager CLI, terminal and gateway independently. */
export class SupervisorStore {
  constructor(path) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, target_key TEXT UNIQUE NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS inputs (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, state TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS operations (id TEXT PRIMARY KEY, task_id TEXT, state TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, task_id TEXT, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS outputs (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, audience TEXT NOT NULL, data TEXT NOT NULL);`);
    this.transaction(() => {
      for (const row of this.db.prepare("SELECT * FROM operations WHERE state='attempting'").all()) {
        const op = decode(row); this.saveOperation({ ...op, state: 'unknown', message: '网关在发送过程中重启，结果未确认；请核查后处理。' });
        if (op.taskId) { const task = this.task(op.taskId); if (task) this.saveTask({ ...task, state: 'blocked', blocker: '存在未确认的指令，已停止自动重发。' }); }
      }
      const manager = this.meta('manager');
      if (manager?.wake?.state === 'attempting') this.setMeta('manager', { ...manager, wake: { ...manager.wake, state: 'unknown' } });
    });
  }
  transaction(fn) { this.db.exec('BEGIN IMMEDIATE'); try { const value = fn(); this.db.exec('COMMIT'); return value; } catch (error) { this.db.exec('ROLLBACK'); throw error; } }
  meta(key) { return decode(this.db.prepare('SELECT data FROM meta WHERE key=?').get(key)); }
  setMeta(key, value) { this.db.prepare('INSERT INTO meta(key,data) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data').run(key, JSON.stringify(value)); }
  tasks() { return this.db.prepare('SELECT data FROM tasks ORDER BY rowid').all().map(decode); }
  task(id) { return decode(this.db.prepare('SELECT data FROM tasks WHERE id=?').get(id)); }
  targetTask(key) { return decode(this.db.prepare('SELECT data FROM tasks WHERE target_key=?').get(key)); }
  saveTask(task) {
    task.updatedAt = Date.now();
    this.db.prepare('INSERT INTO tasks(id,target_key,data) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET target_key=excluded.target_key,data=excluded.data').run(task.id, task.targetKey, JSON.stringify(task));
    return task;
  }
  input(id) { return decode(this.db.prepare('SELECT data FROM inputs WHERE id=?').get(id)); }
  enqueue(input) {
    const value = { ...input, createdAt: Date.now() };
    this.db.prepare("INSERT OR IGNORE INTO inputs(id,state,data) VALUES(?,'pending',?)").run(input.id, JSON.stringify(value));
    return this.input(input.id);
  }
  inbox() { return this.db.prepare("SELECT data FROM inputs WHERE state!='handled' ORDER BY seq LIMIT 40").all().map(decode); }
  acknowledge(ids) { const update = this.db.prepare("UPDATE inputs SET state='handled' WHERE id=?"); for (const id of ids) update.run(id); }
  operation(id) { return decode(this.db.prepare('SELECT data FROM operations WHERE id=?').get(id)); }
  operations(taskId, states) {
    return this.db.prepare('SELECT data FROM operations WHERE task_id=? ORDER BY rowid').all(taskId).map(decode).filter(op => !states || states.includes(op.state));
  }
  pendingOperations() { return this.db.prepare("SELECT data FROM operations WHERE state='queued' ORDER BY rowid").all().map(decode); }
  unknownOperations() { return this.db.prepare("SELECT data FROM operations WHERE state='unknown' ORDER BY rowid").all().map(decode); }
  saveOperation(op) {
    const value = { ...op, updatedAt: Date.now() };
    this.db.prepare('INSERT INTO operations(id,task_id,state,data) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,data=excluded.data').run(op.id, op.taskId ?? null, op.state, JSON.stringify(value));
    return value;
  }
  event(type, taskId, payload = {}, id = randomUUID()) {
    const value = { id, type, taskId, payload, at: Date.now() };
    this.db.prepare('INSERT OR IGNORE INTO events(id,task_id,data) VALUES(?,?,?)').run(id, taskId ?? null, JSON.stringify(value));
    return this.getEvent(id);
  }
  getEvent(id) { return decode(this.db.prepare('SELECT data FROM events WHERE id=?').get(id)); }
  taskEvents(taskId) { return this.db.prepare('SELECT data FROM events WHERE task_id=? ORDER BY seq DESC LIMIT 12').all(taskId).map(decode).reverse(); }
  publish(id, audience, value) { this.db.prepare('INSERT OR IGNORE INTO outputs(id,audience,data) VALUES(?,?,?)').run(id, audience, JSON.stringify({ ...value, id, at: Date.now() })); }
  outputs(audience, after = 0) { return this.db.prepare('SELECT seq,data FROM outputs WHERE audience=? AND seq>? ORDER BY seq LIMIT 40').all(audience, after).map(row => ({ ...decode(row), sequence: row.seq })); }
  close() { this.db.close(); }
}
