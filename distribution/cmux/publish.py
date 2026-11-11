#!/usr/bin/env python3
"""Publish only cmux downloads and the reviewed Panecast index over SSH."""
import argparse
import hashlib
import json
import shlex
import subprocess
import tarfile
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--public', type=Path, required=True)
parser.add_argument('--host', default='note')
parser.add_argument('--directory', default='/var/lib/docker/volumes/card-note-web_static_vol/_data/panecast')
parser.add_argument('--previous-index-sha256', required=True)
args = parser.parse_args()
public = args.public.resolve()
manifest = json.loads((public / 'release.json').read_text())
artifacts = [manifest[key] for key in ['dmg', 'archive', 'source', 'installer']]


def digest(path):
    value = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            value.update(block)
    return value.hexdigest()


for item in artifacts:
    path = public / item['file']
    if path.parent != public or digest(path) != item['sha256'] or path.stat().st_size != item['size']:
        raise SystemExit('Artifact does not match the manifest: ' + item['file'])
if (public / 'install.sh').read_bytes() != (public / manifest['installer']['file']).read_bytes():
    raise SystemExit('Installer alias differs from versioned installer')
# Upload and verify the large files on object storage before any page or
# feed links to them.
if manifest.get('downloadBase'):
    import sys
    sys.path.insert(0, str(ROOT / 'distribution'))
    import cos
    from urllib.parse import urlparse
    location = urlparse(manifest['downloadBase'])
    if location.scheme != 'https' or location.netloc != cos.HOST:
        raise SystemExit('downloadBase must be the configured COS bucket over HTTPS')
    for key in ['dmg', 'archive', 'source']:
        print(cos.upload(location.path.strip('/'), str(public / manifest[key]['file'])), manifest[key]['file'])
ssh = ['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', args.host]
# Artifacts already published with the same content are not sent again; the
# server checks them in place against the manifest.
names = [item['file'] for item in artifacts]
query = ('import pathlib,hashlib,json; root=pathlib.Path(' + repr(args.directory) + ')/"cmux"; '
         'print(json.dumps({n:hashlib.sha256((root/n).read_bytes()).hexdigest() for n in ' + repr(names) + ' if (root/n).is_file()}))')
published = json.loads(subprocess.check_output([*ssh, 'python3 -c ' + shlex.quote(query)], text=True))
for item in artifacts:
    if item['file'] in published and published[item['file']] != item['sha256']:
        raise SystemExit('Refusing to replace an immutable artifact: ' + item['file'])
archive = public.parent / 'cmux-upload.tar'
with tarfile.open(archive, 'w') as tar:
    for path in sorted(public.iterdir()):
        if not path.is_file() or path.is_symlink():
            raise SystemExit('Only regular release files belong in the public directory')
        if path.name in published:
            continue
        tar.add(path, arcname='cmux/' + path.name)
    tar.add(ROOT / 'distribution/site/index.html', arcname='index.html')
stage = '/tmp/cmux-dr2-publish-' + uuid.uuid4().hex
subprocess.run([*ssh, 'mkdir -m 700 ' + shlex.quote(stage)], check=True)
subprocess.run(['scp', '-q', str(archive), args.host + ':' + stage + '/upload.tar'], check=True)
remote = r'''
import hashlib,json,os,pathlib,shutil,sys,tarfile
stage,root=map(pathlib.Path,sys.argv[1:3]); previous=sys.argv[3]
def digest(path):
    h=hashlib.sha256()
    with path.open('rb') as f:
        for b in iter(lambda:f.read(1024*1024),b''): h.update(b)
    return h.hexdigest()
unpacked=stage/'unpacked';unpacked.mkdir()
with tarfile.open(stage/'upload.tar') as tar:
    for m in tar.getmembers():
        p=pathlib.PurePosixPath(m.name)
        if not m.isfile() or p.is_absolute() or '..' in p.parts:
            raise SystemExit('Unsafe upload entry')
    tar.extractall(unpacked)
source=unpacked/'cmux'; target=root/'cmux'
release=json.loads((source/'release.json').read_text())
artifacts=[release[k] for k in ['dmg','archive','source','installer']]
if digest(root/'index.html') not in [previous,digest(unpacked/'index.html')]:
    raise SystemExit('Live download index changed; review before publishing')
for item in artifacts:
    p=source/item['file'] if (source/item['file']).exists() else target/item['file']
    if p.parent not in (source, target) or digest(p)!=item['sha256'] or p.stat().st_size!=item['size']:
        raise SystemExit('Uploaded artifact mismatch')
    if (target/p.name).exists() and digest(target/p.name)!=item['sha256']:
        raise SystemExit('Refusing to replace an immutable artifact: '+p.name)
if target.exists():
    backup=stage/'previous-cmux';backup.mkdir()
    for p in target.iterdir():
        if p.is_file() and p.suffix in ['.html','.css','.js','.json','.sh','.txt']:
            shutil.copy2(p,backup/p.name)
shutil.copy2(root/'index.html',stage/'previous-index.html')
target.mkdir(exist_ok=True)
immutable={item['file'] for item in artifacts}
def publish(p,destination):
    temporary=destination.with_name('.'+destination.name+'.new')
    shutil.copyfile(p,temporary);os.chmod(temporary,0o644);os.replace(temporary,destination)
for name in sorted(n for n in immutable if (source/n).exists()): publish(source/name,target/name)
# Publish metadata only after every referenced artifact exists.
for p in sorted(source.iterdir()):
    if p.name not in immutable and p.name not in ['index.html','release.json']:
        publish(p,target/p.name)
publish(source/'release.json',target/'release.json')
publish(source/'index.html',target/'index.html')
publish(unpacked/'index.html',root/'index.html')
print(json.dumps({'published':str(target),'backup':str(stage),'sourceCommit':release['sourceCommit']}))
'''
command = 'python3 - ' + ' '.join(shlex.quote(value) for value in [stage, args.directory, args.previous_index_sha256])
subprocess.run([*ssh, command], input=remote, text=True, check=True)
print('Public URL: https://ningzx.cn/panecast/cmux/')
