import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

export function desktopArtifacts(desktop) {
  if (!desktop) return [];
  const artifacts = [desktop, desktop.archive, desktop.installer].filter(Boolean);
  for (const artifact of artifacts) {
    if (!/^[\w.-]+\.(?:dmg|zip|sh)$/.test(artifact.file) || !/^[a-f0-9]{64}$/.test(artifact.sha256) || !Number.isSafeInteger(artifact.size) || artifact.size <= 0) {
      throw new Error('Set verified desktop artifact metadata in distribution/release.json first');
    }
  }
  if (!/\.(?:dmg|zip)$/.test(desktop.file)) throw new Error('Desktop download must be a DMG or ZIP');
  if (desktop.archive && !desktop.archive.file.endsWith('.zip')) throw new Error('Desktop archive must be a ZIP');
  if (desktop.installer && !/^install-desktop-\d+\.\d+\.\d+-mac-(?:arm64|x64)\.sh$/.test(desktop.installer.file)) throw new Error('Desktop installer must have an immutable versioned filename');
  return artifacts;
}

export async function stageDesktopArtifacts(root, output, desktop) {
  const artifacts = desktopArtifacts(desktop);
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
  return artifacts;
}
