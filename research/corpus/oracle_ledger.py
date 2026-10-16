"""Validate reference-ledger consistency; this is not execution attestation."""
import hashlib
import json
import re

from state_contract import ASSERTIONS, compare as compare_state


class OracleLedgerError(ValueError):
    pass


def require(condition, message):
    if not condition:
        raise OracleLedgerError(message)


def strict_object(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, 'duplicate oracle JSON key: ' + key)
        result[key] = value
    return result


def state_digest(state):
    return hashlib.sha256(json.dumps(state, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def unsigned(value, bits, label):
    require(isinstance(value, str) and re.fullmatch(r'0x[0-9a-fA-F]+', value) is not None,
            'invalid oracle hex field: ' + label)
    require(0 <= int(value, 16) < 1 << bits, 'out-of-range oracle state: ' + label)


def shape(state):
    require(isinstance(state, dict) and set(state) == {'RIP', 'RFLAGS', 'GPR', 'XMM', 'MM', 'MXCSR', 'FCW', 'FSW', 'FTW'},
            'invalid oracle architectural state fields')
    unsigned(state['RIP'], 64, 'RIP'); unsigned(state['RFLAGS'], 64, 'RFLAGS')
    require(isinstance(state['GPR'], list) and len(state['GPR']) == 16, 'oracle must contain 16 GPRs')
    for value in state['GPR']:
        unsigned(value, 64, 'GPR')
    for field, count in [('XMM', 16), ('MM', 8)]:
        require(isinstance(state[field], list) and len(state[field]) == count, 'invalid oracle ' + field + ' count')
        for vector in state[field]:
            require(isinstance(vector, list) and len(vector) == 2, 'invalid oracle ' + field + ' lanes')
            unsigned(vector[0], 64, field)
            unsigned(vector[1], 16 if field == 'MM' else 64, field)
    for field, bits in [('MXCSR', 32), ('FCW', 16), ('FSW', 16), ('FTW', 8)]:
        require(type(state[field]) is int and 0 <= state[field] < 1 << bits, 'invalid oracle control: ' + field)


def load_oracle(path, manifest, *, skips, project, maximum_bytes):
    require(path is not None, 'a native x86 oracle ledger is required for comparison')
    try:
        require(path.is_file(), 'oracle ledger must be a regular file')
        with path.open('rb') as stream:
            data = stream.read(maximum_bytes + 1)
        require(len(data) <= maximum_bytes, 'oracle ledger exceeds byte budget')
        text = data.decode('utf-8')
        rows = [json.loads(line, object_pairs_hook=strict_object) for line in text.splitlines()]
    except (OSError, UnicodeError, json.JSONDecodeError, RecursionError) as error:
        raise OracleLedgerError('invalid oracle ledger JSON') from error
    require(len(rows) == len(manifest['fixtures']), 'oracle fixture count differs from frozen selection')
    expected = {row['path']: row for row in manifest['fixtures']}
    result = {}
    for record in rows:
        require(isinstance(record, dict), 'invalid oracle row')
        fixture = record.get('fixture')
        require(isinstance(fixture, str) and fixture in expected, 'unexpected oracle fixture')
        require(fixture not in result, 'duplicate oracle fixture: ' + fixture)
        result[fixture] = record
        row = expected[fixture]
        require(record.get('layer') == 'oracle', 'reference is not the native oracle layer: ' + fixture)
        require(type(record.get('schema')) is int and record['schema'] == 2 and
                record.get('comparisonContract') == ASSERTIONS['contract'], 'incompatible oracle contract')
        for key, value in [('sourceSHA256', row['sourceSHA256']), ('binarySHA256', row.get('binarySHA256')),
                           ('family', row['family']), ('originalMetadata', row['metadata']),
                           ('requiredHostFeatures', row['metadata'].get('HostFeatures', [])), ('policy', row['policy']['oracle'])]:
            require(record.get(key) == value, 'oracle fixture binding differs: ' + key)
        known = any(p['category'] == 'Known_Failures' for p in row['policy']['oracle'])
        require(record.get('upstreamKnownFailure') is known, 'oracle known-failure expectation differs')
        if fixture in skips:
            require(record.get('status') == 'skip' and record.get('rawExitCode') is None and
                    record.get('semanticPass') is None and record.get('reason') == skips[fixture] and
                    'observed' not in record and 'comparison' not in record, 'invalid gated oracle skip')
            continue
        require(record.get('status') == ('xpass' if known else 'pass') and record.get('semanticPass') is True,
                'oracle has no successful observation: ' + fixture)
        require(type(record.get('rawExitCode')) is int and record['rawExitCode'] == 0 and
                'interrupted' in record and record['interrupted'] is None, 'oracle raw execution did not complete successfully')
        observed = record.get('observed')
        require(isinstance(observed, dict), 'missing oracle observation')
        require(set(observed) == {'schema', 'method', 'termination', 'blocks', 'state', 'codeSHA256', 'stackSHA256', 'architecturalStateSHA256'},
                'invalid native oracle observation fields')
        require(type(observed['schema']) is int and observed['schema'] == 1 and
                observed['method'] == 'linux-x86-64-hlt-oracle', 'wrong native oracle method')
        require(observed['termination'] == 'hlt' and type(observed['blocks']) is int and observed['blocks'] == 0,
                'invalid oracle termination')
        shape(observed['state'])
        halt = int(manifest['layout']['codeBase'], 0) + row['haltOffset']
        require(int(observed['state']['RIP'], 16) == halt, 'oracle did not stop at the expected HLT')
        for field in ['codeSHA256', 'stackSHA256', 'architecturalStateSHA256']:
            require(isinstance(observed[field], str) and re.fullmatch(r'[0-9a-f]{64}', observed[field]) is not None,
                    'invalid oracle digest: ' + field)
        require(state_digest(observed['state']) == observed['architecturalStateSHA256'], 'oracle state digest mismatch')
        projection = project(row, observed)
        final_state = compare_state(row, observed)
        require(projection['matches'] and final_state['matches'], 'oracle final state fails its assertion contract')
        computed = dict(projection, haltMatches=True, meaningfulFinalState=final_state)
        require(record.get('comparison') == computed, 'oracle comparison receipt differs from recomputed state')
    require(list(result) == [row['path'] for row in manifest['fixtures']], 'oracle fixture order differs from frozen selection')
    return result
