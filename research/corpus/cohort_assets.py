#!/usr/bin/env python3
"""Transfer one bounded runtime asset set, preserving producer/reuse evidence."""
import argparse
import importlib.util
import json
import os
import shutil
from pathlib import Path
import assets as native_assets
from cohort_manifest import HERE, canonical, read_json, sha
from cohort_schedule import UNIQUE_ASSET_CAP

ROOT=HERE.parent.parent
spec=importlib.util.spec_from_file_location('production_asset_rules',ROOT/'scripts/build-assets.py')
host_rules=importlib.util.module_from_spec(spec);spec.loader.exec_module(host_rules)


def copy_file(source,target):
    if source.is_symlink() or not source.is_file():raise ValueError('regular asset file required')
    target.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(source,target)


def native_check(manifest,binary,options):
    if manifest['identity']!=native_assets.identity():raise ValueError('native recipe/tools/source differ')
    if manifest['producer']['repository']!='intraducine/BetterJIT' or manifest['producer']['workflow']!=native_assets.WORKFLOW:
        raise ValueError('native producer differs')
    if manifest['outputs']!={'corpus-native-arm64':sha(binary.read_bytes()),'options.json':sha(options.read_bytes())}:
        raise ValueError('native outputs differ')


def host_check(receipt,binary):
    expected=host_rules.identity(ROOT,'fex-host',host_rules.environment('fex-host'))
    if receipt['identity']!=expected:raise ValueError('host source/tools/SDK recipe differs')
    if receipt['mode']=='verified-production-reuse':
        manifest=receipt['manifest']
        if manifest['identity']!=expected or not host_rules.producer_valid(manifest['producer'],'fex-host'):
            raise ValueError('host producer/identity differs')
        if manifest['files']['fexserve']['sha256']!=sha(binary.read_bytes()):raise ValueError('host output differs')
        # Preserve the successful original all-output cache validation receipt.
        if receipt['usage']!={'action':'reused','manifest':manifest}:raise ValueError('host reuse receipt differs')
    elif receipt['mode']=='current-workflow-build; not a production cache seal':
        if receipt['outputSHA256']!=sha(binary.read_bytes()) or receipt['producer']!={'repository':'intraducine/BetterJIT','workflow':native_assets.WORKFLOW,'run':os.environ.get('GITHUB_RUN_ID'),'attempt':os.environ.get('GITHUB_RUN_ATTEMPT'),'commit':os.environ.get('GITHUB_SHA'),'outcome':'success'}:
            raise ValueError('current workflow build receipt differs')
    else:raise ValueError('unknown host asset origin')


def pack(output, host_build):
    output.mkdir(parents=True,exist_ok=False)
    host=ROOT/'.build/host-fex/fexserve';native=ROOT/'.build/corpus-native-asset'
    usage,_=read_json(ROOT/'.build/asset-usage/fex-host.json')
    if usage.get('action')=='reused':
        receipt={'mode':'verified-production-reuse','identity':usage['manifest']['identity'],'manifest':usage['manifest'],'usage':usage}
    else:
        if host_build!='success' or os.environ.get('GITHUB_REPOSITORY')!='intraducine/BetterJIT' or os.environ.get('GITHUB_WORKFLOW')!=native_assets.WORKFLOW:
            raise ValueError('no successful host producer')
        receipt={'mode':'current-workflow-build; not a production cache seal','identity':usage['identity'],'outputSHA256':sha(host.read_bytes()),
                 'producer':{'repository':'intraducine/BetterJIT','workflow':native_assets.WORKFLOW,'run':os.environ.get('GITHUB_RUN_ID'),'attempt':os.environ.get('GITHUB_RUN_ATTEMPT'),'commit':os.environ.get('GITHUB_SHA'),'outcome':'success'}}
    host_check(receipt,host)
    manifest,_=read_json(native/'manifest.json');native_check(manifest,native/'corpus-native-arm64',native/'options.json')
    copy_file(host,output/'fexserve');copy_file(native/'corpus-native-arm64',output/'corpus-native-arm64')
    copy_file(native/'options.json',output/'native-options.json');copy_file(native/'manifest.json',output/'native-producer.json')
    (output/'host-producer.json').write_bytes(canonical(receipt)+b'\n')
    files={p.name:{'bytes':p.stat().st_size,'sha256':sha(p.read_bytes())} for p in output.iterdir()}
    value={'schema':1,'files':files,'qualification':'64 MiB caps this unique runtime asset set once; cumulative download traffic and process RSS are not capped by this value.'}
    data=canonical(value)+b'\n'
    if sum(p['bytes'] for p in files.values())+len(data)>UNIQUE_ASSET_CAP:raise ValueError('unique asset set exceeds 64 MiB')
    (output/'asset-set.json').write_bytes(data)


def verify(root):
    value,_=read_json(root/'asset-set.json')
    if value['schema']!=1 or set(value['files'])!={'fexserve','corpus-native-arm64','native-options.json','native-producer.json','host-producer.json'}:
        raise ValueError('foreign asset set')
    if sum(p.stat().st_size for p in root.iterdir() if p.is_file())>UNIQUE_ASSET_CAP:raise ValueError('unique asset set exceeds 64 MiB')
    if {p.name for p in root.iterdir()}!=set(value['files'])|{'asset-set.json'}:raise ValueError('unexpected asset entries')
    for name,item in value['files'].items():
        path=root/name
        if path.is_symlink() or not path.is_file() or path.stat().st_size!=item['bytes'] or sha(path.read_bytes())!=item['sha256']:
            raise ValueError('transferred asset output differs')
    host_check(read_json(root/'host-producer.json')[0],root/'fexserve')
    native_check(read_json(root/'native-producer.json')[0],root/'corpus-native-arm64',root/'native-options.json')
    for name in ['fexserve','corpus-native-arm64']:
        if (root/name).read_bytes()[:8]!=bytes.fromhex('cffaedfe0c000001'):raise ValueError('ARM64 Mach-O executable required')
        (root/name).chmod(0o755)


if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('action',choices=['pack','verify']);p.add_argument('--root',type=Path,required=True);p.add_argument('--host-build',default='')
    args=p.parse_args();pack(args.root,args.host_build) if args.action=='pack' else verify(args.root)
