#!/usr/bin/env python3
"""Checkout/overlay tests; asset stubs are not a compiled Iridium runtime."""
import ast
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
FIXTURES = ROOT / 'tests/fixtures/iridium'
spec = importlib.util.spec_from_file_location('addon_prepare', ROOT / 'addon/iridium/prepare.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


def git(path, *args):
    return subprocess.check_output(['git', '-C', str(path), *args], text=True, stderr=subprocess.DEVNULL).strip()


def init_repo(path):
    path.mkdir()
    git(path, 'init', '-q')
    git(path, 'config', 'user.name', 'Fixture')
    git(path, 'config', 'user.email', 'fixture@example.invalid')


def host_files(reference):
    return {
        str(m.VIEW): (FIXTURES / 'common/RootTabView.swift').read_bytes(),
        str(m.BUILD): (FIXTURES / reference[:12] / 'build-local-ipa.sh').read_bytes(),
        str(m.IOS / 'stikjit.yml'): (FIXTURES / 'common/stikjit.yml').read_bytes(),
    }


class PrivateAddonTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.src = self.base / 'public'
        init_repo(self.src)
        self.write_host(m.HOST_REFERENCE)
        self.commit('Reviewed host integration fixture')
        self.latest = git(self.src, 'rev-parse', 'HEAD')
        git(self.src, 'remote', 'add', 'origin', 'https://github.com/example/public.git')
        self.dest = self.base / 'private'
        # Keep filesystem tests hermetic: these files test copying and hashing,
        # not execution. The host integration files above are exact upstream blobs.
        self.addon = self.base / 'addon'
        init_repo(self.addon)
        paths = ['addon/iridium/Sources/Fixture.swift', 'addon/iridium/Web/index.html',
                 'WasmProbe/Sources/FexTranslator.swift', 'WasmProbe/Sources/Log.swift',
                 'Sources/BetterJITCore/ProbeHTTP.swift', 'fexwasm/src/translator.h',
                 'WasmProbe/Web/fexruntime.js', 'WasmProbe/Web/fexlive.js',
                 'WasmProbe/Web/fex/config.json', 'WasmProbe/Web/fex/image.bin',
                 'WasmProbe/Web/fexw64/config.json', 'WasmProbe/Web/fexw64/image.bin',
                 'COPYING', 'WasmProbe/Kernels/box2d/LICENSE', 'WasmProbe/Kernels/coremark/LICENSE.md']
        for name in paths:
            p = self.addon / name
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text('Test fixture: ' + name + '\n')
        git(self.addon, 'add', '.')
        git(self.addon, 'commit', '-qm', 'Add-on asset fixtures')
        root_patch = patch.object(m, 'ROOT', self.addon)
        root_patch.start()
        self.addCleanup(root_patch.stop)

    def write_host(self, reference):
        files = host_files(reference)
        files.update({'.github/workflows/public.yml': b'on: push\n', 'README.md': b'committed version\n'})
        for name, data in files.items():
            p = self.src / name
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_bytes(data)

    def commit(self, message):
        git(self.src, 'add', '.')
        git(self.src, 'commit', '-qm', message)

    def prepare(self, ref='HEAD'):
        return m.prepare(self.src, self.dest, ref)

    def test_source_is_untouched_and_untracked_material_is_not_copied(self):
        (self.src / 'README.md').write_text('uncommitted work\n')
        (self.src / 'private-cert.p12').write_text('fixture, not a real key')
        before = git(self.src, 'status', '--porcelain')
        report = self.prepare()
        self.assertEqual(git(self.src, 'status', '--porcelain'), before)
        self.assertEqual((self.dest / 'README.md').read_text(), 'committed version\n')
        self.assertFalse((self.dest / 'private-cert.p12').exists())
        self.assertEqual(git(self.dest, 'remote'), '')
        self.assertEqual(git(self.dest, 'config', 'push.default'), 'nothing')
        hook = Path(git(self.dest, 'config', 'core.hooksPath')) / 'pre-push'
        self.assertEqual(subprocess.run([str(hook)], capture_output=True).returncode, 1)
        self.assertFalse((self.dest / '.github/workflows').exists())
        self.assertTrue((self.dest / '.github/workflows.disabled-for-private-lab/public.yml').is_file())
        self.assertIn('BETTERJIT_PRIVATE_ADDON', (self.dest / m.VIEW).read_text())
        self.assertIn('IridiumBetterJITPrivate.xcodeproj', (self.dest / 'ci/build-betterjit-private.sh').read_text())
        self.assertIn('IridiumStikJIT.xcodeproj', (self.src / m.BUILD).read_text())
        self.assertFalse(report['normalGameBackendChanged'])
        self.assertGreater(len(report['files']), 10)

    def test_existing_output_is_never_overwritten(self):
        self.dest.mkdir(); (self.dest / 'keep').write_text('keep')
        with self.assertRaisesRegex(ValueError, 'already exists'): self.prepare()
        self.assertEqual((self.dest / 'keep').read_text(), 'keep')

    def test_nested_output_is_rejected_before_modifying_original(self):
        self.dest = self.src / 'private'
        with self.assertRaisesRegex(ValueError, 'outside'): self.prepare()
        self.assertFalse(self.dest.exists())

    def test_changed_host_aborts_before_copying(self):
        for name in m.INTEGRATION_PATHS:
            with self.subTest(path=name):
                p = self.src / name
                original = p.read_bytes()
                p.write_bytes(original + b'\n# unreviewed integration change\n')
                self.commit('Unreviewed host change')
                before = git(self.src, 'rev-parse', 'HEAD')
                with self.assertRaisesRegex(ValueError, 'integration point changed'): self.prepare()
                self.assertFalse(self.dest.exists())
                self.assertEqual(git(self.src, 'rev-parse', 'HEAD'), before)
                p.write_bytes(original)
                self.commit('Restore fixture')

    def test_multiple_or_already_patched_anchors_are_rejected(self):
        for text in [m.ANCHOR * 2, 'unknown', m.INSERT]:
            with self.assertRaises(ValueError): m.patch_view(text)

    def test_distinct_bundle_and_helper_identifiers(self):
        spec = m.project_spec('host', 'addon')
        app = spec['targets']['Iridium']
        self.assertEqual(app['settings']['base']['PRODUCT_BUNDLE_IDENTIFIER'], 'software.iridium.betterjit-local')
        self.assertEqual(spec['targets']['IridiumJITHelper']['settings']['base']['PRODUCT_BUNDLE_IDENTIFIER'], 'software.iridium.betterjit-local.jit-helper')
        self.assertNotIn('CODE_SIGN_ENTITLEMENTS', app['settings']['base'])
        self.assertNotIn('entitlements', app)
        self.assertNotIn('IPHONEOS_DEPLOYMENT_TARGET', app['settings']['base'])
        self.assertEqual(spec['include'], ['stikjit.yml'])
        self.assertIn('$(inherited)', app['settings']['base']['SWIFT_ACTIVE_COMPILATION_CONDITIONS'])

    def test_reviewed_fixtures_match_complete_unmocked_profiles(self):
        for profile in m.HOST_PROFILES:
            with self.subTest(reference=profile['reference']):
                files = host_files(profile['reference'])
                self.assertEqual({n: m.blob_hash(b) for n, b in files.items()}, profile['blobs'])
                self.assertEqual(m.host_profile(files), profile)

    def test_generated_wrapper_preserves_upstream_script_except_three_paths(self):
        for profile in m.HOST_PROFILES:
            with self.subTest(reference=profile['reference']):
                original = host_files(profile['reference'])[str(m.BUILD)].decode()
                wrapper = m.build_script(original)
                restored = (wrapper.replace('ci/build-betterjit-private.sh', 'ci/build-local-ipa.sh')
                            .replace('--spec iridium/apps/ios/betterjit-private.json', '--spec iridium/apps/ios/stikjit.yml')
                            .replace('IridiumBetterJITPrivate.xcodeproj', 'IridiumStikJIT.xcodeproj'))
                self.assertEqual(restored, original)
                subprocess.run(['bash', '-n'], input=wrapper, text=True, check=True)

    def test_new_media_check_and_deployment_policy_are_preserved(self):
        original = host_files(m.HOST_REFERENCE)[str(m.BUILD)].decode()
        wrapper = m.build_script(original)
        check = 'python3 ci/check-media-link.py iridium/apps/ios/.build/media-sdk/GStreamer.xcframework/ios-arm64/libGStreamer.a'
        self.assertEqual(wrapper.count(check), 1)
        self.assertLess(wrapper.index(check), wrapper.index('python3 ci/prepare-local-runtime.py'))
        self.assertNotIn('IPHONEOS_DEPLOYMENT_TARGET=27.0', wrapper)
        self.assertIn('ci/local_build_lock.py "$PWD" bash ci/build-betterjit-private.sh "$@"', wrapper)
        self.assertIn('CODE_SIGNING_ALLOWED=NO', wrapper)
        self.assertIn('python3 ci/check-local-runtime-provenance.py', wrapper)
        self.assertIn('python3 ci/check-ipa-prerequisites.py --package', wrapper)

    def test_default_uses_reviewed_commit_not_source_head(self):
        legacy = m.HOST_PROFILES[1]
        self.write_host(legacy['reference'])
        self.commit('Older integration on source working branch')
        head = git(self.src, 'rev-parse', 'HEAD')
        (self.src / 'README.md').write_text('keep current local edits\n')
        before = git(self.src, 'status', '--porcelain')
        # Substitute only the synthetic Git fixture's commit ID, not its
        # integration allowlist. Production defaults to the real reviewed SHA.
        with patch.object(m, 'HOST_REFERENCE', self.latest):
            report = self.prepare(ref=None)
        self.assertEqual(report['hostCommit'], self.latest)
        self.assertEqual(report['hostCompatibilityReference'], m.HOST_REFERENCE)
        self.assertEqual(report['hostCompatibilityBranch'], m.HOST_BRANCH)
        self.assertEqual(git(self.dest, 'rev-parse', 'HEAD'), self.latest)
        self.assertEqual(git(self.src, 'rev-parse', 'HEAD'), head)
        self.assertEqual(git(self.src, 'status', '--porcelain'), before)

    def test_explicit_legacy_revision_is_still_supported(self):
        legacy = m.HOST_PROFILES[1]
        self.write_host(legacy['reference'])
        self.commit('Legacy host fixture')
        report = self.prepare()
        self.assertEqual(report['hostCompatibilityReference'], legacy['reference'])
        self.assertEqual(report['hostCompatibilityBranch'], 'main')
        self.assertIn('IPHONEOS_DEPLOYMENT_TARGET=27.0', (self.dest / 'ci/build-betterjit-private.sh').read_text())

    def test_missing_default_commit_fails_without_fallback_or_writes(self):
        before = git(self.src, 'status', '--porcelain')
        with patch.object(m, 'HOST_REFERENCE', '0' * 40):
            with self.assertRaisesRegex(ValueError, 'not available locally'):
                self.prepare(ref=None)
        self.assertFalse(self.dest.exists())
        self.assertEqual(git(self.src, 'status', '--porcelain'), before)

    def test_integration_edits_in_worktree_are_not_copied(self):
        (self.src / m.BUILD).write_text('uncommitted build experiments\n')
        self.prepare()
        self.assertEqual((self.src / m.BUILD).read_text(), 'uncommitted build experiments\n')
        self.assertEqual((self.dest / m.BUILD).read_bytes(), host_files(m.HOST_REFERENCE)[str(m.BUILD)])

    def test_manifest_and_generated_project_identify_actual_host(self):
        report = self.prepare()
        saved = json.loads((self.dest / '.betterjit-addon/manifest.json').read_text())
        self.assertEqual(saved, report)
        config = json.loads((self.dest / m.IOS / 'betterjit-private.json').read_text())
        info = config['targets']['Iridium']['info']['properties']
        self.assertEqual(info['BetterJITHostCommit'], self.latest)
        self.assertEqual(info['BetterJITSourceCommit'], git(self.addon, 'rev-parse', 'HEAD'))
        self.assertTrue(info['BetterJITPrivateAddon'])

    def test_build_script_missing_or_duplicate_project_is_rejected(self):
        original = host_files(m.HOST_REFERENCE)[str(m.BUILD)].decode()
        for text in [original.replace('IridiumStikJIT.xcodeproj', 'Other.xcodeproj'), original * 2]:
            with self.assertRaisesRegex(ValueError, 'Unsupported host build script'):
                m.build_script(text)

    def test_prepare_syntax_remains_compatible_with_python39(self):
        ast.parse((ROOT / 'addon/iridium/prepare.py').read_text(), feature_version=(3, 9))

    def test_profiles_cannot_be_mixed_per_file(self):
        files = host_files(m.HOST_REFERENCE)
        hashes = {n: m.blob_hash(b) for n, b in files.items()}
        a, b = dict(hashes), dict(hashes)
        a[str(m.VIEW)] = '0' * 40
        b[str(m.BUILD)] = '1' * 40
        profiles = ({'reference': 'a', 'blobs': a}, {'reference': 'b', 'blobs': b})
        with patch.object(m, 'HOST_PROFILES', profiles):
            with self.assertRaisesRegex(ValueError, 'integration point changed'):
                m.host_profile(files)


if __name__ == '__main__': unittest.main()
