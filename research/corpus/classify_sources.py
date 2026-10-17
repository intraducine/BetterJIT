#!/usr/bin/env python3
"""Read pinned source only. Never assemble, translate, execute, or admit fixtures."""
import argparse
import collections
import hashlib
import json
import re
from pathlib import Path

PIN = 'f59cab95659e8add0c88f0c76ec1cf483c536dbf'
MADEIRA = '279fd0f83170425db002fe25d6bd62f6355f497d'
BASE = '60c4dae805c52a0503537085e699524875d697c4'
SERVICE = set('syscall sysenter sysexit int int1 int3 into iret iretd iretq'.split())
SYSTEM = set('wrfsbase wrgsbase rdfsbase rdgsbase xgetbv xsetbv xsave xrstor xsaveopt xsavec xsaves xrstors rdmsr wrmsr in out ins insb insw insd outs outsb outsw outsd invlpg cli sti lgdt lidt rsm swapgs lmsw smsw sldt str clts verr verw lar lsl'.split())
NONDET = set('rdtsc rdtscp rdpid rdrand rdseed cpuid'.split())
STACK = set('push pop pushfq popfq pushf popf call ret retf enter leave pusha popa pushad popad pushfd popfd'.split())
IMPLICIT_MEMORY = set('movs movsb movsw movsd movsq cmps cmpsb cmpsw cmpsd cmpsq scas scasb scasw scasd scasq stos stosb stosw stosd stosq lods lodsb lodsw lodsd lodsq xlat xlatb maskmovq maskmovdqu'.split())
SCALAR = set('mov movzx movsx movsxd add adc sub sbb and or xor not neg cmp test inc dec shl shr sar rol ror rcl rcr shld shrd clc stc cmc cbw cwde cdqe cwd cdq cqo xchg xadd bswap bt bts btr btc bsf bsr hlt'.split())
EXPLICIT_FAULT = set('ud0 ud1 ud2 icebp int3 into'.split())
OPTIONAL = {'andn':'BMI1','bextr':'BMI1','blsi':'BMI1','blsmsk':'BMI1','blsr':'BMI1','tzcnt':'BMI1','bzhi':'BMI2','mulx':'BMI2','pdep':'BMI2','pext':'BMI2','rorx':'BMI2','sarx':'BMI2','shlx':'BMI2','shrx':'BMI2','adcx':'ADX','adox':'ADX','lzcnt':'ABM','popcnt':'POPCNT','crc32':'SSE4.2','movbe':'MOVBE','pclmulqdq':'PCLMUL','rdrand':'RAND','rdseed':'RAND','rdpid':'RDPID','clwb':'CLWB','clflushopt':'CLFLOPT','clzero':'CLZERO','rdfsbase':'FSGSBASE','rdgsbase':'FSGSBASE','wrfsbase':'FSGSBASE','wrgsbase':'FSGSBASE'}

def sha(data):
    return hashlib.sha256(data).hexdigest()

def dump(path, obj):
    path.write_text(json.dumps(obj, indent=2, sort_keys=True) + '\n')

