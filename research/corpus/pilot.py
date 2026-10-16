#!/usr/bin/env python3
"""Explicit, bounded measurement pilot. Never auto-select or execute corpus ASM."""
import argparse
import collections
import hashlib
import json
import os
import platform
import re
import selectors
import shutil
import signal
import subprocess
import time
from pathlib import Path
from state_contract import ASSERTIONS, compare as compare_state
from oracle_ledger import OracleLedgerError, load_oracle

HERE = Path(__file__).resolve().parent
SPEC = json.loads((HERE / 'pilot.json').read_text())
GPRS = 'RAX RCX RDX RBX RSP RBP RSI RDI R8 R9 R10 R11 R12 R13 R14 R15'.split()


def sha(data):
    return hashlib.sha256(data).hexdigest()


def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + '\n')


def process(argv, seconds=5, limit=524288):
    """Bound wall time AND both output streams; own/reap the whole process group."""
    started = time.monotonic()
    child = subprocess.Popen(list(map(str, argv)), stdout=subprocess.PIPE,
                             stderr=subprocess.PIPE, start_new_session=True)
    selector = selectors.DefaultSelector()
    streams = {'stdout': bytearray(), 'stderr': bytearray()}
    for name in streams:
        selector.register(getattr(child, name), selectors.EVENT_READ, name)
    interrupted = None
    try:
        while selector.get_map():
            if time.monotonic() - started > seconds:
                interrupted = 'timeout'
                break
            for key, _ in selector.select(0.05):
                chunk = os.read(key.fileobj.fileno(), 16384)
                if not chunk:
                    selector.unregister(key.fileobj)
                    continue
                remaining = limit - sum(map(len, streams.values()))
                streams[key.data].extend(chunk[:max(0, remaining)])
                if len(chunk) > remaining:
                    interrupted = 'output-limit'
                    break
            if interrupted:
                break
        if interrupted:
            os.killpg(child.pid, signal.SIGKILL)
        child.wait(timeout=2)
    finally:
        # A translator descendant must never survive a completed fixture.
        try:
            os.killpg(child.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        child.wait()
        selector.close()
        child.stdout.close()
        child.stderr.close()
    return {'exitCode': child.returncode, 'interrupted': interrupted,
            **{k: bytes(v).decode(errors='replace') for k, v in streams.items()}}


def policy(root, fixture):
    directory = 'ASM' if fixture['mode'] == 64 else '32Bit_ASM'
    relative = fixture['path'].split('/' + directory + '/', 1)[1]
    result = {}
    for layer, kind, cpu, desc in [('oracle', 'host', 'x64', 'host'),
                                    ('single', 'jit', '', 'jit_1'),
                                    ('block500', 'jit', '', 'jit_500'),
                                    ('multi500', 'jit', '', 'jit_500_m')]:
        matches = []
        for category, suffixes in [('Known_Failures', ['', '_' + kind]),
                                   ('Disabled_Tests', ['', '_' + kind, '_' + cpu])]:
            for suffix in suffixes:
                path = root / 'unittests' / directory / (category + suffix)
                if not path.exists():
                    continue
                entries = path.read_text().splitlines()
                for candidate in ['Test_' + relative,
                                  f'{desc}/Test_{fixture["mode"]}Bit_{relative}']:
                    if candidate in entries:
                        matches.append({'category': category, 'path': str(path.relative_to(root)),
                                        'sha256': sha(path.read_bytes()), 'matched': candidate})
        result[layer] = matches
    # No upstream policy exists for this custom Wasm backend. Do not invent one.
    result['wasm'] = []
    return result


def gate(row, layer):
    if row['mode'] != 64:
        return 'guest-mode32 outside frozen mode64 profile'
    if row['metadata'].get('HostFeatures'):
        return 'required features excluded or unresolved in frozen AVX-off pilot: ' + ','.join(row['metadata']['HostFeatures'])
    if any(p['category'] == 'Disabled_Tests' for p in row['policy'][layer]):
        return 'disabled by preserved upstream policy'
    return None


def prepare(args):
    root, output = args.fex.resolve(), args.output.resolve()
    assert len(SPEC['fixtures']) <= SPEC['budgets']['maximumPilotFixtures']
    output.mkdir(parents=True, exist_ok=True)
    for source in SPEC['policySources']:
        assert sha((root / source['path']).read_bytes()) == source['sha256'], 'upstream policy source mismatch'
    rows = []
    for number, fixture in enumerate(SPEC['fixtures']):
        source = (root / fixture['path']).read_bytes()
        assert sha(source) == fixture['sourceSHA256'], fixture['path'] + ': pinned source mismatch'
        text = source.decode()
        metadata = json.loads(re.search(r'%ifdef CONFIG\s*(.*?)\s*%endif', text, re.S)[1])
        assert not (set(metadata) - {'RegData', 'Match', 'HostFeatures', 'Mode'}), 'unsupported fixture initialization'
        row = dict(fixture, id=f'{number:02d}', metadata=metadata, policy=policy(root, fixture))
        rows.append(row)
        if gate(row, 'oracle'):
            row['assemblyStatus'] = 'gated-before-assembly'
            continue
        # Original ASM is unchanged; only the load address and bitness are prefixed.
        wrapped = f'BITS 64\nORG {SPEC["layout"]["codeBase"]}\n'.encode() + source
        assembly = output / (row['id'] + '.asm')
        binary, listing = output / (row['id'] + '.bin'), output / (row['id'] + '.lst')
        assembly.write_bytes(wrapped)
        run = process([args.nasm, '-f', 'bin', '-l', listing, '-o', binary, assembly])
        if run['exitCode'] or run['interrupted']:
            row.update(assemblyStatus='failure', assemblyResult=run)
            continue
        data = binary.read_bytes()
        assert 0 < len(data) <= SPEC['budgets']['maximumInputBytes']
        # Require one explicit HLT source statement, not an accidental F4 data byte.
        halts = re.findall(r'^\s*\d+\s+([0-9A-Fa-f]{8})\s+F4\s+hlt\s*(?:;.*)?$', listing.read_text(), re.M | re.I)
        assert len(halts) == 1, fixture['path'] + ': ambiguous HLT listing'
        halt = int(halts[0], 16)
        assert data[halt] == 0xf4
        row.update(assemblyStatus='assembled', binary=row['id'] + '.bin', bytes=len(data),
                   binarySHA256=sha(data), wrappedSourceSHA256=sha(wrapped), haltOffset=halt)
    policy_sources = []
    for directory in ['ASM', '32Bit_ASM']:
        for path in sorted((root / 'unittests' / directory).iterdir()):
            if path.name.startswith(('Known_Failures', 'Disabled_Tests')):
                policy_sources.append({'path': str(path.relative_to(root)), 'sha256': sha(path.read_bytes()),
                                       'entries': path.read_text().splitlines()})
    manifest = {'schema': 1, 'selection': SPEC['selection'], 'source': SPEC['source'],
                'profile': SPEC['profile'], 'layout': SPEC['layout'], 'fixtures': rows,
                'nasmVersion': process([args.nasm, '-v'])['stdout'].strip(),
                'nasmBinarySHA256': sha(Path(shutil.which(args.nasm)).read_bytes()),
                'specSHA256': sha((HERE / 'pilot.json').read_bytes()),
                'policySources': policy_sources,
                'policyCPUClass': {'oracle': 'x64', 'native': 'unclassified: pinned ClassifyCPU.py emits no class for macOS arm64'},
                'assertionsSHA256': sha((HERE / 'assertions.json').read_bytes()),
                'comparisonContract': ASSERTIONS['contract'],
                'comparisonQualification': ASSERTIONS['qualification']}
    (output / 'assertions.json').write_bytes((HERE / 'assertions.json').read_bytes())
    write(output / 'manifest.json', manifest)
    print(json.dumps({'prepared': len(rows), 'assembled': sum(r['assemblyStatus'] == 'assembled' for r in rows)}))


def normalize(observed):
    # Architectural state only; no opaque CPU-frame pointers or private logs.
    for name in ['code', 'stack']:
        data = bytes.fromhex(observed.pop(name + 'Hex'))
        assert len(data) == 65536, name + ' map size mismatch'
        observed[name + 'SHA256'] = sha(data)
    assert set(observed['state']) == {'RIP', 'RFLAGS', 'GPR', 'XMM', 'MM', 'MXCSR', 'FCW', 'FSW', 'FTW'}
    assert len(observed['state']['GPR']) == 16 and len(observed['state']['XMM']) == 16 and len(observed['state']['MM']) == 8
    for vector in observed['state']['XMM'] + observed['state']['MM']:
        assert len(vector) == 2
    assert 0 <= observed['state']['FTW'] <= 255
    observed['architecturalStateSHA256'] = sha(json.dumps(observed['state'], sort_keys=True, separators=(',', ':')).encode())
    return observed


def projection(row, observed):
    state = observed['state']
    actual = {}
    for register, expected in row['metadata'].get('RegData', {}).items():
        if register in GPRS:
            value = state['GPR'][GPRS.index(register)]
        elif re.fullmatch(r'(XMM|MM)\d+', register):
            prefix = re.match(r'\D+', register)[0]
            value = state[prefix][int(register[len(prefix):])]
        else:
            raise ValueError('unreviewed comparison register: ' + register)
        if isinstance(expected, list):
            actual[register] = [int(v, 0) for v in value[:len(expected)]]
        else:
            actual[register] = int(value, 0)
    expected = {k: [int(v, 0) for v in x] if isinstance(x, list) else int(x, 0)
                for k, x in row['metadata'].get('RegData', {}).items()}
    return {'expectedRegData': expected, 'observedRegData': actual, 'matches': expected == actual}


def validate_flag_observation(observed, layer):
    if layer == 'wasm':
        assert observed.get('lazyFlags', {}).get('representation') == 'backend-materialize-v1', 'missing raw lazy descriptor; old flags cannot be corrected post hoc'


def run(args):
    manifest = json.loads((args.inputs / 'manifest.json').read_text())
    assert manifest['specSHA256'] == sha((HERE / 'pilot.json').read_bytes()), 'pilot changed since oracle assembly'
    assert manifest['assertionsSHA256'] == sha((HERE / 'assertions.json').read_bytes()), 'assertion contract changed since preparation'
    assert sha((args.inputs / 'assertions.json').read_bytes()) == manifest['assertionsSHA256'], 'transferred assertions differ'
    assert manifest['source'] == SPEC['source'] and manifest['layout'] == SPEC['layout']
    assert [r['path'] for r in manifest['fixtures']] == [f['path'] for f in SPEC['fixtures']], 'pilot selection changed'
    for number, (row, frozen) in enumerate(zip(manifest['fixtures'], SPEC['fixtures'])):
        assert all(row[k] == v for k, v in frozen.items()), 'frozen fixture metadata changed'
        assert row['id'] == f'{number:02d}'
        if row['assemblyStatus'] == 'assembled':
            assert row['binary'] == row['id'] + '.bin'
            wrapped = (args.inputs / (row['id'] + '.asm')).read_bytes()
            prefix = f'BITS 64\nORG {SPEC["layout"]["codeBase"]}\n'.encode()
            assert wrapped.startswith(prefix) and sha(wrapped[len(prefix):]) == frozen['sourceSHA256']
            metadata = json.loads(re.search(rb'%ifdef CONFIG\s*(.*?)\s*%endif', wrapped, re.S)[1])
            assert metadata == row['metadata'], 'source expectation changed'
    layer = args.layer
    if layer == 'oracle':
        if args.oracle is not None:
            raise OracleLedgerError('oracle creation does not accept a reference ledger')
        oracle = {}
    else:
        skips = {row['path']: reason for row in manifest['fixtures'] if (reason := gate(row, 'oracle'))}
        oracle = load_oracle(args.oracle, manifest, skips=skips, project=projection,
                             maximum_bytes=SPEC['budgets']['maximumResultArtifactBytes'])
    if layer == 'wasm':
        root = HERE.parent.parent
        expected = SPEC['wasmTranslatorSource']
        assert sha((root / 'patches/fex-wasm.patch').read_bytes()) == expected['adapterPatchSHA256']
        pin = re.search(r'^PIN=([0-9a-f]{40})$', (root / 'scripts/prepare-fex.sh').read_text(), re.M)[1]
        assert pin == expected['FEXPin'], 'production translator pin changed outside the frozen measurement profile'
    results = []
    for row in manifest['fixtures']:
        record = {'schema': 2, 'comparisonContract': ASSERTIONS['contract'],
                  'fixture': row['path'], 'family': row['family'], 'layer': layer,
                  'sourceSHA256': row['sourceSHA256'], 'binarySHA256': row.get('binarySHA256'),
                  'requiredHostFeatures': row['metadata'].get('HostFeatures', []), 'policy': row['policy'][layer],
                  'upstreamKnownFailure': any(p['category'] == 'Known_Failures' for p in row['policy'][layer]),
                  'originalMetadata': row['metadata'], 'status': 'untested', 'rawExitCode': None,
                  'semanticPass': None}
        results.append(record)
        reason = gate(row, layer)
        if reason:
            record.update(status='skip', reason=reason)
            continue
        if row['assemblyStatus'] != 'assembled':
            record.update(status='failure', reason='assembly failed; no executable input')
            continue
        binary = args.inputs / row['binary']
        assert sha(binary.read_bytes()) == row['binarySHA256'], 'input hash mismatch'
        if layer == 'oracle' and (platform.system(), platform.machine()) != ('Linux', 'x86_64'):
            record.update(status='skip', reason='independent oracle requires Linux x86-64')
            continue
        if layer not in ['oracle', 'wasm'] and (platform.system(), platform.machine()) != ('Darwin', 'arm64'):
            record.update(status='skip', reason='native pinned FEX requires macOS ARM64')
            continue
        if layer == 'oracle':
            argv = [args.executable, binary, row['haltOffset'], row.get('codeDataWritableOffset', 0)]
        elif layer == 'wasm':
            argv = [args.node, HERE / 'wasm.cjs', args.executable, binary, str(row['haltOffset'])]
        else:
            block = next(x for x in SPEC['profile']['nativeBlockProfiles'] if x['name'] == layer)
            argv = [args.executable, binary, row['haltOffset'], block['maxInstructions'], int(block['multiblock'])]
        receipt = process(argv, SPEC['budgets']['fixtureSeconds'], SPEC['budgets']['maximumCapturedOutputBytes'])
        record.update(rawExitCode=receipt['exitCode'], interrupted=receipt['interrupted'],
                      stderr=receipt['stderr'][:12000], stderrSHA256=sha(receipt['stderr'].encode()),
                      capturedStderrBytes=len(receipt['stderr'].encode()))
        try:
            observed = json.loads(receipt['stdout'])
            if receipt['exitCode'] == 77 and observed.get('status') == 'skip':
                record.update(status='skip', reason=observed['reason'])
                continue
            if receipt['exitCode'] or receipt['interrupted']:
                if 'state' in observed:
                    record['observed'] = normalize(observed)
                    observed = {k: v for k, v in observed.items() if k != 'state'}
                record.update(status='refused' if observed.get('status') == 'refused' else 'failure',
                              diagnostic=observed, reason=receipt['interrupted'] or 'raw execution failed')
                continue
            observed = normalize(observed)
            validate_flag_observation(observed, layer)
            comparison = projection(row, observed)
            state_comparison = compare_state(row, observed)
            halt = int(SPEC['layout']['codeBase'], 0) + row['haltOffset']
            comparison['haltMatches'] = observed['termination'] == 'hlt' and int(observed['state']['RIP'], 0) == halt
            if layer != 'oracle':
                reference = oracle.get(row['path'], {})
                reference_state = reference.get('observed', {})
                comparison['oracleStatus'] = reference.get('status', 'missing')
                comparison['memoryMatches'] = all(observed[k] == reference_state.get(k) for k in ['codeSHA256', 'stackSHA256'])
                comparison['oracleProjectionMatches'] = comparison['observedRegData'] == reference.get('comparison', {}).get('observedRegData')
                comparison['oracleMatchedBytes'] = reference.get('binarySHA256') == row['binarySHA256']
                if 'state' in reference_state:
                    state_comparison = compare_state(row, observed, reference_state)
                    comparison['oracleFinalStateContract'] = compare_state(row, reference_state)['matches']
                else:
                    comparison['oracleFinalStateContract'] = False
            comparison['meaningfulFinalState'] = state_comparison
            passed = comparison['matches'] and comparison['haltMatches'] and state_comparison['matches']
            if layer != 'oracle':
                passed &= comparison['oracleStatus'] in ['pass', 'xpass'] and all(comparison[k] for k in ['memoryMatches', 'oracleProjectionMatches', 'oracleMatchedBytes', 'oracleFinalStateContract'])
            known = record['upstreamKnownFailure']
            status = ('xpass' if passed else 'xfail') if known else ('pass' if passed else 'failure')
            record.update(status=status, semanticPass=bool(passed), observed=observed, comparison=comparison)
        except (ValueError, KeyError, AssertionError, TypeError) as error:
            record.update(status='failure', reason='invalid measurement protocol: ' + str(error),
                          stdout=receipt['stdout'][:12000])
    args.output.parent.mkdir(parents=True, exist_ok=True)
    data = ''.join(json.dumps(r, separators=(',', ':'), sort_keys=True) + '\n' for r in results)
    assert len(data.encode()) <= SPEC['budgets']['maximumResultArtifactBytes']
    args.output.write_text(data)
    translator = ({'kind': 'native x86 hardware oracle', 'FEXPin': None} if layer == 'oracle' else
                  dict(SPEC['wasmTranslatorSource']) if layer == 'wasm' else
                  {'kind': 'unmodified pinned native FEX core', 'FEXPin': SPEC['source']['commit']})
    summary = {'layer': layer, 'fixtureSource': SPEC['source'], 'translatorSource': translator, 'profile': SPEC['profile'],
               'comparisonContract': ASSERTIONS['contract'], 'comparisonQualification': ASSERTIONS['qualification'],
               'measurementRecipe': {p.name: sha(p.read_bytes()) for p in
                                     [HERE / 'pilot.py', HERE / 'oracle_ledger.py', HERE / 'wasm.cjs', HERE / 'flags.cjs', HERE / 'assertions.json', HERE / 'state_contract.py', HERE / 'native-x86.c',
                                      HERE / 'native-x86.S', HERE / 'native-arm64.cpp', HERE / 'state.h']},
               'executableSHA256': sha(args.executable.read_bytes()),
               'counts': dict(collections.Counter(r['status'] for r in results)),
               'ledgerSHA256': sha(data.encode()), 'ledgerBytes': len(data.encode()),
               'coveragePercentage': None, 'scope': 'Frozen measurement pilot; legal-form denominator and device-effective profile unresolved.'}
    write(args.output.with_suffix('.summary.json'), summary)
    print(json.dumps(summary['counts']))
    return int(any(r['status'] in ['failure', 'refused', 'xpass'] for r in results))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    prep = sub.add_parser('prepare')
    prep.add_argument('--fex', type=Path, required=True)
    prep.add_argument('--nasm', required=True)
    prep.add_argument('--output', type=Path, required=True)
    execute = sub.add_parser('run')
    execute.add_argument('--inputs', type=Path, required=True)
    execute.add_argument('--layer', choices=['oracle', 'wasm', 'single', 'block500', 'multi500'], required=True)
    execute.add_argument('--executable', type=Path, required=True)
    execute.add_argument('--oracle', type=Path)
    execute.add_argument('--node', default='node')
    execute.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    try:
        return prepare(args) if args.command == 'prepare' else run(args)
    except OracleLedgerError as error:
        parser.error(str(error))


if __name__ == '__main__':
    raise SystemExit(main())
