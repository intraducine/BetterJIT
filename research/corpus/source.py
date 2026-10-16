#!/usr/bin/env python3
"""Fetch only the public immutable corpus pin into a separate research checkout."""
import argparse
import json
import subprocess
from pathlib import Path

SPEC = json.loads((Path(__file__).parent / 'pilot.json').read_text())
DEPENDENCIES = ['External/fmt', 'External/xxhash', 'External/unordered_dense', 'External/range-v3']


def fetch(target, dependencies=False):
    target = target.resolve()
    def git(*args):
        return subprocess.check_output(['git', '-C', str(target), *args], text=True).strip()
    if not target.exists():
        target.mkdir(parents=True)
        git('init', '--quiet')
        git('fetch', '--quiet', '--depth=1', SPEC['source']['repository'], SPEC['source']['commit'])
        git('checkout', '--quiet', '--detach', 'FETCH_HEAD')
    assert git('rev-parse', 'HEAD') == SPEC['source']['commit'], 'existing research checkout has another pin'
    assert not git('status', '--porcelain', '--untracked-files=no'), 'modified target FEX source'
    if dependencies:
        git('submodule', 'update', '--init', '--depth=1', '--', *DEPENDENCIES)
        for path in DEPENDENCIES:
            expected = git('ls-tree', 'HEAD', path).split()[2]
            actual = subprocess.check_output(['git', '-C', str(target / path), 'rev-parse', 'HEAD'], text=True).strip()
            assert expected == actual, 'submodule pin mismatch: ' + path
            dirty = subprocess.check_output(['git', '-C', str(target / path), 'status', '--porcelain', '--untracked-files=no'], text=True)
            assert not dirty, 'modified dependency: ' + path
    print(json.dumps({'repository': SPEC['source']['repository'], 'commit': SPEC['source']['commit'],
                      'dependencies': dependencies, 'sourceModified': False}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('target', type=Path)
    parser.add_argument('--dependencies', action='store_true')
    args = parser.parse_args()
    fetch(args.target, args.dependencies)
