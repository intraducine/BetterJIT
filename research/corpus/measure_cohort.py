#!/usr/bin/env python3
"""Reviewed external cohorts. Assembly is separate; execution requires exact approval."""
import argparse
import base64
import json
import os
import platform
import selectors
import signal
import subprocess
import sys
import time
from pathlib import Path
from cohort_contract import compare, validate_observation
from cohort_manifest import HERE, LAYERS, SPEC, canonical, digest, load, read_json, relative, sha, validate_inputs
from cohort_results import EvidenceBudget, Ledger, export, load_references
from cohort_schedule import validate_plan
from oracle_ledger import strict_object
from pilot import normalize, validate_flag_observation
from review_admission import assemble, tools_identity


def capture(argv, seconds=5, maximum=524288):
    child=subprocess.Popen(list(map(str,argv)),stdout=subprocess.PIPE,stderr=subprocess.PIPE,start_new_session=True)
    streams={'stdout':bytearray(),'stderr':bytearray()};selector=selectors.DefaultSelector()
    started=time.monotonic();interrupted=None
    try:
        for name in streams:selector.register(getattr(child,name),selectors.EVENT_READ,name)
        while selector.get_map() or child.poll() is None:
            if time.monotonic()-started>seconds:interrupted='timeout';break
            for key,_ in selector.select(0.05):
                data=os.read(key.fileobj.fileno(),16384)
                if not data:selector.unregister(key.fileobj);continue
                room=maximum-sum(map(len,streams.values()));streams[key.data].extend(data[:max(0,room)])
                if len(data)>room:interrupted='output-limit';break
            if interrupted:break
        if interrupted:os.killpg(child.pid,signal.SIGKILL)
        child.wait(timeout=2)
    except (OSError,subprocess.TimeoutExpired):
        interrupted='runner-error'
    finally:
        try:os.killpg(child.pid,signal.SIGKILL)
        except ProcessLookupError:pass
        child.wait();selector.close();child.stdout.close();child.stderr.close()
    return {'exitCode':child.returncode,'interrupted':interrupted,**{k:bytes(v) for k,v in streams.items()}}


def raw_result(receipt):
    interrupted=receipt['interrupted'];code=receipt['exitCode']
    if interrupted:return interrupted,interrupted
    if code<0:return 'host-signal','host-crash'
    if code:return 'nonzero-exit','execution-exit'
    return 'completed',None


def recipe_identity():
    names=['audit_scalar.py','cohort_contract.py','cohort_manifest.py','cohort_results.py','cohort_schedule.py','cohort_assets.py','cohort_ci.py','classify_sources.py',
           'measure_cohort.py','review_admission.py','oracle_ledger.py','pilot.py','wasm.cjs','flags.cjs','native-x86.c','native-x86.S','native-arm64.cpp','state.h']
    return digest({name:sha((HERE/name).read_bytes()) for name in names})


def binding(admission_sha,plan,shard):
    return {'admissionSHA256':admission_sha,'planSHA256':plan['planSHA256'],'profileSHA256':plan['profileSHA256'],
            'recipeSHA256':recipe_identity(),'runID':os.environ.get('GITHUB_RUN_ID','local'),
            'runAttempt':int(os.environ.get('GITHUB_RUN_ATTEMPT','1')),'shardID':shard}


def chosen_rows(manifest,plan,kind,shard):
    item=next((x for x in plan[kind+'Shards'] if x['id']==shard),None)
    if item is None:raise ValueError('shard outside exact plan')
    by_path={r['path']:r for r in manifest['fixtures']}
    return [by_path[name] for name in item['fixtures']]


def prepare(args):
    manifest,identity=load(args.admission,args.admission_sha256)
    plan,_=read_json(args.plan);validate_plan(plan,manifest,identity)
    rows=chosen_rows(manifest,plan,args.kind,args.shard)
    fresh=assemble(args.fex,rows,args.nasm,args.ndisasm,args.output/'inputs')
    if fresh!=rows:raise ValueError('assembly/decode/semantic review differs from external admission')
    prepared={'schema':1,'admissionSHA256':identity,'planSHA256':plan['planSHA256'],'fixtures':rows,
              'tools':tools_identity(args.nasm,args.ndisasm)}
    (args.output/'inputs/manifest.json').write_bytes(canonical(prepared)+b'\n')
    (args.output/'admission.json').write_bytes(args.admission.read_bytes())
    (args.output/'plan.json').write_bytes(args.plan.read_bytes())


def reference_capabilities():
    flags=[]
    if Path('/proc/cpuinfo').is_file():
        for line in Path('/proc/cpuinfo').read_text().splitlines():
            if line.startswith('flags') and ':' in line:flags=line.split(':',1)[1].split();break
    return {'system':platform.system(),'machine':platform.machine(),'referenceCPUFlags':sorted(flags)}


