#!/usr/bin/env node
import { copyFile, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { stageDesktopArtifacts } from './desktop-artifacts.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const settings = JSON.parse(await readFile(join(root, 'distribution/release.json'), 'utf8'));
const output = join(root, 'build/distribution/desktop-public');
const response = await fetch(`${settings.baseUrl}/releases.json`, { signal: AbortSignal.timeout(15_000) });
if (!response.ok) throw new Error('Cannot read existing release metadata');
const current = await response.json();
const desktop = settings.desktop;
if (!desktop) throw new Error('Set verified desktop metadata in distribution/release.json first');
// This directory is generated staging, not a historical release archive.
// Carrying old packages into the next upload bypasses their versioned checksum list.
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await cp(join(root, 'distribution/site'), output, { recursive: true });
await copyFile(join(root, 'client/assets/images/icon.png'), join(output, 'icon.png'));
const artifacts = await stageDesktopArtifacts(root, output, desktop);
await writeFile(join(output, 'SHA256SUMS'), artifacts.map(({ file, sha256 }) => `${sha256}  ${file}\n`).join(''));
await writeFile(join(output, 'releases.json'), `${JSON.stringify({ ...current, desktop }, null, 2)}\n`);
console.log(`Prepared desktop release at ${output}`);
