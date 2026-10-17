#!/usr/bin/env python3
"""Create an SDK-only source candidate from exact committed paths; never publish."""
from __future__ import annotations
import argparse
import gzip
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import re
import subprocess
import tarfile

ROOT = Path(__file__).resolve().parents[1]

def git(root, *args):
    return subprocess.check_output(['git', '-C', str(root), *args])

def safe_path(name):
    p = PurePosixPath(name)
    if p.is_absolute() or not p.parts or any(x in ('..', '.', '.git') for x in p.parts) or str(p) != name:
        raise ValueError('Invalid export path.')
    if any(c in name for c in '\r\n\\'): raise ValueError('Invalid export path.')
    return name

def validate_destination_casing(names):
    seen = {}
    for name in names:
        safe_path(name)
        parts = name.split('/')
        for length in range(1, len(parts) + 1):
            prefix = '/'.join(parts[:length])
            previous = seen.setdefault(prefix.casefold(), prefix)
            if previous != prefix:
                raise ValueError('SDK destination casing conflict: ' + previous + ' / ' + prefix)

def collect(root, ref):
    revision = git(root, 'rev-parse', '--verify', '--end-of-options', ref + '^{commit}').decode().strip()
    spec = json.loads(git(root, 'show', revision + ':distribution/sdk-files.json'))
    if spec.get('schema') != 1 or not isinstance(spec.get('files'), dict): raise ValueError('Invalid SDK allowlist.')
    validate_destination_casing([*spec['files'], 'SOURCE-MANIFEST.json'])
    result = {}; hashes = {}
    for destination, source in sorted(spec['files'].items()):
        safe_path(destination); safe_path(source)
        if destination == 'SOURCE-MANIFEST.json': raise ValueError('Reserved SDK manifest path.')
        entry = git(root, 'ls-tree', '-z', revision, '--', source).split(b'\0')[0]
        if not entry: raise ValueError('Missing committed SDK source: ' + source)
        mode = entry.split(b' ', 1)[0]
        if mode not in (b'100644', b'100755'): raise ValueError('Only regular source files may be exported: ' + source)
        data = git(root, 'show', revision + ':' + source)
        if len(data) > 2 * 1024 * 1024 or b'\0' in data: raise ValueError('Unexpected binary/oversized SDK source: ' + source)
        try: data.decode('utf-8')
        except UnicodeDecodeError as error: raise ValueError('SDK source is not UTF-8: ' + source) from error
        if re.search(rb'-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----', data) or re.search(rb'gh[pousr]_[A-Za-z0-9]{30,}', data):
            raise ValueError('Potential credential in SDK source: ' + source)
        result[destination] = (data, 0o755 if mode == b'100755' else 0o644)
        hashes[destination] = {'source': source, 'sha256': hashlib.sha256(data).hexdigest()}
    for required in ('Package.swift', 'COPYING', 'README.md', 'docs/sdk/provenance.md'):
        if required not in result: raise ValueError('Missing SDK package entry: ' + required)
    manifest = {'schema': 1, 'sourceRevision': revision, 'kind': 'source-sdk-candidate', 'files': hashes}
    result['SOURCE-MANIFEST.json'] = ((json.dumps(manifest, indent=2, sort_keys=True) + '\n').encode(), 0o644)
    return result

def archive(files):
    buffer = io.BytesIO()
    with gzip.GzipFile(filename='', mode='wb', fileobj=buffer, mtime=0) as gz:
        with tarfile.open(fileobj=gz, mode='w') as tar:
            for name, (data, mode) in sorted(files.items()):
                info = tarfile.TarInfo('BetterJIT-SDK/' + name)
                info.size = len(data); info.mode = mode; info.mtime = 0
                tar.addfile(info, io.BytesIO(data))
    return buffer.getvalue()

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--ref', default='HEAD')
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument('--check', action='store_true'); group.add_argument('--output', type=Path)
    args = parser.parse_args()
    files = collect(ROOT, args.ref)
    if args.check: print(f'SDK allowlist validated: {len(files)-1} files. No upload or publication.'); return
    output = args.output.resolve()
    if output == ROOT or ROOT in output.parents: raise ValueError('Export outside the source checkout.')
    data = archive(files)
    with output.open('xb') as file: file.write(data)
    print(f'SDK source candidate: {output}\nSHA-256: {hashlib.sha256(data).hexdigest()}')
if __name__ == '__main__':
    try: main()
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        raise SystemExit('Export stopped: ' + str(error))
