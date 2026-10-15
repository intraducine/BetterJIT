#!/usr/bin/env python3
"""Validate reusable build inputs; never reuse app builds or test outcomes.

Wine caches are immutable, version-recorded snapshots. Alpine package resolution
can change on a fresh build; a cache hit does not claim reproducible resolution.
"""
import argparse, ast, datetime, hashlib, json, os, pathlib, platform, plistlib, re
import shutil, stat, subprocess, tarfile, tempfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
MANIFEST = 'ASSET-MANIFEST.json'
REPOSITORY = 'intraducine/BetterJIT'
WORKFLOW = 'One iPhone device session'
MAX_AGE = datetime.timedelta(days=14)
COMMON = ['scripts/build-assets.py']
FEX = ['fexwasm/src/**/*', 'fexwasm/build.sh', 'fexwasm/build_ios.sh',
       'fexwasm/build_id.sh', 'scripts/prepare-fex.sh', 'patches/fex-wasm.patch']
COMPONENTS = {
    'fex-ios': {'path': '.build/FEXNativePackage', 'step': 'build-native',
                'inputs': COMMON + FEX + ['Backends/FEX/build-ios.sh', 'COPYING']},
    'fex-host': {'path': '.build/host-fex', 'step': 'build-host',
                 'inputs': COMMON + FEX + ['Backends/FEX/build-host.sh', 'fexwasm/tools/fexserve.cpp']},
    'wine-inputs': {'path': '.build/wine-input-assets', 'step': 'wine-flat',
                    'inputs': COMMON + ['scripts/prepare-wine-root.py', 'scripts/prepare-wine-flat-root.py',
                        'patches/wine-flat-guest.patch', 'tests/fexhost/wine-flat-native.py',
                        'tests/fexhost/wine-spawn-native.py', 'tests/fexhost/wine-createprocess.c']},
}

def canonical(value): return json.dumps(value, sort_keys=True, separators=(',', ':')).encode()
def digest(value): return hashlib.sha256(canonical(value)).hexdigest()
def stream_sha(handle):
    result = hashlib.sha256()
    for chunk in iter(lambda: handle.read(1024*1024), b''): result.update(chunk)
    return result.hexdigest()
def sha(path):
    with path.open('rb') as handle: return stream_sha(handle)
def command(*args): return subprocess.check_output(args, text=True).strip()
def constant(path, name):
    for node in ast.parse(path.read_text()).body:
        if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == name for t in node.targets):
            return ast.literal_eval(node.value)
    raise ValueError('Missing pinned dependency: ' + name)

def environment(component):
    if component == 'wine-inputs':
        return {'target': 'linux/amd64', 'python': platform.python_version(),
                'dockerServer': command('docker', 'version', '--format', '{{.Server.Version}}')}
    return {'os': platform.system(), 'architecture': platform.machine(), 'python': platform.python_version(),
            'xcode': command('xcodebuild', '-version'), 'clang': command('clang++', '--version'),
            'clangPath': shutil.which('clang++'), 'cc': command('cc', '--version'), 'ccPath': shutil.which('cc'),
            'iphoneSDK': command('xcrun', '--sdk', 'iphoneos', '--show-sdk-build-version'),
            'hostSDK': command('xcrun', '--sdk', 'macosx', '--show-sdk-build-version'),
            'cmake': command('cmake', '--version'), 'ninja': command('ninja', '--version')}

def identity(root, component, tools):
    files = {}
    for pattern in COMPONENTS[component]['inputs']:
        matches = sorted(p for p in root.glob(pattern) if p.is_file())
        if not matches: raise ValueError('Missing recipe input: ' + pattern)
        for path in matches:
            if path.is_symlink(): raise ValueError('Symlink recipe input')
            files[path.relative_to(root).as_posix()] = sha(path)
    if component == 'wine-inputs':
        stock, flat = root/'scripts/prepare-wine-root.py', root/'scripts/prepare-wine-flat-root.py'
        dependencies = {'image': constant(stock, 'DEFAULT_IMAGE'), 'wine': constant(stock, 'WINE'),
                        'wineCommit': constant(flat, 'WINE_COMMIT')}
        if dependencies['image'] != constant(flat, 'IMAGE'): raise ValueError('Wine image mismatch')
    else:
        pin = re.search(r'^PIN=([a-f0-9]{40})$', (root/'scripts/prepare-fex.sh').read_text(), re.M)
        if not pin: raise ValueError('Missing immutable FEX pin')
        dependencies = {'fexCommit': pin[1], 'submodules': 'gitlinks in the immutable recursive upstream tree'}
    result = {'schema': 1, 'component': component, 'sourcesAndRecipes': files,
              'pinnedDependencies': dependencies, 'toolchainAndSDK': tools}
    return {'key': digest(result), 'inputs': result}

