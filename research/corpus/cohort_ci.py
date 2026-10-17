#!/usr/bin/env python3
"""CI plumbing: source-only planning, bounded transfer, complete aggregation."""
import argparse
import json
import os
import shutil
import subprocess
from pathlib import Path
from cohort_manifest import HERE, LAYERS, canonical, digest, load, object_value, read_json, relative, sha, validate_inputs
from cohort_results import EvidenceBudget, Ledger, export, parse_record, validate_outcome, validate_reference_record
from cohort_schedule import plan as make_plan, validate_plan
from measure_cohort import binding, chosen_rows


def emit(name,value):
    text=value if isinstance(value,str) else json.dumps(value,separators=(',',':'))
    if os.environ.get('GITHUB_OUTPUT'):
        with open(os.environ['GITHUB_OUTPUT'],'a') as f:f.write(name+'='+text+'\n')
    print(name+'='+text)


def verify_export(root):
    if root.is_symlink() or not root.is_dir():raise ValueError('regular artifact directory required')
    total=0
    for path in root.rglob('*'):
        if path.is_symlink():raise ValueError('artifact symlink rejected')
        if path.is_file():total+=path.stat().st_size
        if total>8388608:raise ValueError('all artifact files exceed export cap')
    index,_=read_json(root/'files.json')
    actual={str(p.relative_to(root)) for p in root.rglob('*') if p.is_file() and p!=root/'files.json'}
    if actual!=set(index):raise ValueError('artifact entries differ')
    if sum(x['bytes'] for x in index.values())+(root/'files.json').stat().st_size>8388608:raise ValueError('shard exceeds export cap')
    for name,item in index.items():
        p=relative(root,name)
        if p.stat().st_size!=item['bytes'] or sha(p.read_bytes())!=item['sha256']:raise ValueError('artifact file hash differs')
    return index


def create_plan(args):
    manifest,identity=load(args.admission)
    args.output.mkdir(parents=True,exist_ok=True)
    # Verify the full immutable source index, including unadmitted fixtures.
    subprocess.run([os.environ.get('PYTHON','python3'),str(HERE/'classify_sources.py'),'--source',str(args.fex),
                    '--inventory',str(HERE/'corpus-index.jsonl'),'--repo',str(HERE.parent.parent),'--output',str(args.output/'classification')],check=True,timeout=120,capture_output=True)
    classified=args.output/'classification/corpus-classification.jsonl'
    if sha(classified.read_bytes())!=manifest['classificationSHA256']:raise ValueError('whole-corpus classification differs')
    cursor=read_json(args.continuation)[0] if args.continuation else None
    value=make_plan(manifest,identity,cursor)
    (args.output/'plan.json').write_bytes(canonical(value)+b'\n')
    shutil.copyfile(args.admission,args.output/'admission.json')
    catalog,_=read_json(HERE/'reviewed-admissions.json');enabled=identity in catalog['approvedSHA256']
    emit('enabled',str(enabled).lower());emit('admission',identity)
    emit('oracle',{'include':[{'shard':x['id']} for x in value['oracleShards']]} if enabled else {'include':[]})
    emit('execution',{'include':[{'shard':x['id']} for x in value['executionShards']]} if enabled else {'include':[]})


def gather(args):
    manifest,identity=load(args.admission,args.admission_sha256)
    plan,_=read_json(args.plan);validate_plan(plan,manifest,identity)
    rows=chosen_rows(manifest,plan,'execution',args.shard)
    args.output.mkdir(parents=True,exist_ok=True);inputs=args.output/'inputs';inputs.mkdir()
    roots=sorted(p for p in args.downloads.iterdir() if p.is_dir())
    for row in rows:
        found=[root for root in roots if (root/'inputs'/(row['id']+'.bin')).is_file()]
        if len(found)!=1:continue  # Runner records this fixture's missing input.
        for suffix in ['.asm','.bin','.lst','.decode.txt']:
            source=found[0]/'inputs'/(row['id']+suffix)
            if source.is_file() and not source.is_symlink() and source.stat().st_size==row['inputFileBytes'][suffix]:
                shutil.copyfile(source,inputs/(row['id']+suffix))
    (inputs/'manifest.json').write_bytes(canonical({'schema':1,'admissionSHA256':identity,'planSHA256':plan['planSHA256'],'fixtures':rows,'tools':'original per-shard oracle input receipts retained in same-run artifacts'})+b'\n')
    shutil.copyfile(args.admission,args.output/'admission.json');shutil.copyfile(args.plan,args.output/'plan.json')
    validate_inputs(inputs,identity,rows,isolate=True)


