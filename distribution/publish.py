#!/usr/bin/env python3
"""Publish a built download directory over SSH; preserve versioned artifacts."""
import argparse
import hashlib
import json
import shlex
import subprocess
import tarfile
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--host', required=True)
parser.add_argument('--directory', required=True, help='Existing web root for /panecast/')
parser.add_argument('--desktop-only', action='store_true', help='Publish a desktop build while preserving the current CLI and mobile releases')
args = parser.parse_args()
public = ROOT / ('build/distribution/desktop-public' if args.desktop_only else 'build/distribution/public')
manifest = json.loads((public / 'releases.json').read_text())
desktop = manifest.get('desktop', {})
desktop_artifacts = [item for item in [desktop, desktop.get('archive'), desktop.get('installer'), manifest.get('windows')] if item]
for item in (desktop_artifacts if args.desktop_only else [manifest['android'], manifest['mac'], *desktop_artifacts]):
    actual = hashlib.sha256((public / item['file']).read_bytes()).hexdigest()
    if actual != item['sha256']:
        raise SystemExit('Build output does not match releases.json')
if desktop.get('installer') and (public / 'install-desktop.sh').read_bytes() != (public / desktop['installer']['file']).read_bytes():
    raise SystemExit('Desktop installer alias does not match the versioned installer')

# Packages listed in SHA256SUMS are served from object storage when the manifest
# names a download base. Upload and verify them before any page links to them.
if manifest.get('downloadBase'):
    import cos
    from urllib.parse import urlparse
    location = urlparse(manifest['downloadBase'])
    if location.scheme != 'https' or location.netloc != cos.HOST:
        raise SystemExit('downloadBase must be the configured COS bucket over HTTPS')
    names = [item['file'] for item in (desktop_artifacts if args.desktop_only else [manifest['android'], manifest['mac'], *desktop_artifacts])]
    if not args.desktop_only:
        names += [line.split('  ', 1)[1] for line in (public / 'SHA256SUMS').read_text().splitlines()]
    for name in dict.fromkeys(names):
        print(cos.upload(location.path.strip('/'), str(public / name)), name)

archive = ROOT / ('build/distribution/desktop-upload.tar.gz' if args.desktop_only else 'build/distribution/upload.tar.gz')
ssh = ['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', args.host]
checksums = dict(line.split('  ', 1)[::-1] for line in (public / 'SHA256SUMS').read_text().splitlines())
query = 'import pathlib,hashlib,json; root=pathlib.Path(' + repr(args.directory) + '); print(json.dumps({name:hashlib.sha256((root/name).read_bytes()).hexdigest() for name in ' + repr(list(checksums)) + ' if (root/name).is_file()}))'
existing = json.loads(subprocess.check_output([*ssh, 'python3 -c ' + shlex.quote(query)], text=True))
for filename, actual in existing.items():
    if actual != checksums[filename]:
        raise SystemExit('Refusing to replace a published artifact: ' + filename)
with tarfile.open(archive, 'w:gz') as tar:
    for path in sorted(public.iterdir()):
        if path.name == 'panecast-latest.apk' or path.name in existing:
            continue
        tar.add(path, arcname=path.name)
staging = '/tmp/panecast-publish-' + uuid.uuid4().hex
subprocess.run([*ssh, 'mkdir -m 700 ' + shlex.quote(staging)], check=True)
subprocess.run(['scp', '-q', str(archive), args.host + ':' + staging + '/upload.tar.gz'], check=True)
remote = r'''
import sys, pathlib, tarfile, hashlib, shutil, os
stage, destination = map(pathlib.Path, sys.argv[1:3])
desktop_only = sys.argv[3] == '1'
unpacked = stage / 'public'
unpacked.mkdir()
with tarfile.open(stage / 'upload.tar.gz') as tar:
    for member in tar.getmembers():
        path = pathlib.PurePosixPath(member.name)
        if path.is_absolute() or '..' in path.parts or member.issym() or member.islnk():
            raise SystemExit('Unsafe archive entry: ' + member.name)
    tar.extractall(unpacked)
versioned = set()
for line in (unpacked / 'SHA256SUMS').read_text().splitlines():
    expected, filename = line.split('  ', 1)
    versioned.update([filename, filename + '.sha256'])
    candidate = unpacked / filename if (unpacked / filename).exists() else destination / filename
    if hashlib.sha256(candidate.read_bytes()).hexdigest() != expected:
        raise SystemExit('Upload checksum mismatch: ' + filename)
    target = destination / filename
    if target.exists() and hashlib.sha256(target.read_bytes()).hexdigest() != expected:
        raise SystemExit('Refusing to overwrite versioned artifact: ' + filename)
destination.mkdir(parents=True, exist_ok=True)
if desktop_only:
    import json
    before = json.loads((destination / 'releases.json').read_text())
    after = json.loads((unpacked / 'releases.json').read_text())
    if {k:v for k,v in before.items() if k not in ('desktop', 'windows')} != {k:v for k,v in after.items() if k not in ('desktop', 'windows')}:
        raise SystemExit('Other releases changed during this build. Prepare the desktop release again.')
# Versioned packages first. Old packages stay available for existing links.
for source in unpacked.iterdir():
    if source.is_file() and source.name in versioned:
        target = destination / source.name
        shutil.copyfile(source, str(target) + '.new')
        os.chmod(str(target) + '.new', 0o644)
        os.replace(str(target) + '.new', target)
# The Git object database is append-only. Publish refs after objects.
source_tap, target_tap = unpacked / 'homebrew-tap.git', destination / 'homebrew-tap.git'
if not desktop_only:
    shutil.copytree(source_tap / 'objects', target_tap / 'objects', dirs_exist_ok=True)
    for name in ['refs', 'info', 'hooks']:
        if (source_tap / name).exists():
            shutil.copytree(source_tap / name, target_tap / name, dirs_exist_ok=True)
    for source in source_tap.iterdir():
        if source.is_file():
            target = target_tap / source.name
            shutil.copyfile(source, str(target) + '.new')
            os.replace(str(target) + '.new', target)
# Metadata and page files are small atomic replacements.
for source in unpacked.iterdir():
    if source.is_file() and source.name != 'panecast-latest.apk' and source.name not in versioned:
        if desktop_only and source.name == 'SHA256SUMS':
            existing = dict(line.split('  ', 1)[::-1] for line in (destination / 'SHA256SUMS').read_text().splitlines())
            existing.update(dict(line.split('  ', 1)[::-1] for line in source.read_text().splitlines()))
            source.write_text(''.join(value + '  ' + name + '\n' for name, value in sorted(existing.items())))
        target = destination / source.name
        shutil.copyfile(source, str(target) + '.new')
        os.chmod(str(target) + '.new', 0o644)
        os.replace(str(target) + '.new', target)
import json
if not desktop_only:
    latest = json.loads((unpacked / 'releases.json').read_text())['android']['file']
    link = destination / '.panecast-latest.new'
    if link.is_symlink() or link.exists(): link.unlink()
    link.symlink_to(latest)
    os.replace(link, destination / 'panecast-latest.apk')
print('Published desktop download and metadata.' if desktop_only else 'Published download page, CLI, installers, Homebrew tap and Android APK.')
'''
command = 'python3 - ' + shlex.quote(staging) + ' ' + shlex.quote(args.directory) + (' 1' if args.desktop_only else ' 0')
subprocess.run([*ssh, command], input=remote, text=True, check=True)
print('Remote staging retained for rollback:', staging)
