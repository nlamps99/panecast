#!/usr/bin/env python3
"""Publish cmux DR2 for Windows: the zip, installer and source go to COS first,
then windows.json, checksums and the cmux DR2 page files go to the web root.
Existing versioned files are never replaced; the Mac release.json is untouched."""
import argparse
import hashlib
import json
import shlex
import subprocess
import sys
import tarfile
import urllib.request
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'distribution'))
import cos  # noqa: E402

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--build', type=Path, default=ROOT / 'build/cmux-windows')
parser.add_argument('--host', required=True)
parser.add_argument('--directory', required=True, help='Web root of /panecast/ (the cmux page is its cmux/ folder)')
parser.add_argument('--previous-index-sha256', required=True, help='SHA-256 of the live cmux/index.html this page replaces')
parser.add_argument('--notes', action='append', default=[])
args = parser.parse_args()

manifest = json.loads((args.build / 'cmux-dr2-windows.json').read_text())
artifacts = [manifest, manifest['installer'], manifest['source']]


def digest(path):
    value = hashlib.sha256()
    with open(path, 'rb') as stream:
        for block in iter(lambda: stream.read(1 << 20), b''):
            value.update(block)
    return value.hexdigest()


for item in artifacts:
    path = args.build / item['file']
    if digest(path) != item['sha256'] or path.stat().st_size != item['size']:
        raise SystemExit('Build output does not match its manifest: ' + item['file'])

prefix = 'panecast/cmux'
base = f'https://{cos.HOST}/{prefix}'
for item in artifacts:
    print(cos.upload(prefix, str(args.build / item['file'])), item['file'])
# Check what the public will download, including the installer's text type.
for item in artifacts:
    request = urllib.request.Request(f"{base}/{item['file']}", method='HEAD')
    with urllib.request.urlopen(request, timeout=30) as response:
        if response.headers.get('x-cos-meta-sha256') != item['sha256'] or int(response.headers['content-length']) != item['size']:
            raise SystemExit('Object storage copy differs: ' + item['file'])
        if item is manifest['installer'] and response.headers.get('content-type') != 'text/plain; charset=utf-8':
            raise SystemExit('The installer is not served as UTF-8 text')

windows = {**manifest, 'downloadBase': base, 'notes': args.notes}
stage = args.build / 'publish'
stage.mkdir(exist_ok=True)
(stage / 'windows.json').write_text(json.dumps(windows, ensure_ascii=False, indent=2) + '\n')
for item in artifacts:
    (stage / (item['file'] + '.sha256')).write_text(f"{item['sha256']}  {item['file']}\n")
archive = args.build / 'cmux-windows-upload.tar'
with tarfile.open(archive, 'w') as tar:
    for path in sorted(stage.iterdir()):
        tar.add(path, arcname='files/' + path.name)
    for name in ['index.html', 'app.js', 'style.css']:
        tar.add(ROOT / 'distribution/cmux/site' / name, arcname='site/' + name)

ssh = ['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', args.host]
remote_stage = '/tmp/cmux-windows-publish-' + uuid.uuid4().hex
subprocess.run([*ssh, 'mkdir -m 700 ' + shlex.quote(remote_stage)], check=True)
subprocess.run(['scp', '-q', str(archive), f'{args.host}:{remote_stage}/upload.tar'], check=True)
remote = r'''
import hashlib, os, pathlib, shutil, sys, tarfile
stage, root, previous = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2]) / 'cmux', sys.argv[3]
digest = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
with tarfile.open(stage / 'upload.tar') as tar:
    for member in tar.getmembers():
        path = pathlib.PurePosixPath(member.name)
        if not member.isfile() or path.is_absolute() or '..' in path.parts:
            raise SystemExit('Unsafe upload entry')
    tar.extractall(stage / 'unpacked')
files, site = stage / 'unpacked/files', stage / 'unpacked/site'
if digest(root / 'index.html') not in (previous, digest(site / 'index.html')):
    raise SystemExit('The live cmux page changed; review before publishing')
for path in files.iterdir():
    target = root / path.name
    if path.name.endswith('.sha256') and target.exists() and target.read_bytes() != path.read_bytes():
        raise SystemExit('Refusing to replace a published checksum: ' + path.name)
backup = stage / 'previous'; backup.mkdir()
for name in ['index.html', 'app.js', 'style.css', 'windows.json']:
    if (root / name).exists(): shutil.copy2(root / name, backup / name)
def publish(source, target):
    temporary = target.with_name('.' + target.name + '.new')
    shutil.copyfile(source, temporary); os.chmod(temporary, 0o644); os.replace(temporary, target)
# Checksums and metadata first, then the page that reads them.
for path in sorted(files.iterdir()): publish(path, root / path.name)
for name in ['style.css', 'app.js', 'index.html']: publish(site / name, root / name)
print('Published cmux DR2 for Windows; previous page files in', backup)
'''
command = 'python3 - ' + ' '.join(shlex.quote(value) for value in [remote_stage, args.directory, args.previous_index_sha256])
subprocess.run([*ssh, command], input=remote, text=True, check=True)
print(f"Install command: irm {base}/{manifest['installer']['file']} | iex")
