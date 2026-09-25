#!/usr/bin/env python3
"""Create a private local Iridium checkout; never edit or push the source repo.

Only committed host files are copied. No signing material, untracked files,
submodule working trees, build caches or Git remotes are copied into the lab.
"""
from __future__ import annotations
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]
IOS = Path('iridium/apps/ios')
VIEW = IOS / 'Iridium/Views/RootTabView.swift'
BUILD = Path('ci/build-local-ipa.sh')
SUPPORTED = {
    str(VIEW): '1a5941432633d6886f19da895b0432722d83494f',
    str(BUILD): 'dea459e61e1ee3c3256ca6bbb4a3766cb5d1e6e2',
    str(IOS / 'stikjit.yml'): 'eb83eb4c45e3088a6fe54db1d003af0770700229',
}
HOST_REFERENCE = '31ca8f113b842d4c995474438f14c04ef50b7110'
ANCHOR = '            LibraryView(viewModel: viewModel)\n'
INSERT = ANCHOR + '''                #if BETTERJIT_PRIVATE_ADDON
                .toolbar {
                    ToolbarItem(placement: .topBarTrailing) {
                        BetterJITPrivateLabButton()
                            .disabled(viewModel.activeRuntimePlayerSession != nil)
                    }
                }
                #endif
'''
LIBRARIES = ['libfexwasm.a', 'libFEXCore.a', 'libFEXCore_Base.a', 'libJemallocLibs.a',
             'libfmt.a', 'libxxhash.a', 'libcephes_128bit.a', 'libsoftfloat_3e.a']


def git(repo: Path, *args: str) -> str:
    return subprocess.check_output(['git', '-C', str(repo), *args], text=True).strip()


def commit_file(repo: Path, revision: str, path: str) -> bytes:
    return subprocess.check_output(['git', '-C', str(repo), 'show', f'{revision}:{path}'])


def blob_hash(data: bytes) -> str:
    return hashlib.sha1(b'blob ' + str(len(data)).encode() + b'\0' + data).hexdigest()


def patch_view(data: str) -> str:
    if data.count(ANCHOR) != 1 or 'BETTERJIT_PRIVATE_ADDON' in data:
        raise ValueError('Unsupported/already modified RootTabView; no files were patched.')
    return data.replace(ANCHOR, INSERT, 1)


def build_script(data: str) -> str:
    if data.count('--spec iridium/apps/ios/stikjit.yml') != 1 or data.count('IridiumStikJIT.xcodeproj') != 1:
        raise ValueError('Unsupported host build script.')
    return (data.replace('ci/build-local-ipa.sh', 'ci/build-betterjit-private.sh')
            .replace('--spec iridium/apps/ios/stikjit.yml', '--spec iridium/apps/ios/betterjit-private.json')
            .replace('IridiumStikJIT.xcodeproj', 'IridiumBetterJITPrivate.xcodeproj'))


def project_spec(host_commit: str, addon_commit: str) -> dict:
    prefix = '$(SRCROOT)/../../../.betterjit-addon'
    return {
        'include': ['stikjit.yml'], 'name': 'IridiumBetterJITPrivate',
        'targets': {'Iridium': {
            'sources': [{'path': '../../../.betterjit-addon/Sources', 'excludes': ['*.h']},
                        {'path': '../../../.betterjit-addon/BetterJITWeb', 'type': 'folder', 'buildPhase': 'resources'},
                        {'path': '../../../.betterjit-addon/Notices', 'type': 'folder', 'buildPhase': 'resources'}],
            'settings': {'base': {
                'PRODUCT_BUNDLE_IDENTIFIER': 'software.iridium.betterjit-local',
                'SWIFT_OBJC_BRIDGING_HEADER': prefix + '/Bridging.h',
                'SWIFT_ACTIVE_COMPILATION_CONDITIONS': ['$(inherited)', 'BETTERJIT_PRIVATE_ADDON'],
                'OTHER_LDFLAGS': ['$(inherited)', '-lc++'] + [prefix + '/lib/' + n for n in LIBRARIES],
            }},
            'info': {'properties': {'CFBundleDisplayName': 'Iridium Lab',
                'BetterJITSourceCommit': addon_commit, 'BetterJITHostCommit': host_commit,
                'BetterJITPrivateAddon': True}},
            'dependencies': [{'sdk': 'WebKit.framework'}, {'sdk': 'Network.framework'}],
        }, 'IridiumJITHelper': {'settings': {'base': {
            'PRODUCT_BUNDLE_IDENTIFIER': 'software.iridium.betterjit-local.jit-helper'
        }}}},
    }


