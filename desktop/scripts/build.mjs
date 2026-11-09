import { copyFile, cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
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
execFileSync(process.execPath, [join(root, 'node_modules/@tauri-apps/cli/tauri.js'), 'build', '--bundles', 'app', ...(cross ? ['--target', target] : []), '--', '--locked'], { cwd: root, stdio: 'inherit' });
const application = join(root, 'src-tauri/target', ...(cross ? [target] : []), 'release/bundle/macos/Panecast.app');
execFileSync('codesign', ['--verify', '--deep', '--strict', application]);
const directory = join(output, `Panecast-tauri-${arch}`);
await mkdir(directory, { recursive: true });
await rm(join(directory, 'Panecast.app'), { recursive: true, force: true });
await cp(application, join(directory, 'Panecast.app'), { recursive: true });
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
const metadata = { version: pkg.version, platform: 'macOS', architecture: arch, framework: 'Tauri 2', ...await artifactMetadata(dmgFile), archive, installer: await artifactMetadata(installerFile) };
await writeFile(join(output, `desktop-${arch}.json`), `${JSON.stringify(metadata, null, 2)}\n`);
console.log(JSON.stringify(metadata, null, 2));
