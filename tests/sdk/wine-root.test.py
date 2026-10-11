#!/usr/bin/env python3
"""Regression for the real root-conversion failure; does not execute Wine."""
import importlib.util, io, pathlib, tarfile, tempfile, unittest
ROOT=pathlib.Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('wine_root',ROOT/'scripts/prepare-wine-root.py')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
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
            for name,kind in [('../escape',tarfile.REGTYPE),('dev/unsupported',tarfile.CHRTYPE)]:
                with self.subTest(name=name):
                    with tarfile.open(archive,'w:gz') as tar:
                        member=tarfile.TarInfo(name);member.type=kind
                        tar.addfile(member,io.BytesIO())
                    with self.assertRaises(ValueError): module.extract_input_archive(archive,out)
if __name__=='__main__': unittest.main()
