#!/usr/bin/env python3
"""Package-layout/error tests with metadata fixtures; no native execution claim."""
import importlib.util
import pathlib
import plistlib
import tempfile
import unittest

ROOT=pathlib.Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('fex_adapter',ROOT/'scripts/package-fex-adapter.py')
adapter=importlib.util.module_from_spec(spec)
spec.loader.exec_module(adapter)

class AdapterPackageTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root=pathlib.Path(self.temp.name)
        self.native=self.root/'Native'
        self.info=self.native/'CFEXWasm.xcframework/Info.plist'
        self.info.parent.mkdir(parents=True)
        self.write_info()
        self.sdk=self.root/'SDK'
        self.sdk.mkdir()
        (self.sdk/'Package.swift').write_text('// Metadata fixture only\n')
        self.output=self.root/'Adapter'

    def write_info(self,platform='ios',variant=None):
        library={'SupportedPlatform':platform,'SupportedArchitectures':['arm64']}
        if variant:library['SupportedPlatformVariant']=variant
        self.info.write_bytes(plistlib.dumps({'AvailableLibraries':[library]}))

    def test_relocatable_sibling_dependencies_and_public_sources(self):
        adapter.generate(self.native,self.sdk,self.output)
        manifest=(self.output/'Package.swift').read_text()
        self.assertIn('path: "../SDK"',manifest)
        self.assertIn('path: "../Native"',manifest)
        self.assertNotIn(str(ROOT),manifest)
        self.assertTrue((self.output/'Sources/BetterJITFEXAdapter/FEXProcess.swift').is_file())
        self.assertTrue((self.output/'LICENSES').is_dir())

    def test_existing_output_is_preserved(self):
        self.output.mkdir()
        marker=self.output/'keep';marker.write_text('existing')
        with self.assertRaisesRegex(ValueError,'retained unchanged'):
            adapter.generate(self.native,self.sdk,self.output)
        self.assertEqual(marker.read_text(),'existing')

    def test_simulator_or_other_platform_is_not_claimed(self):
        for platform,variant in [('ios','simulator'),('macos',None)]:
            self.write_info(platform,variant)
            with self.assertRaisesRegex(ValueError,'device-arm64'):
                adapter.generate(self.native,self.sdk,self.output)
            self.assertFalse(self.output.exists())

    def test_incomplete_sources_remove_only_partial_output(self):
        with self.assertRaises(FileNotFoundError):
            adapter.generate(self.native,self.sdk,self.output,source=self.sdk)
        self.assertFalse(self.output.exists())
        self.assertTrue(self.info.is_file())

if __name__=='__main__':unittest.main()
