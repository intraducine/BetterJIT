#!/usr/bin/env python3
"""Local iteration identity, process-boundary and outcome regressions."""
import argparse
import copy
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import signal
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('iteration', ROOT/'scripts/iterate-sparse.py')
iteration = importlib.util.module_from_spec(spec)
spec.loader.exec_module(iteration)


class IterationTests(unittest.TestCase):
    @unittest.skipUnless(shutil.which('clang++') and shutil.which('ar'), 'Clang/ar fixture toolchain unavailable')
    def test_verified_frontend_changes_invalidate_embedded_identity_and_translator(self):
        # A tiny real Clang/static-library fixture, not production FEX evidence.
        with tempfile.TemporaryDirectory() as d:
            root = Path(d).resolve()
            b = root/'FEX/build'
            libs = [b/p for p in ('FEXCore/Source/libFEXCore.a', 'FEXCore/Source/libFEXCore_Base.a',
                    'FEXCore/Source/libJemallocLibs.a', 'External/fmt/libfmt.a',
                    'External/xxhash/cmake_unofficial/libxxhash.a', 'External/cephes/libcephes_128bit.a',
                    'External/SoftFloat-3e/libsoftfloat_3e.a')]
            # Apple ar requires a member even for an otherwise unused archive.
            placeholder = root/'placeholder.o'
            subprocess.run(['clang++', '-x', 'c++', '-c', '-', '-o', str(placeholder)], input=b'', check=True)
            for lib in libs:
                lib.parent.mkdir(parents=True, exist_ok=True)
                subprocess.run(['ar', 'rcs', str(lib), str(placeholder)], check=True)
            for folder in ('fexwasm/src', 'fexwasm/tools', 'Backends/FEX', '.build'):
                (root/folder).mkdir(parents=True, exist_ok=True)
            (root/'Backends/FEX/build-host.sh').write_text('fixture recipe')
            (root/'fexwasm/src/translator.cpp').write_text('const char* identity(){return FEXWASM_BUILD_ID;}\n')
            (root/'fexwasm/tools/fexserve.cpp').write_text('#include <cstdio>\nconst char* identity(); int native(); int main(){std::printf("%s:%d\\n",identity(),native());}\n')
            config = b/'CMakeCache.txt'
            config.write_text('fixture CMake configuration')
            key = {'fixtureFrontendGeneration': 1}

            def seal():
                iteration.save(root/'.build/frontend-current.json', key)
                iteration.save(b/'.betterjit-frontend.json', {'key': dict(key), 'outputSHA256': iteration.sha(config),
                               'dependencies': {str(lib.resolve()): iteration.sha(lib) for lib in libs}})

            def library(value):
                source, obj = root/'native.cpp', root/'native.o'
                source.write_text(f'int native(){{return {value};}}\n')
                subprocess.run(['clang++', '-c', str(source), '-o', str(obj)], check=True)
                subprocess.run(['ar', 'rcs', str(libs[0]), str(obj)], check=True)
                seal()

            def build(link_flags=None):
                args = argparse.Namespace(fex_build=str(b), build_id='unchanged-source-id',
                                          host_flag=[], link_flag=link_flags or [], targets=['fexserve'])
                with contextlib.redirect_stdout(io.StringIO()):
                    iteration.build_tools(args)
                counts = json.loads((root/'.build/host-fex/local-build-summary.json').read_text())
                output = subprocess.check_output([str(root/'.build/host-fex/fexserve')], text=True).strip()
                return output.split(':'), counts

            with patch.object(iteration, 'ROOT', root):
                library(1)
                first, _ = build()
                unchanged, counts = build()
                self.assertEqual(first, unchanged)
                self.assertEqual(counts, {'compiled': 0, 'reusedObjects': 2, 'linked': 0, 'reusedTargets': 1})
                library(2)
                changed, counts = build()
                self.assertEqual(changed[1], '2')
                self.assertNotEqual(changed[0], first[0], 'Changed used library retained the Wasm-cache identity')
                self.assertEqual(counts['compiled'], 1, 'Translator must rebuild with the new identity')
                config.write_text('changed fixture CMake configuration'); seal()
                configured, _ = build()
                self.assertNotEqual(configured[0], changed[0])
                key['fixtureFrontendGeneration'] = 2; seal()
                regenerated, _ = build()
                self.assertNotEqual(regenerated[0], configured[0])
                relinked, counts = build(['-lm'])
                self.assertNotEqual(relinked[0], regenerated[0])
                self.assertEqual(counts['compiled'], 1)
                libs[0].write_bytes(b'corrupt archive')
                with self.assertRaisesRegex(ValueError, 'frontend'):
                    build()

    def test_object_and_dependency_corruption_prevent_reuse(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            obj, header, receipt = root/'object.o', root/'included header.h', root/'receipt.json'
            obj.write_bytes(b'compiled output'); header.write_text('original header')
            iteration.save(receipt, {'key': ['compiler', 'flags'], 'outputSHA256': iteration.sha(obj),
                                     'dependencies': {str(header): iteration.sha(header)}})
            self.assertTrue(iteration.matches(receipt, ['compiler', 'flags'], obj))
            self.assertFalse(iteration.matches(receipt, ['other compiler'], obj))
            obj.write_bytes(b'corrupted output')
            self.assertFalse(iteration.matches(receipt, ['compiler', 'flags'], obj))
            obj.write_bytes(b'compiled output'); header.write_text('changed header')
            self.assertFalse(iteration.matches(receipt, ['compiler', 'flags'], obj))

    def test_process_exit_and_timeout_are_failures_with_retained_output(self):
        with tempfile.TemporaryDirectory() as d:
            log = Path(d)/'process.log'
            result = iteration.run_stage([sys.executable, '-c', "print('program output');raise SystemExit(7)"], log, 5)
            self.assertEqual(result['exitCode'], 7)
            self.assertIn('program output', log.read_text())
            result = iteration.run_stage([sys.executable, '-c', 'import time; time.sleep(10)'], log, 0.1)
            self.assertEqual(result['exitCode'], 124)
            self.assertTrue(result['timedOut'])

    def test_timeout_kills_descendant_after_leader_exits_without_touching_other_group(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            ready, stopped = root/'descendant.json', root/'leader-stopped'
            program = '''import json,os,signal,sys,time
from pathlib import Path
ready,stopped=map(Path,sys.argv[1:])
def stop(signum,frame):
    stopped.write_text('TERM received')
    raise SystemExit(0)
signal.signal(signal.SIGTERM,stop)
if os.fork()==0:
    signal.signal(signal.SIGTERM,signal.SIG_IGN)
    ready.write_text(json.dumps({'pid':os.getpid(),'pgid':os.getpgrp(),'sid':os.getsid(0)}))
while True: time.sleep(1)
'''
            other = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(30)'],
                                     start_new_session=True)
            owned = None

            def running(record):
                try:
                    if os.getpgid(record['pid']) != record['pgid'] or os.getsid(record['pid']) != record['sid']:
                        return False
                except ProcessLookupError:
                    return False
                try:
                    state = subprocess.check_output(['ps', '-o', 'stat=', '-p', str(record['pid'])], text=True).strip()
                except subprocess.CalledProcessError as error:
                    if error.returncode == 1:
                        return False
                    raise
                return bool(state) and not state.startswith('Z')

            try:
                result = iteration.run_stage([sys.executable, '-c', program, str(ready), str(stopped)],
                                             root/'timeout.log', 1)
                self.assertEqual(result['exitCode'], 124)
                self.assertTrue(result['timedOut'])
                self.assertTrue(stopped.is_file(), 'Leader must exit promptly on TERM')
                owned = json.loads(ready.read_text())
                deadline = time.monotonic() + 2
                while running(owned) and time.monotonic() < deadline:
                    time.sleep(0.01)
                self.assertFalse(running(owned), 'Owned TERM-ignoring descendant survived timeout cleanup')
                self.assertIsNone(other.poll(), 'Unrelated process group was signaled')
            finally:
                if owned is None and ready.exists():
                    owned = json.loads(ready.read_text())
                if owned and running(owned):
                    os.kill(owned['pid'], signal.SIGKILL)
                other.terminate()
                other.wait(timeout=5)

    def test_failed_signalling_has_bounded_reap_and_reports_live_child(self):
        owned, watchdogs = [], []
        popen = subprocess.Popen

        def launch(*args, **kwargs):
            child = popen(*args, **kwargs)
            owned.append(child)
            # The fixture must also terminate safely against the old hanging code.
            watchdog = threading.Timer(10, child.kill)
            watchdog.daemon = True
            watchdog.start()
            watchdogs.append(watchdog)
            return child

        with tempfile.TemporaryDirectory() as d:
            try:
                with patch.object(iteration.subprocess, 'Popen', side_effect=launch), \
                     patch.object(iteration, 'signal_owned_group', side_effect=PermissionError(1, 'fixture EPERM')):
                    with self.assertRaisesRegex(RuntimeError, 'cleanup.*within 5s.*fixture EPERM'):
                        iteration.run_stage([sys.executable, '-c', 'import time; time.sleep(30)'],
                                            Path(d)/'failed-cleanup.log', 0.1)
                self.assertIsNone(owned[0].poll(), 'Fixture must verify the leader remained alive')
            finally:
                for watchdog in watchdogs:
                    watchdog.cancel()
                for child in owned:
                    if child.poll() is None:
                        child.kill()
                    child.wait(timeout=5)

    def test_darwin_timeout_accepts_only_verified_dead_group_on_eperm(self):
        # Fault injection from the observed Apple CI error, not macOS execution.
        with tempfile.TemporaryDirectory() as d:
            for platform, states, failure in (
                    ('darwin', '4321 Z\n9000 S\n', None),
                    ('darwin', '', None),
                    ('darwin', '4321 Z\n4321 S\n', PermissionError),
                    ('darwin', OSError('ps unavailable'), OSError),
                    ('darwin', subprocess.CalledProcessError(2, ['ps']), subprocess.CalledProcessError),
                    ('darwin', 'malformed ps output', ValueError),
                    ('linux', '', PermissionError)):
                with self.subTest(platform=platform, states=states):
                    child = Mock(pid=4321)
                    child.wait.side_effect = [subprocess.TimeoutExpired(['fixture'], 0.1), 0]
                    with patch.object(iteration.sys, 'platform', platform), \
                         patch.object(iteration.subprocess, 'Popen', return_value=child), \
                         patch.object(iteration.os, 'killpg', side_effect=[None, PermissionError(1, 'fixture EPERM')]), \
                         patch.object(iteration.time, 'sleep'), \
                         patch.object(iteration, 'capture', **({'side_effect': states} if isinstance(states, Exception) else {'return_value': states})) as ps:
                        if failure:
                            with self.assertRaises(failure):
                                iteration.run_stage(['fixture'], Path(d)/'timeout.log', 0.1)
                        else:
                            result = iteration.run_stage(['fixture'], Path(d)/'timeout.log', 0.1)
                            self.assertEqual(result['exitCode'], 124)
                            self.assertTrue(result['timedOut'])
                        self.assertEqual(child.wait.call_count, 2)
                        if platform != 'darwin':
                            ps.assert_not_called()

    def test_immutable_input_and_budget_baseline_required(self):
        current = {'input': {'elfSHA256': 'wine', 'interpreterSHA256': 'musl'},
                   'provenance': {'wineSourceCommit': 'pin'},
                   'executionBudget': {'maximumSteps': 20000, 'deadlineMs': 30000}}
        retained = {**current, 'result': {'executionBudget': current['executionBudget']}}
        del retained['executionBudget']
        iteration.check_inputs(current, retained)
        for key in current:
            wrong = copy.deepcopy(current); wrong[key] = {}
            with self.assertRaisesRegex(ValueError, 'mismatch'):
                iteration.check_inputs(wrong, retained)
        with self.assertRaises(ValueError):
            iteration.check_inputs(current, {})

    def test_passing_prefix_is_nonzero_and_retirement_stays_distinct(self):
        report = {'result': {'status': 'unsupported-instruction', 'stoppedRip': '0x1234',
                             'instruction': [0x66, 0x83, 0x78, 6, 0], 'guestExitCode': None,
                             'workerRetirementAcknowledged': False},
                  'resourceTelemetry': {'cleanup': {'nativeChildClosed': True}}}
        outcome = iteration.wine_outcome(report)
        self.assertEqual(outcome['classification'], 'unsupported-execution')
        self.assertEqual(outcome['exitCode'], 2)
        self.assertFalse(outcome['workerRetirementAcknowledged'])
        self.assertEqual(outcome['instruction'], report['result']['instruction'])
        self.assertEqual(iteration.wine_outcome({'stage': 'native-start'})['classification'], 'infrastructure-failure')
        self.assertEqual(iteration.wine_outcome({'result': {'status': 'exited', 'guestExitCode': 9,
                                                          'stdout': 'output'}})['exitCode'], 9)

    def test_missing_inputs_emit_results_without_running_a_build(self):
        with tempfile.TemporaryDirectory() as d:
            output = Path(d)/'run'
            args = argparse.Namespace(output=output, expected_source=None, regressions_only=False,
                                      input_identity=None)
            with patch.object(iteration, 'source_identity', return_value={'head': 'base', 'sourceSHA256': 'source'}), \
                 patch.object(iteration, 'run_stage', side_effect=AssertionError('must not execute')):
                self.assertNotEqual(iteration.iterate(args), 0)
            result = json.loads((output/'result.json').read_text())
            self.assertEqual(result['classification'], 'infrastructure-failure')
            self.assertEqual(result['stages'], [])
            self.assertIn('--input-identity', (output/'result.txt').read_text())


if __name__ == '__main__':
    unittest.main()
