import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveUpload } from '../src/upload.mjs';

const folder = async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'panecast-upload-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
};
const b64 = (text) => Buffer.from(text).toString('base64');

test('chunks of any number append in order and the last one names the file', async (t) => {
  const directory = await folder(t);
  const id = 'upload-123456';
  assert.deepEqual(await saveUpload(directory, { upload_id: id, offset: 0, data_base64: b64('hello ') }), { upload_id: id, received: 6 });
  assert.deepEqual(await saveUpload(directory, { upload_id: id, offset: 6, data_base64: b64('large ') }), { upload_id: id, received: 12 });
  const done = await saveUpload(directory, { upload_id: id, offset: 12, data_base64: b64('world'), done: true, filename: 'notes 1.txt', mime_type: 'text/plain' });
  assert.equal(done.bytes, 17); assert.equal(done.mime_type, 'text/plain');
  assert.match(done.filename, /-notes_1\.txt$/);
  assert.equal(await readFile(done.path, 'utf8'), 'hello large world');
  assert.equal((await stat(done.path)).mode & 0o777, 0o600);
  assert.deepEqual((await readdir(directory)).filter((name) => name.endsWith('.part')), [], 'no part file is left behind');
});

test('an empty file is one done chunk', async (t) => {
  const directory = await folder(t);
  const done = await saveUpload(directory, { upload_id: 'empty-file', offset: 0, data_base64: '', done: true, filename: 'empty' });
  assert.equal(done.bytes, 0); assert.equal(await readFile(done.path, 'utf8'), '');
});

test('a chunk at the wrong offset or after the part is gone is refused', async (t) => {
  const directory = await folder(t);
  await saveUpload(directory, { upload_id: 'upload-offset', offset: 0, data_base64: b64('abc') });
  await assert.rejects(saveUpload(directory, { upload_id: 'upload-offset', offset: 2, data_base64: b64('x') }),
    (error) => error.code === 'upload_failed' && error.data.received === 3);
  await assert.rejects(saveUpload(directory, { upload_id: 'upload-missing', offset: 3, data_base64: b64('x') }), { code: 'upload_failed' });
  const done = await saveUpload(directory, { upload_id: 'upload-offset', offset: 3, data_base64: b64('d'), done: true, filename: 'a' });
  assert.equal(await readFile(done.path, 'utf8'), 'abcd', 'a refused chunk leaves the file as it was');
});

test('ids and data that could escape the folder or corrupt it are refused', async (t) => {
  const directory = await folder(t);
  for (const params of [{ upload_id: '../../etc', offset: 0, data_base64: '' }, { upload_id: 'short', offset: 0, data_base64: '' },
    { upload_id: 'upload-valid', offset: -1, data_base64: '' }, { upload_id: 'upload-valid', offset: 1.5, data_base64: '' }]) {
    await assert.rejects(saveUpload(directory, params), { code: 'invalid_params' });
  }
  await assert.rejects(saveUpload(directory, { upload_id: 'upload-valid', offset: 0, data_base64: 'not base64!' }), { code: 'upload_failed' });
  await assert.rejects(saveUpload(directory, { data_base64: 'a_b-' }), { code: 'upload_failed' });
  assert.deepEqual(await readdir(directory), []);
});

test('a new upload clears part files abandoned a day ago, not recent ones', async (t) => {
  const directory = await folder(t);
  const old = join(directory, '.panecast-upload-abandoned.part'), recent = join(directory, '.panecast-upload-inprogress.part');
  await writeFile(old, 'x'); await writeFile(recent, 'y');
  const day = new Date(Date.now() - 25 * 3600 * 1000); await utimes(old, day, day);
  await saveUpload(directory, { upload_id: 'upload-new-one', offset: 0, data_base64: b64('z') });
  const names = await readdir(directory);
  assert.equal(names.includes('.panecast-upload-abandoned.part'), false);
  assert.equal(names.includes('.panecast-upload-inprogress.part'), true);
});

test('a single-message upload still works for older clients', async (t) => {
  const directory = await folder(t);
  const saved = await saveUpload(directory, { filename: 'shot.png', mime_type: 'image/png', data_base64: b64('png') });
  assert.equal(saved.size, 3); assert.equal(saved.bytes, 3); assert.equal(await readFile(saved.path, 'utf8'), 'png');
});
