import { copyFile, cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const settings = JSON.parse(await readFile(join(root, '../distribution/release.json'), 'utf8'));
if (!/^\d+\.\d+\.\d+$/.test(pkg.version)) throw new Error('Invalid release version');
if (!/^https:\/\/[\w.-]+(?::\d+)?(?:\/[\w.~-]+)*\/?$/.test(settings.baseUrl)) throw new Error('Invalid release URL');
const output = resolve(root, '../build/desktop');
const arch = process.env.PANECAST_DESKTOP_ARCH ?? process.arch;
if (!['arm64', 'x64'].includes(arch)) throw new Error('Unsupported architecture');
const target = arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin';
const cross = arch !== process.arch;
// Release signing material, owner-only, never in the repository:
// - the Panecast code-signing certificate in its own keychain. Every release
//   carries the same designated requirement, so the Keychain keeps trusting
//   the updated app instead of asking again after each update;
// - the self-update key whose public half is built into every release
//   (tauri.macos.conf.json). Losing it strands installed apps.
const keys = process.env.PANECAST_RELEASE_KEY_DIR ?? join(homedir(), '.cmuxremote/desktop-release');
const secret = async (name) => (await readFile(join(keys, name), 'utf8')).trim();
/** SHA-1 of the Panecast Code Signing certificate: the `certificate root` every release requires. */
const SIGNING_CERTIFICATE = '1150BFCCE320DEF8F82CC45F88534DEB817E1F9D';
const keychain = join(keys, 'signing.keychain-db');
execFileSync(process.execPath, [join(root, 'node_modules/@tauri-apps/cli/tauri.js'), 'build', '--bundles', 'app', ...(cross ? ['--target', target] : []),
  '--', '--locked'], { cwd: root, stdio: 'inherit' });
const application = join(root, 'src-tauri/target', ...(cross ? [target] : []), 'release/bundle/macos/Panecast.app');
execFileSync('codesign', ['--verify', '--deep', '--strict', application]);
const directory = join(output, `Panecast-tauri-${arch}`);
await mkdir(directory, { recursive: true });
await rm(join(directory, 'Panecast.app'), { recursive: true, force: true });
await cp(application, join(directory, 'Panecast.app'), { recursive: true });
const app = join(directory, 'Panecast.app');
// Tauri signs ad hoc; replace that with the Panecast certificate, keeping the hardened runtime.
execFileSync('security', ['unlock-keychain', '-p', await secret('signing.keychain-password'), keychain]);
execFileSync('codesign', ['--force', '--options', 'runtime', '--timestamp=none', '--keychain', keychain, '--sign', SIGNING_CERTIFICATE, app], { stdio: 'ignore' });
execFileSync('codesign', ['--verify', '--deep', '--strict', app]);
const requirement = execFileSync('codesign', ['-d', '-r-', app], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
if (!requirement.includes(`identifier "com.nzx.panecast.desktop" and certificate root = H"${SIGNING_CERTIFICATE.toLowerCase()}"`)) {
  throw new Error('The app is not signed with the Panecast certificate');
}
await mkdir(output, { recursive: true });
const file = `panecast-desktop-${pkg.version}-mac-${arch}.zip`;
execFileSync('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', join(directory, 'Panecast.app'), join(output, file)]);
async function artifactMetadata(name) {
  const bytes = await readFile(join(output, name));
  const artifact = { file: name, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  await writeFile(join(output, `${name}.sha256`), `${artifact.sha256}  ${name}\n`);
  return artifact;
}
const archive = await artifactMetadata(file);
const installerFile = `install-desktop-${pkg.version}-mac-${arch}.sh`;
const template = await readFile(join(root, 'install/install.sh.in'), 'utf8');
const values = { VERSION: pkg.version, ARCH: arch, ARCHIVE: file, SHA256: archive.sha256, BASE_URL: settings.baseUrl };
const installer = template.replace(/@([A-Z0-9_]+)@/g, (_, key) => {
  if (!values[key]) throw new Error(`Unknown installer template field: ${key}`);
  return values[key];
});
await writeFile(join(output, installerFile), installer, { mode: 0o755 });
execFileSync('/bin/bash', ['-n', join(output, installerFile)]);

const dmgFile = `panecast-desktop-${pkg.version}-mac-${arch}.dmg`;
const dmgStage = await mkdtemp(join(output, '.dmg-'));
try {
  await cp(join(directory, 'Panecast.app'), join(dmgStage, 'Panecast.app'), { recursive: true });
  execFileSync('codesign', ['--verify', '--deep', '--strict', join(dmgStage, 'Panecast.app')]);
  await symlink('/Applications', join(dmgStage, 'Applications'));
  await copyFile(join(root, 'install/instructions.txt'), join(dmgStage, '安装说明.txt'));
  await copyFile(join(root, '../distribution/site/mac-install.html'), join(dmgStage, '安装说明.html'));
  execFileSync('hdiutil', ['create', '-ov', '-volname', `Panecast ${pkg.version}`, '-srcfolder', dmgStage, '-fs', 'HFS+', '-format', 'UDZO', join(output, dmgFile)], { stdio: 'inherit' });
  execFileSync('hdiutil', ['verify', join(output, dmgFile)], { stdio: 'inherit' });
} finally {
  await rm(dmgStage, { recursive: true, force: true });
}
// The self-update package: the signed bundle at the archive root, as the updater unpacks it.
const updateFile = `panecast-desktop-${pkg.version}-mac-${arch}.app.tar.gz`;
await rm(join(output, `${updateFile}.sig`), { force: true });
execFileSync('/usr/bin/tar', ['--no-mac-metadata', '--no-xattrs', '-czf', join(output, updateFile), '-C', directory, 'Panecast.app'], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
execFileSync(process.execPath, [join(root, 'node_modules/@tauri-apps/cli/tauri.js'), 'signer', 'sign', '--private-key-path', join(keys, 'updater.key'),
  '--app-version', pkg.version, join(output, updateFile)], { env: { ...process.env, TAURI_SIGNING_PRIVATE_KEY_PASSWORD: await secret('updater.password') }, stdio: 'ignore' });
const signature = (await readFile(join(output, `${updateFile}.sig`), 'utf8')).trim();
await rm(join(output, `${updateFile}.sig`));
if (!/^[A-Za-z0-9+/]+=*$/.test(signature)) throw new Error('Missing update signature');
const update = { ...await artifactMetadata(updateFile), signature };
const metadata = { version: pkg.version, platform: 'macOS', architecture: arch, framework: 'Tauri 2', ...await artifactMetadata(dmgFile), archive, installer: await artifactMetadata(installerFile), update };
await writeFile(join(output, `desktop-${arch}.json`), `${JSON.stringify(metadata, null, 2)}\n`);
console.log(JSON.stringify(metadata, null, 2));
