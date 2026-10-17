#!/usr/bin/env python3
"""One bounded local sparse iteration; cache compilation, never test results."""
import argparse
import errno
import hashlib
import json
import os
from pathlib import Path
import platform
import shlex
import shutil
import signal
import subprocess
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parents[1]
TARGETS = {
    'fexserve': 'fexwasm/tools/fexserve.cpp',
    **{'sparse-' + name + '-ir': 'fexwasm/src/testing/' + name + '-ir.cpp'
       for name in ('memory-add', 'scalar-shift', 'register-jump', 'register-stack',
                    'register-memory-add', 'memory-or', 'test-immediate',
                    'logical-immediate', 'word-compare', 'setcc', 'register-div', 'scalar-condition')},
}
FAMILIES = {
    'word-compare': ('word-compare', 'word-compare'),
    'conditions': ('conditions', 'scalar-condition'),
    'call': ('call', 'scalar-condition'),
    'logical-immediate': ('logical-immediate', 'logical-immediate'),
    'memory-or': ('memory-or', 'memory-or'),
    'memory-add': ('memory-add', 'memory-add'),
    'read-arithmetic': ('read-arithmetic-program', 'register-memory-add'),
    'stack': ('stack', 'register-stack'),
    'jump': ('jump', 'register-jump'),
    'shift': ('shift', 'scalar-shift'),
    'test-immediate': ('test-immediate', 'test-immediate'),
    'setcc': ('setcc', 'setcc'),
    'div': ('div', 'register-div'),
}


