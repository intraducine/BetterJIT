#!/usr/bin/env python3
"""Add a separate, source-built Win64 Wine candidate to a signed stock root.

The guest still executes Wine and Windows code. This candidate limits Wine's
virtual allocations to the existing flat guest window; it is not 64-bit guest
address-space support. Stock Wine files are retained unchanged.
"""
import argparse, hashlib, json, pathlib, shutil, subprocess, tempfile

REPO = pathlib.Path(__file__).resolve().parents[1]
WINE_COMMIT = '71c6c3dd6dcfffc040aa5a10a825eeb8e17f6299'  # Wine 10.7
IMAGE = 'alpine:3.22.2@sha256:4b7ce07002c69e8f3d704a9c5d6fd3053be500b7f1c69fc0d80990c2ad8dd412'
CONTAINER = r'''
set -eu
apk add --no-cache build-base bison flex-dev perl mingw-w64-gcc python3
ulimit -c 0
mkdir /source /build
tar -xf /input/wine-source.tar -C /source
cd /source
patch -p1 < /input/wine-flat-guest.patch
python3 /input/wine-flat-native.py --source /source --output /output/fs-reset.elf
cd /build
CFLAGS='-O2 -fno-omit-frame-pointer' /source/configure --enable-win64 --enable-archs=x86_64 \
  --prefix=/opt/wine-flat --libdir=/opt/wine-flat/lib --disable-tests --without-x --without-wayland
make -j4 dlls/ntdll/ntdll.so loader/wine
cp dlls/ntdll/ntdll.so /output/ntdll.so
cp loader/wine /output/wine
cp config.log /output/config.log
'''

