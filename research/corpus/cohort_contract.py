"""Source-defined scalar masks, preserving original expectations and raw state."""
from audit_scalar import GPRS, MASK64
from oracle_ledger import shape, state_digest

CONTRACT = 'register-defined-state-v3'


def number(value):
    return int(value,0) if isinstance(value,str) else value


def compare(row, observed, reference=None):
    state=observed['state'];shape(state)
    rule=row['assertions'];masks=rule['gprDefinedMasks']
    raw_expected=row['originalMetadata']['RegData']
    raw_observed={r:state['GPR'][GPRS.index(r.lower())] for r in raw_expected}
    normalized_expected={r:hex(number(v)&number(masks[r])) for r,v in raw_expected.items()}
    normalized_observed={r:hex(number(v)&number(masks[r])) for r,v in raw_observed.items()}
    flags_mask=number(rule['flagsMask'])
    checks={'sourceRegDataDefinedBits':normalized_expected==normalized_observed,
            'allDefinedGPRs':all((number(state['GPR'][i])^number(rule['expectedDefinedGPRs'][r.upper()]))&number(masks[r.upper()])==0 for i,r in enumerate(GPRS)),
            'definedFinalFlags':number(state['RFLAGS'])&flags_mask==number(rule['expectedMaskedFlags']),
            'reservedBit1AndSeedIF':number(state['RFLAGS'])&0x202==0x202,
            'all16XMMsUnchanged':all(all(number(v)==0 for v in x) for x in state['XMM']),
            'MXCSR':state['MXCSR']==0x1f80,'FCW':state['FCW']==0x37f,
            'fullFSWPreserved':state['FSW']==0,'FTW':state['FTW']==0}
    if reference is not None:
        target=reference['state'];shape(target)
        checks.update(oracleDefinedGPRs=all((number(state['GPR'][i])^number(target['GPR'][i]))&number(masks[r.upper()])==0 for i,r in enumerate(GPRS)),
                      oracleDefinedFlags=(number(state['RFLAGS'])^number(target['RFLAGS']))&flags_mask==0,
                      oracleXMM=state['XMM']==target['XMM'],
                      oracleControls=all(state[k]==target[k] for k in ['MXCSR','FCW','FSW','FTW']))
    return {'matches':all(checks.values()),'checks':checks,'originalRegData':raw_expected,
            'rawObservedRegData':raw_observed,'normalizedExpectedRegData':normalized_expected,
            'normalizedObservedRegData':normalized_observed,'gprDefinedMasks':masks,
            'flagsMask':rule['flagsMask'],'expectedMaskedFlags':rule['expectedMaskedFlags'],
            'normalization':'Only source-semantic undefined bits excluded; raw expectations and observations retained. Empty x87 payloads excluded; full non-x87 FSW preserved.'}


def validate_observation(row, observed, layer):
    if not isinstance(observed,dict):raise ValueError('observation must be a JSON object')
    shape(observed['state'])
    if state_digest(observed['state'])!=observed['architecturalStateSHA256']:
        raise ValueError('state digest mismatch')
    expected={'codeSHA256':row['unchangedCodeMapSHA256'],'stackSHA256':row['unchangedStackMapSHA256']}
    if any(observed.get(k)!=v for k,v in expected.items()):raise ValueError('register-only fixture modified memory')
    if observed.get('termination')!='hlt' or number(observed['state']['RIP'])!=0x400400000+row['haltOffset']:
        raise ValueError('not the reviewed HLT boundary')
    if layer=='oracle':
        if set(observed)!={'schema','method','termination','blocks','state','codeSHA256','stackSHA256','architecturalStateSHA256'}:
            raise ValueError('foreign native oracle observation fields')
        if type(observed.get('schema')) is not int or observed['schema']!=1 or observed.get('method')!='linux-x86-64-hlt-oracle' or type(observed.get('blocks')) is not int or observed['blocks']!=0:
            raise ValueError('wrong native oracle method/schema/block count')
    else:
        method='legacy-dense-file-window-maxinst1' if layer=='wasm' else 'macos-arm64-pinned-FEX-spilled-block-return'
        if type(observed.get('schema')) is not int or observed['schema']!=1 or observed.get('method')!=method or type(observed.get('blocks')) is not int or not 1<=observed['blocks']<=min(10000,row['profiles'][layer]['maximumBlocks']):
            raise ValueError('wrong backend method/schema/work bound')
        if layer=='wasm':
            cfg=observed.get('config',{});expected={'linux':False,'windowHi':4,'maxInstructions':1,'callsViaDispatcher':False,'shared':True,'regArgs':0,'memPages':4096,'memMaxPages':0,'stateSize':1472,'gregsOff':32,'xmmOff':448,'mxcsrOff':972,'ripOff':24}
            if not isinstance(cfg,dict):raise ValueError('Wasm config must be a JSON object')
            if any(type(cfg.get(k)) is not type(v) or cfg[k]!=v for k,v in expected.items()):raise ValueError('Wasm effective profile differs')
            lazy=observed.get('lazyFlags',{})
            if not isinstance(lazy,dict):raise ValueError('raw lazy descriptor must be a JSON object')
            if lazy.get('representation')!='backend-materialize-v1' or type(lazy.get('kind')) is not int or lazy['kind'] not in list(range(15))+list(range(16,31)):
                raise ValueError('invalid raw lazy descriptor')
    if not compare(row,observed)['matches']:raise ValueError('observation fails source-defined assertions')
