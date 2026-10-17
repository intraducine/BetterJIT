#!/usr/bin/env python3
"""Deterministic resource packing, hash-bound continuation, no fixture execution."""
import argparse
import json
from pathlib import Path
from cohort_manifest import canonical, digest, load, read_json

EXPORT_CAP=8*1024*1024
UNIQUE_ASSET_CAP=64*1024*1024
SKELETON_RESERVE=128*1024
RECORD_CAP=32*1024
MAX_NEW=512


def pack(rows, kind, shared_bytes=0):
    limit,layers,max_shards=(64,1,8) if kind=='oracle' else (48,4,11)
    base=SKELETON_RESERVE+shared_bytes
    shards=[];current=[];cost=base
    for row in rows:
        weight=sum(row['inputFileBytes'].values())+len(canonical(row))+layers*RECORD_CAP
        if weight+base>EXPORT_CAP:raise ValueError('single fixture cannot fit bounded evidence')
        if current and (len(current)>=limit or cost+weight>EXPORT_CAP):
            shards.append({'id':f'{kind}-{len(shards):03d}','fixtures':[r['path'] for r in current],'reservedBytes':cost})
            current=[];cost=base
        if len(shards)>=max_shards:return shards,False
        current.append(row);cost+=weight
    if current:shards.append({'id':f'{kind}-{len(shards):03d}','fixtures':[r['path'] for r in current],'reservedBytes':cost})
    return shards,True


def plan(manifest, admission_sha, continuation=None):
    profile_sha=digest(manifest['profile']);start=0
    if continuation is not None:
        if set(continuation)!={'admissionSHA256','profileSHA256','nextIndex'} or continuation['admissionSHA256']!=admission_sha or continuation['profileSHA256']!=profile_sha:
            raise ValueError('stale/foreign continuation')
        start=continuation['nextIndex']
    rows=manifest['fixtures']
    if type(start) is not int or not 0<=start<=len(rows):raise ValueError('invalid continuation index')
    count=min(MAX_NEW,len(rows)-start)
    while count:
        selected=rows[start:start+count];shared_bytes=len(canonical(manifest))
        oracle,oracle_fit=pack(selected,'oracle',shared_bytes);execution,execution_fit=pack(selected,'execution',shared_bytes)
        if oracle_fit and execution_fit:break
        count-=1
    if not count:oracle=[];execution=[]
    next_index=start+count
    result={'schema':1,'admissionSHA256':admission_sha,'classificationSHA256':manifest['classificationSHA256'],
            'profileSHA256':profile_sha,'selected':[r['path'] for r in rows[start:next_index]],
            'oracleShards':oracle,'executionShards':execution,
            'continuation':{'admissionSHA256':admission_sha,'profileSHA256':profile_sha,'nextIndex':next_index} if next_index<len(rows) else None,
            'notSelected':[r['path'] for r in rows[:start]+rows[next_index:]],
            'resources':{'processSeconds':5,'maximumBlocks':10000,'exportBytesPerShard':EXPORT_CAP,
                         'maximumCapturedOutputBytes':524288,'recordBytes':RECORD_CAP,'maximumWorkers':4,
                         'nativeJitArenaBytes':67108864,'denseLinearMemoryBytes':268435456,
                         'uniqueCompiledAssetSetBytes':UNIQUE_ASSET_CAP,
                         'qualification':'Linear memory/JIT arena ceilings are not RSS limits. Asset cap is the unique asset set, not cumulative transfer traffic.'}}
    result['planSHA256']=digest(result)
    return result


def validate_plan(value, manifest, identity):
    raw=dict(value);declared=raw.pop('planSHA256',None)
    if declared!=digest(raw) or value['admissionSHA256']!=identity or value['profileSHA256']!=digest(manifest['profile']):
        raise ValueError('plan identity differs')
    paths=[r['path'] for r in manifest['fixtures']]
    selected=value['selected']
    if len(selected)!=len(set(selected)) or selected!=[x for x in paths if x in set(selected)]:raise ValueError('foreign/duplicate/reordered selection')
    start=paths.index(selected[0]) if selected else len(paths)
    cursor={'admissionSHA256':identity,'profileSHA256':digest(manifest['profile']),'nextIndex':start}
    if value!=plan(manifest,identity,cursor):raise ValueError('plan is not canonical resource packing')


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--admission',type=Path,required=True);parser.add_argument('--output',type=Path,required=True)
    parser.add_argument('--continuation',type=Path)
    args=parser.parse_args();manifest,identity=load(args.admission)
    value=plan(manifest,identity,read_json(args.continuation)[0] if args.continuation else None)
    args.output.parent.mkdir(parents=True,exist_ok=True);args.output.write_bytes(canonical(value)+b'\n')
    print(json.dumps({'selected':len(value['selected']),'oracleShards':len(value['oracleShards']),'executionShards':len(value['executionShards']),'continuation':value['continuation']}))
