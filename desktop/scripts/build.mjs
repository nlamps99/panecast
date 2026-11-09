import { packager } from '@electron/packager';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const output = resolve(root, '../build/desktop');
const arch = process.env.PANECAST_DESKTOP_ARCH ?? process.arch;
if (!['arm64', 'x64'].includes(arch)) throw new Error('Unsupported architecture');
const iconset = join(output, 'Panecast.iconset');
await mkdir(iconset, { recursive: true });
for (const size of [16, 32, 128, 256, 512]) {
  for (const scale of [1, 2]) execFileSync('sips', ['-z', String(size * scale), String(size * scale), join(root, '../client/assets/images/icon.png'), '--out', join(iconset, `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`)], { stdio: 'ignore' });
}
const icon = join(output, 'Panecast.icns');
execFileSync('iconutil', ['-c', 'icns', iconset, '-o', icon]);
const [directory] = await packager({ dir: root, name: 'Panecast', appBundleId: 'com.nzx.panecast.desktop', appVersion: pkg.version,
  platform: 'darwin', arch, out: output, overwrite: true, asar: true, icon,
  ignore: [/^\/test(?:\/|$)/, /^\/scripts(?:\/|$)/, /^\/README\.md$/],
  osxSign: { identity: '-', identityValidation: false, preAutoEntitlements: false, preEmbedProvisioningProfile: false,
    optionsForFile: () => ({ hardenedRuntime: false }) },
});
// Packager can warn and continue after a signing failure. Never publish such an archive.
execFileSync('codesign', ['--verify', '--deep', '--strict', join(directory, 'Panecast.app')]);
await mkdir(output, { recursive: true });
const file = `panecast-desktop-${pkg.version}-mac-${arch}.zip`;
execFileSync('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', join(directory, 'Panecast.app'), join(output, file)]);
const bytes = await readFile(join(output, file));
const metadata = { version: pkg.version, platform: 'macOS', architecture: arch, file, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
await writeFile(join(output, `${file}.sha256`), `${metadata.sha256}  ${file}\n`);
await writeFile(join(output, `desktop-${arch}.json`), `${JSON.stringify(metadata, null, 2)}\n`);
console.log(JSON.stringify(metadata, null, 2));
