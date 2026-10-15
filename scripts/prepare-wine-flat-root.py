#!/usr/bin/env python3
"""Add a separate, source-built Win64 Wine candidate to a signed stock root.

The guest still executes Wine and Windows code. This candidate limits Wine's
virtual allocations to the existing flat guest window; it is not 64-bit guest
address-space support. Stock Wine files are retained unchanged.
"""
import argparse, hashlib, json, pathlib, re, shutil, subprocess, tarfile, tempfile

REPO = pathlib.Path(__file__).resolve().parents[1]
WINE_COMMIT = '71c6c3dd6dcfffc040aa5a10a825eeb8e17f6299'  # Wine 10.7
IMAGE = 'alpine:3.22.2@sha256:4b7ce07002c69e8f3d704a9c5d6fd3053be500b7f1c69fc0d80990c2ad8dd412'
CONTAINER = r'''
set -eu
apk add --no-cache build-base bison flex-dev perl mingw-w64-gcc python3 freetype-dev linux-headers
cp /lib/apk/db/installed /output/build-dependencies.txt
{ cc --version; x86_64-w64-mingw32-gcc --version; make --version; } > /output/build-toolchain.txt
ulimit -c 0
mkdir /source /build
trap 'if test -f /build/config.log; then cp /build/config.log /output/config.log; fi' EXIT
tar -xf /input/wine-source.tar -C /source
cd /source
patch -p1 < /input/wine-flat-guest.patch
python3 /input/wine-flat-native.py --source /source --output /output/fs-reset.elf
python3 /input/wine-spawn-native.py --source /source --guest-output /output/spawn-contract.elf
x86_64-w64-mingw32-gcc -O2 -Wall -Wextra -Werror -municode /input/wine-createprocess.c -o /output/createprocess.exe
cd /build
CFLAGS='-O2 -fno-omit-frame-pointer' /source/configure --enable-win64 --enable-archs=x86_64 \
  --prefix=/opt/wine-flat --libdir=/opt/wine-flat/lib --disable-tests --without-x --without-wayland
make -j4 dlls/ntdll/ntdll.so loader/wine
cp dlls/ntdll/ntdll.so /output/ntdll.so
cp loader/wine /output/wine
cp config.log /output/config.log
# Prepare first-run registry/files with the signed stock Wine of the same version, inside this
# disposable Linux container. This is native input preparation, never FEX or
# device success. The original signed stock root remains unchanged.
set +e
(
set -e
apk add --no-cache --no-scripts wine=10.7-r0
adduser -D -u 1000 user
mkdir -p /home/user
chown user:user /home/user
set +e
timeout -k 5 90 su -s /bin/sh user -c '
  export WINEARCH=win64 WINEPREFIX=/home/user/.wine-flat LANG=C
  export WINEDLLPATH=/usr/lib/wine LD_LIBRARY_PATH=/usr/lib/wine/x86_64-unix:/usr/lib
  export WINEDEBUG=-all WINEDLLOVERRIDES="winemenubuilder.exe=d"
  /usr/bin/wine /usr/lib/wine/x86_64-windows/cmd.exe /c ver
' > /output/native-prefix.log 2>&1
status=$?
set -e
printf '%s\n' "$status" > /output/native-prefix-exit.txt
if test "$status" = 0 && grep -Eq '(Microsoft )?Windows.*[0-9]+\.[0-9]+' /output/native-prefix.log; then
  # Flush the registry and terminate only this owned disposable prefix's server.
  timeout -k 2 10 su -s /bin/sh user -c '
    WINEPREFIX=/home/user/.wine-flat /usr/bin/wineserver -k
    WINEPREFIX=/home/user/.wine-flat /usr/bin/wineserver -w
  '
  # Wine supports this marker for immutable, version-matched prefixes. Archive
  # installation changes file times; it must not force the completed setup to
  # run again. The prefix is used only with this pinned input, not other versions.
  printf '%s\n' disable > /home/user/.wine-flat/.update-timestamp
  tar -czf /output/native-prefix.tar.gz -C /home/user/.wine-flat .
else
  printf '%s\n' 'Native prefix preparation did not complete; retain the compiled candidate and honest fresh-prefix guest attempt.'
fi
) > /output/native-prefix-preparation.log 2>&1
prefix_status=$?
set -e
printf '%s\n' "$prefix_status" > /output/native-prefix-preparation-exit.txt
'''

