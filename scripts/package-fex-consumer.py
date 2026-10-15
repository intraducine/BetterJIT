#!/usr/bin/env python3
"""Stage a portable SDK + device backend + adapter bundle from committed sources."""
import argparse
import hashlib
import importlib.util
import json
import pathlib
import shutil

ROOT=pathlib.Path(__file__).resolve().parents[1]

def module(name,path):
    spec=importlib.util.spec_from_file_location(name,path)
    value=importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value

def digest(path):
    digest=hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda:stream.read(1024*1024),b''):
            digest.update(chunk)
    return digest.hexdigest()

def copy_native_receipt(native,binary):
    receipt=native/'ASSET-MANIFEST.json'
    if receipt.is_symlink(): raise ValueError('Native producer receipt must be a regular file')
    if not receipt.exists(): return None  # Legacy local packages have no producer receipt.
    if not receipt.is_file(): raise ValueError('Native producer receipt must be a regular file')
    data=json.loads(receipt.read_text())
    if not isinstance(data,dict) or data.get('schema')!=1:
        raise ValueError('Invalid native producer receipt')
    identity=data.get('identity')
    inputs=identity.get('inputs') if isinstance(identity,dict) else None
    files=data.get('files')
    if not isinstance(inputs,dict) or inputs.get('component')!='fex-ios' or not isinstance(files,dict):
        raise ValueError('Invalid native producer receipt')
    for path in binary.rglob('*'):
        if not path.is_file(): continue
        name=path.relative_to(binary).as_posix()
        entry=files.get(name)
        if not isinstance(entry,dict) or entry.get('sha256')!=digest(path):
            raise ValueError('Native producer receipt does not match packaged output: '+name)
    shutil.copyfile(receipt,binary/receipt.name)
    return {'path':'FEXNativePackage/'+receipt.name,'sha256':digest(binary/receipt.name),
            'scope':'Original native producer output; the portable bundle contains a subset of that output'}

def package(native,out,ref='HEAD'):
    if out.exists(): raise ValueError('Existing consumer bundle retained unchanged: '+str(out))
    if out==ROOT or ROOT in out.parents: raise ValueError('Stage the consumer bundle outside the checkout')
    exporter=module('sdk_export',ROOT/'scripts/export-sdk.py')
    adapter=module('fex_adapter',ROOT/'scripts/package-fex-adapter.py')
    files=exporter.collect(ROOT,ref)
    try:
        sdk=out/'BetterJIT-SDK'
        for name,(data,mode) in files.items():
            target=sdk/name
            target.parent.mkdir(parents=True,exist_ok=True)
            target.write_bytes(data)
            target.chmod(mode)
        binary=out/'FEXNativePackage'
        binary.mkdir()
        for name in ('Package.swift','COPYING'):
            shutil.copyfile(native/name,binary/name)
        shutil.copytree(native/'CFEXWasm.xcframework',binary/'CFEXWasm.xcframework')
        producer_receipt=copy_native_receipt(native,binary)
        adapter.generate(binary,sdk,out/'BetterJITFEXAdapter',source=sdk)
        revision=json.loads(files['SOURCE-MANIFEST.json'][0])['sourceRevision']
        hashes={str(p.relative_to(out)):digest(p)
                for p in out.rglob('*') if p.is_file()}
        manifest={'schema':1,'repository':'intraducine/BetterJIT','sourceRevision':revision,
                  'platforms':['iOS device arm64'],'signed':False,'deviceExecuted':False,
                  'nativeBackend':'Existing CFEXWasm binary; exact packaged bytes hashed below',
                  'nativeProducerReceipt':producer_receipt,
                  'hashScope':'SDK, adapter and native inputs before compilation; generated Xcode files are excluded',
                  'files':hashes}
        (out/'PACKAGE-MANIFEST.json').write_text(json.dumps(manifest,indent=2,sort_keys=True)+'\n')
    except BaseException:
        shutil.rmtree(out,ignore_errors=True)
        raise
    return manifest

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--native',type=pathlib.Path,default=ROOT/'.build/FEXNativePackage')
    parser.add_argument('--output',type=pathlib.Path,required=True)
    parser.add_argument('--ref',default='HEAD')
    args=parser.parse_args()
    manifest=package(args.native.resolve(),args.output.resolve(),args.ref)
    print('Portable device backend bundle: '+str(args.output.resolve()))
    print('Source revision: '+manifest['sourceRevision'])

if __name__=='__main__':main()
