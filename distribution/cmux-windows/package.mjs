#!/usr/bin/env node
// Assembles cmux DR2 for Windows on a Windows machine: the cmux TUI, a pinned
// Node runtime and the Panecast gateway in one zip, plus the versioned
// PowerShell installer that verifies the zip before installing it.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); if (i < 0 || !args[i + 1]) throw new Error(`${name} is required`); return args[i + 1]; };
const cmuxTui = resolve(flag('--cmux-tui')), cmuxSource = resolve(flag('--cmux-source')), cmuxCommit = flag('--cmux-commit');
if (!/^[0-9a-f]{40}$/.test(cmuxCommit)) throw new Error('--cmux-commit must be a full commit hash');
const settings = JSON.parse(await readFile(join(here, 'release.json'), 'utf8'));
const gateway = JSON.parse(await readFile(join(root, 'relay-tmux/package.json'), 'utf8'));
const { version } = settings;
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Invalid version');
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const run = (command, commandArgs, options = {}) => execFileSync(command, commandArgs, { stdio: 'inherit', ...options });
// Windows' own tar (bsdtar) writes zip archives and merges tar archives; Git's tar does neither.
const tar = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';

const output = join(root, 'build/cmux-windows');
const stage = join(output, 'stage'), app = join(stage, 'cmux-dr2');
await rm(output, { recursive: true, force: true });
await mkdir(join(app, 'bin'), { recursive: true });
await mkdir(join(app, 'node'), { recursive: true });
await mkdir(join(app, 'licenses'), { recursive: true });

// cmux TUI and the launchers. `cmux.exe` is a hard link the installer makes.
await copyFile(cmuxTui, join(app, 'bin/cmux-tui.exe'));
for (const name of ['panecast.cmd', 'cmux-dr2.cmd']) await copyFile(join(here, name), join(app, 'bin', name));

// Node runtime, verified against the pinned checksum.
const nodeName = `node-v${settings.node.version}-win-x64`;
const nodeZip = join(output, `${nodeName}.zip`);
const response = await fetch(`https://nodejs.org/dist/v${settings.node.version}/${nodeName}.zip`);
if (!response.ok) throw new Error(`Node download failed: HTTP ${response.status}`);
const nodeBytes = Buffer.from(await response.arrayBuffer());
if (digest(nodeBytes) !== settings.node['win-x64']) throw new Error('Node runtime checksum mismatch');
await writeFile(nodeZip, nodeBytes);
run(tar, ['-xf', nodeZip, '-C', output]);
await copyFile(join(output, nodeName, 'node.exe'), join(app, 'node/node.exe'));
await copyFile(join(output, nodeName, 'LICENSE'), join(app, 'licenses/node-LICENSE.txt'));

// The gateway: the published package's files with production dependencies.
const packed = JSON.parse(execFileSync('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', output], { cwd: join(root, 'relay-tmux'), encoding: 'utf8', shell: true }))[0];
run(tar, ['-xzf', join(output, packed.filename), '-C', output]);
await cp(join(output, 'package'), join(app, 'panecast'), { recursive: true });
await rm(join(app, 'panecast/vendor'), { recursive: true, force: true }); // the macOS cmux relay
await copyFile(join(root, 'relay-tmux/package-lock.json'), join(app, 'panecast/package-lock.json'));
run('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: join(app, 'panecast'), shell: true });
await rm(join(app, 'panecast/package-lock.json'));

for (const [from, to] of [['LICENSE', 'cmux-LICENSE.txt'], ['THIRD_PARTY_LICENSES.md', 'cmux-THIRD_PARTY_LICENSES.md'], ['ghostty/LICENSE', 'ghostty-LICENSE.txt']]) {
  await copyFile(join(cmuxSource, from), join(app, 'licenses', to)).catch(() => { throw new Error(`Missing license file ${from}`); });
}
const info = { name: 'cmux DR2 for Windows', version, cmux: { repository: 'https://github.com/manaflow-ai/cmux', commit: cmuxCommit },
  gateway: gateway.version, node: settings.node.version };
await writeFile(join(app, 'VERSION.json'), `${JSON.stringify(info, null, 2)}\n`);

// Windows tar (bsdtar) writes zip archives that Expand-Archive reads.
const file = `cmux-dr2-${version}-windows-x64.zip`;
run(tar, ['-a', '-cf', join(output, file), '-C', stage, 'cmux-dr2']);
const archive = await readFile(join(output, file));
const artifact = { file, size: archive.length, sha256: digest(archive) };

// Corresponding source (GPL-3.0-or-later): the cmux TUI and Ghostty at the built
// commits, the build scripts, and this repository's recipe for the package.
const sourceFile = `cmux-dr2-${version}-windows-source.tar.gz`;
run('git', ['-C', cmuxSource, 'archive', '--format=tar', '--prefix=cmux/', '-o', join(output, 'cmux.tar'), 'HEAD', 'cmux-tui', 'scripts', 'LICENSE', 'THIRD_PARTY_LICENSES.md', '.gitmodules']);
run('git', ['-C', join(cmuxSource, 'ghostty'), 'archive', '--format=tar', '--prefix=cmux/ghostty/', '-o', join(output, 'ghostty.tar'), 'HEAD']);
run(tar, ['-czf', join(output, sourceFile), `@${join(output, 'cmux.tar')}`, `@${join(output, 'ghostty.tar')}`,
  '-C', root, '.github/workflows/cmux-dr2-windows.yml', 'distribution/cmux-windows']);
await rm(join(output, 'cmux.tar')); await rm(join(output, 'ghostty.tar'));
const sourceBytes = await readFile(join(output, sourceFile));
const source = { file: sourceFile, size: sourceBytes.length, sha256: digest(sourceBytes) };

const template = await readFile(join(here, 'install.ps1.in'), 'utf8');
const values = { VERSION: version, FILE: file, SHA256: artifact.sha256, BASE_URL: settings.downloadBase };
const installer = template.replace(/@([A-Z0-9_]+)@/g, (_, key) => { if (!values[key]) throw new Error(`Unknown installer field ${key}`); return values[key]; });
const installerFile = `install-cmux-dr2-${version}-windows-x64.ps1`;
// Served as text/plain; charset=utf-8 for `irm | iex`, so no byte order mark.
const installerBytes = Buffer.from(installer.replace(/\r?\n/g, '\r\n'));
await writeFile(join(output, installerFile), installerBytes);
await writeFile(join(output, 'install-windows.ps1'), installerBytes);
const manifest = { ...info, ...artifact, date: new Date().toISOString().slice(0, 10), source,
  installer: { file: installerFile, size: installerBytes.length, sha256: digest(installerBytes) } };
await writeFile(join(output, 'cmux-dr2-windows.json'), `${JSON.stringify(manifest, null, 2)}\n`);
await rm(stage, { recursive: true, force: true });
await rm(join(output, nodeName), { recursive: true, force: true });
await rm(join(output, 'package'), { recursive: true, force: true });
await rm(nodeZip); await rm(join(output, packed.filename));
console.log(JSON.stringify(manifest, null, 2));