def sha(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()


def save(path, value):
    path = Path(path)
    temp = path.with_name(path.name + '.tmp')
    temp.write_text(json.dumps(value, indent=2, sort_keys=True) + '\n')
    temp.replace(path)


def capture(args):
    return subprocess.check_output(args, cwd=ROOT, text=True).strip()


def verify_fex():
    fex = ROOT/'FEX'
    pin = next(line[4:] for line in (ROOT/'scripts/prepare-fex.sh').read_text().splitlines() if line.startswith('PIN='))
    if capture(['git', '-C', str(fex), 'rev-parse', 'HEAD']) != pin:
        raise ValueError('Unexpected FEX revision')
    # Compare the entire tracked tree with the official pin plus this repo's
    # exact frontend patch, using a private index and leaving FEX's index alone.
    with tempfile.TemporaryDirectory(dir=ROOT/'.build') as directory:
        env = {**os.environ, 'GIT_INDEX_FILE': str(Path(directory)/'index')}
        def git(*args):
            return subprocess.check_output(['git', '-C', str(fex), *args], env=env, text=True).strip()
        git('read-tree', 'HEAD')
        git('apply', '--cached', str(ROOT/'patches/fex-wasm.patch'))
        expected = git('write-tree')
        git('add', '--update')
        if git('write-tree') != expected:
            raise ValueError('FEX source differs from the pinned frontend and exact repository patch')
    modules = capture(['git', '-C', str(fex), 'submodule', 'status', '--recursive'])
    if any(line.startswith(('-', '+', 'U')) for line in modules.splitlines()):
        raise ValueError('FEX submodule revision mismatch')
    subprocess.run(['git', '-C', str(fex), 'submodule', 'foreach', '--quiet', '--recursive',
                    'test -z "$(git status --porcelain)"'], check=True)
    return {'pin': pin, 'patchedTree': expected, 'submodules': modules}


def frontend(args):
    (ROOT/'.build').mkdir(exist_ok=True)
    b = Path(args.fex_build)
    receipt, current = b/'.betterjit-frontend.json', ROOT/'.build/frontend-current.json'
    if args.command == 'prepare-frontend':
        key = {'source': verify_fex(), 'platform': [platform.system(), platform.machine()],
               'recipes': {n: sha(ROOT/n) for n in
                           ('scripts/iterate-sparse.py', 'Backends/FEX/build-host.sh', 'scripts/prepare-fex.sh')},
               'tools': {n: {'path': shutil.which(n), 'version': capture([n, '--version']),
                             'sha256': sha(shutil.which(n))} for n in ('clang', 'clang++', 'cmake', 'ninja')},
               'environment': {k: os.environ.get(k) for k in
                               ('CPATH', 'CPLUS_INCLUDE_PATH', 'LIBRARY_PATH', 'SDKROOT', 'LD_LIBRARY_PATH')}}
        save(current, key)
        if not matches(receipt, key, b/'CMakeCache.txt') and (b/'CMakeCache.txt').exists():
            print('Rebuild unverified or incompatible frontend artifacts', flush=True)
            subprocess.run(['cmake', '--build', str(b), '--target', 'clean'], check=True)
    else:
        deps = list(b.rglob('*.a'))
        for folder in ('include', 'generated'):
            deps += [p for p in (b/folder).rglob('*') if p.is_file()]
        if not deps:
            raise ValueError('Frontend build produced no artifacts')
        save(receipt, {'key': json.loads(current.read_text()), 'outputSHA256': sha(b/'CMakeCache.txt'),
                       'dependencies': {str(p.resolve()): sha(p) for p in deps}})


def matches(receipt, key, output):
    try:
        old = json.loads(receipt.read_text())
        return (old['key'] == key and old['outputSHA256'] == sha(output)
                and all(sha(p) == h for p, h in old['dependencies'].items()))
    except (OSError, ValueError, KeyError):
        return False


def frontend_generation(build, libraries):
    receipt = build/'.betterjit-frontend.json'
    record = json.loads(receipt.read_text())
    key = json.loads((ROOT/'.build/frontend-current.json').read_text())
    config = build/'CMakeCache.txt'
    if not matches(receipt, key, config):
        raise ValueError('Unverified frontend receipt, configuration or outputs')
    linked = {}
    for library in libraries:
        value = sha(library)
        if record['dependencies'].get(str(library.resolve())) != value:
            raise ValueError('Unverified linked frontend archive: ' + str(library))
        linked[str(library.relative_to(build))] = value
    return {'key': key, 'receiptSHA256': sha(receipt), 'cmakeCacheSHA256': sha(config),
            'linkedLibrarySHA256': linked}


def build_tools(args):
    """Called by the existing host recipe after pinned FEX/Ninja preparation."""
    b, fex = Path(args.fex_build).resolve(), ROOT / 'FEX'
    out = ROOT / '.build/host-fex'
    cache = out / 'objects'
    cache.mkdir(parents=True, exist_ok=True)
    # Preserve argv[0]'s C++ driver name even when clang++ is a clang symlink.
    cxx = Path(shutil.which('clang++')).absolute()
    tool = {'path': str(cxx), 'sha256': sha(cxx),
            'version': capture([str(cxx), '--version']),
            'environment': {k: os.environ.get(k) for k in
                            ('CPATH', 'CPLUS_INCLUDE_PATH', 'LIBRARY_PATH', 'SDKROOT', 'LD_LIBRARY_PATH')}}
    include = [b/'FEXCore/Source', fex/'FEXCore/Source', fex/'FEXCore/Source/IncludePrivate',
               fex/'FEXCore/include', b/'include', b/'generated', fex/'External/fmt/include',
               fex/'External/xxhash', fex/'FEXHeaderUtils', fex/'CodeEmitter',
               fex/'External/unordered_dense/include', fex/'External/cephes/include',
               fex/'External/SoftFloat-3e/include', ROOT/'fexwasm/src']
    flags = ['-std=gnu++20', '-O2', '-gline-tables-only', '-fno-exceptions',
             '-fno-strict-aliasing', '-fwrapv', '-Wno-unused-function', *args.host_flag,
             '-DJIT_ARM64', '-D_LARGEFILE64_SOURCE', *['-I' + str(p) for p in include]]
    libs = [b / p for p in ('FEXCore/Source/libFEXCore.a', 'FEXCore/Source/libFEXCore_Base.a',
            'FEXCore/Source/libJemallocLibs.a', 'External/fmt/libfmt.a',
            'External/xxhash/cmake_unofficial/libxxhash.a', 'External/cephes/libcephes_128bit.a',
            'External/SoftFloat-3e/libsoftfloat_3e.a')]
    # Bind the advertised Wasm-cache identity before any translator-object
    # reuse, including verified frontend configuration and actual link inputs.
    args.build_id = hashlib.sha256(json.dumps({
        'sourceBuildID': args.build_id, 'flags': flags, 'linkFlags': args.link_flag, 'tool': tool,
        'builderSHA256': sha(__file__), 'hostRecipeSHA256': sha(ROOT/'Backends/FEX/build-host.sh'),
        'frontendGeneration': frontend_generation(b, libs),
    }, sort_keys=True).encode()).hexdigest()[:16]
    counts = {'compiled': 0, 'reusedObjects': 0, 'linked': 0, 'reusedTargets': 0}

    def object_for(source):
        source = Path(source).resolve()
        obj = cache / (source.stem + '-' + hashlib.sha256(str(source).encode()).hexdigest()[:12] + '.o')
        receipt, dep = obj.with_suffix('.json'), obj.with_suffix('.d')
        command = [str(cxx), *flags]
        # Only this translation unit consumes the embedded source build ID.
        if source == ROOT/'fexwasm/src/translator.cpp':
            command += ['-DFEXWASM_BUILD_ID="' + args.build_id + '"']
        command += ['-c', str(source), '-o', str(obj), '-MD', '-MF', str(dep)]
        key = {'command': command, 'tool': tool, 'recipeSHA256': sha(__file__)}
        if matches(receipt, key, obj):
            counts['reusedObjects'] += 1
            return obj
        print('Compile ' + str(source.relative_to(ROOT)), flush=True)
        receipt.unlink(missing_ok=True)
        subprocess.run(command, cwd=ROOT, check=True)
        # Clang escapes spaces in Make dependencies; shlex preserves them.
        paths = shlex.split(dep.read_text().replace('\\\n', '').split(':', 1)[1])
        deps = {str(Path(p).resolve()): sha(p) for p in paths}
        save(receipt, {'key': key, 'dependencies': deps, 'outputSHA256': sha(obj)})
        counts['compiled'] += 1
        return obj

    common = [object_for(p) for p in sorted((ROOT/'fexwasm/src').glob('*.cpp'))]
    for target in args.targets or TARGETS:
        objects = [object_for(ROOT/TARGETS[target]), *common]
        binary, receipt = out/target, out/(target + '.local-build.json')
        command = [str(cxx), *map(str, objects), *map(str, libs), *args.link_flag, '-o', str(binary)]
        key = {'command': command, 'tool': tool, 'buildID': args.build_id, 'recipeSHA256': sha(__file__)}
        dependencies = {str(p): sha(p) for p in objects + libs}
        if matches(receipt, key, binary) and json.loads(receipt.read_text())['dependencies'] == dependencies:
            counts['reusedTargets'] += 1
            continue
        print('Link ' + target, flush=True)
        receipt.unlink(missing_ok=True)
        subprocess.run(command, cwd=ROOT, check=True)
        save(receipt, {'key': key, 'dependencies': dependencies, 'outputSHA256': sha(binary)})
        counts['linked'] += 1
    save(out/'local-build-summary.json', counts)
    print(json.dumps(counts), flush=True)


def source_identity():
    names = set()
    for flags in (['--cached'], ['--others', '--exclude-standard']):
        names.update(subprocess.check_output(['git', 'ls-files', '-z', *flags], cwd=ROOT).decode().split('\0'))
    files = {}
    for name in sorted(names - {''}):
        path = ROOT/name
        if path.is_symlink():
            files[name] = {'link': os.readlink(path)}
        elif path.is_file():
            files[name] = {'sha256': sha(path), 'mode': path.stat().st_mode & 0o777}
        else:
            files[name] = {'absent': True}
    digest = hashlib.sha256(json.dumps(files, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
    return {'head': capture(['git', 'rev-parse', 'HEAD']), 'sourceSHA256': digest, 'files': files}


def wine_identity(root):
    # Reuse the probe's executable/symlink checks and identity convention.
    script = "const B=require('./tests/sdk/linux-host/sparse-linux-bootstrap.cjs'),P=require('./tests/sdk/linux-host/sparse-linux-probe-report.cjs');const i=B.inputs(process.argv[1]);console.log(JSON.stringify({input:P.inputIdentity(i),provenance:i.provenance,executionBudget:P.executionBudget(undefined,'host-wine-probe-v1')}));"
    return json.loads(capture(['node', '-e', script, str(root.resolve())]))


def check_inputs(current, expected):
    # A prior published probe report can be used directly. Never create a new
    # baseline implicitly when a root or an expected hash is unavailable.
    expected = dict(expected)
    if 'executionBudget' not in expected:
        expected['executionBudget'] = (expected.get('result') or {}).get('executionBudget')
    for key in ('input', 'provenance', 'executionBudget'):
        if key not in expected or current[key] != expected[key]:
            raise ValueError('Immutable Wine ' + key + ' mismatch or missing baseline')


def signal_owned_group(pgid, signum):
    # Caller retains the unreaped leader of its start_new_session group.
    try:
        os.killpg(pgid, signum)
    except PermissionError as error:
        if sys.platform != 'darwin' or error.errno != errno.EPERM:
            raise
        # Darwin can report EPERM for a group containing only zombies.
        # Verify there are no live members; other permission failures propagate.
        for line in capture(['ps', '-axo', 'pgid=,stat=']).splitlines():
            group, state = line.split()
            if int(group) == pgid and not state.startswith('Z'):
                raise


def run_stage(command, log, timeout):
    started = time.monotonic()
    with Path(log).open('w') as handle:
        child = subprocess.Popen(command, cwd=ROOT, stdout=handle, stderr=subprocess.STDOUT,
                                 start_new_session=True)
        timed_out = False
        try:
            code = child.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            timed_out = True
            cleanup_error = None
            try:
                signal_owned_group(child.pid, signal.SIGTERM)
                # Keep the leader unreaped through the grace period. Its PID
                # reserves this owned PGID even if it exits before descendants.
                time.sleep(5)
                signal_owned_group(child.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass  # The owned group has already disappeared.
            except BaseException as error:
                cleanup_error = error
                raise
            finally:
                try:
                    child.wait(timeout=5)
                except subprocess.TimeoutExpired as error:
                    detail = '; signalling failed: ' + str(cleanup_error) if cleanup_error is not None else ''
                    raise RuntimeError('Timed-out stage cleanup did not reap owned leader within 5s' + detail) from error
            code = 124
    return {'command': command, 'exitCode': code, 'timedOut': timed_out,
            'seconds': round(time.monotonic() - started, 3), 'log': str(log)}


def wine_outcome(report):
    result = report.get('result') or {}
    if result.get('status') in ('exit', 'exited') and type(result.get('guestExitCode')) is int:
        code = result['guestExitCode']
        return {'classification': 'command-completed', 'exitCode': code,
                'stdout': result.get('stdout'), 'stderr': result.get('stderr')}
    if result.get('status') == 'unsupported-instruction':
        return {'classification': 'unsupported-execution', 'exitCode': 2,
                'rip': result.get('stoppedRip'), 'instruction': result.get('instruction'),
                'executedWasmSteps': result.get('executedWasmSteps'), 'guestExitCode': None,
                'workerRetirementAcknowledged': result.get('workerRetirementAcknowledged')}
    infrastructure = report.get('stage') in ('inputs', 'native-start', 'native-configuration', 'native-validation')
    return {'classification': 'infrastructure-failure' if infrastructure else 'execution-failed', 'exitCode': 1,
            'status': result.get('status'), 'stage': report.get('stage'), 'error': report.get('error')}


def iterate(args):
    output = args.output.resolve() if args.output else ROOT/'.build/iterations'/str(time.time_ns())
    output.mkdir(parents=True, exist_ok=False)
    result = {'schema': 1, 'classification': 'infrastructure-failure', 'exitCode': 1, 'stages': []}
    source = None
    code = 1
    try:
        source = source_identity()
        save(output/'source-identity.json', source)
        result['source'] = {k: source[k] for k in ('head', 'sourceSHA256')}
        if args.expected_source and args.expected_source != source['sourceSHA256']:
            raise ValueError('Source identity mismatch')
        if not args.regressions_only:
            if args.input_identity is None:
                raise ValueError('--input-identity must name a retained probe report or input identity')
            current = wine_identity(args.wine_root)
            check_inputs(current, json.loads(args.input_identity.read_text()))
            result['wineInputs'] = current
        families = args.family or ['word-compare']
        targets = list(dict.fromkeys(['fexserve', *['sparse-' + FAMILIES[f][1] + '-ir' for f in families]]))
        stage = run_stage(['bash', 'Backends/FEX/build-host.sh', *targets], output/'build.log', 1800)
        result['stages'].append(stage)
        if stage['exitCode']:
            code = stage['exitCode'] if stage['exitCode'] > 0 else 1
            raise RuntimeError('Native build failed; see build.log')
        summary = ROOT/'.build/host-fex/local-build-summary.json'
        result['build'] = json.loads(summary.read_text())
        tests = [['node', '--test', *map(str, sorted((ROOT/'tests/sdk').glob('*.test.mjs')))]]
        for family in families:
            test, ir = FAMILIES[family]
            tests += [[str(ROOT/'.build/host-fex'/('sparse-' + ir + '-ir'))],
                      ['node', 'tests/sdk/linux-host/sparse-' + test + '.cjs',
                       str(ROOT/'.build/host-fex/fexserve'), str(output/(family + '.json'))]]
        if 'word-compare' in families and 'read-arithmetic' not in families:
            tests.append(['node', 'tests/sdk/linux-host/sparse-read-arithmetic-program.cjs',
                          str(ROOT/'.build/host-fex/fexserve'), str(output/'read-arithmetic-program.json')])
        failure = 0
        for index, command in enumerate(tests):
            stage = run_stage(command, output/f'test-{index}.log', 300)
            result['stages'].append(stage)
            if stage['exitCode'] and not failure:
                failure = stage['exitCode'] if stage['exitCode'] > 0 else 1
        result['classification'], code = ('regression-failed', failure) if failure else ('regressions-passed', 0)
        if not args.regressions_only:
            report_path = output/'wine.json'
            stage = run_stage(['node', 'tests/sdk/linux-host/sparse-linux-bootstrap.cjs',
                               str(ROOT/'.build/host-fex/fexserve'), str(report_path),
                               str(args.wine_root.resolve()), '--host-wine-probe-v1'], output/'wine.log', 45)
            result['stages'].append(stage)
            if not report_path.is_file():
                result['classification'], code = 'infrastructure-failure', stage['exitCode'] or 1
            else:
                result['wine'] = wine_outcome(json.loads(report_path.read_text()))
                if not failure:
                    result['classification'] = result['wine']['classification']
                    code = stage['exitCode'] or result['wine']['exitCode']
            check_inputs(wine_identity(args.wine_root), result['wineInputs'])
        else:
            result['wine'] = {'classification': 'not-requested', 'commandCompletionEstablished': False}
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
        result['error'] = str(error)
        code = code or 1
        result['classification'] = 'infrastructure-failure'
    finally:
        if source is not None:
            try:
                if source_identity() != source:
                    result['classification'], code = 'source-changed-during-run', 1
            except subprocess.SubprocessError:
                result['classification'], code = 'source-changed-during-run', 1
        result['exitCode'] = code
        save(output/'result.json', result)
        text = f"{result['classification']}; exit {code}; source {(source or {}).get('sourceSHA256', 'unavailable')}\n"
        text += f"Logs and machine result: {output}\n"
        if result.get('wine'):
            text += 'Wine: ' + json.dumps(result['wine'], sort_keys=True) + '\n'
        if result.get('error'):
            text += result['error'] + '\n'
        (output/'result.txt').write_text(text)
        print(text, end='')
    return code


def main():
    p = argparse.ArgumentParser(description=__doc__)
    sub = p.add_subparsers(dest='command', required=True)
    b = sub.add_parser('build-tools', help=argparse.SUPPRESS)
    b.add_argument('--fex-build', required=True)
    b.add_argument('--build-id', required=True)
    b.add_argument('--host-flag', action='append', default=[])
    b.add_argument('--link-flag', action='append', default=[])
    b.add_argument('targets', nargs='*')
    for name in ('prepare-frontend', 'seal-frontend'):
        f = sub.add_parser(name, help=argparse.SUPPRESS)
        f.add_argument('--fex-build', required=True)
    r = sub.add_parser('run', help='Build selected families and run the unchanged bounded Wine probe')
    r.add_argument('--family', choices=list(FAMILIES), action='append')
    r.add_argument('--wine-root', type=Path, default=ROOT/'.build/device-linuxroot')
    r.add_argument('--input-identity', type=Path, help='Retained Wine probe report with input/provenance/budget')
    r.add_argument('--expected-source', help='Optional exact source SHA256 from a prior source identity')
    r.add_argument('--output', type=Path, help='Fresh output directory')
    r.add_argument('--regressions-only', action='store_true', help='Explicitly omit Wine when inputs are unavailable')
    args = p.parse_args()
    if args.command in ('prepare-frontend', 'seal-frontend'):
        frontend(args)
        return 0
    if args.command == 'build-tools':
        if any(t not in TARGETS for t in args.targets):
            p.error('Unknown host build target')
        build_tools(args)
        return 0
    return iterate(args)


if __name__ == '__main__':
    sys.exit(main())
