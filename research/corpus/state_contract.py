"""Final-state assertions; empty x87 payloads and undefined flag bits are excluded."""
import json
from pathlib import Path

ASSERTIONS = json.loads((Path(__file__).parent / 'assertions.json').read_text())


def number(value):
    return int(value, 0) if isinstance(value, str) else int(value)


def compare(row, observed, reference=None):
    state = observed['state']
    rule = ASSERTIONS['fixtures'][row['path']]
    flags = number(state['RFLAGS'])
    mask, expected = number(rule['flagsMask']), number(rule['expectedMaskedFlags'])
    fsw_mask = number(rule['fswMask'])
    checks = {
        'definedFinalFlags': flags & mask == expected,
        'reservedBit1AndSeedIF': flags & 0x202 == 0x202,
        'definedX87Status': number(state['FSW']) & fsw_mask == number(rule['expectedMaskedFSW']),
    }
    details = {'flagsMask': hex(mask), 'expectedMaskedFlags': hex(expected),
               'observedMaskedFlags': hex(flags & mask), 'reservedBit1AndIFMask': '0x202',
               'FSWMask': hex(fsw_mask), 'expectedMaskedFSW': rule['expectedMaskedFSW'],
               'observedMaskedFSW': hex(number(state['FSW']) & fsw_mask)}
    if reference is not None:
        target = reference['state']
        checks.update({
            'all16GPRs': [number(x) for x in state['GPR']] == [number(x) for x in target['GPR']],
            'all16XMMs': [[number(x) for x in r] for r in state['XMM']] == [[number(x) for x in r] for r in target['XMM']],
            'MXCSR': number(state['MXCSR']) == number(target['MXCSR']),
            'FCW': number(state['FCW']) == number(target['FCW']),
            'definedFSWMatchesOracle': (number(state['FSW']) ^ number(target['FSW'])) & fsw_mask == 0,
            'FTW': number(state['FTW']) == number(target['FTW']),
            'definedFlagsMatchOracle': (flags ^ number(target['RFLAGS'])) & mask == 0,
        })
        tagged = [r for r in range(8) if number(target['FTW']) & 1 << r]
        checks['liveX87Payloads'] = all([number(x) for x in state['MM'][r]] == [number(x) for x in target['MM'][r]] for r in tagged)
        details.update(livePhysicalX87Registers=tagged,
                       oracleArchitecturalStateSHA256=reference.get('architecturalStateSHA256'))
    return {'matches': all(checks.values()), 'checks': checks, **details}
