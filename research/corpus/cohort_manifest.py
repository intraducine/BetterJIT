"""Hash-bound external admissions. A lexical classification is never admission."""
import hashlib
import json
import re
from pathlib import Path
from audit_scalar import GPRS, MASK64
from cohort_contract import CONTRACT
from oracle_ledger import strict_object

HERE=Path(__file__).resolve().parent
SPEC=json.loads((HERE/'pilot.json').read_text())
LAYERS=['oracle','single','block500','multi500','wasm']


def sha(data):return hashlib.sha256(data).hexdigest()
def canonical(value):return json.dumps(value,sort_keys=True,separators=(',',':')).encode()
def digest(value):return sha(canonical(value))


def object_value(value,label='JSON document'):
    if not isinstance(value,dict):raise ValueError(label+' must be a JSON object')
    return value


def read_json(path, maximum=8388608):
    if path.is_symlink() or not path.is_file():raise ValueError('regular JSON file required')
    with path.open('rb') as stream:data=stream.read(maximum+1)
    if len(data)>maximum:raise ValueError('JSON exceeds byte budget')
    return object_value(json.loads(data,object_pairs_hook=strict_object)),sha(data)


def relative(root, name):
    p=Path(name)
    if p.is_absolute() or '..' in p.parts or not p.parts:raise ValueError('unsafe relative path')
    path=root/p
    if any(x.is_symlink() for x in [path,*path.parents] if x.is_relative_to(root)):
        raise ValueError('symlink rejected')
    return path


def load(path, expected_sha=None, approved=None):
    manifest,identity=read_json(path)
    if expected_sha is not None and identity!=expected_sha:raise ValueError('admission hash differs')
    if approved is not None:
        catalog,_=read_json(approved)
        approved_ids=catalog.get('approvedSHA256')
        if type(catalog.get('schema')) is not int or catalog['schema']!=1 or not isinstance(approved_ids,list) or any(not isinstance(v,str) or not re.fullmatch('[0-9a-f]{64}',v) for v in approved_ids) or identity not in approved_ids:
            raise ValueError('exact admission has not been independently reviewed for execution')
    if manifest.get('schema')!=1 or manifest.get('comparisonContract')!=CONTRACT:
        raise ValueError('wrong external admission schema/contract')
    if manifest.get('source')!=SPEC['source'] or manifest.get('layout')!=SPEC['layout']:
        raise ValueError('source/layout outside frozen adapter profile')
    if manifest.get('profile')!=SPEC['profile'] or manifest.get('budgets')!=SPEC['budgets']:
        raise ValueError('profile/resource constants changed')
    if manifest.get('auditScalarSHA256')!=sha((HERE/'audit_scalar.py').read_bytes()):
        raise ValueError('definedness analyzer recipe changed')
    rows=manifest.get('fixtures')
    if not isinstance(rows,list) or not rows or len(rows)>2467:raise ValueError('bounded fixture list required')
    ids=[];file_ids=[]
    for row in rows:
        ids.append(row['path']);relative(Path('.'),row['path']);file_ids.append(row['id'])
        if not re.fullmatch('[0-9]{3,4}',row['id']):raise ValueError('invalid fixture file ID')
        if row.get('mode')!=64 or set(row['originalMetadata'])!={'RegData'}:raise ValueError('outside reviewed scalar metadata/mode contract')
        original=row['originalMetadata']['RegData']
        if not isinstance(original,dict) or not original or len(original)>16 or any(k not in {r.upper() for r in GPRS} or not isinstance(v,str) or not 0<=int(v,0)<=MASK64 for k,v in original.items()):
            raise ValueError('bounded scalar RegData required')
        if any(len(canonical(p))>4096 for p in row['policy'].values()):raise ValueError('policy receipt exceeds record slot')
        for field in ['sourceSHA256','binarySHA256','wrappedSourceSHA256','decodeSHA256','listingSHA256','unchangedCodeMapSHA256','unchangedStackMapSHA256']:
            if not re.fullmatch('[0-9a-f]{64}',row.get(field,'')):raise ValueError('invalid admission hash: '+field)
        if type(row.get('bytes')) is not int or not 0<row['bytes']<=65536 or not 0<=row['haltOffset']<row['bytes']:
            raise ValueError('invalid bounded input/HLT offset')
        rules=row['assertions']
        if set(rules)!={'gprDefinedMasks','expectedDefinedGPRs','flagsMask','expectedMaskedFlags','fswMask','expectedMaskedFSW'}:
            raise ValueError('foreign scalar assertion fields')
        mask=int(rules['flagsMask'],0);flags=int(rules['expectedMaskedFlags'],0)
        if not 0<=mask<=0xcd5 or mask&~0xcd5 or flags&~mask or rules['fswMask']!='0xffff' or rules['expectedMaskedFSW']!='0x0':
            raise ValueError('invalid scalar flag/control contract')
        if set(rules['gprDefinedMasks'])!={x.upper() for x in GPRS} or set(rules['expectedDefinedGPRs'])!={x.upper() for x in GPRS}:
            raise ValueError('all 16 GPR masks and semantic values required')
        for value in list(rules['gprDefinedMasks'].values())+list(rules['expectedDefinedGPRs'].values()):
            if not isinstance(value,str) or not re.fullmatch('0x[0-9a-f]+',value) or not 0<=int(value,0)<=MASK64:raise ValueError('invalid defined GPR bit vector')
        if set(row['profiles'])!=set(LAYERS) or set(row['policy'])!=set(LAYERS):raise ValueError('all profile decisions required')
        for layer,decision in row['profiles'].items():
            if decision['decision'] not in ['admit','exclude'] or not decision.get('reason'):raise ValueError('profile admission needs reason')
            if layer!='oracle' and decision['decision']=='admit' and decision['maximumBlocks']>10000:
                raise ValueError('profile work exceeds frozen bound')
    if ids!=sorted(ids) or len(ids)!=len(set(ids)) or len(file_ids)!=len(set(file_ids)):raise ValueError('fixture order/uniqueness differs')
    return manifest,identity


