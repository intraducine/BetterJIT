"""Durable complete skeletons, bounded raw outcomes and per-fixture references."""
import json
import os
import re
from pathlib import Path
from cohort_contract import CONTRACT, compare, validate_observation
from cohort_manifest import LAYERS, canonical, read_json, sha
from cohort_schedule import EXPORT_CAP, RECORD_CAP
from oracle_ledger import strict_object


def require_record(record):
    """Validate the row envelope before field access or hash-map membership."""
    if not isinstance(record,dict):raise ValueError('ledger row must be a JSON object')
    if type(record.get('schema')) is not int or record['schema']!=3:
        raise ValueError('ledger row requires integer schema 3')
    if record.get('comparisonContract')!=CONTRACT:
        raise ValueError('ledger row comparison contract differs')
    for field in ['fixture','layer','shardID']:
        if not isinstance(record.get(field),str) or not record[field]:
            raise ValueError('ledger row requires string '+field)
    if record['layer'] not in LAYERS:raise ValueError('ledger row layer is unknown')
    return record


def parse_record(line):
    return require_record(json.loads(line,object_pairs_hook=strict_object))


class EvidenceBudget:
    def __init__(self, root, maximum=EXPORT_CAP, metadata_reserve=65536):
        self.root=root;self.maximum=maximum;self.metadata_reserve=metadata_reserve
        root.mkdir(parents=True,exist_ok=True)

    def used(self):
        total=0
        for path in self.root.rglob('*'):
            if path.is_symlink():raise ValueError('evidence symlink rejected')
            if path.is_file():total+=path.stat().st_size
        return total

    def room(self):return self.maximum-self.metadata_reserve-self.used()


def skeleton(row, layer, binding):
    return {'schema':3,'comparisonContract':CONTRACT,**binding,
            'fixture':row['path'],'sourceSHA256':row['sourceSHA256'],'binarySHA256':row['binarySHA256'],
            'originalMetadata':row['originalMetadata'],'layer':layer,'policy':row['policy'][layer],
            'status':'untested','semanticPass':None,'rawOutcome':'not-started','failureKind':None,
            'rawExitCode':None,'interrupted':None,'reason':'selected but no execution has started'}


class Ledger:
    def __init__(self, path, rows, layer, binding, budget):
        self.path=path;self.budget=budget;self.rows=[skeleton(r,layer,binding) for r in rows]
        self.flush()

    def bytes(self):return b''.join(canonical(r)+b'\n' for r in self.rows)

    def flush(self):
        self.path.parent.mkdir(parents=True,exist_ok=True);data=self.bytes()
        old=self.path.stat().st_size if self.path.exists() else 0
        if len(data)-old>self.budget.room():raise ValueError('no room to reserve complete outcome skeletons')
        temporary=self.path.with_suffix('.tmp');temporary.write_bytes(data);os.replace(temporary,self.path)

    def can_execute(self):return self.budget.room()>=RECORD_CAP

    def update(self,index,**values):
        candidate=dict(self.rows[index],**values)
        if len(canonical(candidate))>RECORD_CAP:raise ValueError('record exceeds reserved slot')
        old=self.rows[index];self.rows[index]=candidate
        try:self.flush()
        except Exception:self.rows[index]=old;raise

    def persist_result(self,index,values):
        """A pre-reserved slot always has room for this bounded raw fallback.

        Execution starts only with RECORD_CAP bytes free. A detailed update is
        atomic and rolls back on failure, so its small fallback retains that room.
        No further fixture starts after the next can_execute check fails.
        """
        try:
            self.update(index,**values)
            return True
        except ValueError as error:
            status=values.get('status')
            fallback={'status':status if status in ['failure','refused','xfail'] else 'failure',
                      'semanticPass':None,'rawOutcome':values.get('rawOutcome','unavailable'),
                      'rawExitCode':values.get('rawExitCode'),'interrupted':values.get('interrupted'),
                      'failureKind':values.get('failureKind') or 'evidence-budget',
                      'evidenceFailureKind':'record-budget' if 'reserved slot' in str(error) else 'artifact-budget',
                      'reason':'Detailed evidence exceeded its reserved budget; raw execution outcome preserved.',
                      'detailFailureReason':str(error)[:256]}
            for field in ['executableSHA256','rawStdoutSHA256','rawStderrSHA256','capturedStdoutBytes','capturedStderrBytes','rawCaptureComplete']:
                if field in values:fallback[field]=values[field]
            for field in ['rawStdoutPrefixBase64','rawStderrPrefixBase64']:
                if isinstance(values.get(field),str):fallback[field]=values[field][:684]
            self.update(index,**fallback)
            return False

    def defer(self,index,reason,kind='artifact-budget'):
        self.update(index,reason=reason,failureKind=kind)


