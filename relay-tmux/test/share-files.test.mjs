import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { link, mkdir, mkdtemp, readFile, realpath, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listShareFiles, mimeFor, openInside, ShareFileLinks, uploadName } from '../src/hub/share-files.mjs';

async function folder(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'panecast-share-files-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const outside = await realpath(await mkdtemp(join(tmpdir(), 'panecast-outside-')));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(join(outside, 'id_rsa'), 'secret');
  return { root, outside };
}

test('the listing is newest first and leaves out hidden folders and links', async (t) => {
  const { root, outside } = await folder(t);
  await mkdir(join(root, 'figures'));
  await writeFile(join(root, 'old.tex'), 'a');
  await writeFile(join(root, 'figures', 'plot.png'), 'b');
  await utimes(join(root, 'old.tex'), new Date(1_000_000), new Date(1_000_000));
  await mkdir(join(root, '.claude')); await writeFile(join(root, '.claude', 'x.json'), '{}');
  await mkdir(join(root, 'node_modules')); await writeFile(join(root, 'node_modules', 'x.js'), '');
  await symlink(join(outside, 'id_rsa'), join(root, 'key.txt'));
  await symlink(outside, join(root, 'home'));
  const { files } = await listShareFiles(root);
  assert.deepEqual(files.map((f) => f.path), ['figures/plot.png', 'old.tex']);
  assert.equal(files[0].name, 'plot.png');
});

test('only regular files inside the directory open', async (t) => {
  const { root, outside } = await folder(t);
  await writeFile(join(root, 'paper.docx'), 'paper');
  await symlink(join(outside, 'id_rsa'), join(root, 'key.txt'));
  await symlink(outside, join(root, 'home'));
  await link(join(outside, 'id_rsa'), join(root, 'copy.txt'));
  await mkdir(join(root, '.git')); await writeFile(join(root, '.git', 'config'), 'x');
  execFileSync('mkfifo', [join(root, 'pipe.docx')]);
  const opened = await openInside(root, join(root, 'paper.docx'));
  assert.equal(opened.path, 'paper.docx');
  await opened.handle.close();
  for (const path of ['key.txt', 'home/id_rsa', 'copy.txt', '.git/config', '../x', join(outside, 'id_rsa'), '/etc/hosts']) {
    await assert.rejects(openInside(root, path), (error) => ['forbidden', 'not_found'].includes(error.code), path);
  }
  await assert.rejects(openInside(root, 'pipe.docx'), { code: 'invalid_params' }, 'a FIFO neither opens nor blocks');
  await assert.rejects(openInside(root, 'missing.docx'), { code: 'not_found' });
});

test('a link is uploaded once per file version and reused', async (t) => {
  const { root } = await folder(t);
  await writeFile(join(root, '论文.docx'), 'paper v1');
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).includes('/v1/relay/files')) {
      const body = JSON.parse(init.body);
      return new Response(JSON.stringify({ upload_url: `https://files.example/put/${calls.length}`, download_url: `https://files.example/get/${calls.length}/${body.name}`,
        expires_at: new Date(Date.now() + 3_600_000).toISOString() }), { status: 201 });
    }
    return new Response('{}', { status: 201 });
  };
  const links = new ShareFileLinks({ url: 'https://broker.example/cmux-remote', relay_id: 'home', relay_token: 'relay-secret' }, { fetch: fetchImpl });
  const [a, b] = await Promise.all([links.link(root, '论文.docx'), links.link(root, '论文.docx')]);
  assert.equal(a.url, b.url, 'concurrent requests share one upload');
  assert.equal(calls.length, 2, 'one ticket and one upload');
  const ticket = JSON.parse(calls[0].init.body);
  assert.deepEqual(ticket, { name: '论文.docx', type: mimeFor('x.docx'), size: 8, sha256: createHash('sha256').update('paper v1').digest('hex') });
  assert.equal(calls[0].init.headers.authorization, 'Bearer relay-secret');
  assert.match(calls[0].url, /\/cmux-remote\/v1\/relay\/files\?relay_id=home$/);
  assert.equal(Buffer.from(calls[1].init.body).toString(), 'paper v1');
  assert.equal((await links.link(root, '论文.docx')).url, a.url, 'an unchanged file is not uploaded again');
  await writeFile(join(root, '论文.docx'), 'paper version 2');
  const changed = await links.link(root, '论文.docx');
  assert.notEqual(changed.url, a.url);
  assert.equal(changed.size, 15);
});

test('broker answers become messages for the guest', async (t) => {
  const { root } = await folder(t);
  await writeFile(join(root, 'a.pdf'), 'x');
  const respond = (status, body = {}) => new ShareFileLinks({ url: 'https://b.example', relay_id: 'r', relay_token: 't' },
    { fetch: async () => new Response(JSON.stringify(body), { status }) });
  await assert.rejects(respond(404).link(root, 'a.pdf'), { code: 'file_links_unavailable' });
  await assert.rejects(respond(429).link(root, 'a.pdf'), { code: 'busy' });
  await assert.rejects(respond(201, { upload_url: 'http://evil.example/x', download_url: 'https://x', expires_at: '' }).link(root, 'a.pdf'), { code: 'file_link_failed' });
  const small = new ShareFileLinks({ url: 'https://b.example', relay_id: 'r', relay_token: 't' }, { maxBytes: 0, fetch: async () => assert.fail('no request') });
  await assert.rejects(small.link(root, 'a.pdf'), { code: 'too_large' });
});

test('upload names stay in the directory and avoid the input filter', () => {
  assert.equal(uploadName('../../.ssh/authorized_keys'), 'authorized_keys');
  assert.equal(uploadName('报告!最终.docx'), '报告！最终.docx');
  assert.equal(uploadName('..'), '附件');
  assert.equal(uploadName('a\nb.txt'), 'ab.txt');
  assert.equal(mimeFor('A.PDF'), 'application/pdf');
  assert.equal(mimeFor('main.tex'), 'text/plain');
  assert.equal(mimeFor('run.command'), 'application/octet-stream');
});

test('a guest upload lands as a new file', async (t) => {
  const { root } = await folder(t);
  const { saveUpload } = await import('../src/hub/share-files.mjs');
  const saved = await saveUpload(root, 'a.txt', Buffer.from('one'));
  const again = await saveUpload(root, 'a.txt', Buffer.from('two'));
  assert.deepEqual([saved.filename, again.filename], ['a.txt', 'a (2).txt']);
  assert.equal(await readFile(saved.path, 'utf8'), 'one');
});
