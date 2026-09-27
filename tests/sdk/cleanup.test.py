#!/usr/bin/env python3
import copy
import importlib.util
from pathlib import Path
import unittest
ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('cleanup',ROOT/'scripts/cleanup-branches.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class CleanupTests(unittest.TestCase):
    def setUp(self):
        self.sha='a'*40;self.head='feature/retired';self.tag='refs/tags/archive/test/'+self.head
        self.plan={'active':['main','private/iridium-addon','feature/runtime-sdk'],'tagPrefix':'archive/test/','archive':{self.head:self.sha}}
        self.refs={'refs/heads/feature/runtime-sdk':'b'*40,'refs/heads/'+self.head:self.sha}
    def test_matching_head_plans_archive_and_delete(self):
        self.assertEqual(m.plan_actions(self.plan,self.refs),[('refs/heads/'+self.head,self.tag,self.sha,True)])
    def test_missing_head_with_verified_sdk_ancestry(self):
        del self.refs['refs/heads/'+self.head]
        self.assertEqual(m.plan_actions(self.plan,self.refs,{self.sha}),[])
    def test_missing_head_without_proof_rejects(self):
        del self.refs['refs/heads/'+self.head]
        with self.assertRaisesRegex(ValueError,'without verified'):m.plan_actions(self.plan,self.refs)
    def test_missing_head_with_exact_archive(self):
        del self.refs['refs/heads/'+self.head];self.refs[self.tag]=self.sha
        self.assertEqual(m.plan_actions(self.plan,self.refs),[])
    def test_moved_head_rejects_even_with_ancestry(self):
        self.refs['refs/heads/'+self.head]='c'*40
        with self.assertRaisesRegex(ValueError,'moved'):m.plan_actions(self.plan,self.refs,{self.sha})
    def test_moved_archive_rejects(self):
        self.refs[self.tag]='c'*40
        with self.assertRaisesRegex(ValueError,'differs'):m.plan_actions(self.plan,self.refs,{self.sha})
    def test_active_branches_and_missing_sdk_are_protected(self):
        self.plan['archive']={'main':self.sha}
        with self.assertRaises(ValueError):m.plan_actions(self.plan,self.refs)
        self.plan['archive']={};del self.refs['refs/heads/feature/runtime-sdk']
        with self.assertRaises(ValueError):m.plan_actions(self.plan,self.refs)
    def test_invalid_ref_names_and_expected_hashes(self):
        for name,value in [('feature/../main',self.sha),('--delete',self.sha),('feature/x','HEAD')]:
            p=copy.deepcopy(self.plan);p['archive']={name:value}
            with self.assertRaises(ValueError):m.plan_actions(p,self.refs)
if __name__=='__main__':unittest.main()
