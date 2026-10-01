"""Portable configuration and source identity; no accounts, signing or network I/O."""
from __future__ import annotations
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import subprocess

DEFAULTS = {'schema': 1, 'appBundleIdentifier': 'software.iridium.betterjit-local',
            'appDisplayName': 'Iridium Lab'}


def app_config(value: dict | None = None) -> dict:
    if value is not None and not isinstance(value, dict):
        raise ValueError('Add-on configuration must be an object.')
    config = {**DEFAULTS, **(value or {})}
    if set(config) != set(DEFAULTS) or type(config['schema']) is not int or config['schema'] != 1:
        raise ValueError('Unknown configuration fields or schema. Signing settings are not supported.')
    bundle = config['appBundleIdentifier']
    if (not isinstance(bundle, str) or len(bundle) > 200
            or not re.fullmatch(r'[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+){2,}', bundle)
            or bundle.lower() in {'software.iridium', 'software.iridium.jit-helper'}
            or bundle.lower().endswith('.jit-helper')):
        raise ValueError('Use a distinct reverse-DNS appBundleIdentifier (up to 200 characters).')
    name = config['appDisplayName']
    if (not isinstance(name, str) or not name.strip() or name != name.strip() or len(name) > 40
            or any(ord(c) < 32 or ord(c) == 127 or c in '$"\\' for c in name)):
        raise ValueError('appDisplayName must be 1-40 printable characters without build substitutions.')
    return config


def load_config(path: Path | None = None, *, bundle_id: str | None = None,
                display_name: str | None = None) -> dict:
    data = {} if path is None else json.loads(path.read_text())
    # Validate the file before applying CLI overrides; typos never silently disappear.
    config = app_config(data)
    if bundle_id is not None: config['appBundleIdentifier'] = bundle_id
    if display_name is not None: config['appDisplayName'] = display_name
    return app_config(config)


def load_profiles(path: Path, integration_paths: tuple[str, ...]) -> tuple[str, tuple[dict, ...]]:
    data = json.loads(path.read_text())
    if not isinstance(data, dict) or set(data) != {'schema', 'default', 'profiles'} or type(data['schema']) is not int or data['schema'] != 1:
        raise ValueError('Invalid host profile registry.')
    profiles = data['profiles']
    if not isinstance(profiles, list) or not profiles: raise ValueError('No reviewed host profiles.')
    ids = set()
    for p in profiles:
        if not isinstance(p, dict) or set(p) != {'id', 'branch', 'reference', 'blobs'}:
            raise ValueError('Invalid host profile fields.')
        if not isinstance(p['id'], str) or not re.fullmatch(r'[a-z0-9-]+', p['id']) or p['id'] in ids:
            raise ValueError('Invalid or duplicate host profile ID.')
        ids.add(p['id'])
        if not isinstance(p['branch'], str) or not p['branch'] or any(ord(c) < 32 for c in p['branch']):
            raise ValueError('Invalid host branch label.')
        if not isinstance(p['reference'], str) or not re.fullmatch(r'[0-9a-f]{40}', p['reference']):
            raise ValueError('A reviewed host reference must be a full commit SHA.')
        if not isinstance(p['blobs'], dict) or set(p['blobs']) != set(integration_paths):
            raise ValueError('A host profile must cover every integration path as one set.')
        if any(not isinstance(v, str) or not re.fullmatch(r'[0-9a-f]{40}', v) for v in p['blobs'].values()):
            raise ValueError('Invalid reviewed blob hash.')
    if not isinstance(data['default'], str) or data['default'] not in ids:
        raise ValueError('Unknown default host profile.')
    return data['default'], tuple(profiles)


def safe_relative(name: str) -> str:
    if (not isinstance(name, str) or not name or '\\' in name or ':' in name
            or any(ord(c) < 32 or ord(c) == 127 for c in name)
            or name.startswith('/') or any(p in {'', '.', '..'} for p in name.split('/'))):
        raise ValueError(f'Unsafe relative source path: {name!r}')
    return str(PurePosixPath(name))


def source_identity(root: Path) -> dict:
    """Support Git checkouts and clean exports without borrowing a parent repo's HEAD.

    Hashes are provenance diagnostics, not signatures or an authenticity guarantee.
    """
    root = root.resolve()
    if (root / '.git').exists():
        def git(*args):
            return subprocess.check_output(['git', '-C', str(root), *args], text=True).strip()
        if Path(git('rev-parse', '--show-toplevel')).resolve() != root:
            raise ValueError('Add-on root is not the Git repository root.')
        return {'commit': git('rev-parse', 'HEAD'), 'kind': 'git',
                'dirty': bool(git('status', '--porcelain', '--untracked-files=normal'))}
    manifest = json.loads((root / 'SOURCE-MANIFEST.json').read_text())
    if (not isinstance(manifest, dict) or type(manifest.get('schema')) is not int or manifest.get('schema') != 1
            or not isinstance(manifest.get('sourceRevision'), str)
            or not re.fullmatch(r'[0-9a-f]{40}', manifest['sourceRevision'])
            or not isinstance(manifest.get('files'), dict) or not manifest['files']):
        raise ValueError('Missing or invalid source-export identity; use a Git checkout or a verified export.')
    dirty = False
    expected = set()
    for name, digest in manifest['files'].items():
        safe_relative(name)
        if not isinstance(digest, str) or not re.fullmatch(r'[0-9a-f]{64}', digest):
            raise ValueError('Invalid source-export checksum.')
        expected.add(name)
        path = root / name
        if any(p.is_symlink() for p in [path, *path.parents] if p != root and root in p.parents):
            raise ValueError('Source-export paths must not use symlinks.')
        dirty |= not path.is_file() or hashlib.sha256(path.read_bytes()).hexdigest() != digest
    ignored = {'.git', '.build', '.swiftpm', '__pycache__', 'FEX', 'out', 'build'}
    for base, dirs, files in os.walk(root, followlinks=False):
        for d in dirs:
            if (Path(base) / d).is_symlink(): dirty = True
        dirs[:] = [d for d in dirs if d not in ignored and not (Path(base) / d).is_symlink()]
        for name in files:
            rel = (Path(base) / name).relative_to(root).as_posix()
            if rel != 'SOURCE-MANIFEST.json' and rel not in expected: dirty = True
    return {'commit': manifest['sourceRevision'], 'kind': 'source-export', 'dirty': dirty}
