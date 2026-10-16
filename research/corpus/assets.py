#!/usr/bin/env python3
"""Strict native pilot cache; producer, tools, recipe and output hashes must match."""
import argparse
import hashlib
import json
import os
import platform
import subprocess
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
ASSET = ROOT / '.build/corpus-native-asset'
WORKFLOW = 'Pinned FEX corpus measurement'


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def environment():
    tools = {}
    for name, command in [('clang', ['clang++', '--version']), ('cmake', ['cmake', '--version']),
                          ('ninja', ['ninja', '--version']), ('sdk', ['xcrun', '--sdk', 'macosx', '--show-sdk-version']),
                          ('xcode', ['xcodebuild', '-version'])]:
        tools[name] = subprocess.check_output(command, text=True).strip()
    return {'system': platform.system(), 'machine': platform.machine(), 'release': platform.release(), 'tools': tools}


def identity():
    assert (platform.system(), platform.machine()) == ('Darwin', 'arm64')
    recipe = {p.name: sha(p) for p in [HERE / name for name in
              ['assets.py', 'build-native.sh', 'native-arm64.cpp', 'state.h', 'pilot.json', 'source.py']]}
    value = {'schema': 1, 'recipe': recipe, 'environment': environment(),
             'sourcePin': json.loads((HERE / 'pilot.json').read_text())['source']['commit']}
    value['key'] = 'fex-corpus-native-v1-' + hashlib.sha256(json.dumps(value, sort_keys=True).encode()).hexdigest()
    return value


def output(key, value):
    print(f'{key}={value}')
    if os.environ.get('GITHUB_OUTPUT'):
        with open(os.environ['GITHUB_OUTPUT'], 'a') as stream:
            stream.write(f'{key}={value}\n')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['identity', 'check', 'seal'])
    args = parser.parse_args()
    expected = identity()
    if args.action == 'identity':
        output('key', expected['key'])
        return
    if args.action == 'seal':
        assert os.environ.get('GITHUB_WORKFLOW') == WORKFLOW
        assert os.environ.get('GITHUB_REPOSITORY') == 'intraducine/BetterJIT'
        manifest = {'identity': expected, 'producer': {'repository': os.environ['GITHUB_REPOSITORY'],
                    'workflow': WORKFLOW, 'run': os.environ['GITHUB_RUN_ID'], 'attempt': os.environ['GITHUB_RUN_ATTEMPT'],
                    'commit': os.environ['GITHUB_SHA']},
                    'outputs': {name: sha(ASSET / name) for name in ['corpus-native-arm64', 'options.json']}}
        (ASSET / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
        output('sealed', 'true')
        return
    valid, reason = False, 'cache absent'
    try:
        manifest = json.loads((ASSET / 'manifest.json').read_text())
        assert manifest['identity'] == expected, 'tools/recipe/source mismatch'
        assert manifest['producer']['repository'] == 'intraducine/BetterJIT'
        assert manifest['producer']['workflow'] == WORKFLOW
        assert set(manifest['outputs']) == {'corpus-native-arm64', 'options.json'}
        assert all(sha(ASSET / name) == value for name, value in manifest['outputs'].items()), 'output hash mismatch'
        kind = subprocess.check_output(['file', str(ASSET / 'corpus-native-arm64')], text=True)
        assert 'Mach-O 64-bit executable arm64' in kind, 'wrong binary architecture'
        valid, reason = True, 'verified producer, tools, recipe, pin and outputs'
    except (OSError, ValueError, KeyError, AssertionError) as error:
        reason = str(error)
    usage = {'hit': valid, 'reason': reason, 'requestedIdentity': expected,
             'manifest': manifest if valid else None}
    usage_path = ROOT / '.build/corpus-pilot/results/native-asset-usage.json'
    usage_path.parent.mkdir(parents=True, exist_ok=True)
    usage_path.write_text(json.dumps(usage, indent=2) + '\n')
    output('hit', str(valid).lower())


if __name__ == '__main__':
    main()