def classify(root, inventory, repo, output):
    spec = json.loads((repo / 'research/corpus/pilot.json').read_text())
    assertions = json.loads((repo / 'research/corpus/assertions.json').read_text())
    baseline = {r['path']: r for r in spec['fixtures']}
    policies = []
    for directory in ['ASM', '32Bit_ASM']:
        for path in sorted((root / 'unittests' / directory).iterdir()):
            if path.name.startswith(('Known_Failures', 'Disabled_Tests')):
                policies.append({'path': str(path.relative_to(root)), 'sha256': sha(path.read_bytes()), 'entries': path.read_text().splitlines()})
    records = []
    for line in inventory.read_text().splitlines():
        row = json.loads(line)
        path = root / row['id']
        raw = path.read_bytes()
        assert sha(raw) == row['sha256'], row['id']
        text = raw.decode()
        match = re.search(r'%ifdef\s+CONFIG\s*(.*?)%endif', text, re.S)
        metadata = json.loads(match[1]) if match else {}
        body = text[:match.start()] + '\n' + text[match.end():] if match else text
        clean = '\n'.join(x.split(';', 1)[0] for x in body.splitlines())
        ops = row.get('instructions')
        if ops is None:
            ops=[]
            config_lines=set(range(text[:match.start()].count('\n')+1,text[:match.end()].count('\n')+2)) if match else set()
            for number,line in enumerate(text.splitlines(),1):
                code=line.split(';',1)[0].strip()
                if number in config_lines or not code or code.startswith('%') or ':' in code.split()[0]:continue
                words=code.lower().split();prefixes=[]
                while words and words[0] in ['lock','rep','repe','repz','repne','repnz','a16','a32','a64','o16','o32','o64']:prefixes.append(words.pop(0))
                if not words:continue
                mnemonic=words[0]
                if mnemonic in ['align','db','dw','dd','dq','dt','do','dy','dz','resb','resw','resd','resq','section','global','bits','default','times','equ','org','end']:continue
                if re.fullmatch(r'[a-z][a-z0-9]*',mnemonic):ops.append({'line':number,'mnemonic':mnemonic,'prefixes':prefixes,'text':code,'memorySyntaxPresent':'[' in code})
        names = {o['mnemonic'] for o in ops}
        memory = [o for o in ops if o['memorySyntaxPresent']]
        relmemory = [o for o in memory if re.search(r'\[\s*rel\b', o['text'], re.I)]
        othermemory = [o for o in memory if o not in relmemory]
        directives = sorted(set(re.findall(r'^\s*(%[a-z]+)\b', clean, re.M | re.I)))
        macro = bool(re.search(r'^\s*%(?:macro|include|rep|define|assign)\b', clean, re.M | re.I))
        dependencies = []
        for inc in re.finditer(r'^\s*%include\s+(.+)$', clean, re.M | re.I):
            value = inc[1].strip()
            literal = re.fullmatch(r'["\']([^"\']+)["\']', value)
            dep = {'expression': value, 'status': 'unresolved'}
            if literal:
                candidates = [path.parent / literal[1], root / 'unittests/ASM/Includes' / literal[1], root / 'unittests/32Bit_ASM/Includes' / literal[1]]
                found = next((p.resolve() for p in candidates if p.is_file() and p.resolve().is_relative_to(root.resolve())), None)
                if found:
                    dep.update(path=str(found.relative_to(root.resolve())), sha256=sha(found.read_bytes()), status='literal-direct-include-hashed; transitive/preprocessed closure not validated')
            dependencies.append(dep)
        inferred = set(OPTIONAL[n] for n in names if n in OPTIONAL)
        for n in names:
            if n.startswith('aes'): inferred.add('AES')
            if n.startswith('sha'): inferred.add('SHA')
            if n.startswith('v') and n not in SYSTEM: inferred.add('AVX-family-unresolved')
        vector256 = any(re.search(r'\b(?:ymm|zmm)\d+\b|\bk[0-7]\b', o['text'], re.I) for o in ops)
        x87 = bool(re.search(r'/X87(?:_F64)?/', row['id'])) or any(n.startswith('f') for n in names)
        mmx = any(re.search(r'\bmm[0-7]\b', o['text'], re.I) for o in ops)
        low_marker = bool(re.search(r'0xe[08]000000', clean, re.I))
        # A numeric immediate can be test data: never call it a proven address.
        implicit_memory = sorted(names & IMPLICIT_MEMORY)
        low = low_marker and bool(memory or names & STACK or implicit_memory)
        segment = bool(re.search(r'\b(?:fs|gs|cs|ss|ds|es)\s*:|\b(?:[cdefgs]s)\b', '\n'.join(o['text'] for o in ops), re.I))
        selfmod = '/SelfModifyingCode/' in row['id']
        halt_count = sum(o['mnemonic'] == 'hlt' for o in ops)
        before_hlt=re.split(r'^\s*hlt\s*$',clean,maxsplit=1,flags=re.M|re.I)[0]
        rawcode = bool(re.search(r'^\s*(?:db|dw|dd|dq)\b',before_hlt,re.M|re.I))
        unknown_registers = [k for k,v in metadata.get('RegData', {}).items() if not (k in 'RAX RCX RDX RBX RSP RBP RSI RDI R8 R9 R10 R11 R12 R13 R14 R15'.split() or re.fullmatch(r'(?:XMM|MM)\d+', k)) or isinstance(v, list) and len(v) > 2]
        body_lines = [x.strip() for x in clean.splitlines() if x.strip()]
        straight_screen = bool(set(metadata)=={'RegData'} and body_lines and all(x.split()[0].lower() in SCALAR for x in body_lines) and body_lines[-1].lower()=='hlt' and not memory and not macro and not segment and halt_count==1 and len(body_lines)<=128)
        policy = []
        directory = 'ASM' if row['mode'] == 64 else '32Bit_ASM'
        relative = row['id'].split('/' + directory + '/', 1)[1]
        for source in policies:
            if not source['path'].startswith('unittests/' + directory + '/'): continue
            for entry in source['entries']:
                if entry == 'Test_' + relative or re.fullmatch(r'[^/]+/Test_' + str(row['mode']) + 'Bit_' + re.escape(relative), entry):
                    policy.append({'source': source['path'], 'sourceSHA256': source['sha256'], 'entry': entry, 'category': Path(source['path']).name.split('_', 2)[0] + '_' + Path(source['path']).name.split('_', 2)[1], 'applicability': 'must select exact layer/CPU-class policy; all matches preserved'})
        requirements = []
        def need(code, evidence):
            requirements.append({'code': code, 'evidence': evidence})
        if row['mode'] != 64: need('mode32', {'mode': row['mode'], 'metadataMode': metadata.get('Mode')})
        if metadata.get('HostFeatures'): need('declared-feature-profile', metadata['HostFeatures'])
        if inferred: need('inferred-feature-review', sorted(inferred))
        if vector256 or unknown_registers: need('extended-or-unsupported-state', {'vector256Lexical': vector256, 'unsupportedRegData': unknown_registers})
        if metadata.get('Env'): need('configuration-profile', metadata['Env'])
        extra = sorted(set(metadata) - {'RegData','HostFeatures','Mode','Env','MemoryRegions','MemoryData'})
        if extra: need('metadata-semantics', {k: metadata[k] for k in extra})
        if not metadata.get('RegData'): need('missing-regdata-contract', {'metadataKeys': list(metadata)})
        if metadata.get('MemoryRegions') or metadata.get('MemoryData'): need('explicit-memory-layout', {k:metadata[k] for k in ['MemoryRegions','MemoryData'] if k in metadata})
        if low: need('low-scratch-address-layout', '0xe0000000/0xe8000000 literal marker; address use and extent need validation')
        if othermemory: need('computed-or-absolute-memory', [{'line':o['line'],'text':o['text']} for o in othermemory[:6]])
        if relmemory: need('rip-relative-memory-permissions', [{'line':o['line'],'text':o['text']} for o in relmemory[:6]])
        if implicit_memory: need('implicit-memory-bounds', implicit_memory)
        if names & STACK: need('stack-or-call-contract', sorted(names & STACK))
        branches = sorted(n for n in names if n.startswith('j') or n in {'loop','loope','loopz','loopne','loopnz','call','ret','retf'})
        if branches: need('control-flow-bounds', branches)
        if names & SERVICE: need('service-or-control-transfer', sorted(names & SERVICE))
        if names & SYSTEM or segment: need('system-segment-or-extended-control-state', {'mnemonics':sorted(names & SYSTEM),'segmentSyntax':segment})
        if names & NONDET: need('nondeterministic-or-cpuid-contract', sorted(names & NONDET))
        if names & EXPLICIT_FAULT: need('intentional-fault-contract', sorted(names & EXPLICIT_FAULT))
        if names & {'div','idiv'}: need('divide-exception-review', sorted(names & {'div','idiv'}))
        if halt_count != 1: need('termination-contract', {'lexicalHLTCount': halt_count})
        if macro: need('preprocessor-closure-review', {'directives':directives,'directIncludes':dependencies})
        if rawcode: need('raw-encoding-review', 'data directive before first lexical HLT; all bytes require decode/reachability review, including redundant REX and repeated address-size prefixes')
        if selfmod: need('self-modifying-code-profile', 'upstream requires FEX_SMCCHECKS=full; current protected compile/execute adapter has no invalidation contract')
        if x87 or mmx: need('x87-mmx-state-contract', {'x87Lexical':x87,'mmxLexical':mmx,'reducedPrecision':metadata.get('Env',{}).get('FEX_X87REDUCEDPRECISION')})
        if policy: need('upstream-policy-resolution', policy)
        baseline_row = baseline.get(row['id'])
        if baseline_row:
            lane = 'baseline-frozen-14'
            admission = 'admitted-frozen-baseline-with-profile-gates'
        elif row['mode'] != 64: lane = 'mode32-profile'
        elif names & SERVICE or names & SYSTEM or segment or names & NONDET or names & EXPLICIT_FAULT or selfmod:
            lane = 'service-system-exception-or-nondeterminism'
        elif metadata.get('Env') or extra: lane = 'configuration-or-metadata-profile'
        elif metadata.get('HostFeatures') or inferred or vector256 or unknown_registers: lane = 'feature-or-extended-state-profile'
        elif metadata.get('MemoryRegions') or metadata.get('MemoryData'): lane = 'explicit-memory-layout'
        elif low: lane = 'low-scratch-address-layout'
        elif macro or rawcode or halt_count != 1 or not metadata.get('RegData'): lane = 'source-expansion-or-termination-review'
        elif memory or names & STACK or implicit_memory: lane = 'shared64-memory-stack-contract-candidate'
        elif x87 or mmx: lane = 'shared64-x87-mmx-contract-candidate'
        elif names <= SCALAR: lane = 'shared64-straight-line-register-contract-candidate'
        else: lane = 'shared64-other-register-contract-review'
        if not baseline_row:
            admission = 'not-admitted; source triage only'
            need('reviewed-state-and-form-contract', {'instructionForms':'not decoded or assembled','definedFinalFlags':'not supplied','memoryPermissionsAndBounds':'not proven','termination':'not proven'})
        records.append({'schema':'betterjit-corpus-classification-v1','fixture':row['id'],'sourceSHA256':row['sha256'],'mode':row['mode'],'metadata':metadata,'primaryLane':lane,'requirements':requirements,'admission':admission,'sourceFacts':{'bytes':len(raw),'lexicalInstructionRecords':len(ops),'lexicalMnemonics':sorted(names),'memoryOperandRecords':len(memory),'explicitRIPRelativeRecords':len(relmemory),'otherMemoryRecords':len(othermemory),'implicitMemoryMnemonics':implicit_memory,'lowAddressLiteralMarker':low_marker,'directives':directives,'directIncludes':dependencies,'lexicalHLTCount':halt_count,'straightLineScalarScreen':straight_screen},'historicalBaseline':{'commit':BASE,'run':38980550570,'source':'workflow logs and independent parent artifact audit; parent message received 2026-10-16','assertion':assertions['fixtures'].get(row['id']),'eligible':row['mode']==64 and not metadata.get('HostFeatures')} if baseline_row else None,'newExecution':{'status':'untested','exitCode':None,'semanticPass':None,'reason':'read-only classification; no assembly, translation or execution'}})
    records.sort(key=lambda x:x['fixture'])
    assert len(records) == 2467 and len({r['fixture'] for r in records}) == 2467
    out = output / 'corpus-classification.jsonl'
    out.write_text(''.join(json.dumps(r, sort_keys=True, separators=(',',':'))+'\n' for r in records))
    counts = collections.Counter(r['primaryLane'] for r in records)
    requirements = collections.Counter(x['code'] for r in records for x in r['requirements'])
    groups = []
    for lane, count in sorted(counts.items()):
        selected = [r for r in records if r['primaryLane']==lane]
        group = {'name':lane,'count':count,'fixtures':[r['fixture'] for r in selected], 'requirementCounts': dict(sorted(collections.Counter(x['code'] for r in selected for x in r['requirements']).items())),'autoExecutable':False}
        groups.append(group)
    dump(output/'cohort-index.json', {'schema':'betterjit-proposed-cohort-index-v1','classificationSHA256':sha(out.read_bytes()),'groups':groups,'qualification':'groups classify source requirements; they do not authorize execution'})
    dump(output/'policy-sources.json',policies)
    summary = {'schema':'betterjit-corpus-classification-summary-v1','scope':'read-only source triage; no new fixture assembly, translation or execution','sourcePins':{'Madeira':MADEIRA,'FEX':PIN,'BetterJIT':BASE},'inventorySHA256':sha(inventory.read_bytes()),'classificationSHA256':sha(out.read_bytes()),'total':len(records),'sourceHashMismatches':0,'modeCounts':dict(collections.Counter(str(r['mode']) for r in records)),'primaryLaneCounts':dict(sorted(counts.items())),'overlappingRequirementCounts':dict(sorted(requirements.items())),'HostFeaturesFixtureCount':sum(bool(r['metadata'].get('HostFeatures')) for r in records),'featureTagCounts':dict(sorted(collections.Counter(f for r in records for f in r['metadata'].get('HostFeatures',[])).items())),'metadataKeyCounts':dict(sorted(collections.Counter(k for r in records for k in r['metadata']).items())),'EnvKeyCounts':dict(sorted(collections.Counter(k for r in records for k in r['metadata'].get('Env',{})).items())),'newFixturesExecuted':0,'qualification':['Primary lanes are a first-match partition; requirements overlap and are all retained.','Lexical mnemonics include macro invocations and are not decoded ISA coverage.','Literal address markers are evidence for review, not complete dataflow or bounds proofs.','No HostFeatures tag is not proof of baseline ISA compatibility.','No new source-only row is safe to execute until explicit admission and the matching adapter contract are reviewed.','Historical baseline results remain separate from newExecution=untested.']}
    dump(output/'classification-summary.json',summary)
    print(json.dumps(summary,indent=2))

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source',type=Path,required=True)
    parser.add_argument('--inventory',type=Path,required=True)
    parser.add_argument('--repo',type=Path,required=True)
    parser.add_argument('--output',type=Path,required=True)
    args=parser.parse_args()
    args.output.mkdir(parents=True,exist_ok=True)
    classify(args.source,args.inventory,args.repo,args.output)
