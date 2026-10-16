#!/usr/bin/env python3
"""Measurement-integrity tests; no production decoder/backend behavior is mocked as evidence."""
import contextlib
import copy
import hashlib
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent))
import pilot
import assets
from state_contract import ASSERTIONS, compare as compare_state


class Integrity(unittest.TestCase):
    def test_canonical_materializer_matches_exact_production_function(self):
        root = Path(__file__).resolve().parents[2]
        source = (root / 'fexwasm/src/backend.cpp').read_text()
        helpers = source[source.index('enum FlagKind : int32_t {'):source.index('// Whether an arm64 condition holds')]
        body = source[source.index('uint32_t MaterializeFlags(uint32_t Kind,'):source.index('\nstd::vector<uint8_t> BuildDispatcher')]
        self.assertEqual(hashlib.sha256((helpers + body).encode()).hexdigest(), ASSERTIONS['materializerSourceSHA256'])
        program = '#include <cstdint>\n#include <cstring>\n#include <iostream>\n' + helpers + body + '''
int main() {
  uint32_t kind, nzcv; uint64_t a, b;
  while (std::cin >> kind >> std::hex >> a >> b >> nzcv >> std::dec)
    std::cout << MaterializeFlags(kind, a, b, nzcv) << '\\n';
}
'''
        values = [0, 1, 0x7fffffff, 0x80000000, 0xffffffff, 0x7fffffffffffffff,
                  0x8000000000000000, 0xffffffffffffffff, 0x3f800000, 0x7f800000,
                  0x7fc00001, 0xff800000, 0x3ff0000000000000, 0x7ff0000000000000,
                  0x7ff8000000000001, 0xfff0000000000000]
        rows = [[kind | inversion, hex(a), hex(b), nzcv]
                for inversion in [0, 16] for kind in range(15) for a in values for b in values
                for nzcv in [0, 0x20000000, 0x40000000, 0x80000000, 0xf0000000]]
        with tempfile.TemporaryDirectory() as directory:
            cpp, binary = Path(directory) / 'reference.cpp', Path(directory) / 'reference'
            cpp.write_text(program)
            subprocess.run([os.environ.get('CXX', 'c++'), '-std=c++20', '-O2', str(cpp), '-o', str(binary)], check=True, capture_output=True, timeout=20)
            inputs = ''.join(f'{kind} {a} {b} {nzcv:x}\n' for kind, a, b, nzcv in rows)
            reference = subprocess.run([str(binary)], input=inputs, capture_output=True, text=True, check=True, timeout=20)
            reader = subprocess.run([os.environ.get('NODE', 'node'), str(Path(__file__).parent / 'test-flags.cjs')],
                                    input=json.dumps(rows), capture_output=True, text=True, check=True, timeout=20)
        self.assertEqual(json.loads(reader.stdout), [int(line) for line in reference.stdout.splitlines()])
        self.assertEqual(len(rows), 38400)

    def test_unknown_lazy_descriptor_is_rejected(self):
        for kind in [-1, 15, 31, 2.5]:
            result = subprocess.run([os.environ.get('NODE', 'node'), str(Path(__file__).parent / 'test-flags.cjs')],
                                    input=json.dumps([[kind, '0x0', '0x0', 0]]), capture_output=True, text=True, timeout=5)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('unknown lazy flag kind', result.stderr)

    def test_old_wasm_receipt_cannot_be_canonicalized_without_descriptor(self):
        with self.assertRaisesRegex(AssertionError, 'cannot be corrected post hoc'):
            pilot.validate_flag_observation(self.sample_state(), 'wasm')

    @staticmethod
    def sample_state(flags=0x202, fsw=0, ftw=0):
        return {'state': {'RIP': '0x400400000', 'RFLAGS': hex(flags),
                         'GPR': ['0x0'] * 16, 'XMM': [['0x0', '0x0'] for _ in range(16)],
                         'MM': [['0x0', '0x0'] for _ in range(8)],
                         'MXCSR': 0x1f80, 'FCW': 0x37f, 'FSW': fsw, 'FTW': ftw}}

    def test_undeclared_register_and_control_mutations_fail(self):
        row = {'path': 'unittests/ASM/Primary/Primary_98.asm'}
        reference = self.sample_state()
        self.assertTrue(compare_state(row, reference, reference)['matches'])
        for register in range(16):
            observed = copy.deepcopy(reference); observed['state']['GPR'][register] = '0x1'
            self.assertFalse(compare_state(row, observed, reference)['matches'])
            for lane in range(2):
                observed = copy.deepcopy(reference); observed['state']['XMM'][register][lane] = '0x1'
                self.assertFalse(compare_state(row, observed, reference)['matches'])
        for field in ['MXCSR', 'FCW', 'FTW']:
            observed = copy.deepcopy(reference); observed['state'][field] ^= 1
            self.assertFalse(compare_state(row, observed, reference)['matches'])

    def test_defined_flags_and_seed_controls_fail_but_undefined_bits_do_not(self):
        for fixture, excluded in [('Primary/SHL.asm', 0x811), ('TwoByte/0F_AD_3.asm', 0x10)]:
            row = {'path': 'unittests/ASM/' + fixture}
            reference = self.sample_state(flags=0x246)
            observed = copy.deepcopy(reference); observed['state']['RFLAGS'] = hex(0x246 ^ excluded ^ 0x10000)
            self.assertTrue(compare_state(row, observed, reference)['matches'])
            for bit in [0x4, 0x40, 0x80, 0x400, 0x2, 0x200]:
                observed = copy.deepcopy(reference); observed['state']['RFLAGS'] = hex(0x246 ^ bit)
                self.assertFalse(compare_state(row, observed, reference)['matches'], (fixture, hex(bit)))

    def test_x87_checks_only_live_payloads_and_defined_status(self):
        row = {'path': 'unittests/ASM/fadd.asm'}
        reference = self.sample_state(fsw=0x3800, ftw=0x80)
        reference['state']['MM'][7] = ['0xc90fdb0000000000', '0x4001']
        self.assertTrue(compare_state(row, reference, reference)['matches'])
        for register in range(7):
            observed = copy.deepcopy(reference); observed['state']['MM'][register] = ['0xffffffffffffffff', '0xffff']
            self.assertTrue(compare_state(row, observed, reference)['matches'])
        for lane in range(2):
            observed = copy.deepcopy(reference); observed['state']['MM'][7][lane] = '0x0'
            self.assertFalse(compare_state(row, observed, reference)['matches'])
        for bit in [0x100, 0x400, 0x4000]:
            observed = copy.deepcopy(reference); observed['state']['FSW'] ^= bit
            self.assertTrue(compare_state(row, observed, reference)['matches'])
        for bit in [1, 0x200, 0x800]:
            observed = copy.deepcopy(reference); observed['state']['FSW'] ^= bit
            self.assertFalse(compare_state(row, observed, reference)['matches'])

    def test_fsw_condition_bits_are_excluded_only_for_x87_arithmetic(self):
        arithmetic = {'unittests/ASM/fadd.asm', 'unittests/ASM/X87/valid_operation.asm'}
        for fixture, rule in ASSERTIONS['fixtures'].items():
            x87 = fixture in arithmetic
            self.assertEqual(int(rule['fswMask'], 0), 0xbaff if x87 else 0xffff)
            row = {'path': fixture}
            reference = self.sample_state(flags=0x202 | int(rule['expectedMaskedFlags'], 0),
                                          fsw=int(rule['expectedMaskedFSW'], 0))
            self.assertTrue(compare_state(row, reference, reference)['matches'], fixture)
            for bit in [0x100, 0x400, 0x4000]:  # C0, C2, C3
                observed = copy.deepcopy(reference); observed['state']['FSW'] ^= bit
                result = compare_state(row, observed, reference)
                self.assertEqual(result['matches'], x87, (fixture, hex(bit)))
                self.assertEqual(result['checks']['definedX87Status'], x87)
                self.assertEqual(result['checks']['definedFSWMatchesOracle'], x87)

    def test_dormant_andn_contract_is_correct_and_profile_skipped(self):
        fixture = 'unittests/ASM/VEX/andn.asm'
        rule = ASSERTIONS['fixtures'][fixture]
        self.assertEqual(rule['flagsMask'], '0xcc1')
        self.assertEqual(rule['expectedMaskedFlags'], '0x40')
        self.assertFalse(pilot.SPEC['profile']['guestAVX'])
        row = next(dict(f) for f in pilot.SPEC['fixtures'] if f['path'] == fixture)
        row.update(metadata={'HostFeatures': ['BMI1']}, policy={'oracle': []})
        self.assertIn('BMI1', pilot.gate(row, 'oracle'))

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