def inventory(root):
    if root.is_symlink() or not root.is_dir(): raise ValueError('Missing regular asset directory')
    result = {}
    for path in sorted(root.rglob('*')):
        name = path.relative_to(root).as_posix()
        if name == MANIFEST: continue
        if path.is_symlink(): raise ValueError('Asset symlink rejected: ' + name)
        if path.is_dir(): continue
        if not path.is_file(): raise ValueError('Special asset file rejected: ' + name)
        result[name] = {'sha256': sha(path), 'bytes': path.stat().st_size,
                        'mode': stat.S_IMODE(path.stat().st_mode)}
    if not result: raise ValueError('Empty asset')
    return result

def wine_members(archive):
    seen, total = set(), 0
    for member in archive:
        p = pathlib.PurePosixPath(member.name)
        if (p.is_absolute() or '..' in p.parts or not p.parts or
            p.parts[0] not in ('device-linuxroot', 'wine-flat-build') or
            member.name != p.as_posix() or member.name in seen or
            not (member.isdir() or member.isfile())):
            raise ValueError('Unsafe or duplicate Wine archive member')
        seen.add(member.name); total += member.size
        if total > 8*1024**3: raise ValueError('Wine archive exceeds limit')
        yield member

def required_outputs(root, component, expected):
    if component == 'fex-ios':
        for name in ('Package.swift', 'COPYING', 'Headers/translator.h', 'Headers/module.modulemap', 'libCFEXWasm.a'):
            if not (root/name).is_file() or not (root/name).stat().st_size: raise ValueError('Incomplete native package')
        info = plistlib.loads((root/'CFEXWasm.xcframework/Info.plist').read_bytes())
        if not isinstance(info, dict): raise ValueError('Invalid native package metadata')
        libraries = info.get('AvailableLibraries', [])
        if not isinstance(libraries, list) or len(libraries) != 1: raise ValueError('Unexpected native slices')
        lib = libraries[0]
        if not isinstance(lib, dict): raise ValueError('Invalid native slice metadata')
        if lib.get('SupportedPlatform') != 'ios' or lib.get('SupportedArchitectures') != ['arm64'] or lib.get('SupportedPlatformVariant'):
            raise ValueError('Wrong native platform')
        identifier, library = lib['LibraryIdentifier'], lib['LibraryPath']
        if any('/' in p or p in ('.', '..') for p in (identifier, library)): raise ValueError('Unsafe native path')
        with (root/'CFEXWasm.xcframework'/identifier/library).open('rb') as handle: header = handle.read(8)
        if header != b'!<arch>\n':
            raise ValueError('Missing native archive')
        return expected['inputs']['pinnedDependencies']
    if component == 'fex-host':
        path = root/'fexserve'
        with path.open('rb') as handle: header = handle.read(8)
        if header != bytes.fromhex('cffaedfe0c000001') or not path.stat().st_mode & 0o111:
            raise ValueError('Host translator must be executable arm64 Mach-O')
        return expected['inputs']['pinnedDependencies']
    # Scan compressed snapshots once, without repeated multi-gigabyte seeks.
    evidence, hashes = {}, {}
    small = {'device-linuxroot/.betterjit-linux-root.json',
             'device-linuxroot/.symlinks.json', 'device-linuxroot/.modes.json',
             'device-linuxroot/lib/apk/db/installed',
             'device-linuxroot/home/user/.wine-flat/.update-timestamp',
             'device-linuxroot/opt/wine-flat/.betterjit-wine-flat.json',
             'device-linuxroot/opt/wine-flat/share/betterjit-provenance/COPYING.LIB',
             'device-linuxroot/usr/share/betterjit-root-provenance/installed-packages.txt'}
    small.update('wine-flat-build/'+name for name in ('native-prefix-exit.txt',
        'native-prefix-preparation-exit.txt', 'build.log', 'config.log', 'wine-flat-guest.patch',
        'wine-flat-native.py', 'wine-spawn-native.py', 'wine-createprocess.c',
        'build-dependencies.txt', 'build-toolchain.txt'))
    large = {'wine-flat-build/wine-source.tar',
             'device-linuxroot/opt/wine-flat/lib/wine/x86_64-unix/wine',
             'device-linuxroot/opt/wine-flat/lib/wine/x86_64-unix/ntdll.so'}
    required_prefix = {'device-linuxroot/home/user/.wine-flat/'+name for name in ('system.reg', 'user.reg', 'userdef.reg')}
    present_prefix = set()
    with tarfile.open(root/'bundle.tar.gz', 'r|gz') as archive:
        for member in wine_members(archive):
            if member.name in small:
                if not member.isfile() or member.size > 8*1024*1024: raise ValueError('Invalid Wine evidence size/type')
                evidence[member.name] = archive.extractfile(member).read()
            elif member.name in large:
                if not member.isfile() or not member.size: raise ValueError('Missing Wine source/binary')
                with archive.extractfile(member) as handle:
                    hashes[member.name] = stream_sha(handle)
            elif member.name in required_prefix and member.isfile() and member.size:
                present_prefix.add(member.name)
    def read(name):
        if name not in evidence: raise ValueError('Missing Wine evidence: '+name)
        return evidence[name]
    stock = json.loads(read('device-linuxroot/.betterjit-linux-root.json'))
    flat = json.loads(read('device-linuxroot/opt/wine-flat/.betterjit-wine-flat.json'))
    links = json.loads(read('device-linuxroot/.symlinks.json'))
    modes = json.loads(read('device-linuxroot/.modes.json'))
    if not isinstance(modes, dict) or not isinstance(links, dict) or '/opt/wine-flat/bin/wine' not in links:
        raise ValueError('Missing portable Wine manifests')
    if present_prefix != required_prefix or read('device-linuxroot/home/user/.wine-flat/.update-timestamp').strip() != b'disable':
        raise ValueError('Incomplete immutable Wine prefix')
    pinned = expected['inputs']['pinnedDependencies']
    if stock['wineVersion'] != pinned['wine'] or stock['baseImageRequested'] != pinned['image']:
        raise ValueError('Stock dependency mismatch')
    if flat['wineSourceCommit'] != pinned['wineCommit'] or flat['buildImage'] != pinned['image']:
        raise ValueError('Flat Wine dependency mismatch')
    if not flat.get('nativePrefixArchiveSHA256'): raise ValueError('No completed Wine prefix')
    for name in ('native-prefix-exit.txt', 'native-prefix-preparation-exit.txt'):
        if read('wine-flat-build/'+name).strip() != b'0': raise ValueError('Incomplete prefix producer')
    for name in ('build.log', 'config.log', 'wine-flat-guest.patch', 'wine-flat-native.py',
                 'wine-spawn-native.py', 'wine-createprocess.c'):
        read('wine-flat-build/'+name)
    if hashes.get('wine-flat-build/wine-source.tar') != flat['wineSourceArchiveSHA256']:
        raise ValueError('Wine source archive mismatch')
    patch_hash = hashlib.sha256(read('wine-flat-build/wine-flat-guest.patch')).hexdigest()
    if patch_hash != flat['patchSHA256'] or patch_hash != expected['inputs']['sourcesAndRecipes']['patches/wine-flat-guest.patch']:
        raise ValueError('Wine patch mismatch')
    for name in ('wine-flat-native.py', 'wine-spawn-native.py', 'wine-createprocess.c'):
        if hashlib.sha256(read('wine-flat-build/'+name)).hexdigest() != expected['inputs']['sourcesAndRecipes']['tests/fexhost/'+name]:
            raise ValueError('Wine fixture source mismatch')
    if set(flat['filesSHA256']) != {'wine', 'ntdll.so'}: raise ValueError('Incomplete Wine binaries')
    for name, expected_hash in flat['filesSHA256'].items():
        if name not in ('wine', 'ntdll.so'): raise ValueError('Unexpected Wine binary')
        if hashes.get('device-linuxroot/opt/wine-flat/lib/wine/x86_64-unix/'+name) != expected_hash:
            raise ValueError('Wine binary mismatch')
    read('device-linuxroot/opt/wine-flat/share/betterjit-provenance/COPYING.LIB')
    packages = read('device-linuxroot/usr/share/betterjit-root-provenance/installed-packages.txt')
    if packages != read('device-linuxroot/lib/apk/db/installed'): raise ValueError('Stock installed-package inventory mismatch')
    build_packages = read('wine-flat-build/build-dependencies.txt')
    compiler = read('wine-flat-build/build-toolchain.txt').decode()
    if not packages or not build_packages or not compiler: raise ValueError('Missing resolved dependency inventory')
    return {'kind': 'verified immutable Alpine snapshot; fresh resolution can differ',
            'stockPackageVersions': stock['packageVersions'], 'stockInstalledSHA256': hashlib.sha256(packages).hexdigest(),
            'buildInstalledSHA256': hashlib.sha256(build_packages).hexdigest(), 'buildToolchain': compiler,
            'wineSourceArchiveSHA256': flat['wineSourceArchiveSHA256'], 'stockRootArchiveSHA256': stock['rootArchiveSHA256']}

