#!/usr/bin/env python3
"""Regression for the real root-conversion failure; does not execute Wine."""
import importlib.util, io, pathlib, tarfile, tempfile, unittest
ROOT=pathlib.Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('wine_root',ROOT/'scripts/prepare-wine-root.py')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
flat_spec=importlib.util.spec_from_file_location('wine_flat',ROOT/'scripts/prepare-wine-flat-root.py')
flat=importlib.util.module_from_spec(flat_spec);flat_spec.loader.exec_module(flat)
class RootArchiveTests(unittest.TestCase):
    def test_virtual_device_and_wine_entry(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=pathlib.Path(tmp);out=root/'root';out.mkdir();archive=root/'input.tar.gz'
            with tarfile.open(archive,'w:gz') as tar:
                device=tarfile.TarInfo('./dev/null');device.type=tarfile.CHRTYPE
                device.devmajor=1;device.devminor=3;tar.addfile(device)
                binary=tarfile.TarInfo('./usr/bin/wine64');binary.size=4;binary.mode=0o755
                tar.addfile(binary,io.BytesIO(b'ELF!'))
                link=tarfile.TarInfo('./opt/wine/bin/wine');link.type=tarfile.SYMTYPE
                link.linkname='/usr/bin/wine64';tar.addfile(link)
            links,modes,total,devices=module.extract_input_archive(archive,out)
            self.assertEqual((out/'usr/bin/wine64').read_bytes(),b'ELF!')
            self.assertFalse((out/'dev/null').exists())
            self.assertEqual(devices,['/dev/null'])
            self.assertEqual(modes['/usr/bin/wine64'],0o755)
            self.assertEqual(links['/opt/wine/bin/wine'],'/usr/bin/wine64')
            self.assertEqual(total,4)
    def test_rejects_paths_outside_root_and_unknown_special_nodes(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=pathlib.Path(tmp);out=root/'root';out.mkdir();archive=root/'input.tar.gz'
            for name,kind in [('../escape',tarfile.REGTYPE),('var/native-device',tarfile.CHRTYPE)]:
                with self.subTest(name=name):
                    with tarfile.open(archive,'w:gz') as tar:
                        member=tarfile.TarInfo(name);member.type=kind
                        tar.addfile(member,io.BytesIO())
                    with self.assertRaises(ValueError): module.extract_input_archive(archive,out)
    def test_separate_candidate_preserves_stock_and_failure_leaves_manifests(self):
        # Installation fixture only. Real candidate compatibility is a required
        # live host Wine workload when these source-built inputs are present.
        with tempfile.TemporaryDirectory() as tmp:
            base=pathlib.Path(tmp);root=base/'root';output=base/'output'
            unix=root/'usr/lib/wine/x86_64-unix';unix.mkdir(parents=True);output.mkdir()
            stock=unix/'ntdll.so';stock.write_bytes(b'stock')
            (root/'.symlinks.json').write_text('{}\n');(root/'.modes.json').write_text('{}\n')
            source=base/'source.tar';source.write_bytes(b'source fixture')
            patch=base/'patch';patch.write_bytes(b'patch fixture')
            (output/'ntdll.so').write_bytes(b'adapted fixture')
            with self.assertRaises(FileNotFoundError): flat.install(root,output,source,patch)
            self.assertFalse((root/'opt/wine-flat').exists())
            self.assertEqual((root/'.symlinks.json').read_text(),'{}\n')
            self.assertEqual(stock.read_bytes(),b'stock')
            for name in ('wine','COPYING.LIB','fs-reset.elf'): (output/name).write_bytes(b'fixture')
            flat.install(root,output,source,patch)
            import json
            links=json.loads((root/'.symlinks.json').read_text())
            self.assertEqual(links['/opt/wine-flat/bin/wine'],'../lib/wine/x86_64-unix/wine')
            self.assertEqual(stock.read_bytes(),b'stock')
            meta=json.loads((root/'opt/wine-flat/.betterjit-wine-flat.json').read_text())
            self.assertFalse(meta['stockWineFilesChanged'])
            self.assertFalse(meta['wineExecutedDuringPreparation'])
            self.assertFalse(meta['guestExecutedThroughFEXDuringPreparation'])
            self.assertEqual(meta['guestAddressLimitExclusive'],'0x7fff0000')
    def test_native_prefix_archive_remaps_hardlinks_and_rejects_escape(self):
        # Archive fixture only: no native Wine or guest success claim.
        with tempfile.TemporaryDirectory() as tmp:
            root=pathlib.Path(tmp);archive=root/'prefix.tar.gz';links={};modes={}
            with tarfile.open(archive,'w:gz') as tar:
                f=tarfile.TarInfo('system.reg');f.size=4;tar.addfile(f,io.BytesIO(b'reg!'))
                hard=tarfile.TarInfo('.registry-copy');hard.type=tarfile.LNKTYPE;hard.linkname='system.reg';tar.addfile(hard)
                link=tarfile.TarInfo('dosdevices/z:');link.type=tarfile.SYMTYPE;link.linkname='/';tar.addfile(link)
            flat.install_prefix(root,archive,links,modes)
            self.assertEqual((root/'home/user/.wine-flat/system.reg').read_bytes(),b'reg!')
            self.assertEqual(links['/home/user/.wine-flat/.registry-copy'],'/home/user/.wine-flat/system.reg')
            self.assertEqual(links['/home/user/.wine-flat/dosdevices/z:'],'/')
            import shutil
            shutil.rmtree(root/'home/user/.wine-flat')
            with tarfile.open(archive,'w:gz') as tar: tar.addfile(tarfile.TarInfo('../escape'))
            with self.assertRaises(ValueError): flat.install_prefix(root,archive,{}, {})
            self.assertFalse((root/'home/user/.wine-flat').exists())
if __name__=='__main__': unittest.main()
