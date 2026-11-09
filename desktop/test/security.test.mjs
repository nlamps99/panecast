import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import test from 'node:test';
import { appFrame, assetPath, serviceUrl } from '../src/security.mjs';
import { Vault } from '../src/vault.mjs';

test('desktop transport permits authenticated Panecast APIs, without redirects or file access', () => {
  assert.equal(serviceUrl('https://example.com/cmux-remote/v1/account/login'), 'https://example.com/cmux-remote/v1/account/login');
  assert.equal(serviceUrl('ws://192.168.1.2:4399/v1/ws', true), 'ws://192.168.1.2:4399/v1/ws');
  for (const url of ['file:///etc/passwd', 'https://user:password@example.com/v1/health', 'http://example.com/v1/account/login', 'https://example.com/arbitrary', 'https://example.com/v1/relay/ws']) assert.throws(() => serviceUrl(url));
  assert.equal(appFrame('panecast-app://desktop/account'), true);
  assert.equal(appFrame('https://desktop/account'), false);
  assert.equal(assetPath('/app/web', 'panecast-app://desktop/'), '/app/web/index.html');
  assert.throws(() => assetPath('/app/web', 'panecast-app://desktop/%2e%2e%2fsecrets'));
  assert.throws(() => assetPath('/app/web', 'panecast-app://desktop/%00'));
});

test('vault serializes concurrent writes, survives restart, and never falls back to plaintext', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'panecast-vault-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const key = randomBytes(32), iv = randomBytes(16);
  const encryption = { isEncryptionAvailable: () => true,
    encryptString: (text) => { const cipher = createCipheriv('aes-256-cbc', key, iv); return Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]); },
    decryptString: (bytes) => { const cipher = createDecipheriv('aes-256-cbc', key, iv); return Buffer.concat([cipher.update(bytes), cipher.final()]).toString(); },
  };
  const file = join(directory, 'credentials.enc');
  const vault = new Vault(file, encryption);
  await Promise.all([vault.set('panecast.account.v1', 'private-account-token'), vault.set('panecast.clientId', 'client-id')]);
  assert.equal((await readFile(file)).includes(Buffer.from('private-account-token')), false);
  const reopened = new Vault(file, encryption);
  assert.equal(await reopened.get('panecast.account.v1'), 'private-account-token');
  assert.equal(await reopened.get('panecast.clientId'), 'client-id');
  await reopened.remove('panecast.account.v1');
  assert.equal(await reopened.get('panecast.account.v1'), null);
  await assert.rejects(new Vault(file, { isEncryptionAvailable: () => false }).get('panecast.clientId'));
  await assert.rejects(new Vault(file, { ...encryption, getSelectedStorageBackend: () => 'basic_text' }).get('panecast.clientId'));
  assert.throws(() => vault.get('../../config'));
});
