import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { storageKey } from './security.mjs';

/** A single encrypted, atomically replaced file backed by the OS credential service. */
export class Vault {
  constructor(path, encryption) { this.path = path; this.encryption = encryption; this.operation = Promise.resolve(); }
  run(action) {
    const pending = this.operation.then(async () => {
      if (!this.encryption.isEncryptionAvailable() || this.encryption.getSelectedStorageBackend?.() === 'basic_text') throw new Error('系统安全存储不可用，请解锁钥匙串后重试。');
      let data = {};
      try { data = JSON.parse(this.encryption.decryptString(await readFile(this.path))); }
      catch (error) { if (error.code !== 'ENOENT') throw new Error('无法读取登录信息，请检查系统钥匙串。'); }
      const { value, write } = action(data);
      if (write) {
        await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
        const temporary = `${this.path}.tmp`;
        await writeFile(temporary, this.encryption.encryptString(JSON.stringify(data)), { mode: 0o600 });
        await rename(temporary, this.path);
      }
      return value;
    });
    this.operation = pending.catch(() => {});
    return pending;
  }
  get(key) { storageKey(key); return this.run((data) => ({ value: data[key] ?? null })); }
  set(key, value) {
    storageKey(key);
    if (typeof value !== 'string' || value.length > 1024 * 1024) throw new Error('Invalid stored value');
    return this.run((data) => { data[key] = value; return { write: true }; });
  }
  remove(key) { storageKey(key); return this.run((data) => { delete data[key]; return { write: true }; }); }
}
