#!/usr/bin/env python3
"""Assemble/decode/analyze explicit candidates. This command never executes guests."""
import argparse
import json
import re
import shutil
from pathlib import Path
from audit_scalar import analyze, decoded
from cohort_contract import CONTRACT
from cohort_manifest import HERE, LAYERS, SPEC, canonical, digest, object_value, read_json, relative, sha
from pilot import policy, process


def tools_identity(nasm, ndisasm):
    result={}
    for key,path in [('nasm',nasm),('ndisasm',ndisasm)]:
        resolved=Path(shutil.which(str(path)) or path).resolve()
        run=process([resolved,'-v']);
        if run['exitCode'] or run['interrupted']:raise ValueError('assembler/decoder version failed')
        result[key]={'version':run['stdout'].strip() or run['stderr'].strip(),'sha256':sha(resolved.read_bytes())}
    return result


def assemble(fex, candidates, nasm, ndisasm, output):
    output.mkdir(parents=True,exist_ok=True);rows=[]
    for number,candidate in enumerate(candidates):
        original=relative(fex,candidate['path']).read_bytes()
        if sha(original)!=candidate['sourceSHA256']:raise ValueError('candidate source differs')
        metadata=object_value(json.loads(re.search(rb'%ifdef CONFIG\s*(.*?)%endif',original,re.S)[1]),'fixture metadata')
        if set(metadata)!={'RegData'}:raise ValueError('candidate has unreviewed metadata')
        stem=candidate.get('id',f'{number:03d}');wrapped=b'BITS 64\nORG 0x400400000\n'+original
        (output/(stem+'.asm')).write_bytes(wrapped)
        listing,binary=output/(stem+'.lst'),output/(stem+'.bin')
        run=process([nasm,'-f','bin','-l',listing,'-o',binary,output/(stem+'.asm')])
        if run['exitCode'] or run['interrupted']:raise ValueError('bounded candidate assembly failed: '+candidate['path'])
        data=binary.read_bytes()
        if not 0<len(data)<=65536:raise ValueError('input exceeds frozen byte limit')
        run=process([ndisasm,'-b','64','-o','0x400400000',binary])
        if run['exitCode'] or run['interrupted']:raise ValueError('bounded decoder failed')
        decode=run['stdout'];(output/(stem+'.decode.txt')).write_text(decode)
        instructions=decoded(decode,data);facts=analyze(instructions,metadata)
        halts=re.findall(r'^\s*\d+\s+([0-9A-Fa-f]{8})\s+F4\s+hlt\s*(?:;.*)?$',listing.read_text(),re.M|re.I)
        if len(halts)!=1 or int(halts[0],16)!=instructions[-1]['offset']:raise ValueError('source/listing/decode HLT differs')
        row={'id':stem,'path':candidate['path'],'family':'reviewed-register-scalar','mode':64,
             'sourceSHA256':candidate['sourceSHA256'],'originalMetadata':metadata,'policy':policy(fex,dict(candidate,mode=64)),
             'binarySHA256':sha(data),'wrappedSourceSHA256':sha(wrapped),'listingSHA256':sha(listing.read_bytes()),'decodeSHA256':sha(decode.encode()),
             'bytes':len(data),'haltOffset':int(halts[0],16),'unchangedCodeMapSHA256':sha(data+bytes(65536-len(data))),'unchangedStackMapSHA256':sha(bytes(65536)),
             'inputFileBytes':{suffix:(output/(stem+suffix)).stat().st_size for suffix in ['.asm','.bin','.lst','.decode.txt']},
             'requiredReferenceFlags':['lahf_lm'] if any(r['mnemonic'] in ['lahf','sahf'] for r in instructions) else [],
             'assertions':{k:facts[k] for k in ['gprDefinedMasks','expectedDefinedGPRs','flagsMask','expectedMaskedFlags','fswMask','expectedMaskedFSW']},
             'reviewEvidence':facts,'decodedInstructions':instructions,'profiles':{}}
        for layer in LAYERS:
            bounded=layer=='oracle' or facts['dynamicInstructionBound']<=10000
            row['profiles'][layer]={'decision':'admit' if bounded else 'exclude','maximumBlocks':0 if layer=='oracle' else facts['dynamicInstructionBound'],
                                   'reason':'Source/decoded constant-path proof, source-derived definedness and original expectations reviewed; no guest execution.' if bounded else 'No proven work bound within frozen 10000-block adapter limit; single/Wasm maxinst=1 definitely exceed it; larger native profiles conservatively excluded.'}
        rows.append(row)
    return rows


def main():
    p=argparse.ArgumentParser(description=__doc__)
    for name in ['fex','candidates','classification','output']:p.add_argument('--'+name,type=Path,required=True)
    p.add_argument('--nasm',required=True);p.add_argument('--ndisasm',required=True)
    args=p.parse_args();candidates,_=read_json(args.candidates)
    rows=assemble(args.fex,candidates['fixtures'],args.nasm,args.ndisasm,args.output/'inputs')
    value={'schema':1,'reviewStatus':'proposed; independent review and exact-hash approval required before execution',
           'comparisonContract':CONTRACT,'source':SPEC['source'],'layout':SPEC['layout'],'profile':SPEC['profile'],'budgets':SPEC['budgets'],
           'classificationSHA256':sha(args.classification.read_bytes()),'candidateSelectionSHA256':sha(args.candidates.read_bytes()),
           'auditScalarSHA256':sha((HERE/'audit_scalar.py').read_bytes()),'tools':tools_identity(args.nasm,args.ndisasm),'fixtures':rows,
           'semanticsAuthority':{'source':'Intel SDM Volume 2, instruction semantics; no observed-value mask selection','url':'https://www.intel.com/content/www/us/en/developer/articles/technical/intel-sdm.html'},
           'qualification':'No new guest execution. Register masks propagate semantic undefinedness. Original source, RegData and decoded bytes preserved. Linear memory and JIT arena limits do not establish RSS.'}
    (args.output/'admission.json').write_bytes(canonical(value)+b'\n')
    print(json.dumps({'fixtures':len(rows),'admissionSHA256':sha((args.output/'admission.json').read_bytes()),'executionEnabled':False}))


if __name__=='__main__':main()
