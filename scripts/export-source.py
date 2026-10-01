#!/usr/bin/env python3
"""Export an explicit, committed source allowlist. No uploads or visibility changes."""
from __future__ import annotations
import argparse
import gzip
import hashlib
import io
import json
import os
from pathlib import Path
import re
import subprocess
import tarfile
import tempfile

POLICY = 'distribution/source-files.txt'
FIXTURES = 'distribution/binary-fixtures.json'
REQUIRED = {POLICY, FIXTURES, 'README.md', 'COPYING', 'THIRD_PARTY.md',
            'docs/publishing.md', 'addon/iridium/prepare.py', 'addon/iridium/sync.py',
            'addon/iridium/configuration.py', 'addon/iridium/host-profiles.json',
            'LICENSES/Apache-2.0.txt', 'WasmProbe/Kernels/box2d/LICENSE',
            'WasmProbe/Kernels/coremark/LICENSE.md'}
FORBIDDEN_PARTS = {'.git', '.betterjit-addon', '.build', '.swiftpm', 'results',
                   'artifacts', 'FEX', 'out', 'build', '__pycache__', 'xcuserdata'}
FORBIDDEN_SUFFIXES = {'.log', '.jsonl', '.ipa', '.p12', '.pfx', '.mobileprovision',
                      '.pem', '.key', '.a', '.dylib', '.o', '.xcarchive'}
SENSITIVE = [re.compile(rb'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----'),
             re.compile(rb'gh[pousr]_[A-Za-z0-9]{36,}'),
             re.compile(rb'github_pat_[A-Za-z0-9_]{30,}'),
             re.compile(rb'/Users/[A-Za-z0-9_.-]+/'),
             re.compile(rb'\b[0-9A-Fa-f]{8}-[0-9A-Fa-f]{16}\b')]


def git(root: Path, *args: str) -> bytes:
    return subprocess.check_output(['git', '-C', str(root), *args], stderr=subprocess.PIPE)


def validate_path(name: str) -> None:
    if (not name or name == 'SOURCE-MANIFEST.json' or name.startswith('/') or ':' in name or '\\' in name
            or any(ord(c) < 32 or ord(c) == 127 for c in name)
            or any(p in {'', '.', '..'} | FORBIDDEN_PARTS for p in name.split('/'))
            or Path(name).suffix.lower() in FORBIDDEN_SUFFIXES
            or name.endswith('.local.json') or Path(name).name.startswith('.env')):
        raise ValueError(f'Disallowed export path: {name!r}')


def collect(root: Path, ref: str = 'HEAD') -> tuple[str, dict[str, tuple[str, bytes]]]:
    root = root.resolve()
    if Path(git(root, 'rev-parse', '--show-toplevel').decode().strip()).resolve() != root:
        raise ValueError('Run from the add-on repository, not a parent checkout.')
    if git(root, 'status', '--porcelain', '--untracked-files=no').strip():
        raise ValueError('Commit or preserve tracked edits before export. Only committed bytes are exported.')
    revision = git(root, 'rev-parse', '--verify', '--end-of-options', ref + '^{commit}').decode().strip()
    tree = {}
    for record in git(root, 'ls-tree', '-r', '-z', revision).split(b'\0'):
        if not record: continue
        info, path = record.split(b'\t', 1)
        mode, kind, sha = info.decode().split()
        tree[path.decode()] = (mode, kind, sha)
    def content(name: str) -> tuple[str, bytes]:
        validate_path(name)
        if name not in tree: raise ValueError(f'Missing allowlisted source: {name}')
        mode, kind, sha = tree[name]
        if kind != 'blob' or mode not in {'100644', '100755'}:
            raise ValueError(f'Only regular files may be exported: {name}')
        return mode, git(root, 'cat-file', 'blob', sha)
    policy = content(POLICY)[1].decode().splitlines()
    paths = [n.strip() for n in policy if n.strip() and not n.lstrip().startswith('#')]
    if len(paths) != len(set(paths)): raise ValueError('Duplicate source export path.')
    if not REQUIRED.issubset(paths): raise ValueError('Source policy omits required implementation or license files.')
    fixture_data = json.loads(content(FIXTURES)[1])
    if (not isinstance(fixture_data, dict) or type(fixture_data.get('schema')) is not int or fixture_data.get('schema') != 1
            or not isinstance(fixture_data.get('files'), dict)):
        raise ValueError('Invalid binary fixture manifest.')
    fixtures = fixture_data['files']
    if not set(fixtures).issubset(paths): raise ValueError('Source policy omits a declared binary fixture.')
    result = {}
    for name in sorted(paths):
        mode, data = content(name)
        if name in fixtures:
            item = fixtures[name]
            if (not isinstance(item, dict) or not isinstance(item.get('sources'), list)
                    or not item['sources'] or not all(isinstance(p, str) for p in item['sources'])
                    or not set(item['sources']).issubset(paths)
                    or hashlib.sha256(data).hexdigest() != item.get('sha256')):
                raise ValueError(f'Fixture digest/source declaration needs review: {name}')
        else:
            if Path(name).suffix in {'.bin', '.wasm'}: raise ValueError(f'Undeclared binary fixture: {name}')
            try: data.decode('utf-8')
            except UnicodeError as error: raise ValueError(f'Undeclared binary content: {name}') from error
            if b'\0' in data: raise ValueError(f'NUL byte in source text: {name}')
        if any(pattern.search(data) for pattern in SENSITIVE):
            raise ValueError(f'Potential personal data or credential in {name}; inspect manually. Nothing exported.')
        result[name] = mode, data
    return revision, result