def validate_reference_record(record, row, binding):
    require_record(record)
    expected=skeleton(row,'oracle',binding)
    for field in ['schema','comparisonContract','admissionSHA256','planSHA256','profileSHA256','recipeSHA256','runID','runAttempt',
                  'fixture','sourceSHA256','binarySHA256','originalMetadata','layer','policy']:
        if record.get(field)!=expected[field] or field in ['schema','runAttempt'] and type(record.get(field)) is not type(expected[field]):
            raise ValueError('oracle binding differs: '+field)
    known=any(p['category']=='Known_Failures' for p in row['policy']['oracle'])
    if record.get('status')!=('xpass' if known else 'pass') or record.get('semanticPass') is not True:
        raise ValueError('oracle fixture has no successful observation')
    if type(record.get('rawExitCode')) is not int or record['rawExitCode']!=0 or record.get('interrupted','missing') is not None or record.get('rawOutcome')!='completed' or record.get('failureKind') is not None:
        raise ValueError('oracle raw execution did not complete successfully')
    validate_observation(row,record['observed'],'oracle')
    comparison=compare(row,record['observed'])
    comparison['validatedStateMemoryAndTermination']=True
    if comparison!=record.get('comparison'):raise ValueError('oracle normalized comparison differs')
    if not re.fullmatch('[0-9a-f]{64}',record.get('rawStdoutSHA256','')) or not re.fullmatch('[0-9a-f]{64}',record.get('rawStderrSHA256','')):
        raise ValueError('oracle raw output digest missing')
    if not re.fullmatch('[0-9a-f]{64}',record.get('executableSHA256','')) or record.get('rawCaptureComplete') is not True:
        raise ValueError('oracle executable/capture binding missing')
    validate_capture(record)
    return record


def validate_capture(record):
    for field in ['executableSHA256','rawStdoutSHA256','rawStderrSHA256']:
        if not isinstance(record.get(field),str) or not re.fullmatch('[0-9a-f]{64}',record[field]):raise ValueError('missing executable/raw output identity')
    counts=[record.get('capturedStdoutBytes'),record.get('capturedStderrBytes')]
    if any(type(v) is not int or v<0 for v in counts) or counts[0]==0 or sum(counts)>524288:
        raise ValueError('invalid raw capture byte counts')


def load_references(paths, expected_rows, binding, expected_order, shards=None):
    """Structural corruption fails a shard; unsuccessful/invalid states isolate a fixture."""
    expected={r['path']:r for r in expected_rows};records={};order=[]
    if shards is not None:
        valid={};unavailable={};used=set()
        for shard in shards:
            matches=[p for p in paths if p.stem==shard['id'] or p.parent.name==shard['id'] or p.parent.parent.name.endswith('-'+shard['id'])]
            if len(matches)!=1:
                unavailable.update({f:'missing/duplicate oracle shard' for f in shard['fixtures']});continue
            path=matches[0];used.add(path)
            try:
                # CI artifacts carry a bounded file index. Standalone test/local
                # shard files still require full record/source/byte/state binding.
                index_path=path.parent.parent/'files.json'
                if path.name=='oracle.jsonl':
                    if path.is_symlink() or path.stat().st_size>EXPORT_CAP:raise ValueError('oracle ledger type/size differs')
                    index,_=read_json(index_path)
                    item=index[str(path.relative_to(path.parent.parent))]
                    if item!={'bytes':path.stat().st_size,'sha256':sha(path.read_bytes())}:raise ValueError('oracle artifact hash differs')
                values,errors=load_references([path],[expected[f] for f in shard['fixtures']],binding,shard['fixtures'])
                for fixture in list(values):
                    if values[fixture].get('shardID')!=shard['id']:
                        errors[fixture]='oracle shard binding differs';del values[fixture]
                valid.update(values);unavailable.update(errors)
            except (ValueError,KeyError,TypeError,OSError,RecursionError) as error:
                unavailable.update({f:'oracle shard integrity: '+str(error) for f in shard['fixtures']})
        if set(paths)-used:raise ValueError('foreign/duplicate oracle shard files')
        return valid,unavailable
    for path in paths:
        if path.is_symlink() or not path.is_file():raise ValueError('regular oracle ledger required')
        with path.open('rb') as stream:data=stream.read(EXPORT_CAP+1)
        if len(data)>EXPORT_CAP:raise ValueError('oracle ledger exceeds byte budget')
        for line in data.splitlines():
            record=parse_record(line)
            fixture=record.get('fixture')
            if fixture not in expected or fixture in records:raise ValueError('foreign or duplicate oracle fixture')
            records[fixture]=record;order.append(fixture)
    if order!=expected_order or set(records)!=set(expected):raise ValueError('oracle ledger incomplete/reordered')
    valid={};unavailable={}
    for fixture,row in expected.items():
        try:valid[fixture]=validate_reference_record(records[fixture],row,binding)
        except (ValueError,KeyError,TypeError) as error:unavailable[fixture]=str(error)
    return valid,unavailable


