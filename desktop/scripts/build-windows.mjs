// Builds the Windows installer (NSIS, per-user, no administrator rights) on Windows.
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'win32') throw new Error('Build the Windows installer on Windows');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
if (!/^\d+\.\d+\.\d+$/.test(pkg.version)) throw new Error('Invalid release version');
const arch = process.env.PANECAST_DESKTOP_ARCH ?? process.arch;
if (arch !== 'x64') throw new Error('Only x64 Windows builds are supported');
execFileSync(process.execPath, [join(root, 'node_modules/@tauri-apps/cli/tauri.js'), 'build', '--bundles', 'nsis', '--', '--locked'], { cwd: root, stdio: 'inherit' });

// The app must start as a windowed program, without a console window.
const program = await readFile(join(root, 'src-tauri/target/release/panecast-desktop.exe'));
const header = program.readUInt32LE(0x3c);
if (program.toString('latin1', header, header + 4) !== 'PE\0\0') throw new Error('Not a Windows program');
const machine = program.readUInt16LE(header + 4);
const subsystem = program.readUInt16LE(header + 24 + 68);
if (machine !== 0x8664) throw new Error(`Unexpected machine type ${machine.toString(16)}`);
if (subsystem !== 2) throw new Error(`Expected a GUI program, got subsystem ${subsystem}`);

const setup = join(root, `src-tauri/target/release/bundle/nsis/Panecast_${pkg.version}_x64-setup.exe`);
const output = resolve(root, '../build/desktop');
await mkdir(output, { recursive: true });
const file = `panecast-desktop-${pkg.version}-windows-x64-setup.exe`;
await copyFile(setup, join(output, file));
const bytes = await readFile(join(output, file));
const metadata = { version: pkg.version, platform: 'Windows', architecture: 'x64', framework: 'Tauri 2',
  file, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
await writeFile(join(output, `${file}.sha256`), `${metadata.sha256}  ${file}\n`);
await writeFile(join(output, 'desktop-windows-x64.json'), `${JSON.stringify(metadata, null, 2)}\n`);
console.log(JSON.stringify(metadata, null, 2));