def prepare(source: Path, output: Path, ref: str = 'HEAD') -> dict:
    source, output = source.resolve(), output.resolve()
    if output.exists():
        raise ValueError('Output already exists; choose a new directory. Existing work will not be overwritten.')
    if output == source or source in output.parents or output in source.parents:
        raise ValueError('Private output must be outside the public Iridium checkout.')
    if any(c in str(output) for c in '\n\r"'):
        raise ValueError('Unsupported output path characters.')
    revision = git(source, 'rev-parse', '--verify', ref + '^{commit}')
    files = {name: commit_file(source, revision, name) for name in SUPPORTED}
    for name, expected in SUPPORTED.items():
        if blob_hash(files[name]) != expected:
            raise ValueError(f'Host integration point changed: {name}. Reviewed host: {HOST_REFERENCE}. No changes made.')
    # Validate all substitutions before creating the private destination.
    view = patch_view(files[str(VIEW)].decode())
    wrapper = build_script(files[str(BUILD)].decode())
    output.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(['git', 'clone', '--no-hardlinks', '--no-checkout', '--', str(source), str(output)], check=True)
    for remote in git(output, 'remote').splitlines():
        subprocess.run(['git', '-C', str(output), 'remote', 'remove', remote], check=True)
    subprocess.run(['git', '-C', str(output), 'checkout', '--detach', revision], check=True)
    subprocess.run(['git', '-C', str(output), 'config', 'push.default', 'nothing'], check=True)
    # A guardrail against accidental explicit pushes. This is not DRM: the
    # repository owner can deliberately remove Git's hook or use --no-verify.
    hooks = output / '.git/betterjit-hooks'
    hooks.mkdir()
    hook = hooks / 'pre-push'
    hook.write_text('#!/bin/sh\necho "Private BetterJIT checkout: pushes are disabled." >&2\nexit 1\n')
    hook.chmod(0o700)
    subprocess.run(['git', '-C', str(output), 'config', 'core.hooksPath', str(hooks)], check=True)
    # Prevent a manually added remote from silently enabling this clone's CI.
    workflows = output / '.github/workflows'
    if workflows.exists():
        workflows.rename(output / '.github/workflows.disabled-for-private-lab')
    vendor = output / '.betterjit-addon'
    (vendor / 'Sources').mkdir(parents=True)
    for file in (ROOT / 'addon/iridium/Sources').glob('*.swift'):
        shutil.copy2(file, vendor / 'Sources' / file.name)
    for file in ['WasmProbe/Sources/FexTranslator.swift', 'WasmProbe/Sources/Log.swift',
                 'Sources/BetterJITCore/ProbeHTTP.swift']:
        shutil.copy2(ROOT / file, vendor / 'Sources' / Path(file).name)
    shutil.copy2(ROOT / 'fexwasm/src/translator.h', vendor / 'Sources/translator.h')
    (vendor / 'Bridging.h').write_text('#include "../iridium/apps/ios/BuiltinJIT/Host/Bridging.h"\n#include "Sources/translator.h"\n')
    web = vendor / 'BetterJITWeb'
    shutil.copytree(ROOT / 'addon/iridium/Web', web)
    for name in ['fexruntime.js', 'fexlive.js']:
        shutil.copy2(ROOT / 'WasmProbe/Web' / name, web / name)
    for directory in ['fex', 'fexw64']:
        (web / directory).mkdir()
        for name in ['config.json', 'image.bin']:
            shutil.copy2(ROOT / 'WasmProbe/Web' / directory / name, web / directory / name)
    notices = vendor / 'Notices'
    notices.mkdir()
    for source_file, target in [('COPYING', 'BetterJIT-COPYING'), ('WasmProbe/Kernels/box2d/LICENSE', 'Box2D-LICENSE'),
                                ('WasmProbe/Kernels/coremark/LICENSE.md', 'CoreMark-LICENSE.md')]:
        shutil.copy2(ROOT / source_file, notices / target)
    addon_commit = git(ROOT, 'rev-parse', 'HEAD')
    manifest = {'schema': 1, 'hostCommit': revision, 'addonCommit': addon_commit,
                'addonWorkingTreeDirty': bool(git(ROOT, 'status', '--porcelain', '--untracked-files=normal')),
                'normalGameBackendChanged': False, 'files': {}}
    (output / VIEW).write_text(view)
    (output / 'ci/build-betterjit-private.sh').write_text(wrapper)
    (output / IOS / 'betterjit-private.json').write_text(json.dumps(project_spec(revision, addon_commit), indent=2) + '\n')
    with (output / '.git/info/exclude').open('a') as f:
        f.write('\n# Private BetterJIT overlay; never stage for the public repository.\n/.betterjit-addon/\n')
    for file in sorted(vendor.rglob('*')):
        if file.is_file():
            manifest['files'][str(file.relative_to(vendor))] = hashlib.sha256(file.read_bytes()).hexdigest()
    manifest['integrationFiles'] = {str(p): hashlib.sha256((output / p).read_bytes()).hexdigest()
                                    for p in [VIEW, Path('ci/build-betterjit-private.sh'), IOS / 'betterjit-private.json']}
    (vendor / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    print(f'Private checkout: {output}\nHost commit: {revision}\nNo remotes. Original checkout unchanged.')
    return manifest


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--iridium', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--ref', default='HEAD', help='Committed Iridium revision to copy; uncommitted work is not included')
    args = parser.parse_args()
    try:
        prepare(args.iridium, args.output, args.ref)
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        print(f'Preparation stopped: {error}', file=sys.stderr)
        return 1
    return 0

if __name__ == '__main__':
    raise SystemExit(main())