def seal(args):
    manifest,identity=load(args.admission,args.admission_sha256)
    plan,_=read_json(args.plan);validate_plan(plan,manifest,identity)
    rows=chosen_rows(manifest,plan,args.kind,args.shard);budget=EvidenceBudget(args.output)
    layers=['oracle'] if args.kind=='oracle' else LAYERS[1:]
    for layer in layers:
        path=args.output/'results'/(layer+'.jsonl')
        if not path.exists():
            ledger=Ledger(path,rows,layer,binding(identity,plan,args.shard),budget)
            for i in range(len(rows)):ledger.defer(i,'workflow step unavailable before this layer completed','infrastructure-unavailable')
    export(args.output)


def aggregate(args):
    manifest,identity=load(args.admission,args.admission_sha256)
    plan,_=read_json(args.plan);validate_plan(plan,manifest,identity)
    all_paths={r['path']:r for r in manifest['fixtures']};observations={};raw_records={};artifacts=[]
    expected_shards={s['id']:s for kind in ['oracle','execution'] for s in plan[kind+'Shards']}
    seen_shards=set()
    for root in sorted(p.parent for p in args.downloads.glob('*/files.json')):
        files=verify_export(root);artifact_rows=[]
        for ledger in sorted((root/'results').glob('*.jsonl')):
            raw=ledger.read_bytes()
            for line in raw.splitlines():
                r=parse_record(line)
                shard=r.get('shardID');layer=r.get('layer');fixture=r.get('fixture')
                if shard not in expected_shards or fixture not in expected_shards[shard]['fixtures'] or fixture not in all_paths:raise ValueError('foreign fixture/shard')
                expected_layers=['oracle'] if shard.startswith('oracle-') else LAYERS[1:]
                if layer not in expected_layers or r.get('admissionSHA256')!=identity or r.get('planSHA256')!=plan['planSHA256'] or r.get('profileSHA256')!=plan['profileSHA256']:
                    raise ValueError('stale/foreign layer/identity')
                if r.get('runID')!=os.environ.get('GITHUB_RUN_ID','local') or r.get('runAttempt')!=int(os.environ.get('GITHUB_RUN_ATTEMPT','1')):
                    raise ValueError('stale run context')
                if r.get('sourceSHA256')!=all_paths[fixture]['sourceSHA256'] or r.get('binarySHA256')!=all_paths[fixture]['binarySHA256']:
                    raise ValueError('source/byte binding differs')
                key=(fixture,layer)
                if key in observations:raise ValueError('duplicate fixture outcome')
                raw_records[key]=r
                observations[key]={k:r.get(k) for k in ['status','semanticPass','rawOutcome','failureKind','evidenceFailureKind','rawExitCode','interrupted','reason']}
                observations[key].update(outcomeSHA256=sha(canonical(r)),shardID=shard,comparisonContract=r['comparisonContract'])
                artifact_rows.append((shard,layer,fixture));seen_shards.add(shard)
        for shard in {x[0] for x in artifact_rows}:
            expected_layers=['oracle'] if shard.startswith('oracle-') else LAYERS[1:]
            for layer in expected_layers:
                actual=[x[2] for x in artifact_rows if x[:2]==(shard,layer)]
                if actual!=expected_shards[shard]['fixtures']:raise ValueError('incomplete/reordered shard layer')
        artifacts.append({'artifactDirectory':root.name,'filesIndexSHA256':sha((root/'files.json').read_bytes()),'bytes':sum(x['bytes'] for x in files.values())+(root/'files.json').stat().st_size})
    valid_references={}
    for (fixture,layer),record in raw_records.items():
        if layer=='oracle':
            context=binding(identity,plan,record['shardID'])
            validate_outcome(record,all_paths[fixture],layer,context)
            if record['semanticPass'] is True:valid_references[fixture]=record
    for (fixture,layer),record in raw_records.items():
        if layer!='oracle':validate_outcome(record,all_paths[fixture],layer,binding(identity,plan,record['shardID']),valid_references.get(fixture))
    classification=[]
    for line in args.classification.read_bytes().splitlines():classification.append(object_value(json.loads(line),'classification row'))
    if sha(args.classification.read_bytes())!=manifest['classificationSHA256'] or len(classification)!=2467 or len({r['fixture'] for r in classification})!=2467:
        raise ValueError('whole-corpus denominator differs')
    args.output.mkdir(parents=True,exist_ok=True)
    matrix=[]
    for source in classification:
        for layer in LAYERS:
            outcome=observations.get((source['fixture'],layer))
            if outcome is None:
                outcome={'status':'untested','semanticPass':None,'rawOutcome':'not-started','failureKind':'infrastructure-unavailable' if source['fixture'] in plan['selected'] else None,
                         'reason':'selected shard unavailable' if source['fixture'] in plan['selected'] else 'not in this reviewed cohort/continuation; frozen baseline reported separately'}
            matrix.append({'fixture':source['fixture'],'sourceSHA256':source['sourceSHA256'],'layer':layer,**outcome})
    (args.output/'whole-corpus-outcomes.jsonl').write_bytes(b''.join(canonical(r)+b'\n' for r in matrix))
    summary={'admissionSHA256':identity,'planSHA256':plan['planSHA256'],'profileSHA256':plan['profileSHA256'],
             'artifacts':artifacts,'missingShards':sorted(set(expected_shards)-seen_shards),'continuation':plan['continuation'],
             'fixtureCount':2467,'fixtureLayerRows':len(matrix),'counts':{layer:{status:sum(r['layer']==layer and r['status']==status for r in matrix) for status in ['pass','failure','refused','skip','xfail','xpass','untested']} for layer in LAYERS},
             'baseline':'Existing fourteen-fixture v2 report remains a separate same-workflow artifact; this matrix records only the new contract.',
             'coveragePercentage':None,'qualification':'Source fixture files are not an ISA/release denominator. Missing outcomes never pass.'}
    (args.output/'summary.json').write_bytes(canonical(summary)+b'\n')
    if sum(p.stat().st_size for p in args.output.iterdir())>16*1024*1024:raise ValueError('aggregate index exceeds 16 MiB')
    if sum(x['bytes'] for x in artifacts)+sum(p.stat().st_size for p in args.output.iterdir())>192*1024*1024:raise ValueError('evidence envelope exceeds 192 MiB')
    return int(bool(summary['missingShards']) or any(r['status'] in ['failure','refused','xpass','untested'] for r in matrix if r['fixture'] in plan['selected']))