def execute_record(row, layer, executable, inputs, reference, node='node'):
    executable_sha=sha(executable.read_bytes())
    binary=relative(inputs,row['id']+'.bin')
    if layer=='oracle':argv=[executable,binary,row['haltOffset'],0]
    elif layer=='wasm':argv=[node,HERE/'wasm.cjs',executable,binary,row['haltOffset']]
    else:
        profile=next(x for x in SPEC['profile']['nativeBlockProfiles'] if x['name']==layer)
        argv=[executable,binary,row['haltOffset'],profile['maxInstructions'],int(profile['multiblock'])]
    receipt=capture(argv);raw_outcome,kind=raw_result(receipt)
    values={'rawOutcome':raw_outcome,'failureKind':kind,'rawExitCode':receipt['exitCode'],'interrupted':receipt['interrupted'],
            'rawStdoutSHA256':sha(receipt['stdout']),'rawStderrSHA256':sha(receipt['stderr']),
            'capturedStdoutBytes':len(receipt['stdout']),'capturedStderrBytes':len(receipt['stderr']),
            'rawCaptureComplete':receipt['interrupted'] is None,
            'rawStderrPrefixBase64':base64.b64encode(receipt['stderr'][:4096]).decode(),
            'executableSHA256':executable_sha}
    known=any(p['category']=='Known_Failures' for p in row['policy'][layer])
    try:
        observation=json.loads(receipt['stdout'],object_pairs_hook=strict_object)
        if not isinstance(observation,dict):raise ValueError('measurement observation must be a JSON object')
        if receipt['exitCode']==77 and observation.get('status')=='skip' and not receipt['interrupted']:
            return dict(values,status='skip',rawOutcome='runtime-profile-gate',failureKind=None,reason=str(observation['reason'])[:2000],semanticPass=None)
        if kind:
            refused=observation.get('status')=='refused' and not receipt['interrupted'] and receipt['exitCode']>0
            if 'state' in observation:
                try:values['observed']=compact_observation(normalize(dict(observation)))
                except (ValueError,TypeError,AssertionError,KeyError):pass
            values['rawStdoutPrefixBase64']=base64.b64encode(receipt['stdout'][:4096]).decode()
            supplied_reason=observation.get('reason')
            failure_reason=receipt['interrupted'] or (supplied_reason[:2000] if isinstance(supplied_reason,str) else 'raw execution failed')
            return dict(values,status='xfail' if known else 'refused' if refused else 'failure',
                        rawOutcome='refused' if refused else raw_outcome,failureKind='translator-refusal' if refused else kind,
                        reason=failure_reason,semanticPass=None)
        observation=compact_observation(normalize(observation));validate_flag_observation(observation,layer)
        comparison=compare(row,observation,reference['observed'] if reference else None)
        # State/memory/HLT failures are semantic failures, never valid references.
        boundary=True;validation_error=None
        try:validate_observation(row,observation,layer)
        except ValueError as error:boundary=False;validation_error=str(error)
        comparison['validatedStateMemoryAndTermination']=boundary
        passed=comparison['matches'] and boundary
        return dict(values,status=('xpass' if passed else 'xfail') if known else 'pass' if passed else 'failure',
                    failureKind=None if passed else 'profile-mismatch' if validation_error and any(x in validation_error for x in ['method','profile','work bound']) else 'semantic-mismatch',semanticPass=passed,
                    reason=validation_error or ('source-defined comparison passed' if passed else 'defined state differs'),
                    observed=observation,comparison=comparison)
    except (ValueError,KeyError,TypeError,AssertionError,RecursionError) as error:
        # A timeout/signal stays a raw execution failure even if stdout is malformed.
        return dict(values,status='xfail' if known else 'failure',semanticPass=None,
                    failureKind=kind or 'protocol-invalid',reason=str(error)[:2000],
                    rawStdoutPrefixBase64=base64.b64encode(receipt['stdout'][:4096]).decode())


def compact_observation(observed):
    if not isinstance(observed,dict):raise ValueError('measurement observation must be a JSON object')
    for field in ['config','lazyFlags']:
        if field in observed and not isinstance(observed[field],dict):raise ValueError(field+' must be a JSON object')
    allowed=['schema','method','termination','blocks','state','codeSHA256','stackSHA256','architecturalStateSHA256','lazyFlags']
    value={k:observed[k] for k in allowed if k in observed}
    if 'lazyFlags' in value:
        keys=['representation','kind','operandA','operandB','storedNZCV','materializedNZCV','storedRFLAGS','parityRaw','auxiliaryRaw','directionRaw']
        value['lazyFlags']={k:v for k,v in value['lazyFlags'].items() if k in keys and isinstance(v,(str,bool,int)) and len(str(v))<128}
    if 'config' in observed:
        keys=['buildID','linux','windowHi','maxInstructions','callsViaDispatcher','shared','regArgs','memPages','memMaxPages','stateSize','gregsOff','xmmOff','mxcsrOff','ripOff']
        value['config']={k:v for k,v in observed['config'].items() if k in keys and isinstance(v,(str,bool,int)) and len(str(v))<128}
    if len(canonical(value))>12288:raise ValueError('observation exceeds bounded state/config size')
    return value


