#!/usr/bin/env python3
import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('addon_prepare', ROOT / 'addon/iridium/prepare.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


def git(path, *args):
    return subprocess.check_output(['git', '-C', str(path), *args], text=True, stderr=subprocess.DEVNULL).strip()


class PrivateAddonTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.base = Path(self.temp.name)
        self.src = self.base / 'public'
        self.src.mkdir()
        git(self.src, 'init', '-q')
        git(self.src, 'config', 'user.name', 'Fixture')
        git(self.src, 'config', 'user.email', 'fixture@example.invalid')
        files = {
            str(m.VIEW): 'import SwiftUI\nstruct RootTabView {\n' + m.ANCHOR + '}\n',
            str(m.BUILD): 'exec bash ci/build-local-ipa.sh "$@"\nxcodegen generate --spec iridium/apps/ios/stikjit.yml\nxcodebuild -project iridium/apps/ios/IridiumStikJIT.xcodeproj\n',
            str(m.IOS / 'stikjit.yml'): 'include: madeira.yml\n',
            '.github/workflows/public.yml': 'on: push\n',
            'README.md': 'committed version\n',
        }
        for name, text in files.items():
            p = self.src / name; p.parent.mkdir(parents=True, exist_ok=True); p.write_text(text)
        git(self.src, 'add', '.')
        git(self.src, 'commit', '-qm', 'Fixture')
        git(self.src, 'remote', 'add', 'origin', 'https://github.com/example/public.git')
        self.supported = {name: m.blob_hash((self.src / name).read_bytes()) for name in m.SUPPORTED}
        self.dest = self.base / 'private'

    def tearDown(self):
        self.temp.cleanup()

    def prepare(self):
        with patch.object(m, 'SUPPORTED', self.supported):
            return m.prepare(self.src, self.dest)

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
        self.supported[str(m.VIEW)] = '0' * 40
        with self.assertRaisesRegex(ValueError, 'integration point changed'): self.prepare()
        self.assertFalse(self.dest.exists())

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
        self.assertEqual(spec['include'], ['stikjit.yml'])
        self.assertIn('$(inherited)', app['settings']['base']['SWIFT_ACTIVE_COMPILATION_CONDITIONS'])

if __name__ == '__main__': unittest.main()
