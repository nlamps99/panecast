#!/usr/bin/env node
import { readFile, writeFile, mkdir, cp, copyFile, access, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { stageDesktopArtifacts } from './desktop-artifacts.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = join(root, 'build/distribution/public');
const settingsPath = join(root, 'distribution/release.json');
const settings = JSON.parse(await readFile(settingsPath, 'utf8'));
const packageJSON = JSON.parse(await readFile(join(root, 'relay-tmux/package.json'), 'utf8'));
const digest = async (path) => createHash('sha256').update(await readFile(path)).digest('hex');
const safeFile = (name) => { if (!/^[\w.-]+$/.test(name)) throw new Error(`Invalid artifact filename: ${name}`); return name; };
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await copyFile(join(root, 'LICENSE'), join(root, 'relay-tmux/LICENSE'));
// The gateway starts this relay for cmux when the Mac has no relay of its own.
// Universal (Apple Silicon + Intel), stripped, ad-hoc signed; 4 jobs keep the Mac responsive.
const relayDirectory = join(root, 'relay');
const swift = (...args) => execFileSync('swift', ['build', '-c', 'release', '-j', '4', '--arch', 'arm64', '--arch', 'x86_64', '--product', 'cmux-relay', ...args], { cwd: relayDirectory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
swift();
const vendored = join(root, 'relay-tmux/vendor/darwin/cmux-relay');
await rm(join(root, 'relay-tmux/vendor'), { recursive: true, force: true });
await mkdir(join(root, 'relay-tmux/vendor/darwin'), { recursive: true });
await copyFile(join(swift('--show-bin-path').trim(), 'cmux-relay'), vendored);
execFileSync('strip', ['-x', vendored]);
execFileSync('codesign', ['--force', '--sign', '-', vendored], { stdio: 'ignore' });
execFileSync('codesign', ['--verify', '--strict', vendored]);
const architectures = execFileSync('lipo', ['-archs', vendored], { encoding: 'utf8' }).trim().split(/\s+/).sort().join(' ');
if (architectures !== 'arm64 x86_64') throw new Error(`cmux-relay must be universal, got: ${architectures}`);
if (!execFileSync(vendored, ['devices', 'add', '--help'], { encoding: 'utf8' }).includes('--state-dir')) throw new Error('cmux-relay lacks gateway support');
const packed = JSON.parse(execFileSync('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', output], { cwd: join(root, 'relay-tmux'), encoding: 'utf8' }))[0];
const cliFile = safeFile(packed.filename), cliSHA = await digest(join(output, cliFile));
const mac = { version: packageJSON.version, file: cliFile, sha256: cliSHA, date: settings.mac.date, notes: settings.mac.notes };
for (const arch of ['arm64', 'x64']) {
  const filename = `node-v${settings.node.version}-darwin-${arch}.tar.gz`;
  const cached = join(root, 'build/distribution/cache', filename);
  if (await digest(cached) !== settings.node[`darwin-${arch}`]) throw new Error(`Node runtime checksum mismatch: ${filename}`);
  await copyFile(cached, join(output, filename));
}
const androidFile = safeFile(settings.android.file);
const apkPath = join(root, 'client/build/android', androidFile);
if (await digest(apkPath) !== settings.android.sha256) throw new Error('Android APK checksum mismatch');
await copyFile(apkPath, join(output, androidFile));
await copyFile(apkPath, join(output, 'panecast-latest.apk'));
const desktopArtifacts = await stageDesktopArtifacts(root, output, settings.desktop);
for (const artifact of [mac, settings.android]) await writeFile(join(output, artifact.file + '.sha256'), `${artifact.sha256}  ${artifact.file}\n`);
const template = await readFile(join(root, 'distribution/install.sh.in'), 'utf8');
const values = { CLI_VERSION: mac.version, CLI_FILE: mac.file, CLI_SHA: mac.sha256, NODE_VERSION: settings.node.version,
  NODE_ARM64_SHA: settings.node['darwin-arm64'], NODE_X64_SHA: settings.node['darwin-x64'], BASE_URL: settings.baseUrl };
const installer = template.replace(/__([A-Z0-9_]+)__/g, (_, key) => { if (!values[key]) throw new Error(`Unknown template field ${key}`); return values[key]; });
await writeFile(join(output, 'install.sh'), installer, { mode: 0o755 });
await cp(join(root, 'distribution/site'), output, { recursive: true });
await copyFile(join(root, 'client/assets/images/icon.png'), join(output, 'icon.png'));
await writeFile(join(output, 'releases.json'), JSON.stringify({ schemaVersion: 1, android: settings.android, mac, ...(settings.desktop ? { desktop: settings.desktop } : {}), history: settings.history }, null, 2) + '\n');

const tap = join(root, 'build/distribution/tap');
await mkdir(join(tap, 'Formula'), { recursive: true });
const formula = `class Panecast < Formula
  desc "Connect your Mac's terminals to Panecast"
  homepage "${settings.baseUrl}/"
  url "${settings.baseUrl}/${mac.file}"
  version "${mac.version}"
  sha256 "${mac.sha256}"
  license "MIT"

  depends_on :macos
  depends_on "tmux"

  resource "node-runtime" do
    url "${settings.baseUrl}/node-v${settings.node.version}-darwin-#{Hardware::CPU.arm? ? 'arm64' : 'x64'}.tar.gz"
    sha256 Hardware::CPU.arm? ? "${settings.node['darwin-arm64']}" : "${settings.node['darwin-x64']}"
  end

  def install
    libexec.install Dir["*"]
    resource("node-runtime").stage do
      (libexec/"runtime").install Dir["*"]
    end
    (bin/"panecast").write <<~EOS
      #!/bin/bash
      export PANECAST_LAUNCHER="#{opt_bin}/panecast"
      export PATH="#{opt_libexec}/runtime/bin:#{Formula["tmux"].opt_bin}:$PATH"
      exec "#{opt_libexec}/runtime/bin/node" "#{opt_libexec}/bin/panecast.mjs" "$@"
    EOS
  end

  def caveats
    <<~EOS
      Configure once (sign in, credentials are assigned automatically): panecast setup
      Start in background: panecast start
      Phones signed in to the same account see this computer; or pair by QR: panecast pair
      After upgrading: panecast restart
      Before uninstalling: panecast stop
      Configuration and paired devices stay in ~/.cmuxremote.
    EOS
  end

  test do
    assert_equal "${mac.version}", shell_output("#{bin}/panecast --version").strip
    assert_match "panecast setup", shell_output("#{bin}/panecast --help")
  end
end
`;
await writeFile(join(tap, 'Formula/panecast.rb'), formula);
await writeFile(join(tap, 'README.md'), '# Panecast Homebrew tap\n\nbrew tap panecast/tap ' + settings.baseUrl + '/homebrew-tap.git\nbrew install panecast/tap/panecast\n');
const git = (...args) => execFileSync('git', ['-C', tap, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
try { await access(join(tap, '.git')); } catch { git('init', '-b', 'main'); }
git('add', 'Formula/panecast.rb', 'README.md');
if (git('diff', '--cached', '--name-only').trim()) git('-c', 'user.name=Panecast Releases', '-c', 'user.email=releases@panecast.local', 'commit', '-m', `Release Panecast ${mac.version}`);
const bare = join(output, 'homebrew-tap.git');
try { await access(bare); execFileSync('git', ['--git-dir', bare, 'fetch', tap, 'main:main']); }
catch { execFileSync('git', ['clone', '--bare', tap, bare], { stdio: 'pipe' }); }
execFileSync('git', ['--git-dir', bare, 'update-server-info']);
// Remove the build machine's local path from the publicly served Git config.
try { execFileSync('git', ['--git-dir', bare, 'config', '--remove-section', 'remote.origin'], { stdio: 'ignore' }); } catch {}
const checksums = [];
for (const filename of [cliFile, androidFile, ...desktopArtifacts.map(({ file }) => file), ...['arm64', 'x64'].map((arch) => `node-v${settings.node.version}-darwin-${arch}.tar.gz`)]) {
  checksums.push(`${await digest(join(output, filename))}  ${filename}`);
}
await writeFile(join(output, 'SHA256SUMS'), checksums.join('\n') + '\n');
console.log(JSON.stringify({ output, cli: mac, cmuxRelay: { sha256: await digest(vendored), architectures }, android: settings.android.file }, null, 2));
