#!/usr/bin/env node
import { access, copyFile, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const settings = JSON.parse(await readFile(join(root, 'distribution/release.json'), 'utf8'));
const output = join(root, 'build/distribution/desktop-public');
const response = await fetch(`${settings.baseUrl}/releases.json`, { signal: AbortSignal.timeout(15_000) });
if (!response.ok) throw new Error('Cannot read existing release metadata');
const current = await response.json();
const desktop = settings.desktop;
if (!desktop?.file || !/^[\w.-]+\.zip$/.test(desktop.file)) throw new Error('Set verified desktop metadata in distribution/release.json first');
const artifact = join(root, 'build/desktop', desktop.file);
await access(artifact);
const digest = createHash('sha256').update(await readFile(artifact)).digest('hex');
if (digest !== desktop.sha256) throw new Error('Desktop archive checksum mismatch');
// This directory is generated staging, not a historical release archive.
// Carrying an older ZIP into the next upload bypasses its versioned checksum list.
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await cp(join(root, 'distribution/site'), output, { recursive: true });
await copyFile(join(root, 'client/assets/images/icon.png'), join(output, 'icon.png'));
await copyFile(artifact, join(output, desktop.file));
await writeFile(join(output, `${desktop.file}.sha256`), `${digest}  ${desktop.file}\n`);
await writeFile(join(output, 'SHA256SUMS'), `${digest}  ${desktop.file}\n`);
await writeFile(join(output, 'releases.json'), `${JSON.stringify({ ...current, desktop }, null, 2)}\n`);
console.log(`Prepared desktop release at ${output}`);