def export(root: Path, output: Path, ref: str = 'HEAD') -> dict:
    root, output = root.resolve(), output.absolute()
    if output.exists() or output.is_symlink(): raise ValueError('Output exists; it will not be overwritten.')
    if not output.name.endswith('.tar.gz'): raise ValueError('Output must end in .tar.gz.')
    if output.resolve() == root or root in output.resolve().parents:
        raise ValueError('Export outside the source checkout to avoid accidental recommits.')
    revision, files = collect(root, ref)
    manifest = {'schema': 1, 'sourceRevision': revision, 'kind': 'source-export-candidate',
                'files': {name: hashlib.sha256(data).hexdigest() for name, (_, data) in files.items()}}
    files['SOURCE-MANIFEST.json'] = '100644', (json.dumps(manifest, indent=2, sort_keys=True) + '\n').encode()
    output.parent.mkdir(parents=True, exist_ok=True)
    fd, temp = tempfile.mkstemp(prefix='.betterjit-export-', dir=output.parent)
    try:
        with os.fdopen(fd, 'wb') as raw, gzip.GzipFile(filename='', fileobj=raw, mode='wb', mtime=0) as gz:
            with tarfile.open(fileobj=gz, mode='w', format=tarfile.PAX_FORMAT) as archive:
                for name, (mode, data) in sorted(files.items()):
                    entry = tarfile.TarInfo('BetterJIT/' + name)
                    entry.size = len(data)
                    entry.mode = 0o755 if mode == '100755' else 0o644
                    entry.mtime = entry.uid = entry.gid = 0
                    entry.uname = entry.gname = ''
                    archive.addfile(entry, io.BytesIO(data))
        # Publish locally, atomically, and exclusively; never replace an existing file.
        os.link(temp, output)
    finally:
        os.unlink(temp)
    return manifest


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--repo', type=Path, default=Path(__file__).resolve().parents[1])
    p.add_argument('--ref', default='HEAD', help='Exact committed source revision to inspect')
    mode = p.add_mutually_exclusive_group(required=True)
    mode.add_argument('--output', type=Path)
    mode.add_argument('--check', action='store_true', help='Validate committed export policy without writing an archive')
    args = p.parse_args()
    try:
        if args.check:
            rev, files = collect(args.repo, args.ref)
            print(f'Checked {len(files)} allowlisted files at {rev}; human publication review is still required.')
        else:
            report = export(args.repo, args.output, args.ref)
            digest = hashlib.sha256(args.output.read_bytes()).hexdigest()
            print(f'Local source candidate: {args.output}\nSource: {report["sourceRevision"]}\nSHA-256: {digest}\nNo files were uploaded or published.')
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        print(f'Export stopped: {error}', file=__import__('sys').stderr)
        return 1
    return 0


if __name__ == '__main__': raise SystemExit(main())
