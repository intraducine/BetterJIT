#!/usr/bin/env python3
"""Measurement-integrity tests; no production decoder/backend behavior is mocked as evidence."""
import contextlib
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent))
import pilot
import assets


class Integrity(unittest.TestCase):
    def test_timeout_reaps_process_group(self):
        with tempfile.TemporaryDirectory() as directory:
            pidfile = Path(directory) / 'pid'
            code = ('import subprocess,time,pathlib;'
                    'p=subprocess.Popen(["sleep","30"]);'
                    f'pathlib.Path({str(pidfile)!r}).write_text(str(p.pid));'
                    'time.sleep(30)')
            result = pilot.process([sys.executable, '-c', code], seconds=0.3)
            self.assertEqual(result['interrupted'], 'timeout')
            pid = int(pidfile.read_text())
            # Linux can briefly retain a dead grandchild as a zombie for its reaper.
            proc = Path('/proc') / str(pid) / 'stat'
            if proc.exists():
                self.assertEqual(proc.read_text().split()[2], 'Z')

    def test_output_cap_kills_instead_of_truncating_to_pass(self):
        result = pilot.process([sys.executable, '-c', 'print("x"*1000000)'], limit=1000)
        self.assertEqual(result['interrupted'], 'output-limit')
        self.assertLessEqual(len(result['stdout']) + len(result['stderr']), 1000)
        self.assertNotEqual(result['exitCode'], 0)

    def test_nonzero_and_skip_exits_preserved(self):
        for code in [1, 77, 125]:
            result = pilot.process([sys.executable, '-c', f'print("{{}}");raise SystemExit({code})'])
            self.assertEqual(result['exitCode'], code)
            self.assertIsNone(result['interrupted'])

    def test_gates_do_not_claim_pass(self):
        row = {'mode': 64, 'metadata': {'HostFeatures': ['BMI1']}, 'policy': {'oracle': []}}
        self.assertIn('BMI1', pilot.gate(row, 'oracle'))
        row['metadata'] = {}
        row['mode'] = 32
        self.assertIn('mode32', pilot.gate(row, 'oracle'))
        row['mode'] = 64
        row['policy']['oracle'] = [{'category': 'Disabled_Tests'}]
        self.assertIn('disabled', pilot.gate(row, 'oracle'))

    def test_projection_detects_wrong_lane_and_preserves_full_state(self):
        state = {'GPR': ['0x0'] * 16, 'XMM': [['0x0', '0x0']] * 16}
        state['GPR'][0] = '0x123'
        state['XMM'][1] = ['0xabc', '0xdef']
        row = {'metadata': {'RegData': {'RAX': '0x123', 'XMM1': ['0xabc', '0xdef']}}}
        observed = {'state': state}
        self.assertTrue(pilot.projection(row, observed)['matches'])
        state['XMM'][1] = ['0xabc', '0xdee']
        self.assertFalse(pilot.projection(row, observed)['matches'])

    def test_hash_covers_entire_maps(self):
        state = {'RIP': '0x0', 'RFLAGS': '0x202', 'GPR': ['0x0'] * 16,
                 'XMM': [['0x0', '0x0']] * 16, 'MM': [['0x0', '0x0']] * 8,
                 'MXCSR': 0x1f80, 'FCW': 0x37f, 'FSW': 0, 'FTW': 0}
        code = bytearray(65536)
        def observed():
            return pilot.normalize({'state': state, 'codeHex': code.hex(), 'stackHex': bytes(65536).hex()})
        first = observed()
        code[-1] = 1
        second = observed()
        self.assertNotEqual(first['codeSHA256'], second['codeSHA256'])
        self.assertEqual(first['stackSHA256'], second['stackSHA256'])
        self.assertEqual(first['architecturalStateSHA256'], second['architecturalStateSHA256'])
        self.assertNotIn('codeHex', first)
        self.assertEqual(first['state'], state)

    def test_known_failure_and_disabled_policy_keeps_exact_source_match(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            policies = root / 'unittests/ASM'
            policies.mkdir(parents=True)
            (policies / 'Known_Failures_jit').write_text('jit_500/Test_64Bit_Example.asm\n')
            (policies / 'Disabled_Tests_host').write_text('Test_Example.asm\n')
            matches = pilot.policy(root, {'path': 'unittests/ASM/Example.asm', 'mode': 64})
            self.assertEqual(matches['block500'][0]['category'], 'Known_Failures')
            self.assertEqual(matches['block500'][0]['matched'], 'jit_500/Test_64Bit_Example.asm')
            self.assertEqual(matches['single'], [])
            self.assertEqual(matches['oracle'][0]['category'], 'Disabled_Tests')
            self.assertEqual(matches['wasm'], [])

    def test_native_cache_rejects_changed_binary_recipe_and_producer(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            asset = root / 'asset'
            asset.mkdir()
            binary, options = asset / 'corpus-native-arm64', asset / 'options.json'
            binary.write_bytes(b'fake binary for cache-integrity unit test only')
            options.write_text('{}')
            identity = {'key': 'frozen-unit-test-recipe'}
            valid = {'identity': identity, 'producer': {'repository': 'intraducine/BetterJIT', 'workflow': assets.WORKFLOW},
                     'outputs': {p.name: assets.sha(p) for p in [binary, options]}}
            def check(manifest):
                (asset / 'manifest.json').write_text(json.dumps(manifest))
                with mock.patch.object(assets, 'ROOT', root), mock.patch.object(assets, 'ASSET', asset), \
                     mock.patch.object(assets, 'identity', return_value=identity), \
                     mock.patch.object(sys, 'argv', ['assets.py', 'check']), \
                     mock.patch.object(assets.subprocess, 'check_output', return_value='Mach-O 64-bit executable arm64'), \
                     mock.patch.dict(assets.os.environ, {'GITHUB_OUTPUT': ''}), contextlib.redirect_stdout(io.StringIO()):
                    assets.main()
                return json.loads((root / '.build/corpus-pilot/results/native-asset-usage.json').read_text())['hit']
            self.assertTrue(check(valid))
            changed = json.loads(json.dumps(valid)); changed['producer']['workflow'] = 'another producer'
            self.assertFalse(check(changed))
            changed = json.loads(json.dumps(valid)); changed['identity']['key'] = 'other recipe'
            self.assertFalse(check(changed))
            binary.write_bytes(b'corrupted cache')
            self.assertFalse(check(valid))

    def test_export_records_missing_layers_and_enforces_total_byte_limit(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'inputs').mkdir()
            (root / 'inputs/manifest.json').write_text('{}')
            script = Path(__file__).parent / 'verify-results.py'
            result = pilot.process([sys.executable, script, root])
            self.assertEqual(result['exitCode'], 0)
            for layer in ['oracle', 'single', 'block500', 'multi500', 'wasm']:
                rows = [json.loads(line) for line in (root / f'export/results/{layer}.jsonl').read_text().splitlines()]
                self.assertEqual(len(rows), 14)
                self.assertTrue(all(r['status'] == 'untested' and r['semanticPass'] is None for r in rows))
            (root / 'results/oversized.json').write_bytes(bytes(8388608))
            result = pilot.process([sys.executable, script, root])
            self.assertEqual(result['exitCode'], 1)
            self.assertEqual([p.name for p in (root / 'export').iterdir()], ['budget-failure.json'])


if __name__ == '__main__':
    unittest.main()
