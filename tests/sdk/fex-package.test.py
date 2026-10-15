#!/usr/bin/env python3
"""Package-layout/error tests with metadata fixtures; no native execution claim."""
import importlib.util
import json
import pathlib
import plistlib
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch

ROOT=pathlib.Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('fex_adapter',ROOT/'scripts/package-fex-adapter.py')
adapter=importlib.util.module_from_spec(spec)
spec.loader.exec_module(adapter)
spec=importlib.util.spec_from_file_location('fex_consumer',ROOT/'scripts/package-fex-consumer.py')
consumer=importlib.util.module_from_spec(spec);spec.loader.exec_module(consumer)

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

    def test_portable_native_receipt_is_preserved_exactly_and_checks_packaged_bytes(self):
        binary=self.root/'PortableNative';binary.mkdir()
        for name in ('Package.swift','COPYING','CFEXWasm.xcframework/ios-arm64/Headers/translator.h',
                     'CFEXWasm.xcframework/ios-arm64/Headers/module.modulemap'):
            path=binary/name;path.parent.mkdir(parents=True,exist_ok=True);path.write_text('fixture '+name)
        files={p.relative_to(binary).as_posix():{'sha256':consumer.digest(p)} for p in binary.rglob('*') if p.is_file()}
        receipt={'schema':1,'identity':{'inputs':{'component':'fex-ios'}},
                 'producer':{'commit':'a'*40},'files':files}
        original=json.dumps(receipt,indent=2)+'\n';(self.native/'ASSET-MANIFEST.json').write_text(original)
        result=consumer.copy_native_receipt(self.native,binary)
        self.assertEqual((binary/'ASSET-MANIFEST.json').read_text(),original)
        self.assertEqual(result['sha256'],consumer.digest(binary/'ASSET-MANIFEST.json'))
        (binary/'ASSET-MANIFEST.json').unlink();(binary/'COPYING').write_text('changed')
        with self.assertRaisesRegex(ValueError,'does not match'): consumer.copy_native_receipt(self.native,binary)
        self.assertFalse((binary/'ASSET-MANIFEST.json').exists())

    def test_legacy_native_package_has_no_claimed_producer_receipt(self):
        binary=self.root/'PortableNative';binary.mkdir()
        self.assertIsNone(consumer.copy_native_receipt(self.native,binary))

    def test_malformed_native_receipts_are_rejected(self):
        binary=self.root/'PortableNative';binary.mkdir();(binary/'COPYING').write_text('fixture')
        receipt=self.native/'ASSET-MANIFEST.json'
        invalid=[[], {'schema':1,'identity':[]}, {'schema':1,'identity':{'inputs':[]}},
                 {'schema':1,'identity':{'inputs':{'component':'fex-host'}},'files':{}},
                 {'schema':1,'identity':{'inputs':{'component':'fex-ios'}},'files':[]},
                 {'schema':1,'identity':{'inputs':{'component':'fex-ios'}},'files':{'COPYING':[]}}]
        for data in invalid:
            with self.subTest(data=data):
                receipt.write_text(json.dumps(data))
                with self.assertRaises(ValueError): consumer.copy_native_receipt(self.native,binary)
                self.assertFalse((binary/'ASSET-MANIFEST.json').exists())

    def test_broken_receipt_symlink_is_not_treated_as_legacy(self):
        binary=self.root/'PortableNative';binary.mkdir()
        (self.native/'ASSET-MANIFEST.json').symlink_to(self.native/'missing-receipt.json')
        with self.assertRaisesRegex(ValueError,'regular file'): consumer.copy_native_receipt(self.native,binary)

    def consumer_fixture(self):
        # Real exporter/adapter/consumer code, using a committed metadata-only
        # SDK and fake native bytes. This does not compile or execute Swift/FEX.
        producer=self.root/'Producer';producer.mkdir()
        names=['Package.swift','COPYING','README.md','docs/sdk/provenance.md','THIRD_PARTY.md',
               'LICENSES/fixture.txt']+['Backends/FEX/Swift/'+name for name in adapter.SOURCES]
        for name in names:
            path=producer/name;path.parent.mkdir(parents=True,exist_ok=True)
            path.write_text('Metadata fixture: '+name+'\n')
        (producer/'distribution').mkdir()
        (producer/'distribution/sdk-files.json').write_text(json.dumps({'schema':1,'files':{n:n for n in names}}))
        (producer/'scripts').mkdir()
        for name in ('export-sdk.py','package-fex-adapter.py'):
            shutil.copyfile(ROOT/'scripts'/name,producer/'scripts'/name)
        def git(*args):
            return subprocess.check_output(['git','-C',str(producer),*args],stderr=subprocess.DEVNULL,text=True).strip()
        git('init','-q');git('add','.')
        git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','Metadata fixture')
        revision=git('rev-parse','HEAD')
        for name in ('Package.swift','COPYING','CFEXWasm.xcframework/ios-arm64/libCFEXWasm.a',
                     'CFEXWasm.xcframework/ios-arm64/Headers/translator.h',
                     'CFEXWasm.xcframework/ios-arm64/Headers/module.modulemap'):
            path=self.native/name;path.parent.mkdir(parents=True,exist_ok=True);path.write_text('Metadata fixture\n')
        self.info.write_bytes(plistlib.dumps({'AvailableLibraries':[{
            'LibraryIdentifier':'ios-arm64','LibraryPath':'libCFEXWasm.a','HeadersPath':'Headers',
            'SupportedPlatform':'ios','SupportedArchitectures':['arm64']}]}))
        receipt={'schema':1,'identity':{'inputs':{'component':'fex-ios'}},'producer':{'commit':'a'*40},
                 'files':{p.relative_to(self.native).as_posix():{'sha256':consumer.digest(p)}
                          for p in self.native.rglob('*') if p.is_file()}}
        exact=(json.dumps(receipt,indent=2)+'\n').encode()
        (self.native/'ASSET-MANIFEST.json').write_bytes(exact)
        return producer,revision,exact

    @unittest.skipUnless((ROOT/'scripts/export-sdk.py').is_file(),
                         'Producer exporter is intentionally outside the standalone SDK')
    def test_complete_consumer_keeps_original_producer_and_current_source_revision(self):
        producer,revision,exact=self.consumer_fixture();out=self.root/'Portable'
        with patch.object(consumer,'ROOT',producer): manifest=consumer.package(self.native,out)
        self.assertEqual(manifest['sourceRevision'],revision)
        receipt=out/manifest['nativeProducerReceipt']['path']
        self.assertEqual(receipt.read_bytes(),exact)
        self.assertNotEqual(json.loads(exact)['producer']['commit'],revision)
        self.assertEqual(manifest['nativeProducerReceipt']['sha256'],consumer.digest(receipt))
        self.assertEqual(json.loads((out/'PACKAGE-MANIFEST.json').read_text()),manifest)
        for name,digest in manifest['files'].items(): self.assertEqual(consumer.digest(out/name),digest,name)
        self.assertTrue((out/'BetterJITFEXAdapter/Sources/BetterJITFEXAdapter/FEXProcess.swift').is_file())

    @unittest.skipUnless((ROOT/'scripts/export-sdk.py').is_file(),
                         'Producer exporter is intentionally outside the standalone SDK')
    def test_complete_consumer_rejects_mismatched_receipt_and_removes_only_staging(self):
        producer,_,exact=self.consumer_fixture();out=self.root/'Portable'
        (self.native/'COPYING').write_text('Changed after producer sealing\n')
        with patch.object(consumer,'ROOT',producer):
            with self.assertRaisesRegex(ValueError,'does not match'): consumer.package(self.native,out)
        self.assertFalse(out.exists())
        self.assertEqual((self.native/'ASSET-MANIFEST.json').read_bytes(),exact)
        self.assertEqual((self.native/'COPYING').read_text(),'Changed after producer sealing\n')

if __name__=='__main__':unittest.main()