def validate_inputs(root, admission, expected_rows, isolate=False):
    manifest,_=read_json(root/'manifest.json')
    if manifest.get('admissionSHA256')!=admission or manifest.get('fixtures')!=expected_rows:
        raise ValueError('prepared fixture/admission binding differs')
    issues={}
    for row in expected_rows:
        try:validate_input(root,row)
        except (ValueError,OSError,KeyError,TypeError) as error:
            if not isolate:raise
            issues[row['path']]=str(error)
    return issues if isolate else manifest


def validate_input(root,row):
    for suffix,field in [('.bin','binarySHA256'),('.asm','wrappedSourceSHA256'),('.lst','listingSHA256'),('.decode.txt','decodeSHA256')]:
        path=relative(root,row['id']+suffix)
        if path.stat().st_size!=row['inputFileBytes'][suffix]:raise ValueError('prepared input size differs')
        data=path.read_bytes()
        if sha(data)!=row[field]:raise ValueError('prepared input hash differs: '+row['path'])
    binary=relative(root,row['id']+'.bin').read_bytes()
    if len(binary)!=row['bytes'] or binary[row['haltOffset']]!=0xf4:raise ValueError('prepared HLT/length differs')
    wrapped=relative(root,row['id']+'.asm').read_bytes();prefix=b'BITS 64\nORG 0x400400000\n'
    if not wrapped.startswith(prefix) or sha(wrapped[len(prefix):])!=row['sourceSHA256']:
        raise ValueError('wrapped original source differs')
    metadata=object_value(json.loads(re.search(rb'%ifdef CONFIG\s*(.*?)%endif',wrapped,re.S)[1],object_pairs_hook=strict_object),'fixture metadata')
    if metadata!=row['originalMetadata']:raise ValueError('original metadata changed')