def producer_valid(producer, component):
    return (isinstance(producer, dict) and producer.get('repository') == REPOSITORY and producer.get('workflow') == WORKFLOW and
            producer.get('step') == COMPONENTS[component]['step'] and producer.get('outcome') == 'success' and
            re.fullmatch(r'[a-f0-9]{40}', str(producer.get('commit', ''))) and
            str(producer.get('run', '')).isdigit() and int(producer['run']) > 0 and
            str(producer.get('attempt', '')).isdigit() and int(producer['attempt']) > 0)

def seal(root, component, expected, producer, now):
    if not producer_valid(producer, component): raise ValueError('Unsuccessful or untrusted producer')
    files = inventory(root)
    if (root/MANIFEST).is_symlink(): raise ValueError('Asset manifest symlink rejected')
    dependencies = required_outputs(root, component, expected)
    manifest = {'schema': 1, 'identity': expected, 'producer': producer, 'createdAt': now.isoformat(),
                'dependencySnapshot': dependencies, 'dependencyFingerprint': digest(dependencies), 'files': files}
    (root/MANIFEST).write_bytes(canonical(manifest)+b'\n')
    return manifest

def validate(root, component, expected, now, bypass=False):
    if bypass: raise ValueError('Explicit rebuild requested')
    if root.is_symlink(): raise ValueError('Asset root symlink rejected')
    path = root/MANIFEST
    if path.is_symlink() or path.stat().st_size > 4*1024*1024: raise ValueError('Invalid asset manifest')
    m = json.loads(path.read_text())
    if not isinstance(m, dict) or m.get('schema') != 1 or m.get('identity') != expected or expected['key'] != digest(expected['inputs']):
        raise ValueError('Incompatible source, recipe, dependency, toolchain or SDK identity')
    if not producer_valid(m.get('producer', {}), component): raise ValueError('Unsuccessful or untrusted producer')
    age = now-datetime.datetime.fromisoformat(m['createdAt'])
    if age < -datetime.timedelta(minutes=5) or age > MAX_AGE: raise ValueError('Expired or future asset')
    if inventory(root) != m['files']: raise ValueError('Missing, changed or unexpected asset output')
    dependencies = required_outputs(root, component, expected)
    if dependencies != m['dependencySnapshot'] or digest(dependencies) != m['dependencyFingerprint']:
        raise ValueError('Dependency snapshot mismatch')
    return m

