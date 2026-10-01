"""Fault-injection test: a failed compiler must not publish stale iOS archives."""
import os
import pathlib
import shutil
import subprocess
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]

class BuildFailures(unittest.TestCase):
    def run_build(self, fail):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            project = root / 'fexwasm'
            (project / 'src').mkdir(parents=True)
            (project / 'out/ios').mkdir(parents=True)
            shutil.copy(ROOT / 'fexwasm/build_ios.sh', project / 'build_ios.sh')
            (project / 'build_id.sh').write_text('echo fixture-id\n')
            (project / 'src/fixture.h').write_text('// header fixture\n')
            for name in ('ok', 'bad'):
                (project / f'src/{name}.cpp').write_text('// fixture\n')
                (project / f'out/ios/{name}.o').write_text('stale object')
            (project / 'out/ios/libfexwasm.a').write_text('stale archive')
            (project / 'out/ios/libs.txt').write_text('stale link manifest')
            fex = root / 'FEX'
            (fex / 'build-ios/FEXCore/Source').mkdir(parents=True)
            (fex / 'build-ios/FEXCore/Source/libFEXCore.a').touch()
            tools = root / 'bin'
            tools.mkdir()
            scripts = {
                'ninja': '#!/bin/bash\nexit 0\n',
                'cmake': '#!/bin/bash\nexit 0\n',
                'clang++': '''#!/bin/bash
out=''
while (( $# )); do
  if [[ $1 == -o ]]; then out=$2; shift 2; else source=$1; shift; fi
done
if [[ ${FAIL_COMPILER:-0} == 1 && $source == src/bad.cpp ]]; then exit 17; fi
printf 'fresh object' > "$out"
''',
                'xcrun': '''#!/bin/bash
if [[ $1 == --sdk ]]; then echo /fixture-sdk; exit 0; fi
if [[ $1 == ar ]]; then
  echo invoked >> "$AR_LOG"
  shift 2
  out=$1; shift
  for object in "$@"; do [[ -f $object ]] || exit 1; done
  printf 'fresh archive' > "$out"
fi
''',
            }
            for name, script in scripts.items():
                p = tools / name
                p.write_text(script)
                p.chmod(0o755)
            env = dict(os.environ, PATH=f'{tools}:{os.environ["PATH"]}',
                       FAIL_COMPILER=str(int(fail)), FEX_DIR=str(fex), AR_LOG=str(root / 'ar.log'))
            result = subprocess.run(['bash', str(project / 'build_ios.sh')], env=env,
                                    capture_output=True, text=True, timeout=10)
            return result, (root / 'ar.log').exists(), (project / 'out/ios/libfexwasm.a').exists()

    def test_failed_child_stops_archive_publication(self):
        result, archived, exists = self.run_build(True)
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertFalse(archived)
        self.assertFalse(exists)

    def test_all_children_succeed_before_archive_publication(self):
        result, archived, exists = self.run_build(False)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertTrue(archived)
        self.assertTrue(exists)

if __name__ == '__main__':
    unittest.main()
