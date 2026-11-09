// Exercise the built installer against real release bytes, entirely in scratch directories.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { copyFile, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'darwin') throw new Error('Installer verification requires macOS');
const exec = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const output = join(root, 'build/desktop');
const metadata = JSON.parse(await readFile(join(output, `desktop-${process.env.PANECAST_DESKTOP_ARCH ?? process.arch}.json`), 'utf8'));
const installer = join(output, metadata.installer.file);
const bytes = await readFile(join(output, metadata.archive.file));
const scratch = await mkdtemp(join(tmpdir(), 'panecast-installer-test-'));
let corrupt = false;
let requests = 0;
const server = createServer((request, response) => {
  requests++;
  if (request.url !== `/${metadata.archive.file}`) { response.writeHead(404).end(); return; }
  response.end(corrupt ? Buffer.from('damaged download') : bytes);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const directory = join(scratch, 'Applications with spaces');
const app = join(directory, 'Panecast.app');
const plist = join(app, 'Contents/Info.plist');
const env = { ...process.env, PANECAST_DESKTOP_INSTALL_DIR: directory, PANECAST_DESKTOP_DOWNLOAD_BASE: `http://127.0.0.1:${server.address().port}` };
const install = (overrides = {}) => exec('/bin/bash', [installer], { env: { ...env, ...overrides } });
const version = async (path = plist) => (await exec('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', path])).stdout.trim();
const signature = (path = app) => exec('/usr/bin/codesign', ['--verify', '--deep', '--strict', path]);
const entries = () => readdir(directory);
const reject = async (run, message) => {
  await assert.rejects(run, (error) => error.code !== 0 && (!message || error.stderr.includes(message)));
};

try {
  await install();
  assert.equal(await version(), metadata.version);
  await signature();
  assert.ok(!(await exec('/usr/bin/xattr', [app])).stdout.includes('com.apple.quarantine'));
  console.log('PASS fresh install in a path with spaces; version, signature and quarantine checked');

  await exec('/usr/libexec/PlistBuddy', ['-c', 'Set :CFBundleShortVersionString 0.0.0', plist]);
  await exec('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', app]);
  await signature();
  await install();
  const backup = (await entries()).find((name) => name.startsWith('.Panecast-previous.'));
  assert.ok(backup);
  assert.equal(await version(join(directory, backup, 'Panecast.app/Contents/Info.plist')), '0.0.0');
  await signature(join(directory, backup, 'Panecast.app'));
  assert.equal(await version(), metadata.version);
  await signature();
  console.log('PASS upgrade installs current version and preserves a valid previous app');

  const beforeCorruption = (await entries()).sort();
  corrupt = true;
  await reject(() => install(), 'SHA-256');
  corrupt = false;
  assert.deepEqual((await entries()).sort(), beforeCorruption);
  assert.equal(await version(), metadata.version);
  await signature();
  console.log('PASS corrupt download stops before changing the installed app');

  const unrelated = join(scratch, 'unrelated');
  await mkdir(join(unrelated, 'Panecast.app'), { recursive: true });
  await writeFile(join(unrelated, 'Panecast.app/keep.txt'), 'preserve');
  const beforeRejections = requests;
  await reject(() => install({ PANECAST_DESKTOP_INSTALL_DIR: unrelated }), '同名应用不是 Panecast');
  assert.equal(await readFile(join(unrelated, 'Panecast.app/keep.txt'), 'utf8'), 'preserve');
  const linked = join(scratch, 'linked');
  await mkdir(linked);
  await symlink(app, join(linked, 'Panecast.app'));
  await reject(() => install({ PANECAST_DESKTOP_INSTALL_DIR: linked }), '符号链接');
  assert.equal(requests, beforeRejections);
  console.log('PASS unrelated applications and symlink targets are preserved before download');

  // Run only /bin/sleep inside a disposable bundle; never open the actual app or a UI.
  const busy = join(scratch, 'busy');
  const busyApp = join(busy, 'Panecast.app');
  await exec('/usr/bin/ditto', [app, busyApp]);
  const executableName = (await exec('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleExecutable', plist])).stdout.trim();
  await copyFile('/bin/sleep', join(busyApp, 'Contents/MacOS', executableName));
  await exec('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', busyApp]);
  const processFixture = spawn(join(busyApp, 'Contents/MacOS', executableName), ['60']);
  const processExit = new Promise((resolve) => processFixture.once('exit', resolve));
  try {
    await new Promise((resolve, reject) => { processFixture.once('spawn', resolve); processFixture.once('error', reject); });
    await reject(() => install({ PANECAST_DESKTOP_INSTALL_DIR: busy }), '先退出');
    assert.equal(requests, beforeRejections);
  } finally {
    processFixture.kill();
    await processExit;
  }
  console.log('PASS a running bundle is preserved, including when its path uses a filesystem alias');

  // Fail only the final rename, using the actual script's normal rollback path.
  const bin = join(scratch, 'bin');
  await mkdir(bin);
  await writeFile(join(bin, 'mv'), '#!/bin/bash\ncase "$1" in */.Panecast-install.*/Panecast.app) exit 73;; esac\nexec /bin/mv "$@"\n', { mode: 0o755 });
  await reject(() => install({ PATH: `${bin}:${process.env.PATH}` }));
  assert.equal(await version(), metadata.version);
  await signature();
  assert.ok(!(await entries()).some((name) => name.startsWith('.Panecast-install.')));
  console.log('PASS failed final rename restores the installed app and clears staging');

  // A partial network response must never begin executing the install routine.
  const partial = join(scratch, 'partial.sh');
  const script = await readFile(installer, 'utf8');
  await writeFile(partial, script.slice(0, script.indexOf('mv "$panecast_stage/Panecast.app"')));
  const partialDirectory = join(scratch, 'partial-install');
  await reject(() => exec('/bin/bash', [partial], { env: { ...env, PANECAST_DESKTOP_INSTALL_DIR: partialDirectory } }));
  assert.ok(!(await readdir(scratch)).includes('partial-install'));
  console.log('PASS truncated installer cannot execute a partial installation');
} finally {
  await new Promise((resolve) => server.close(resolve));
  await rm(scratch, { recursive: true, force: true });
}