def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def install_prefix(root, archive, links, modes):
    prefix = root / 'home/user/.wine-flat'
    if prefix.exists(): raise ValueError('Existing Wine prefix retained unchanged')
    prefix.mkdir(parents=True)
    try:
        # Use the same strict archive conversion as signed input acquisition.
        spec_path = REPO / 'scripts/prepare-wine-root.py'
        import importlib.util
        spec = importlib.util.spec_from_file_location('stock_wine_root', spec_path)
        module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
        added_links, added_modes, _, _ = module.extract_input_archive(archive, prefix)
        with tarfile.open(archive, 'r:gz') as tar:
            hardlinks = {'/' + pathlib.PurePosixPath(m.name).as_posix() for m in tar if m.islnk()}
        modes['/home/user/.wine-flat'] = 0o700
        for key, value in added_modes.items(): modes['/home/user/.wine-flat' + key] = value
        for key, value in added_links.items():
            links['/home/user/.wine-flat' + key] = '/home/user/.wine-flat' + value if key in hardlinks else value
    except BaseException:
        shutil.rmtree(prefix); raise

def install(root, output, source_archive, patch):
    target = root / 'opt/wine-flat'
    if target.exists():
        raise ValueError('Flat Wine candidate already exists; retained unchanged')
    links = json.loads((root / '.symlinks.json').read_text())
    modes = json.loads((root / '.modes.json').read_text())
    unix = target / 'lib/wine/x86_64-unix'
    unix.mkdir(parents=True)
    (target / 'bin').mkdir()
    prefix_installed = False
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
        shutil.copyfile(output / 'spawn-contract.elf', notes / 'spawn-contract.elf')
        shutil.copyfile(output / 'createprocess.exe', notes / 'createprocess.exe')
        shutil.copyfile(REPO / 'tests/fexhost/wine-createprocess.c', notes / 'wine-createprocess.c')
        modes['/opt/wine-flat/share/betterjit-provenance/fs-reset.elf'] = 0o755
        modes['/opt/wine-flat/share/betterjit-provenance/spawn-contract.elf'] = 0o755
        modes['/opt/wine-flat/share/betterjit-provenance/createprocess.exe'] = 0o755
        source = 'https://github.com/wine-mirror/wine/tree/' + WINE_COMMIT
        prefix = output / 'native-prefix.tar.gz'
        def successful_prefix():
            if not prefix.exists(): return False
            for name in ('native-prefix-exit.txt', 'native-prefix-preparation-exit.txt'):
                if not (output / name).exists() or (output / name).read_text()[:32].strip() != '0': return False
            log = output / 'native-prefix.log'
            if not log.exists(): return False
            with log.open() as handle: text = handle.read(64 * 1024)
            return re.search(r'(?im)^\s*(Microsoft )?Windows[^\n]*\d+\.\d+', text) is not None
        if successful_prefix():
            install_prefix(root, prefix, links, modes)
            prefix_installed = True
        provenance = {
            'schema': 1, 'candidate': 'Source-built Wine Win64 for a flat guest window; compatibility unverified',
            'wineSourceCommit': WINE_COMMIT, 'wineSource': source,
            'wineSourceArchiveSHA256': sha(source_archive), 'patchSHA256': sha(patch),
            'guestAddressLimitExclusive': '0x7fff0000', 'guestISA': 'x86_64',
            'nonNullFSSelectors': 'unsupported; SIGILL, never a selector NOP',
            'filesSHA256': {name: sha(unix / name) for name in ('ntdll.so', 'wine')},
            'fsResetFixtureSHA256': sha(notes / 'fs-reset.elf'),
            'spawnContractFixtureSHA256': sha(notes / 'spawn-contract.elf'),
            'createProcessFixtureSHA256': sha(notes / 'createprocess.exe'),
            'createProcessSourceSHA256': sha(notes / 'wine-createprocess.c'),
            'stockWineFilesChanged': False, 'wineExecutedDuringPreparation': (output / 'native-prefix-exit.txt').exists(),
            'guestExecutedThroughFEXDuringPreparation': False, 'nativeFSContractChecked': True,
            'processSpawnPolicy': 'Opt-in BETTERJIT_WINE_SPAWN=1: parent-prepared POSIX spawn with stdio/cwd/session/socket/signal actions and a signal-blocked exact-PID reaper reserved before launch',
            'nativePrefix': 'Prepared with signed stock Wine 10.7 cmd /c ver; not FEX/adapted-binary/device evidence' if prefix_installed else 'Unavailable; the guest performs fresh first-run setup',
            'nativePrefixArchiveSHA256': sha(prefix) if prefix_installed else None,
            'nativePrefixUpdates': 'Wine-supported disable marker for this immutable pinned prefix' if prefix_installed else 'Fresh prefix setup',
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
        if prefix_installed: shutil.rmtree(root / 'home/user/.wine-flat')
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
        shutil.copyfile(REPO / 'tests/fexhost/wine-spawn-native.py', inputs / 'wine-spawn-native.py')
        shutil.copyfile(REPO / 'tests/fexhost/wine-createprocess.c', inputs / 'wine-createprocess.c')
        shutil.copyfile(source / 'COPYING.LIB', output / 'COPYING.LIB')
        evidence = REPO / '.build/wine-flat-build'
        evidence.mkdir(parents=True, exist_ok=True)
        try:
            with open(output / 'build.log', 'w') as log:
                subprocess.run(['docker', 'run', '--rm', '--platform', 'linux/amd64', '--hostname', 'betterjit',
                    '--mount', f'type=bind,src={inputs},dst=/input,readonly',
                    '--mount', f'type=bind,src={output},dst=/output', IMAGE,
                    'sh', '-c', CONTAINER], stdout=log, stderr=subprocess.STDOUT, check=True)
        finally:
            shutil.copyfile(archive, evidence / archive.name)
            shutil.copyfile(patch, evidence / patch.name)
            shutil.copyfile(inputs / 'wine-flat-native.py', evidence / 'wine-flat-native.py')
            shutil.copyfile(inputs / 'wine-spawn-native.py', evidence / 'wine-spawn-native.py')
            shutil.copyfile(inputs / 'wine-createprocess.c', evidence / 'wine-createprocess.c')
            shutil.copyfile(output / 'build.log', evidence / 'build.log')
            for name in ('config.log', 'build-dependencies.txt', 'build-toolchain.txt', 'fs-reset.elf', 'spawn-contract.elf', 'createprocess.exe', 'native-prefix.log', 'native-prefix-exit.txt',
                         'native-prefix-preparation.log', 'native-prefix-preparation-exit.txt'):
                if (output / name).exists(): shutil.copyfile(output / name, evidence / name)
            print((output / 'build.log').read_text()[-12000:])
        install(root, output, archive, patch)
        for name in ('native-prefix-preparation-exit.txt', 'native-prefix-exit.txt'):
            if (output / name).exists(): print(name + ': ' + (output / name).read_text()[:32].strip())
        if (output / 'native-prefix.log').exists():
            print('Native Wine prefix preparation log (not FEX/device evidence):')
            print((output / 'native-prefix.log').read_text()[-4096:])
        print('Prepared native prefix bundled: ' + str((root / 'home/user/.wine-flat').exists()))
        shutil.copyfile(archive, evidence / archive.name)
        shutil.copyfile(patch, evidence / patch.name)
        for name in ('build.log', 'config.log'):
            shutil.copyfile(output / name, evidence / name)
    print('Prepared separate Wine flat-window input; real cmd /c ver execution is still required.')

if __name__ == '__main__':
    main()