def aggregation_failure(output,error):
    """Keep a complete conservative index even when incoming shards are corrupt."""
    output.mkdir(parents=True,exist_ok=True)
    rows=[json.loads(line) for line in (HERE/'corpus-index.jsonl').read_text().splitlines()]
    values=[{'fixture':r['id'],'sourceSHA256':r['sha256'],'layer':layer,'status':'untested','semanticPass':None,
             'rawOutcome':'unavailable','failureKind':'aggregation-integrity',
             'reason':'Shard observations not validated; actual execution may exist in preserved artifacts.'} for r in rows for layer in LAYERS]
    (output/'whole-corpus-outcomes.jsonl').write_bytes(b''.join(canonical(r)+b'\n' for r in values))
    (output/'aggregation-failure.json').write_bytes(canonical({'status':'failure','reason':str(error)[:2000],'rows':len(values),'coveragePercentage':None})+b'\n')


def reference(args):
    root=args.output;root.mkdir(parents=True,exist_ok=True)
    source=HERE.parent.parent/'.build/corpus-pilot/corpus-native-x86'
    if args.action=='reference-pack':
        if not source.is_file():raise ValueError('reference executable missing')
        shutil.copyfile(source,root/'corpus-native-x86')
        value={'schema':1,'sourceRecipe':{name:sha((HERE/name).read_bytes()) for name in ['native-x86.c','native-x86.S','state.h']},
               'executableSHA256':sha(source.read_bytes()),'runID':os.environ.get('GITHUB_RUN_ID'),'runAttempt':os.environ.get('GITHUB_RUN_ATTEMPT')}
        (root/'reference.json').write_bytes(canonical(value)+b'\n')
    else:
        value,_=read_json(root/'reference.json')
        if value.get('sourceRecipe')!={name:sha((HERE/name).read_bytes()) for name in ['native-x86.c','native-x86.S','state.h']} or value.get('executableSHA256')!=sha((root/'corpus-native-x86').read_bytes()) or value.get('runID')!=os.environ.get('GITHUB_RUN_ID') or value.get('runAttempt')!=os.environ.get('GITHUB_RUN_ATTEMPT'):
            raise ValueError('reference binary source/run/output differs')
        (root/'corpus-native-x86').chmod(0o755)


if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('action',choices=['plan','gather','seal','aggregate','reference-pack','reference-verify'])
    for name in ['admission','plan','fex','downloads','classification','continuation']:p.add_argument('--'+name,type=Path)
    p.add_argument('--admission-sha256');p.add_argument('--shard');p.add_argument('--kind',choices=['oracle','execution'])
    p.add_argument('--output',type=Path,required=True)
    args=p.parse_args()
    fn={'plan':create_plan,'gather':gather,'seal':seal,'aggregate':aggregate}.get(args.action,reference)
    try:result=fn(args)
    except (ValueError,KeyError,TypeError,OSError,RecursionError) as error:
        if args.action!='aggregate':raise
        aggregation_failure(args.output,error);result=1
    raise SystemExit(result)