def validate_outcome(record,row,layer,context,reference=None):
    require_record(record)
    expected=skeleton(row,layer,context)
    for field in ['schema','comparisonContract','admissionSHA256','planSHA256','profileSHA256','recipeSHA256','runID','runAttempt','fixture','sourceSHA256','binarySHA256','originalMetadata','layer','policy']:
        if record.get(field)!=expected[field] or field in ['schema','runAttempt'] and type(record.get(field)) is not type(expected[field]):raise ValueError('outcome binding differs: '+field)
    status=record.get('status');known=any(p['category']=='Known_Failures' for p in row['policy'][layer])
    if status not in ['pass','failure','refused','skip','xfail','xpass','untested']:raise ValueError('unknown outcome status')
    if status in ['xfail','xpass'] and not known:raise ValueError('invented known-failure outcome')
    if status in ['skip','untested']:
        if record.get('semanticPass') is not None or not record.get('reason') or 'observed' in record or 'comparison' in record:raise ValueError('nonexecution outcome contains observation')
        if status=='untested' and (record.get('rawOutcome')!='not-started' or record.get('rawExitCode') is not None):raise ValueError('untested outcome executed')
        if status=='skip' and record.get('rawOutcome')=='source-profile-gate' and row['profiles'][layer]['decision']!='exclude' and not any(p['category']=='Disabled_Tests' for p in row['policy'][layer]):raise ValueError('invented source gate')
        return
    if status in ['failure','refused','xfail'] and not record.get('failureKind'):raise ValueError('underlying failure kind missing')
    if record.get('semanticPass') is True:
        if status!=('xpass' if known else 'pass'):raise ValueError('successful comparison has wrong status')
        if layer=='oracle':validate_reference_record(record,row,context);return
        if reference is None:raise ValueError('backend pass without valid native reference')
        if type(record.get('rawExitCode')) is not int or record['rawExitCode']!=0 or record.get('interrupted','missing') is not None or record.get('rawOutcome')!='completed' or record.get('failureKind') is not None or record.get('rawCaptureComplete') is not True:raise ValueError('pass has invalid raw execution')
        validate_capture(record)
        validate_observation(row,record['observed'],layer)
        computed=compare(row,record['observed'],reference['observed']);computed['validatedStateMemoryAndTermination']=True
        if computed!=record.get('comparison') or not computed['matches']:raise ValueError('backend comparison differs')
    elif status in ['pass','xpass']:raise ValueError('pass without successful comparison')


def export(root):
    files={};total=0
    for path in sorted(root.rglob('*')):
        if path.is_symlink():raise ValueError('evidence symlink rejected')
        if not path.is_file() or path==root/'files.json':continue
        total+=path.stat().st_size
        if total>EXPORT_CAP:raise ValueError('bounded export exceeds bytes')
        raw=path.read_bytes();files[str(path.relative_to(root))]={'bytes':len(raw),'sha256':sha(raw)}
    data=canonical(files)+b'\n'
    if sum(f['bytes'] for f in files.values())+len(data)>EXPORT_CAP:raise ValueError('bounded export exceeds bytes')
    (root/'files.json').write_bytes(data)
    return files