def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def install(root, output, source_archive, patch):
    target = root / 'opt/wine-flat'
    if target.exists():
        raise ValueError('Flat Wine candidate already exists; retained unchanged')
    links = json.loads((root / '.symlinks.json').read_text())
    modes = json.loads((root / '.modes.json').read_text())
    unix = target / 'lib/wine/x86_64-unix'
    unix.mkdir(parents=True)
    (target / 'bin').mkdir()
    try:
        for name in ('ntdll.so', 'wine'):
            shutil.copyfile(output / name, unix / name)
            modes['/opt/wine-flat/lib/wine/x86_64-unix/' + name] = 0o755
        def link(relative, original):
            links['/opt/wine-flat/' + relative] = original
            modes['/opt/wine-flat/' + relative] = 0o777
        link('bin/wine', '../lib/wine/x86_64-unix/wine')
        link('bin/wineserver', '/usr/bin/wineserver')
        link('share/wine', '/usr/share/wine')
        link('lib/wine/x86_64-windows', '/usr/lib/wine/x86_64-windows')
        # Other Unix modules remain the signed distribution's exact inputs.
        originals = root / 'usr/lib/wine/x86_64-unix'
        names = {p.name for p in originals.iterdir()}
        names.update(pathlib.PurePosixPath(k).name for k in links
                     if pathlib.PurePosixPath(k).parent.as_posix() == '/usr/lib/wine/x86_64-unix')
        for name in sorted(names - {'wine', 'ntdll.so'}):
            link('lib/wine/x86_64-unix/' + name, '/usr/lib/wine/x86_64-unix/' + name)
        notes = target / 'share/betterjit-provenance'
        notes.mkdir(parents=True)
        shutil.copyfile(patch, notes / 'wine-flat-guest.patch')
        shutil.copyfile(output / 'COPYING.LIB', notes / 'COPYING.LIB')
        shutil.copyfile(output / 'fs-reset.elf', notes / 'fs-reset.elf')
        modes['/opt/wine-flat/share/betterjit-provenance/fs-reset.elf'] = 0o755
        source = 'https://github.com/wine-mirror/wine/tree/' + WINE_COMMIT
        provenance = {
            'schema': 1, 'candidate': 'Source-built Wine Win64 for a flat guest window; compatibility unverified',
            'wineSourceCommit': WINE_COMMIT, 'wineSource': source,
            'wineSourceArchiveSHA256': sha(source_archive), 'patchSHA256': sha(patch),
            'guestAddressLimitExclusive': '0xffff0000', 'guestISA': 'x86_64',
            'nonNullFSSelectors': 'unsupported; SIGILL, never a selector NOP',
            'filesSHA256': {name: sha(unix / name) for name in ('ntdll.so', 'wine')},
            'fsResetFixtureSHA256': sha(notes / 'fs-reset.elf'),
            'stockWineFilesChanged': False, 'guestExecutedDuringPreparation': False,
            'buildImage': IMAGE, 'license': 'LGPL-2.1-or-later',
        }
        (target / '.betterjit-wine-flat.json').write_text(json.dumps(provenance, indent=2) + '\n')
        (notes / 'SOURCE.txt').write_text(source + '\nWine 10.7 source plus the included patch.\n'
            'The workflow retains the complete source archive and build configuration separately.\n'
            'Win32, WoW64, large guest address spaces and DXMT are not implemented by this candidate.\n')
        # Commit manifests last; no partially installed candidate is advertised.
        (root / '.symlinks.json').write_text(json.dumps(links, indent=2, sort_keys=True) + '\n')
        (root / '.modes.json').write_text(json.dumps(modes, indent=2, sort_keys=True) + '\n')
    except BaseException:
        shutil.rmtree(target)
        raise

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=pathlib.Path, default=REPO / '.build/device-linuxroot')
    parser.add_argument('--source', type=pathlib.Path, required=True, help='Clean checkout of the pinned Wine commit')
    args = parser.parse_args()
    root, source = args.root.resolve(), args.source.resolve()
    if (root / 'opt/wine-flat').exists():
        raise SystemExit('Flat Wine candidate already exists; retained unchanged')
    stock = json.loads((root / '.betterjit-linux-root.json').read_text())
    if stock['wineVersion'] != '10.7-r0':
        raise SystemExit('Requires the pinned stock Wine 10.7-r0 root')
    revision = subprocess.check_output(['git', '-C', str(source), 'rev-parse', 'HEAD'], text=True).strip()
    dirty = subprocess.check_output(['git', '-C', str(source), 'status', '--porcelain', '--untracked-files=no'], text=True)
    if revision != WINE_COMMIT or dirty:
        raise SystemExit('Requires a clean Wine source checkout at ' + WINE_COMMIT)
    patch = REPO / 'patches/wine-flat-guest.patch'
    with tempfile.TemporaryDirectory(prefix='betterjit-wine-flat-') as temp:
        work = pathlib.Path(temp)
        inputs, output = work / 'input', work / 'output'
        inputs.mkdir(); output.mkdir()
        archive = inputs / 'wine-source.tar'
        subprocess.run(['git', '-C', str(source), 'archive', '--format=tar', '--output=' + str(archive), 'HEAD'], check=True)
        shutil.copyfile(patch, inputs / patch.name)
        shutil.copyfile(REPO / 'tests/fexhost/wine-flat-native.py', inputs / 'wine-flat-native.py')
        shutil.copyfile(source / 'COPYING.LIB', output / 'COPYING.LIB')
        evidence = REPO / '.build/wine-flat-build'
        evidence.mkdir(parents=True, exist_ok=True)
        try:
            with open(output / 'build.log', 'w') as log:
                subprocess.run(['docker', 'run', '--rm', '--platform', 'linux/amd64',
                    '--mount', f'type=bind,src={inputs},dst=/input,readonly',
                    '--mount', f'type=bind,src={output},dst=/output', IMAGE,
                    'sh', '-c', CONTAINER], stdout=log, stderr=subprocess.STDOUT, check=True)
        finally:
            shutil.copyfile(archive, evidence / archive.name)
            shutil.copyfile(patch, evidence / patch.name)
            shutil.copyfile(inputs / 'wine-flat-native.py', evidence / 'wine-flat-native.py')
            shutil.copyfile(output / 'build.log', evidence / 'build.log')
            print((output / 'build.log').read_text()[-12000:])
        install(root, output, archive, patch)
        shutil.copyfile(archive, evidence / archive.name)
        shutil.copyfile(patch, evidence / patch.name)
        for name in ('build.log', 'config.log'):
            shutil.copyfile(output / name, evidence / name)
    print('Prepared separate Wine flat-window input; real cmd /c ver execution is still required.')

if __name__ == '__main__':
    main()
