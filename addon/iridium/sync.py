#!/usr/bin/env python3
"""Refresh only the add-on-owned files in an existing private checkout."""
import hashlib
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('prepare', ROOT / 'addon/iridium/prepare.py')
prepare = importlib.util.module_from_spec(spec)
spec.loader.exec_module(prepare)


def sync(destination):
    destination = Path(destination).resolve()
    vendor = destination / '.betterjit-addon'
    if vendor.is_symlink() or any(p.is_symlink() for p in vendor.rglob('*')):
        raise ValueError('Private snapshot contains symlinks; refusing writes through them.')
    manifest = json.loads((vendor / 'manifest.json').read_text())
    if prepare.git(destination, 'remote'):
        raise ValueError('Private checkout has a Git remote; refusing to modify it.')
    if manifest.get('schema') != 1:
        raise ValueError('Unsupported private checkout manifest.')
    libraries = [Path(p) for p in (ROOT / 'fexwasm/out/ios/libs.txt').read_text().splitlines()]
    if [p.name for p in libraries] != prepare.LIBRARIES or not all(p.is_file() for p in libraries):
        raise ValueError('Incomplete or unexpected FEX library set; rebuild first.')
    # Do not overwrite edits made inside the private checkout behind the user's back.
    for name, checksum in manifest.get('integrationFiles', {}).items():
        p = destination / name
        if p.is_symlink() or not p.is_file() or hashlib.sha256(p.read_bytes()).hexdigest() != checksum:
            raise ValueError(f'Private integration changed locally: {name}. Create a fresh checkout rather than overwriting it.')
    for name, checksum in manifest['files'].items():
        path = vendor / name
        if not path.is_file() or hashlib.sha256(path.read_bytes()).hexdigest() != checksum:
            raise ValueError(f'Private snapshot changed locally: {name}. Keep that edit or create a fresh checkout.')
    identity = prepare.configuration.source_identity(ROOT)
    for p in (ROOT / 'addon/iridium/Sources').glob('*.swift'):
        shutil.copy2(p, vendor / 'Sources' / p.name)
    for p in ['WasmProbe/Sources/FexTranslator.swift', 'WasmProbe/Sources/Log.swift', 'Sources/BetterJITCore/ProbeHTTP.swift']:
        shutil.copy2(ROOT / p, vendor / 'Sources' / Path(p).name)
    shutil.copy2(ROOT / 'fexwasm/src/translator.h', vendor / 'Sources/translator.h')
    for p in (ROOT / 'addon/iridium/Web').iterdir():
        if p.is_file(): shutil.copy2(p, vendor / 'BetterJITWeb' / p.name)
    for name in ['fexruntime.js', 'fexlive.js']:
        shutil.copy2(ROOT / 'WasmProbe/Web' / name, vendor / 'BetterJITWeb' / name)
    for directory in ['fex', 'fexw64']:
        for name in ['config.json', 'image.bin']:
            shutil.copy2(ROOT / 'WasmProbe/Web' / directory / name, vendor / 'BetterJITWeb' / directory / name)
    (vendor / 'lib').mkdir(exist_ok=True)
    for library in libraries: shutil.copy2(library, vendor / 'lib' / library.name)
    manifest['addonCommit'] = identity['commit']
    manifest['addonWorkingTreeDirty'] = identity['dirty']
    manifest['addonSourceKind'] = identity['kind']
    manifest['files'] = {str(p.relative_to(vendor)): hashlib.sha256(p.read_bytes()).hexdigest()
                         for p in sorted(vendor.rglob('*')) if p.is_file() and p.name != 'manifest.json'}
    project = destination / prepare.IOS / 'betterjit-private.json'
    config = json.loads(project.read_text())
    config['targets']['Iridium']['info']['properties']['BetterJITSourceCommit'] = manifest['addonCommit']
    project.write_text(json.dumps(config, indent=2) + '\n')
    manifest['integrationFiles'][str(project.relative_to(destination))] = hashlib.sha256(project.read_bytes()).hexdigest()
    (vendor / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    print('Private add-on snapshot refreshed; no public repository was modified.')

if __name__ == '__main__':
    try:
        if len(sys.argv) != 2: raise ValueError('usage: sync.py PRIVATE_CHECKOUT')
        sync(sys.argv[1])
    except (OSError, ValueError, KeyError, subprocess.CalledProcessError) as error:
        print(f'Sync stopped: {error}', file=sys.stderr)
        raise SystemExit(1)
