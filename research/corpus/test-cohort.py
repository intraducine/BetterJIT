#!/usr/bin/env python3
"""Host integrity tests and source-derived certificates; never execute corpus guests."""
import argparse
import copy
import hashlib
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0,str(Path(__file__).resolve().parent))
from audit_scalar import AuditError, Facts, GPRS, MASK64, analyze, decoded
from cohort_contract import compare, validate_observation
from cohort_manifest import HERE, SPEC, canonical, digest, load, read_json, sha, validate_inputs
from cohort_results import EvidenceBudget, Ledger, export, load_references, parse_record, skeleton, validate_reference_record
from cohort_schedule import pack, plan, validate_plan
import measure_cohort as measure
import cohort_ci
import cohort_assets


class CohortIntegrity(unittest.TestCase):
    @classmethod
    def setUpClass(cls):cls.manifest,cls.identity=load(HERE/'register-admission.json')

    def fixture(self,suffix='Primary/Primary_84.asm'):
        return copy.deepcopy(next(r for r in self.manifest['fixtures'] if r['path'].endswith(suffix)))

    def context(self):
        value=plan(self.manifest,self.identity)
        return measure.binding(self.identity,value,'oracle-000')

    def observation(self,row):
        state={'RIP':hex(0x400400000+row['haltOffset']),'RFLAGS':hex(0x202|int(row['assertions']['expectedMaskedFlags'],0)),
               'GPR':[row['assertions']['expectedDefinedGPRs'][r.upper()] for r in GPRS],
               'XMM':[['0x0','0x0'] for _ in range(16)],'MM':[['0x0','0x0'] for _ in range(8)],
               'MXCSR':0x1f80,'FCW':0x37f,'FSW':0,'FTW':0}
        return {'schema':1,'method':'linux-x86-64-hlt-oracle','termination':'hlt','blocks':0,'state':state,
                'codeSHA256':row['unchangedCodeMapSHA256'],'stackSHA256':row['unchangedStackMapSHA256'],
                'architecturalStateSHA256':sha(canonical(state))}

    def reference(self,row,context=None):
        observed=self.observation(row);value=skeleton(row,'oracle',context or self.context())
        comparison=compare(row,observed);comparison['validatedStateMemoryAndTermination']=True
        value.update(status='pass',semanticPass=True,rawOutcome='completed',rawExitCode=0,interrupted=None,
                     observed=observed,comparison=comparison,executableSHA256='a'*64,
                     rawStdoutSHA256='b'*64,rawStderrSHA256='c'*64,rawCaptureComplete=True,capturedStdoutBytes=300000,capturedStderrBytes=0)
        return value

    def wire(self,row):
        value=self.observation(row)
        binary=b''.join(bytes.fromhex(i['hex']) for i in row['decodedInstructions'])
        for field in ['codeSHA256','stackSHA256','architecturalStateSHA256']:value.pop(field)
        value.update(codeHex=(binary+bytes(65536-len(binary))).hex(),stackHex=bytes(65536).hex())
        return value

    def runner_case(self,root,count):
        manifest=copy.deepcopy(self.manifest);manifest['fixtures']=manifest['fixtures'][:count]
        admission=root/'admission.json';admission.write_bytes(canonical(manifest)+b'\n');identity=sha(admission.read_bytes())
        value=plan(manifest,identity);planned=root/'plan.json';planned.write_bytes(canonical(value)+b'\n')
        approvals=root/'unit-test-approval.json';approvals.write_bytes(canonical({'schema':1,'approvedSHA256':[identity]})+b'\n')
        shard=value['executionShards'][-1]['id']
        args=argparse.Namespace(admission=admission,admission_sha256=identity,approvals=approvals,plan=planned,
                               kind='execution',shard=shard,output=root/'outcomes',oracle_ledgers=[],
                               native_executable=Path(sys.executable),wasm_executable=Path(sys.executable),oracle_executable=None,node='node')
        return manifest,identity,value,args

    def test_all_127_decoded_certificates_recompute_without_observations(self):
        self.assertEqual(len(self.manifest['fixtures']),127)
        normalized=[];control=0;divides=0
        for row in self.manifest['fixtures']:
            facts=analyze(row['decodedInstructions'],row['originalMetadata'])
            self.assertEqual(facts,row['reviewEvidence'],row['path'])
            for key,value in row['assertions'].items():self.assertEqual(value,facts[key])
            if int(facts['gprDefinedMasks']['RAX'],0)!=MASK64:
                normalized.append(row['path']);self.assertEqual(facts['gprDefinedMasks']['RAX'],'0xffffffffffffefff')
            self.assertTrue(all(int(mask,0)==MASK64 for r,mask in facts['gprDefinedMasks'].items() if r!='RAX'))
            control+=any(i['mnemonic'].startswith('j') or i['mnemonic']=='loop' for i in row['decodedInstructions'])
            divides+=sum(e['kind']=='nonfaulting divide proof' for e in facts['events'])
        self.assertEqual((len(normalized),control,divides),(33,22,2))

    def test_undefined_AF_normalizes_both_RegData_and_full_GPR_comparison(self):
        for suffix in ['Primary/Primary_84.asm','Primary/Primary_A8.asm','FEX_bugs/xor_flags.asm']:
            row=self.fixture(suffix);reference=self.observation(row);changed=copy.deepcopy(reference)
            changed['state']['GPR'][0]=hex(int(changed['state']['GPR'][0],0)^0x1000)
            result=compare(row,changed,reference)
            self.assertTrue(result['matches']);self.assertNotEqual(result['rawObservedRegData'],result['originalRegData'])
            self.assertEqual(result['originalRegData'],row['originalMetadata']['RegData'])
            changed['state']['GPR'][0]=hex(int(changed['state']['GPR'][0],0)^0x100)
            self.assertFalse(compare(row,changed,reference)['matches'])

    def test_source_masking_recovers_defined_RAX_bits(self):
        for suffix in ['Primary/Primary_85.asm','Primary/Primary_A9.asm']:
            row=self.fixture(suffix);self.assertEqual(row['assertions']['gprDefinedMasks']['RAX'],hex(MASK64))
            value=self.observation(row);value['state']['GPR'][0]=hex(int(value['state']['GPR'][0],0)^0x1000)
            self.assertFalse(compare(row,value)['matches'])

    def test_undefined_condition_rejected_before_any_branch_admission(self):
        facts=Facts()
        facts.step({'offset':0,'hex':'31c0','mnemonic':'xor','operands':['eax','eax']})
        facts.step({'offset':2,'hex':'c1e802','mnemonic':'shr','operands':['eax','0x2']})
        with self.assertRaisesRegex(AuditError,'undefined flag-dependent'):
            facts.step({'offset':5,'hex':'7100','mnemonic':'jno','operands':['0x400400007']})

    def test_redundant_prefixes_and_hidden_XADD_are_in_decoded_review(self):
        row=self.fixture('REX/TwoByte.asm');xadd=[i for i in row['decodedInstructions'] if i['mnemonic']=='xadd']
        self.assertEqual([x['hex'] for x in xadd],['4f480fc1c8','4f2e0fc1d3'])
        self.assertEqual([x['operands'] for x in xadd],[['rax','rcx'],['ebx','edx']])
        binary=b''.join(bytes.fromhex(x['hex']) for x in row['decodedInstructions'])
        self.assertEqual(sha(binary),row['binarySHA256'])
        row=self.fixture('mov_address_size_override.asm')
        self.assertTrue(any(i['hex']=='67674c89c2' for i in row['decodedInstructions']))

    def test_decoder_must_cover_every_byte_and_targets_must_be_boundaries(self):
        with self.assertRaises(AuditError):decoded('400400000 F4 hlt\n',b'\xf4\x90')
        with self.assertRaises(AuditError):analyze([{'offset':0,'hex':'ebff','mnemonic':'jmp','operands':['0x400400001']},{'offset':2,'hex':'f4','mnemonic':'hlt','operands':[]}],{'RegData':{'RAX':'0'}})
        with self.assertRaisesRegex(AuditError,'including unreachable'):
            analyze([{'offset':0,'hex':'eb02','mnemonic':'jmp','operands':['0x400400004']},{'offset':2,'hex':'0f05','mnemonic':'syscall','operands':[]},{'offset':4,'hex':'f4','mnemonic':'hlt','operands':[]}],{'RegData':{'RAX':'0'}})

    def test_divide_preconditions_and_final_flag_undefinedness(self):
        expected=[('Divide32.asm','4294967299','2','2147483649','1'),('LongSignedDivide.asm','18446744073709318393','-45','-409927646082429297','28')]
        for suffix,dividend,divisor,quotient,remainder in expected:
            row=self.fixture(suffix);event=next(e for e in row['reviewEvidence']['events'] if e['kind']=='nonfaulting divide proof')
            self.assertEqual([event[k] for k in ['dividend','divisor','quotient','remainder']],[dividend,divisor,quotient,remainder])
            self.assertEqual(row['assertions']['flagsMask'],'0x400')
        facts=Facts()
        with self.assertRaisesRegex(AuditError,'divide by zero'):facts.step({'offset':0,'hex':'f7f1','mnemonic':'div','operands':['ecx']})

    def test_loop_bound_excludes_frozen_block_profiles_without_changing_constants(self):
        row=self.fixture('LoopAddressSizeCheck.asm')
        self.assertEqual(row['reviewEvidence']['dynamicInstructionBound'],131081)
        self.assertEqual(row['profiles']['oracle']['decision'],'admit')
        self.assertTrue(all(row['profiles'][layer]['decision']=='exclude' for layer in ['single','block500','multi500','wasm']))
        self.assertEqual(SPEC['budgets']['maximumBlocks'],10000)

    def test_broad_selection_and_deterministic_resource_packing(self):
        value=plan(self.manifest,self.identity)
        self.assertEqual(len(value['selected']),127)
        self.assertEqual((len(value['oracleShards']),len(value['executionShards'])),(2,3))
        self.assertEqual(value,plan(self.manifest,self.identity));validate_plan(value,self.manifest,self.identity)
        self.assertTrue(all(x['reservedBytes']<=8388608 for x in value['executionShards']))

    def test_large_resource_based_selection_and_hash_bound_continuation(self):
        manifest={'profile':{},'classificationSHA256':'a'*64,'fixtures':[{'path':f'f{i:04d}.asm','inputFileBytes':{'.bin':16}} for i in range(600)]}
        value=plan(manifest,'b'*64);self.assertEqual(len(value['selected']),512)
        next_value=plan(manifest,'b'*64,value['continuation']);self.assertEqual(len(next_value['selected']),88)
        self.assertFalse(set(value['selected'])&set(next_value['selected']))
        with self.assertRaises(ValueError):plan(manifest,'c'*64,value['continuation'])
        wrong=copy.deepcopy(value);wrong['executionShards'][0]['fixtures'].reverse();wrong['planSHA256']=digest({k:v for k,v in wrong.items() if k!='planSHA256'})
        with self.assertRaises(ValueError):validate_plan(wrong,manifest,'b'*64)
        fat=[{'path':str(i),'inputFileBytes':{'.lst':400000}} for i in range(20)]
        shards,fit=pack(fat,'execution');self.assertTrue(fit);self.assertGreater(len(shards),1)

    def test_exact_approval_required_before_runner_or_file_work(self):
        with tempfile.TemporaryDirectory() as directory:
            empty=Path(directory)/'unapproved.json';empty.write_bytes(canonical({'schema':1,'approvedSHA256':[]}))
            args=argparse.Namespace(admission=HERE/'register-admission.json',admission_sha256=self.identity,approvals=empty)
            with mock.patch.object(measure,'capture',side_effect=AssertionError('must never execute')):
                with self.assertRaisesRegex(ValueError,'independently reviewed'):measure.run(args)

    def test_reference_bindings_and_normalization_are_recomputed(self):
        row=self.fixture();record=self.reference(row);self.assertEqual(validate_reference_record(record,row,self.context()),record)
        for field,value in [('layer','wasm'),('rawExitCode',1),('rawOutcome','refused'),('semanticPass',False),('recipeSHA256','0'*64),('rawCaptureComplete',False)]:
            changed=copy.deepcopy(record);changed[field]=value
            with self.subTest(field=field),self.assertRaises(ValueError):validate_reference_record(changed,row,self.context())
        changed=copy.deepcopy(record);changed['observed']['state']['GPR'][0]=hex(int(changed['observed']['state']['GPR'][0],0)^0x1000)
        changed['observed']['architecturalStateSHA256']=sha(canonical(changed['observed']['state']))
        changed['comparison']=compare(row,changed['observed']);changed['comparison']['validatedStateMemoryAndTermination']=True
        validate_reference_record(changed,row,self.context())
        changed['comparison']['gprDefinedMasks']['RAX']='0x0'
        with self.assertRaises(ValueError):validate_reference_record(changed,row,self.context())

    def test_backend_observation_cannot_be_relabelled_or_exceed_work_bound(self):
        row=self.fixture();observed=self.observation(row)
        with self.assertRaisesRegex(ValueError,'backend method'):validate_observation(row,observed,'single')
        observed['method']='macos-arm64-pinned-FEX-spilled-block-return';observed['blocks']=1
        validate_observation(row,observed,'single')
        observed['blocks']=10001
        with self.assertRaisesRegex(ValueError,'work bound'):validate_observation(row,observed,'single')

    def test_one_failed_oracle_fixture_does_not_hide_valid_neighbor(self):
        rows=[self.fixture('Primary/Primary_84.asm'),self.fixture('Primary/Primary_A8.asm')]
        records=[self.reference(r) for r in rows];records[0].update(status='failure',semanticPass=False)
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'reference.jsonl';path.write_bytes(b''.join(canonical(r)+b'\n' for r in records))
            valid,errors=load_references([path],rows,self.context(),[r['path'] for r in rows])
            self.assertEqual(set(valid),{rows[1]['path']});self.assertEqual(set(errors),{rows[0]['path']})
            path.write_bytes(canonical(records[1])+b'\n'+canonical(records[1])+b'\n')
            with self.assertRaises(ValueError):load_references([path],rows,self.context(),[r['path'] for r in rows])

    def test_structurally_corrupt_shard_isolated_from_other_shard(self):
        rows=[self.fixture('Primary/Primary_84.asm'),self.fixture('Primary/Primary_A8.asm')]
        with tempfile.TemporaryDirectory() as directory:
            a,b=Path(directory)/'oracle-000.jsonl',Path(directory)/'oracle-001.jsonl'
            a.write_bytes(b'{broken\n');record=self.reference(rows[1]);record['shardID']='oracle-001';b.write_bytes(canonical(record)+b'\n')
            shards=[{'id':'oracle-000','fixtures':[rows[0]['path']]},{'id':'oracle-001','fixtures':[rows[1]['path']]}]
            valid,errors=load_references([a,b],rows,self.context(),[r['path'] for r in rows],shards=shards)
            self.assertEqual(set(valid),{rows[1]['path']});self.assertEqual(set(errors),{rows[0]['path']})

    def test_reserve_all_skeletons_before_budget_fills(self):
        rows=[self.fixture() for _ in range(15)]
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);budget=EvidenceBudget(root,maximum=100000,metadata_reserve=1024)
            ledgers=[Ledger(root/(layer+'.jsonl'),rows,layer,self.context(),budget) for layer in ['single','wasm']]
            for ledger in ledgers:
                for i in range(len(rows)):
                    if ledger.can_execute():ledger.update(i,status='failure',rawOutcome='host-signal',failureKind='host-crash',diagnostic='x'*20000)
                    else:ledger.defer(i,'no guest started: reserved slot unavailable')
            self.assertLessEqual(budget.used(),100000)
            for ledger in ledgers:self.assertEqual(len(ledger.path.read_text().splitlines()),15)
            self.assertTrue(any(r['status']=='untested' for l in ledgers for r in l.rows))

    def test_capture_deadlines_even_after_child_closes_streams(self):
        result=measure.capture([sys.executable,'-c','import os,time;os.close(1);os.close(2);time.sleep(5)'],seconds=0.2)
        self.assertEqual(result['interrupted'],'timeout');self.assertLess(result['exitCode'],0)
        result=measure.capture([sys.executable,'-c','import os;os.write(1,b"\\xff"*100000)'],maximum=1000)
        self.assertEqual(result['interrupted'],'output-limit');self.assertEqual(len(result['stdout']),1000)

    def test_raw_timeout_signal_and_nonzero_are_not_replaced_by_protocol_failure(self):
        row=self.fixture()
        for code,interrupted,kind in [(-11,None,'host-crash'),(1,None,'execution-exit'),(-9,'timeout','timeout'),(-9,'output-limit','output-limit')]:
            receipt={'exitCode':code,'interrupted':interrupted,'stdout':b'{broken','stderr':b'raw'}
            with mock.patch.object(measure,'capture',return_value=receipt):
                result=measure.execute_record(row,'oracle',Path(sys.executable),Path('/tmp'),None)
            self.assertEqual(result['failureKind'],kind);self.assertEqual(result['rawExitCode'],code);self.assertIsNone(result['semanticPass'])

    def test_success_shaped_stdout_cannot_hide_nonzero_or_refusal(self):
        row=self.fixture();wire=self.observation(row)
        data=b''.join(bytes.fromhex(x['hex']) for x in row['decodedInstructions'])
        wire.pop('codeSHA256');wire.pop('stackSHA256');wire.pop('architecturalStateSHA256')
        wire.update(codeHex=(data+bytes(65536-len(data))).hex(),stackHex=bytes(65536).hex())
        for code in [0,1]:
            with mock.patch.object(measure,'capture',return_value={'exitCode':code,'interrupted':None,'stdout':canonical(wire),'stderr':b''}):
                result=measure.execute_record(row,'oracle',Path(sys.executable),Path('/tmp'),None)
            self.assertEqual(result['status'],'pass' if code==0 else 'failure')
            self.assertEqual(result['semanticPass'],True if code==0 else None)
        with mock.patch.object(measure,'capture',return_value={'exitCode':1,'interrupted':None,'stdout':b'{"status":"refused"}','stderr':b''}):
            result=measure.execute_record(row,'oracle',Path(sys.executable),Path('/tmp'),None)
        self.assertEqual((result['status'],result['rawOutcome'],result['failureKind']),('refused','refused','translator-refusal'))

    def test_hash_and_frozen_profile_mutations_rejected(self):
        for change in ['profile','fileid','audit']:
            manifest=copy.deepcopy(self.manifest)
            if change=='profile':manifest['budgets']['maximumBlocks']=100000
            elif change=='fileid':manifest['fixtures'][0]['id']='../escape'
            else:manifest['auditScalarSHA256']='0'*64
            with tempfile.TemporaryDirectory() as directory:
                p=Path(directory)/'admission.json';p.write_bytes(canonical(manifest)+b'\n')
                with self.assertRaises(ValueError):load(p)
                with self.assertRaises(ValueError):load(p,expected_sha=self.identity)

    def test_aggregate_complete_unknowns_and_duplicate_or_stale_shards(self):
        rows=[self.fixture('Primary/Primary_84.asm'),self.fixture('Primary/Primary_A8.asm')]
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);classification=root/'classification.jsonl'
            index=[json.loads(line) for line in (HERE/'corpus-index.jsonl').read_text().splitlines()]
            classification.write_bytes(b''.join(canonical({'fixture':r['id'],'sourceSHA256':r['sha256']})+b'\n' for r in index))
            manifest=copy.deepcopy(self.manifest);manifest['fixtures']=rows;manifest['classificationSHA256']=sha(classification.read_bytes())
            admission=root/'admission.json';admission.write_bytes(canonical(manifest)+b'\n');identity=sha(admission.read_bytes())
            value=plan(manifest,identity);planned=root/'plan.json';planned.write_bytes(canonical(value)+b'\n')
            downloads=root/'downloads';downloads.mkdir()
            for kind in ['oracle','execution']:
                item=value[kind+'Shards'][0];target=downloads/item['id'];budget=EvidenceBudget(target)
                for layer in ['oracle'] if kind=='oracle' else ['single','block500','multi500','wasm']:
                    Ledger(target/'results'/(layer+'.jsonl'),rows,layer,measure.binding(identity,value,item['id']),budget)
                export(target)
            args=argparse.Namespace(admission=admission,admission_sha256=identity,plan=planned,downloads=downloads,classification=classification,output=root/'aggregate')
            self.assertEqual(cohort_ci.aggregate(args),1)
            matrix=[json.loads(line) for line in (args.output/'whole-corpus-outcomes.jsonl').read_text().splitlines()]
            self.assertEqual(len(matrix),2467*5);self.assertTrue(all(r['status']=='untested' for r in matrix))
            import shutil
            shutil.copytree(downloads/'oracle-000',downloads/'duplicate')
            with self.assertRaisesRegex(ValueError,'duplicate'):cohort_ci.aggregate(args)
            cohort_ci.aggregation_failure(root/'fallback','duplicate/stale input')
            self.assertEqual(len((root/'fallback/whole-corpus-outcomes.jsonl').read_text().splitlines()),12335)

    def test_underlying_known_failure_preserves_raw_failure(self):
        row=self.fixture();row['policy']['oracle']=[{'category':'Known_Failures','sourceSHA256':'a'*64}]
        with mock.patch.object(measure,'capture',return_value={'exitCode':-11,'interrupted':None,'stdout':b'broken','stderr':b'raw crash'}):
            result=measure.execute_record(row,'oracle',Path(sys.executable),Path('/tmp'),None)
        self.assertEqual(result['status'],'xfail');self.assertEqual(result['rawOutcome'],'host-signal');self.assertEqual(result['failureKind'],'host-crash')

    def test_reused_asset_recipe_producer_and_output_hash_are_all_bound(self):
        with tempfile.TemporaryDirectory() as directory:
            binary=Path(directory)/'fexserve';binary.write_bytes(b'fixture bytes for asset integrity test only')
            identity={'key':'unit-test-identity'}
            manifest={'identity':identity,'producer':{'repository':'intraducine/BetterJIT','workflow':'One iPhone device session','step':'build-host','outcome':'success','commit':'a'*40,'run':'1','attempt':'1'},'files':{'fexserve':{'sha256':sha(binary.read_bytes())}}}
            receipt={'mode':'verified-production-reuse','identity':identity,'manifest':manifest,'usage':{'action':'reused','manifest':manifest}}
            with mock.patch.object(cohort_assets.host_rules,'identity',return_value=identity),mock.patch.object(cohort_assets.host_rules,'environment',return_value={}):
                cohort_assets.host_check(receipt,binary)
                binary.write_bytes(b'tampered')
                with self.assertRaises(ValueError):cohort_assets.host_check(receipt,binary)
                receipt['mode']='unknown producer'
                with self.assertRaises(ValueError):cohort_assets.host_check(receipt,binary)

    def test_aggregate_recomputes_success_instead_of_trusting_pass_label(self):
        row=self.fixture()
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);classification=root/'classification.jsonl'
            index=[json.loads(line) for line in (HERE/'corpus-index.jsonl').read_text().splitlines()]
            classification.write_bytes(b''.join(canonical({'fixture':r['id'],'sourceSHA256':r['sha256']})+b'\n' for r in index))
            manifest=copy.deepcopy(self.manifest);manifest['fixtures']=[row];manifest['classificationSHA256']=sha(classification.read_bytes())
            admission=root/'admission.json';admission.write_bytes(canonical(manifest)+b'\n');identity=sha(admission.read_bytes())
            value=plan(manifest,identity);planned=root/'plan.json';planned.write_bytes(canonical(value)+b'\n');downloads=root/'downloads';downloads.mkdir()
            reference=self.reference(row,measure.binding(identity,value,'oracle-000'))
            for kind in ['oracle','execution']:
                shard=value[kind+'Shards'][0]['id'];target=downloads/shard;target.mkdir();(target/'results').mkdir()
                for layer in ['oracle'] if kind=='oracle' else ['single','block500','multi500','wasm']:
                    if layer=='oracle':record=reference
                    else:
                        record=skeleton(row,layer,measure.binding(identity,value,shard));observed=copy.deepcopy(reference['observed'])
                        observed.update(method='macos-arm64-pinned-FEX-spilled-block-return',blocks=1)
                        if layer=='wasm':
                            observed.update(method='legacy-dense-file-window-maxinst1',config={'linux':False,'windowHi':4,'maxInstructions':1,'callsViaDispatcher':False,'shared':True,'regArgs':0,'memPages':4096,'memMaxPages':0,'stateSize':1472,'gregsOff':32,'xmmOff':448,'mxcsrOff':972,'ripOff':24},lazyFlags={'representation':'backend-materialize-v1','kind':0})
                        comparison=compare(row,observed,reference['observed']);comparison['validatedStateMemoryAndTermination']=True
                        record.update(status='pass',semanticPass=True,rawOutcome='completed',rawExitCode=0,interrupted=None,failureKind=None,rawCaptureComplete=True,observed=observed,comparison=comparison,executableSHA256='a'*64,rawStdoutSHA256='b'*64,rawStderrSHA256='c'*64,capturedStdoutBytes=300000,capturedStderrBytes=0)
                    (target/'results'/(layer+'.jsonl')).write_bytes(canonical(record)+b'\n')
                export(target)
            args=argparse.Namespace(admission=admission,admission_sha256=identity,plan=planned,downloads=downloads,classification=classification,output=root/'aggregate')
            self.assertEqual(cohort_ci.aggregate(args),0)
            path=downloads/'execution-000/results/single.jsonl';record=json.loads(path.read_text());record['observed']['state']['GPR'][1]='0x1234';record['observed']['architecturalStateSHA256']=sha(canonical(record['observed']['state']));path.write_bytes(canonical(record)+b'\n');export(path.parent.parent)
            with self.assertRaises(ValueError):cohort_ci.aggregate(args)

    def test_no_directory_scan_executes_unclassified_input(self):
        source=(HERE/'measure_cohort.py').read_text()
        self.assertIn('approved=args.approvals',source)
        approved=read_json(HERE/'reviewed-admissions.json')[0]['approvedSHA256']
        self.assertEqual(approved,[self.identity])
        self.assertEqual(load(HERE/'register-admission.json',self.identity,approved=HERE/'reviewed-admissions.json')[1],self.identity)

    def test_every_ledger_row_has_object_root_and_integer_schema(self):
        for invalid in [[],None,True,False,0,1.5,'scalar']:
            with self.subTest(root=invalid),self.assertRaisesRegex(ValueError,'JSON object'):parse_record(canonical(invalid))
            with tempfile.TemporaryDirectory() as directory:
                path=Path(directory)/'document.json';path.write_bytes(canonical(invalid))
                with self.assertRaisesRegex(ValueError,'JSON object'):read_json(path)
        valid=self.reference(self.fixture())
        for field,invalid in [('schema',True),('schema',3.0),('schema','3'),('schema',2),('fixture',[]),('layer',None),('shardID',{}),('layer','foreign')]:
            changed=copy.deepcopy(valid);changed[field]=invalid
            with self.subTest(field=field,value=invalid),self.assertRaises(ValueError):parse_record(canonical(changed))

    def test_nonobject_oracle_shard_preserves_valid_neighbor_runner_progress(self):
        # Synthetic reference files and a mocked callback test routing only.
        # No machine instructions or guest executables are invoked.
        for invalid in [[],None,True,1.5,'scalar']:
            with self.subTest(root=invalid),tempfile.TemporaryDirectory() as directory:
                root=Path(directory);manifest,identity,value,args=self.runner_case(root,65)
                first,second=value['oracleShards'];self.assertEqual(len(second['fixtures']),1)
                good=next(r for r in manifest['fixtures'] if r['path']==second['fixtures'][0])
                bad_path=root/(first['id']+'.jsonl');good_path=root/(second['id']+'.jsonl')
                bad_path.write_bytes(canonical(invalid)+b'\n')
                context=measure.binding(identity,value,second['id']);good_path.write_bytes(canonical(self.reference(good,context))+b'\n')
                args.oracle_ledgers=[bad_path,good_path];calls=[]
                def completed(row,layer,*unused):
                    calls.append((row['path'],layer))
                    return {'status':'pass','semanticPass':True,'rawOutcome':'completed','failureKind':None,'rawExitCode':0,'interrupted':None}
                with mock.patch.object(measure,'validate_inputs',return_value={}),mock.patch.object(measure,'reference_capabilities',return_value={'system':'Darwin','machine':'arm64','referenceCPUFlags':[]}),mock.patch.object(measure,'execute_record',side_effect=completed),mock.patch.object(measure,'capture',side_effect=AssertionError('guest execution forbidden in integrity test')):
                    self.assertEqual(measure.run(args),1)
                self.assertEqual(calls,[(good['path'],layer) for layer in ['single','block500','multi500','wasm']])
                for layer in ['single','block500','multi500','wasm']:
                    records=[json.loads(line) for line in (args.output/'results'/(layer+'.jsonl')).read_text().splitlines()]
                    self.assertEqual(len(records),17);self.assertEqual(records[-1]['status'],'pass')
                    self.assertTrue(all(r['status']=='untested' and r['rawOutcome']=='not-started' and r['failureKind']=='reference-unavailable' for r in records[:-1]))

    def test_nonobject_execution_replies_are_bounded_failures_then_neighbor_completes(self):
        row=self.fixture();wire=canonical(self.wire(row))
        for invalid in [[],None,True,1.5,'scalar']:
            for code in [0,1,77]:
                receipts=[{'exitCode':code,'interrupted':None,'stdout':canonical(invalid),'stderr':b''},
                          {'exitCode':0,'interrupted':None,'stdout':wire,'stderr':b''}]
                with self.subTest(root=invalid,exit=code),mock.patch.object(measure,'capture',side_effect=receipts):
                    failed=measure.execute_record(row,'oracle',Path(sys.executable),Path('/tmp'),None)
                    neighbor=measure.execute_record(row,'oracle',Path(sys.executable),Path('/tmp'),None)
                self.assertEqual(failed['status'],'failure');self.assertEqual(failed['rawExitCode'],code)
                self.assertEqual(failed['failureKind'],'protocol-invalid' if code==0 else 'execution-exit')
                self.assertIsNone(failed['semanticPass']);self.assertIn('JSON object',failed['reason'])
                self.assertLess(len(canonical(failed)),32768);self.assertEqual(neighbor['status'],'pass')
        for field in ['config','lazyFlags']:
            observed=self.observation(row);observed[field]=[]
            with self.assertRaisesRegex(ValueError,'JSON object'):measure.compact_observation(observed)

    def test_nonobject_indexed_aggregate_rows_produce_complete_cli_fallback(self):
        for invalid in [[],None,True,1.5,'scalar']:
            with self.subTest(root=invalid),tempfile.TemporaryDirectory() as directory:
                root=Path(directory);manifest,identity,value,args=self.runner_case(root,2)
                artifact=root/'downloads/oracle-000';(artifact/'results').mkdir(parents=True)
                (artifact/'results/oracle.jsonl').write_bytes(canonical(invalid)+b'\n');export(artifact)
                result=subprocess.run([sys.executable,str(HERE/'cohort_ci.py'),'aggregate','--admission',str(args.admission),'--admission-sha256',identity,'--plan',str(args.plan),'--downloads',str(root/'downloads'),'--classification',str(root/'not-reached.jsonl'),'--output',str(root/'aggregate')],capture_output=True,text=True,timeout=10)
                self.assertEqual(result.returncode,1);self.assertNotIn('AttributeError',result.stderr)
                failure=json.loads((root/'aggregate/aggregation-failure.json').read_text());self.assertIn('JSON object',failure['reason'])
                records=[json.loads(line) for line in (root/'aggregate/whole-corpus-outcomes.jsonl').read_text().splitlines()]
                self.assertEqual(len(records),12335);self.assertTrue(all(r['status']=='untested' and r['semanticPass'] is None and r['failureKind']=='aggregation-integrity' for r in records))

    def test_nested_files_json_is_indexed_and_cannot_bypass_export_or_transfer_cap(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);(root/'extra').mkdir();nested=root/'extra/files.json';nested.write_bytes(b'{}')
            index=export(root);self.assertIn('extra/files.json',index);self.assertEqual(cohort_ci.verify_export(root),index)
            with nested.open('wb') as stream:stream.truncate(9*1024*1024)
            with self.assertRaisesRegex(ValueError,'export exceeds'):export(root)
            with self.assertRaisesRegex(ValueError,'export cap'):cohort_ci.verify_export(root)
            # Recreate the formerly accepted unindexed nested-file artifact.
            (root/'files.json').write_bytes(b'{}')
            with self.assertRaisesRegex(ValueError,'export cap'):cohort_ci.verify_export(root)

    def test_aggregate_counts_root_index_and_rejects_oversized_nested_transfer(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);manifest,identity,value,args=self.runner_case(root,2)
            classification=root/'classification.jsonl'
            index=[json.loads(line) for line in (HERE/'corpus-index.jsonl').read_text().splitlines()]
            classification.write_bytes(b''.join(canonical({'fixture':r['id'],'sourceSHA256':r['sha256']})+b'\n' for r in index))
            manifest['classificationSHA256']=sha(classification.read_bytes());args.admission.write_bytes(canonical(manifest)+b'\n');identity=sha(args.admission.read_bytes());value=plan(manifest,identity);args.plan.write_bytes(canonical(value)+b'\n')
            artifact=root/'downloads/oracle-000';budget=EvidenceBudget(artifact)
            Ledger(artifact/'results/oracle.jsonl',manifest['fixtures'],'oracle',measure.binding(identity,value,'oracle-000'),budget);export(artifact)
            aggregation=argparse.Namespace(admission=args.admission,admission_sha256=identity,plan=args.plan,downloads=root/'downloads',classification=classification,output=root/'aggregate')
            self.assertEqual(cohort_ci.aggregate(aggregation),1)
            summary=json.loads((aggregation.output/'summary.json').read_text())
            self.assertEqual(summary['artifacts'][0]['bytes'],sum(p.stat().st_size for p in artifact.rglob('*') if p.is_file()))
            (artifact/'extra').mkdir()
            with (artifact/'extra/files.json').open('wb') as stream:stream.truncate(9*1024*1024)
            with self.assertRaisesRegex(ValueError,'export cap'):cohort_ci.aggregate(aggregation)

    def test_large_refusal_and_nonzero_observations_are_compacted_before_storage(self):
        row=self.fixture()
        for code,status in [(1,'refused'),(7,'failure')]:
            wire=self.wire(row);wire.update(status=status,diagnostic='x'*100000,reason='r'*100000)
            payload=canonical(wire);self.assertLess(len(payload),524288)
            with mock.patch.object(measure,'capture',return_value={'exitCode':code,'interrupted':None,'stdout':payload,'stderr':b'raw stderr'}):
                result=measure.execute_record(row,'oracle',Path(sys.executable),Path('/tmp'),None)
            self.assertEqual(result['rawOutcome'],'refused' if status=='refused' else 'nonzero-exit')
            self.assertEqual(result['failureKind'],'translator-refusal' if status=='refused' else 'execution-exit')
            self.assertEqual(result['rawExitCode'],code);self.assertEqual(result['rawStdoutSHA256'],sha(payload))
            self.assertLessEqual(len(result['reason']),2000);self.assertNotIn('diagnostic',result['observed'])
            with tempfile.TemporaryDirectory() as directory:
                root=Path(directory);ledger=Ledger(root/'oracle.jsonl',[row],'oracle',self.context(),EvidenceBudget(root))
                self.assertTrue(ledger.persist_result(0,result));self.assertLess(len(ledger.bytes()),32768)

    def test_oversized_detailed_failure_retains_raw_outcome_and_all_neighbor_profiles(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);manifest,identity,value,args=self.runner_case(root,2);rows=manifest['fixtures']
            context=measure.binding(identity,value,'oracle-000');path=root/'oracle-000.jsonl'
            path.write_bytes(b''.join(canonical(self.reference(row,context))+b'\n' for row in rows));args.oracle_ledgers=[path]
            calls=[]
            def completed(row,layer,*unused):
                calls.append((row['path'],layer))
                if row['path']==rows[0]['path']:
                    return {'status':'refused','semanticPass':None,'rawOutcome':'refused','failureKind':'translator-refusal','rawExitCode':1,'interrupted':None,'diagnostic':'x'*100000,'rawStdoutSHA256':'a'*64,'rawStderrSHA256':'b'*64,'executableSHA256':'c'*64,'capturedStdoutBytes':400000,'capturedStderrBytes':0,'rawCaptureComplete':True}
                return {'status':'pass','semanticPass':True,'rawOutcome':'completed','failureKind':None,'rawExitCode':0,'interrupted':None}
            with mock.patch.object(measure,'validate_inputs',return_value={}),mock.patch.object(measure,'reference_capabilities',return_value={'system':'Darwin','machine':'arm64','referenceCPUFlags':[]}),mock.patch.object(measure,'execute_record',side_effect=completed),mock.patch.object(measure,'capture',side_effect=AssertionError('guest execution forbidden in integrity test')):
                self.assertEqual(measure.run(args),1)
            self.assertEqual(len(calls),8)
            for layer in ['single','block500','multi500','wasm']:
                records=[json.loads(line) for line in (args.output/'results'/(layer+'.jsonl')).read_text().splitlines()]
                self.assertEqual(len(records),2);failed,neighbor=records
                self.assertEqual((failed['status'],failed['rawOutcome'],failed['rawExitCode'],failed['failureKind']),('refused','refused',1,'translator-refusal'))
                self.assertEqual(failed['evidenceFailureKind'],'record-budget');self.assertNotIn('diagnostic',failed)
                self.assertEqual(neighbor['status'],'pass')

    def test_lost_success_detail_is_evidence_failure_without_invented_semantic_failure(self):
        row=self.fixture()
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);ledger=Ledger(root/'results.jsonl',[row],'single',self.context(),EvidenceBudget(root))
            self.assertFalse(ledger.persist_result(0,{'status':'pass','semanticPass':True,'rawOutcome':'completed','rawExitCode':0,'interrupted':None,'failureKind':None,'diagnostic':'x'*100000}))
            stored=json.loads(ledger.path.read_text())
            self.assertEqual((stored['status'],stored['rawOutcome'],stored['rawExitCode']),('failure','completed',0))
            self.assertEqual(stored['failureKind'],'evidence-budget');self.assertIsNone(stored['semanticPass'])


if __name__=='__main__':unittest.main()