def run(args):
    manifest,identity=load(args.admission,args.admission_sha256,approved=args.approvals)
    plan,_=read_json(args.plan);validate_plan(plan,manifest,identity)
    rows=chosen_rows(manifest,plan,args.kind,args.shard)
    input_issues=validate_inputs(args.output/'inputs',identity,rows,isolate=True)
    layers=['oracle'] if args.kind=='oracle' else ['single','block500','multi500','wasm']
    context=binding(identity,plan,args.shard);budget=EvidenceBudget(args.output)
    # Reserve every layer's skeleton before reference parsing or any execution.
    ledgers={layer:Ledger(args.output/'results'/(layer+'.jsonl'),rows,layer,context,budget) for layer in layers}
    capabilities=reference_capabilities()
    (args.output/'capabilities.json').write_bytes(canonical(capabilities)+b'\n')
    valid={};unavailable={}
    if args.kind!='oracle':
        all_rows=[r for r in manifest['fixtures'] if r['path'] in set(plan['selected'])]
        expected_order=[p for s in plan['oracleShards'] for p in s['fixtures']]
        try:
            valid,unavailable=load_references(args.oracle_ledgers,all_rows,context,expected_order,shards=plan['oracleShards'])
            oracle_shards={p:s['id'] for s in plan['oracleShards'] for p in s['fixtures']}
            for name in list(valid):
                if valid[name].get('shardID')!=oracle_shards[name]:
                    unavailable[name]='oracle shard assignment differs';del valid[name]
        except (ValueError,KeyError,TypeError,OSError) as error:
            unavailable={r['path']:'reference shard integrity: '+str(error) for r in all_rows}
    for layer in layers:
        ledger=ledgers[layer]
        executable=args.oracle_executable if layer=='oracle' else args.wasm_executable if layer=='wasm' else args.native_executable
        for index,row in enumerate(rows):
            decision=row['profiles'][layer]
            if decision['decision']=='exclude' or any(p['category']=='Disabled_Tests' for p in row['policy'][layer]):
                ledger.update(index,status='skip',rawOutcome='source-profile-gate',reason=decision['reason']);continue
            if row['path'] in input_issues:
                ledger.defer(index,'prepared input integrity: '+input_issues[row['path']],'input-integrity');continue
            needed=('Linux','x86_64') if layer=='oracle' else ('Darwin','arm64')
            if (capabilities['system'],capabilities['machine'])!=needed:
                ledger.update(index,status='skip',rawOutcome='host-profile-gate',reason='required host profile unavailable: '+str(needed));continue
            if layer=='oracle' and not set(row['requiredReferenceFlags'])<=set(capabilities['referenceCPUFlags']):
                ledger.update(index,status='skip',rawOutcome='reference-feature-gate',reason='reference CPU lacks recorded required flags');continue
            if layer!='oracle' and row['path'] not in valid:
                ledger.defer(index,'independent reference unavailable: '+unavailable.get(row['path'],'missing'),'reference-unavailable');continue
            if not ledger.can_execute():
                ledger.defer(index,'reserved artifact slot unavailable; guest not started');continue
            try:
                if executable is None or not executable.is_file():raise ValueError('required executable unavailable')
                values=execute_record(row,layer,executable,args.output/'inputs',valid.get(row['path']),args.node)
            except (OSError,ValueError,TypeError,KeyError) as error:
                ledger.update(index,status='failure',rawOutcome='not-started',failureKind='runner-infrastructure',reason=str(error)[:2000])
                continue
            ledger.persist_result(index,values)
    export(args.output)
    return int(any(r['status'] not in ['pass','skip','xfail'] for ledger in ledgers.values() for r in ledger.rows))


def main():
    parser=argparse.ArgumentParser(description=__doc__);commands=parser.add_subparsers(dest='command',required=True)
    prepare_parser=commands.add_parser('prepare');run_parser=commands.add_parser('run')
    for p in [prepare_parser,run_parser]:
        p.add_argument('--admission',type=Path,required=True);p.add_argument('--admission-sha256',required=True)
        p.add_argument('--plan',type=Path,required=True);p.add_argument('--kind',choices=['oracle','execution'],required=True)
        p.add_argument('--shard',required=True);p.add_argument('--output',type=Path,required=True)
    prepare_parser.add_argument('--fex',type=Path,required=True);prepare_parser.add_argument('--nasm',required=True);prepare_parser.add_argument('--ndisasm',required=True)
    run_parser.add_argument('--approvals',type=Path,default=HERE/'reviewed-admissions.json')
    run_parser.add_argument('--oracle-ledgers',type=Path,nargs='*',default=[])
    for name in ['oracle-executable','native-executable','wasm-executable']:run_parser.add_argument('--'+name,type=Path)
    run_parser.add_argument('--node',default='node')
    args=parser.parse_args()
    return prepare(args) if args.command=='prepare' else run(args)


if __name__=='__main__':raise SystemExit(main())
