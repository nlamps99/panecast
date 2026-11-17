import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const verified = (artifact) => /^[a-f0-9]{64}$/.test(artifact.sha256) && Number.isSafeInteger(artifact.size) && artifact.size > 0;

export function desktopArtifacts(desktop) {
  if (!desktop) return [];
  const artifacts = [desktop, desktop.archive, desktop.installer, desktop.update].filter(Boolean);
  for (const artifact of artifacts) {
    if (!/^[\w.-]+\.(?:dmg|zip|sh|app\.tar\.gz)$/.test(artifact.file) || !verified(artifact)) {
      throw new Error('Set verified desktop artifact metadata in distribution/release.json first');
    }
  }
  if (!/\.(?:dmg|zip)$/.test(desktop.file)) throw new Error('Desktop download must be a DMG or ZIP');
  if (desktop.archive && !desktop.archive.file.endsWith('.zip')) throw new Error('Desktop archive must be a ZIP');
  if (desktop.installer && !/^install-desktop-\d+\.\d+\.\d+-mac-(?:arm64|x64)\.sh$/.test(desktop.installer.file)) throw new Error('Desktop installer must have an immutable versioned filename');
  if (desktop.update && (!/^panecast-desktop-\d+\.\d+\.\d+-mac-(?:arm64|x64)\.app\.tar\.gz$/.test(desktop.update.file) || !/^[A-Za-z0-9+/]+=*$/.test(desktop.update.signature ?? ''))) {
    throw new Error('Desktop update package must be versioned and signed');
  }
  return artifacts;
}

/**
 * The manifest installed Mac apps poll (`plugins.updater.endpoints`). It names
 * the signed package; the app refuses one whose signature does not match the
 * public key it was built with.
 */
export function desktopUpdateManifest(desktop, downloadBase) {
  if (!desktop?.update) return null;
  const platform = { arm64: 'darwin-aarch64', x64: 'darwin-x86_64' }[desktop.architecture];
  if (!platform) throw new Error('Unknown desktop architecture');
  return {
    version: desktop.version,
    notes: (desktop.notes ?? []).join('\n'),
    pub_date: `${desktop.date}T00:00:00Z`,
    platforms: { [platform]: { signature: desktop.update.signature, url: `${downloadBase.replace(/\/$/, '')}/${desktop.update.file}` } },
  };
}

/** The Windows desktop app ships as one versioned per-user installer. */
export function windowsArtifacts(windows) {
  if (!windows) return [];
  if (!/^panecast-desktop-\d+\.\d+\.\d+-windows-x64-setup\.exe$/.test(windows.file) || !verified(windows)) {
    throw new Error('Set verified Windows desktop metadata in distribution/release.json first');
  }
  return [windows];
}

export async function stageDesktopArtifacts(root, output, desktop, windows, downloadBase) {
  const artifacts = [...desktopArtifacts(desktop), ...windowsArtifacts(windows)];
  // Verify all inputs before copying any to the release staging directory.
  for (const artifact of artifacts) {
    const bytes = await readFile(join(root, 'build/desktop', artifact.file));
    if (bytes.length !== artifact.size || createHash('sha256').update(bytes).digest('hex') !== artifact.sha256) {
      throw new Error(`Desktop artifact checksum or size mismatch: ${artifact.file}`);
    }
  }
  for (const artifact of artifacts) {
    await copyFile(join(root, 'build/desktop', artifact.file), join(output, artifact.file));
    await writeFile(join(output, `${artifact.file}.sha256`), `${artifact.sha256}  ${artifact.file}\n`);
  }
  if (desktop?.installer) await copyFile(join(output, desktop.installer.file), join(output, 'install-desktop.sh'));
  const manifest = desktopUpdateManifest(desktop, downloadBase);
  if (manifest) await writeFile(join(output, 'desktop-update.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return artifacts;
}