def discard(root, target):
    # Only these dedicated generated roots can be cleared after a rejected restore.
    if target not in [root/c['path'] for c in COMPONENTS.values()] or (root/'.build').is_symlink():
        raise ValueError('Refusing to discard outside a dedicated build-asset path')
    if target.is_symlink() or target.is_file(): target.unlink()
    elif target.exists(): shutil.rmtree(target)

def unpack_wine(root, asset):
    unpack_archive(root, asset/'bundle.tar.gz', ('device-linuxroot', 'wine-flat-build'))

def unpack_archive(root, path, destinations):
    if any((root/'.build'/p).exists() or (root/'.build'/p).is_symlink() for p in destinations):
        raise ValueError('Existing Wine inputs retained')
    with tempfile.TemporaryDirectory(dir=root/'.build', prefix='wine-asset-') as temp:
        stage = pathlib.Path(temp)
        with tarfile.open(path, 'r|gz') as archive:
            for member in wine_members(archive):
                if pathlib.PurePosixPath(member.name).parts[0] not in destinations: raise ValueError('Unexpected Wine archive root')
                path = stage/member.name
                if member.isdir(): path.mkdir(parents=True, exist_ok=True)
                else:
                    path.parent.mkdir(parents=True, exist_ok=True)
                    with archive.extractfile(member) as src, path.open('xb') as dst: shutil.copyfileobj(src, dst)
                    path.chmod(member.mode & 0o777)
        for name in destinations: (stage/name).rename(root/'.build'/name)

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['identity', 'check', 'seal', 'pack-wine', 'unpack-wine', 'unpack-root'])
    parser.add_argument('component', choices=COMPONENTS)
    parser.add_argument('--producer-outcome', default='')
    parser.add_argument('--bypass', action='store_true')
    args = parser.parse_args()
    component, now = args.component, datetime.datetime.now(datetime.timezone.utc)
    target = ROOT/COMPONENTS[component]['path']
    identities = ROOT/'.build/asset-identities'; identities.mkdir(parents=True, exist_ok=True)
    if args.action == 'unpack-root':
        if component != 'wine-inputs': raise ValueError('Wine component required')
        unpack_archive(ROOT, ROOT/'.build/bundled-wine-root.tar.gz', ('device-linuxroot',)); return
    def output(key, value):
        print(f'{key}={value}')
        if os.environ.get('GITHUB_OUTPUT'):
            with open(os.environ['GITHUB_OUTPUT'], 'a') as handle: handle.write(f'{key}={value}\n')
    if args.action == 'identity':
        expected = identity(ROOT, component, environment(component))
        (identities/(component+'.json')).write_bytes(canonical(expected)+b'\n')
        output('key', 'betterjit-assets-v1-'+component+'-'+expected['key']); return
    expected = json.loads((identities/(component+'.json')).read_text())
    usage = ROOT/'.build/asset-usage'; usage.mkdir(parents=True, exist_ok=True)
    if args.action == 'check':
        try:
            m = validate(target, component, expected, now, args.bypass)
        except (OSError, ValueError, KeyError, TypeError, EOFError, tarfile.TarError) as error:
            print('Rebuild '+component+': '+str(error)); discard(ROOT, target)
            (usage/(component+'.json')).write_bytes(canonical({'action':'rebuild', 'identity':expected, 'reason':str(error)})+b'\n')
            output('hit', 'false'); return
        (usage/(component+'.json')).write_bytes(canonical({'action':'reused', 'manifest':m})+b'\n')
        output('hit', 'true'); return
    if args.action == 'unpack-wine':
        validate(target, component, expected, now); unpack_wine(ROOT, target); return
    if args.action == 'pack-wine':
        if component != 'wine-inputs': raise ValueError('Wine component required')
        target.mkdir(parents=True, exist_ok=False)
        with tarfile.open(target/'bundle.tar.gz', 'w:gz') as archive:
            for name in ('device-linuxroot', 'wine-flat-build'): archive.add(ROOT/'.build'/name, arcname=name)
        return
    producer = {'repository':os.environ.get('GITHUB_REPOSITORY'), 'workflow':os.environ.get('GITHUB_WORKFLOW'),
                'run':os.environ.get('GITHUB_RUN_ID'), 'attempt':os.environ.get('GITHUB_RUN_ATTEMPT'),
                'commit':command('git', '-C', str(ROOT), 'rev-parse', 'HEAD'),
                'step':COMPONENTS[component]['step'], 'outcome':args.producer_outcome}
    m = seal(target, component, expected, producer, now)
    (usage/(component+'.json')).write_bytes(canonical({'action':'built', 'manifest':m})+b'\n')
    output('sealed', 'true')

if __name__ == '__main__':
    try: main()
    except (OSError, ValueError, KeyError, TypeError, EOFError, tarfile.TarError, subprocess.CalledProcessError) as error:
        raise SystemExit('Build asset rejected: '+str(error))
