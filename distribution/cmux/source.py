#!/usr/bin/env python3
"""Archive committed cmux source and its native source submodules."""
import argparse
import io
import json
import subprocess
import tarfile
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--repo', type=Path, required=True)
parser.add_argument('--output', type=Path, required=True)
args = parser.parse_args()
repo = args.repo.resolve()
commit = subprocess.check_output(['git', '-C', str(repo), 'rev-parse', 'HEAD'], text=True).strip()
if subprocess.check_output(['git', '-C', str(repo), 'status', '--porcelain'], text=True).strip():
    raise SystemExit('Commit the reviewed source before archiving it')
prefix = 'cmux-dr2-source/'
components = [{'path': '.', 'commit': commit}]
for name in ['ghostty', 'vendor/bonsplit']:
    tree = subprocess.check_output(['git', '-C', str(repo), 'ls-tree', 'HEAD', name], text=True)
    expected = tree.split()[2]
    actual = subprocess.check_output(['git', '-C', str(repo / name), 'rev-parse', 'HEAD'], text=True).strip()
    if actual != expected:
        raise SystemExit('Submodule is not at its pinned revision: ' + name)
    components.append({'path': name, 'commit': actual})
args.output.parent.mkdir(parents=True, exist_ok=True)
with tarfile.open(args.output, 'w:gz') as destination:
    for component in components:
        path = component['path']
        subprefix = prefix if path == '.' else prefix + path + '/'
        process = subprocess.Popen(['git', '-C', str(repo / path), 'archive',
                                    '--format=tar', '--prefix=' + subprefix, component['commit']], stdout=subprocess.PIPE)
        with tarfile.open(fileobj=process.stdout, mode='r|') as source:
            for member in source:
                destination.addfile(member, source.extractfile(member) if member.isfile() else None)
        if process.wait() != 0:
            raise SystemExit('git archive failed')
    data = (json.dumps({'upstreamTag': 'v0.65.2.2', 'components': components}, indent=2) + '\n').encode()
    info = tarfile.TarInfo(prefix + 'SOURCE-REVISIONS.json')
    info.size = len(data)
    info.mode = 0o644
    destination.addfile(info, io.BytesIO(data))
    patch = subprocess.check_output(['git', '-C', str(repo), 'diff', '--binary', 'v0.65.2.2', 'HEAD'])
    info = tarfile.TarInfo(prefix + 'DR2.patch')
    info.size, info.mode = len(patch), 0o644
    destination.addfile(info, io.BytesIO(patch))
    distribution = Path(__file__).resolve().parent
    for name in ['package.py', 'source.py', 'publish.py', 'install.sh.in', 'README.md',
                 'site/index.html', 'site/style.css', 'site/app.js']:
        destination.add(distribution / name, arcname=prefix + 'selfhost/distribution/' + name)
print(json.dumps({'sourceCommit': commit, 'archive': str(args.output), 'bytes': args.output.stat().st_size}))
