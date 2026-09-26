#!/usr/bin/env python3
"""Hermetic source-export and conservative branch-cleanup planning checks."""
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
def module(name, path):
    spec = importlib.util.spec_from_file_location(name, ROOT / path)
    value = importlib.util.module_from_spec(spec); spec.loader.exec_module(value); return value
exporter = module('sdk_export', 'scripts/export-sdk.py')
cleanup = module('branch_cleanup', 'scripts/cleanup-branches.py')
def git(root, *args):
    return subprocess.check_output(['git', '-C', str(root), *args], stderr=subprocess.DEVNULL)

class ExportTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        git(self.root, 'init', '-q')
        git(self.root, 'config', 'user.name', 'Fixture')
        git(self.root, 'config', 'user.email', 'fixture@example.invalid')
        self.files = {p:p for p in ['Package.swift', 'README.md', 'COPYING', 'docs/sdk/provenance.md']}
        for name in self.files:
            p=self.root/name; p.parent.mkdir(parents=True, exist_ok=True); p.write_text(name+'\n')
        (self.root/'distribution').mkdir()
        self.commit()
    def commit(self):
        (self.root/'distribution/sdk-files.json').write_text(json.dumps({'schema':1,'files':self.files}))
        git(self.root, 'add', '.'); git(self.root, 'commit', '-qm', 'Fixture')
    def test_committed_allowlist_only_and_deterministic_archive(self):
        (self.root/'README.md').write_text('uncommitted edit')
        (self.root/'personal.log').write_text('not selected')
        a=exporter.archive(exporter.collect(self.root, 'HEAD'))
        self.assertEqual(a, exporter.archive(exporter.collect(self.root, 'HEAD')))
        with tarfile.open(fileobj=io.BytesIO(a), mode='r:gz') as archive:
            self.assertEqual(archive.extractfile('BetterJIT-SDK/README.md').read(), b'README.md\n')
            self.assertNotIn('BetterJIT-SDK/personal.log', archive.getnames())
            manifest=json.load(archive.extractfile('BetterJIT-SDK/SOURCE-MANIFEST.json'))
            self.assertEqual(manifest['sourceRevision'],git(self.root,'rev-parse','HEAD').decode().strip())
    def test_unsafe_export_paths_and_reserved_manifest_are_rejected(self):
        for name in ['../secret','/etc/key','x/../y','a\\b','a\nb','.git/config','x//y']:
            with self.subTest(name=name),self.assertRaises(ValueError): exporter.safe_path(name)
        self.files['SOURCE-MANIFEST.json']='README.md'; self.commit()
        with self.assertRaisesRegex(ValueError,'Reserved'): exporter.collect(self.root,'HEAD')
    def test_symlink_is_not_followed(self):
        (self.root/'link').symlink_to('README.md');self.files['link']='link';self.commit()
        with self.assertRaisesRegex(ValueError,'regular'): exporter.collect(self.root,'HEAD')
    def test_missing_source_and_notice_fail(self):
        self.files['gone']='absent';self.commit()
        with self.assertRaisesRegex(ValueError,'Missing'):exporter.collect(self.root,'HEAD')
        del self.files['gone'];del self.files['COPYING'];self.commit()
        with self.assertRaisesRegex(ValueError,'Missing'):exporter.collect(self.root,'HEAD')
    def test_binary_and_private_key_fail(self):
        self.files['unexpected']='unexpected'
        for data in [b'bad\0binary', b'\xff\xfe', b'-----BEGIN RSA PRIVATE KEY-----']:
            (self.root/'unexpected').write_bytes(data);self.commit()
            with self.assertRaises(ValueError):exporter.collect(self.root,'HEAD')

class CleanupTests(unittest.TestCase):
    def setUp(self):
        self.sha='1'*40
        self.plan={'active':['main','private/iridium-addon','feature/runtime-sdk'],
                   'archive':{'feature/old':self.sha},'tagPrefix':'archive/test/'}
        self.head='refs/heads/feature/old';self.tag='refs/tags/archive/test/feature/old'
        self.refs={'refs/heads/feature/runtime-sdk':'2'*40,self.head:self.sha}
    def test_exact_tips_are_archived_before_pruning(self):
        self.assertEqual(cleanup.plan_actions(self.plan,self.refs),[(self.head,self.tag,self.sha,True)])
    def test_moved_heads_and_conflicting_archives_fail(self):
        for ref in [self.head,self.tag]:
            refs={**self.refs,ref:'3'*40}
            with self.assertRaises(ValueError):cleanup.plan_actions(self.plan,refs)
    def test_existing_archive_makes_rerun_idempotent(self):
        refs={'refs/heads/feature/runtime-sdk':'2'*40,self.tag:self.sha}
        self.assertEqual(cleanup.plan_actions(self.plan,refs),[])
        del refs[self.tag]
        with self.assertRaises(ValueError):cleanup.plan_actions(self.plan,refs)
    def test_active_lanes_cannot_be_deleted(self):
        self.plan['archive']['main']=self.sha
        with self.assertRaises(ValueError):cleanup.plan_actions(self.plan,self.refs)
    def test_consolidated_branch_must_exist(self):
        del self.refs['refs/heads/feature/runtime-sdk']
        with self.assertRaises(ValueError):cleanup.plan_actions(self.plan,self.refs)

if __name__=='__main__':unittest.main()
