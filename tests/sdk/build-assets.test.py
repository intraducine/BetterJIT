#!/usr/bin/env python3
"""Hermetic compatibility, provenance and corruption tests; no cached binary runs."""
import copy, datetime, hashlib, importlib.util, io, json, pathlib, plistlib, shutil, tarfile, tempfile, unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('assets', ROOT/'scripts/build-assets.py')
assets = importlib.util.module_from_spec(spec); spec.loader.exec_module(assets)
NOW = datetime.datetime(2026, 10, 15, tzinfo=datetime.timezone.utc)

class AssetTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = pathlib.Path(self.temp.name)
        for config in assets.COMPONENTS.values():
            for pattern in config['inputs']:
                matches = list(ROOT.glob(pattern))
                for path in matches:
                    if path.is_file():
                        dest = self.root/path.relative_to(ROOT); dest.parent.mkdir(parents=True, exist_ok=True)
                        shutil.copyfile(path, dest)
                if not matches:
                    # SDK exports omit the full C++ producer tree. Use synthetic
                    # recipe files to test identity rules there independently.
                    name = pattern.replace('**/*', 'fixture.cpp').replace('*', 'fixture.cpp')
                    dest = self.root/name; dest.parent.mkdir(parents=True, exist_ok=True)
                    dest.write_text('PIN='+'a'*40+'\n' if name == 'scripts/prepare-fex.sh' else 'fixture recipe\n')
        self.tools = {'clang': 'clang fixture', 'iphoneSDK':'sdk fixture', 'cmake':'cmake fixture', 'ninja':'ninja fixture'}
        self.expected = assets.identity(self.root, 'fex-host', self.tools)
        self.asset = self.root/assets.COMPONENTS['fex-host']['path']; self.asset.mkdir(parents=True)
        self.binary = self.asset/'fexserve'; self.binary.write_bytes(bytes.fromhex('cffaedfe0c000001')+b'fixture')
        self.binary.chmod(0o755)
        self.producer = {'repository':assets.REPOSITORY, 'workflow':assets.WORKFLOW,
                         'run':'123', 'attempt':'1', 'commit':'a'*40, 'step':'build-host', 'outcome':'success'}
    def seal(self): return assets.seal(self.asset, 'fex-host', self.expected, self.producer, NOW)
    def validate(self, **kwargs): return assets.validate(self.asset, 'fex-host', self.expected, NOW, **kwargs)
    def test_compatible_reuse_and_ui_only_stability(self):
        first = self.seal(); self.assertEqual(self.validate(), first)
        path = self.root/'Examples/FEXHost/App.swift'; path.parent.mkdir(parents=True); path.write_text('UI edit')
        (self.root/'README.md').write_text('documentation edit')
        self.assertEqual(assets.identity(self.root, 'fex-host', self.tools), self.expected)
        self.assertEqual(self.validate()['producer']['commit'], 'a'*40)
    def test_every_embedded_build_id_recipe_and_native_notice_invalidates(self):
        for component in ('fex-host', 'fex-ios'):
            for name in ('fexwasm/build.sh', 'fexwasm/build_ios.sh', 'fexwasm/build_id.sh', 'scripts/prepare-fex.sh'):
                before = assets.identity(self.root, component, self.tools)
                path = self.root/name; original = path.read_bytes(); path.write_bytes(original+b'\n# recipe change\n')
                self.assertNotEqual(assets.identity(self.root, component, self.tools), before)
                path.write_bytes(original)
        before = assets.identity(self.root, 'fex-ios', self.tools)
        (self.root/'COPYING').write_text('changed notice')
        self.assertNotEqual(assets.identity(self.root, 'fex-ios', self.tools), before)
    def test_compiler_sdk_and_build_tool_changes_reject(self):
        self.seal()
        for key in self.tools:
            tools = {**self.tools, key:'changed'}
            expected = assets.identity(self.root, 'fex-host', tools)
            with self.subTest(key=key), self.assertRaisesRegex(ValueError, 'Incompatible'):
                assets.validate(self.asset, 'fex-host', expected, NOW)
    def test_native_package_requires_device_arm64_and_matching_required_outputs(self):
        target = self.root/assets.COMPONENTS['fex-ios']['path']; target.mkdir()
        for name in ('Package.swift','COPYING','Headers/translator.h','Headers/module.modulemap','libCFEXWasm.a',
                     'CFEXWasm.xcframework/ios-arm64/libCFEXWasm.a'):
            path = target/name; path.parent.mkdir(parents=True, exist_ok=True); path.write_bytes(b'!<arch>\nfixture')
        info = {'AvailableLibraries':[{'LibraryIdentifier':'ios-arm64','LibraryPath':'libCFEXWasm.a',
                 'SupportedPlatform':'ios','SupportedArchitectures':['arm64']}]}
        path = target/'CFEXWasm.xcframework/Info.plist'; path.write_bytes(plistlib.dumps(info))
        expected = assets.identity(self.root, 'fex-ios', self.tools)
        producer = {**self.producer, 'step':'build-native'}
        assets.seal(target, 'fex-ios', expected, producer, NOW)
        assets.validate(target, 'fex-ios', expected, NOW)
        info['AvailableLibraries'][0]['SupportedPlatformVariant'] = 'simulator'; path.write_bytes(plistlib.dumps(info))
        with self.assertRaisesRegex(ValueError, 'platform'): assets.seal(target, 'fex-ios', expected, producer, NOW)
    def test_tampered_missing_extra_and_mode_changed_outputs_reject(self):
        self.seal(); original = self.binary.read_bytes()
        self.binary.write_bytes(original+b'tampered')
        with self.assertRaisesRegex(ValueError, 'changed'): self.validate()
        self.binary.write_bytes(original); self.binary.chmod(0o644)
        with self.assertRaisesRegex(ValueError, 'changed'): self.validate()
        self.binary.chmod(0o755); (self.asset/'extra').write_text('unrecorded')
        with self.assertRaisesRegex(ValueError, 'unexpected'): self.validate()
        (self.asset/'extra').unlink(); self.binary.unlink()
        with self.assertRaises(ValueError): self.validate()
    def test_partial_failed_or_wrong_producer_never_seals(self):
        for field, value in (('outcome','failure'), ('repository','other/repo'), ('workflow','Other workflow'), ('step','other'), ('run','0')):
            producer = {**self.producer, field:value}
            with self.subTest(field=field), self.assertRaisesRegex(ValueError, 'producer'):
                assets.seal(self.asset, 'fex-host', self.expected, producer, NOW)
            self.assertFalse((self.asset/assets.MANIFEST).exists())
        self.binary.write_bytes(b'incomplete build')
        with self.assertRaisesRegex(ValueError, 'arm64'): self.seal()
    def test_expired_future_bypassed_and_manifest_mismatch_reject(self):
        self.seal()
        for when in (NOW+datetime.timedelta(days=15), NOW-datetime.timedelta(days=1)):
            with self.assertRaisesRegex(ValueError, 'Expired'):
                assets.validate(self.asset, 'fex-host', self.expected, when)
        with self.assertRaisesRegex(ValueError, 'Explicit'): self.validate(bypass=True)
        m = json.loads((self.asset/assets.MANIFEST).read_text()); m['dependencyFingerprint'] = '0'*64
        (self.asset/assets.MANIFEST).write_text(json.dumps(m))
        with self.assertRaisesRegex(ValueError, 'Dependency'): self.validate()
    def test_symlinks_and_discard_outside_owned_output_reject(self):
        self.seal(); (self.asset/'escape').symlink_to(self.root/'COPYING')
        with self.assertRaisesRegex(ValueError, 'symlink'): self.validate()
        with self.assertRaisesRegex(ValueError, 'outside'): assets.discard(self.root, self.root/'scripts')
        assets.discard(self.root, self.asset)
        self.assertFalse(self.asset.exists()); self.assertTrue((self.root/'scripts').is_dir())
    def test_malformed_manifest_and_file_instead_of_directory_reject_cleanly(self):
        self.seal(); (self.asset/assets.MANIFEST).write_text('[]')
        with self.assertRaisesRegex(ValueError, 'Incompatible'): self.validate()
        self.assertFalse(assets.producer_valid([], 'fex-host'))
        assets.discard(self.root, self.asset); self.asset.write_text('incomplete restore')
        assets.discard(self.root, self.asset); self.assertFalse(self.asset.exists())
    def test_archive_traversal_links_duplicates_and_existing_destination_reject(self):
        for name, kind in (('../escape', tarfile.REGTYPE), ('/escape',tarfile.REGTYPE),
                           ('device-linuxroot/link',tarfile.SYMTYPE), ('other/file',tarfile.REGTYPE)):
            buffer = io.BytesIO()
            with tarfile.open(fileobj=buffer, mode='w') as archive:
                member = tarfile.TarInfo(name); member.type = kind; archive.addfile(member)
            buffer.seek(0)
            with tarfile.open(fileobj=buffer) as archive, self.assertRaises(ValueError): list(assets.wine_members(archive))
        buffer = io.BytesIO()
        with tarfile.open(fileobj=buffer, mode='w') as archive:
            for _ in range(2): archive.addfile(tarfile.TarInfo('device-linuxroot/file'))
        buffer.seek(0)
        with tarfile.open(fileobj=buffer) as archive, self.assertRaises(ValueError): list(assets.wine_members(archive))
        (self.root/'.build/device-linuxroot').mkdir()
        with self.assertRaisesRegex(ValueError, 'Existing'): assets.unpack_wine(self.root, self.asset)
    def wine_bundle(self, omit=None):
        expected = assets.identity(self.root, 'wine-inputs', {'target':'linux/amd64'})
        pinned = expected['inputs']['pinnedDependencies']; source = b'fixture source archive'
        entries = {'wine-flat-build/wine-source.tar':source}
        for name in ('wine-flat-native.py','wine-spawn-native.py','wine-createprocess.c'):
            entries['wine-flat-build/'+name] = (self.root/'tests/fexhost'/name).read_bytes()
        patch = (self.root/'patches/wine-flat-guest.patch').read_bytes(); entries['wine-flat-build/wine-flat-guest.patch'] = patch
        for name in ('build.log','config.log','build-dependencies.txt','build-toolchain.txt'): entries['wine-flat-build/'+name] = b'fixture inventory'
        for name in ('native-prefix-exit.txt','native-prefix-preparation-exit.txt'): entries['wine-flat-build/'+name] = b'0\n'
        entries['device-linuxroot/opt/wine-flat/share/betterjit-provenance/COPYING.LIB'] = b'fixture notice'
        entries['device-linuxroot/usr/share/betterjit-root-provenance/installed-packages.txt'] = b'fixture installed packages'
        entries['device-linuxroot/lib/apk/db/installed'] = b'fixture installed packages'
        entries['device-linuxroot/.symlinks.json'] = b'{"/opt/wine-flat/bin/wine":"../lib/wine/x86_64-unix/wine"}'
        entries['device-linuxroot/.modes.json'] = b'{}'
        entries['device-linuxroot/home/user/.wine-flat/.update-timestamp'] = b'disable\n'
        for name in ('system.reg','user.reg','userdef.reg'):
            entries['device-linuxroot/home/user/.wine-flat/'+name] = b'fixture registry'
        stock = {'wineVersion':pinned['wine'], 'baseImageRequested':pinned['image'], 'packageVersions':['fixture-1'], 'rootArchiveSHA256':'1'*64}
        flat = {'wineSourceCommit':pinned['wineCommit'], 'buildImage':pinned['image'], 'nativePrefixArchiveSHA256':'2'*64,
                'wineSourceArchiveSHA256':hashlib.sha256(source).hexdigest(), 'patchSHA256':hashlib.sha256(patch).hexdigest(), 'filesSHA256':{}}
        for name in ('wine','ntdll.so'):
            data = ('fixture '+name).encode(); entries['device-linuxroot/opt/wine-flat/lib/wine/x86_64-unix/'+name] = data
            flat['filesSHA256'][name] = hashlib.sha256(data).hexdigest()
        entries['device-linuxroot/.betterjit-linux-root.json'] = json.dumps(stock).encode()
        entries['device-linuxroot/opt/wine-flat/.betterjit-wine-flat.json'] = json.dumps(flat).encode()
        target = self.root/assets.COMPONENTS['wine-inputs']['path']; target.mkdir()
        with tarfile.open(target/'bundle.tar.gz','w:gz') as archive:
            for name, data in entries.items():
                if name == omit: continue
                member = tarfile.TarInfo(name); member.size = len(data); archive.addfile(member, io.BytesIO(data))
        return target, expected
    def test_wine_snapshot_requires_matching_inputs_and_preserves_dependency_identity(self):
        target, expected = self.wine_bundle(); producer = {**self.producer, 'step':'wine-flat'}
        m = assets.seal(target, 'wine-inputs', expected, producer, NOW)
        self.assertEqual(assets.validate(target, 'wine-inputs', expected, NOW), m)
        self.assertEqual(m['dependencySnapshot']['stockPackageVersions'], ['fixture-1'])
        wrong = copy.deepcopy(expected); wrong['inputs']['pinnedDependencies']['wineCommit'] = 'b'*40; wrong['key'] = assets.digest(wrong['inputs'])
        with self.assertRaisesRegex(ValueError, 'Incompatible'): assets.validate(target, 'wine-inputs', wrong, NOW)
        assets.unpack_wine(self.root, target)
        self.assertEqual((self.root/'.build/wine-flat-build/build-toolchain.txt').read_bytes(), b'fixture inventory')
    def test_missing_wine_build_dependencies_and_changed_recipe_cannot_seal(self):
        target, expected = self.wine_bundle(omit='wine-flat-build/build-dependencies.txt')
        producer = {**self.producer, 'step':'wine-flat'}
        with self.assertRaisesRegex(ValueError, 'Missing Wine evidence'):
            assets.seal(target, 'wine-inputs', expected, producer, NOW)
        self.assertFalse((target/assets.MANIFEST).exists())
        shutil.rmtree(target); target, expected = self.wine_bundle()
        expected['inputs']['sourcesAndRecipes']['patches/wine-flat-guest.patch'] = '0'*64
        expected['key'] = assets.digest(expected['inputs'])
        with self.assertRaisesRegex(ValueError, 'patch mismatch'):
            assets.seal(target, 'wine-inputs', expected, producer, NOW)

if __name__ == '__main__': unittest.main()
