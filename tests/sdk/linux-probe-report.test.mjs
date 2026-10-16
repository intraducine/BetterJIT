// SPDX-License-Identifier: GPL-3.0-or-later
import test from 'node:test';import assert from 'node:assert/strict';
import P from './linux-host/sparse-linux-probe-report.cjs';
import Bootstrap from './linux-host/sparse-linux-bootstrap.cjs';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
const entry=0x12340000n,stackPointer=0x7ffff000n;
const image=bytes=>({entry,stackPointer,codes:[{address:entry,bytes:Uint8Array.from(bytes)}],space:{executableSnapshot(){throw Error('Must not read guest mapping');}}});
test('probe completion uses the enforced execution budget independently of trace length',()=>{
 const budget=P.executionBudget(),result={status:'unsupported-instruction',guestExitCode:null,executedWasmSteps:653};
 assert.deepEqual(budget,{maximumSteps:20000,deadlineMs:30000,translationProfile:'default',maximumTranslationUnits:256,maximumTranslationBytes:2097152});P.validateCompletion(result,2,budget);
 P.validateCompletion({...result,executedWasmSteps:20000},2,budget);
 for(const executedWasmSteps of [0,1,20001,1.5,NaN,Infinity])assert.throws(()=>P.validateCompletion({...result,executedWasmSteps},2,budget),assert.AssertionError);
 for(const change of [{status:'step-limit'},{status:'completed'},{guestExitCode:0}])assert.throws(()=>P.validateCompletion({...result,...change},2,budget),assert.AssertionError);
 for(const maximum of [0,-1,20001,1.5,NaN,Infinity])assert.throws(()=>P.executionBudget(maximum),assert.AssertionError);
});
test('the host Wine profile is explicit and cannot raise fixed count, byte, step or deadline maxima',()=>{
 assert.deepEqual(P.executionBudget(undefined,'host-wine-probe-v1'),{maximumSteps:20000,deadlineMs:30000,translationProfile:'host-wine-probe-v1',maximumTranslationUnits:512,maximumTranslationBytes:2097152});
 for(const profile of ['__proto__','constructor','toString','host-wine-probe-v2',512,null,{}, {maximumUnits:4096}])assert.throws(()=>P.executionBudget(20000,profile),/profile/);
 assert.throws(()=>P.executionBudget(20001,'host-wine-probe-v1'),/step budget/);
 assert.equal(Bootstrap.selectInputs('--synthetic').translationProfile,undefined);
 assert.throws(()=>Bootstrap.selectInputs('--synthetic','--host-wine-probe-v1'),/prepared-root/);
 for(const flag of ['--maximum-translations=999999','--host-wine-probe-v2',512,{}])assert.throws(()=>Bootstrap.selectInputs(undefined,flag),/profile option/);
});
test('host telemetry preserves scope and unmeasured fields and refuses arbitrary strings or totals',()=>{
 const context={resourceSamples:{failure:{host:{cacheEntries:512,receivedTranslationBytes:148907},node:{rssBytes:123,parentIsolateHeapUsedBytes:NaN},native:{source:'/private/secret',rssBytes:456,retainedIRBytes:999},system:{freeBytes:-1},secret:'TOKEN=secret'}},
  cleanup:{hostClosed:true,cacheEntries:0,guestQuiescenceAcknowledged:false},nativeProcess:{lifecycle:{closeRequested:true,closed:true}}};
 const t=P.resourceTelemetryInfo(context);assert.equal(t.samples.failure.host.receivedTranslationBytes,148907);assert.equal(t.samples.failure.native.source,'unavailable');assert.equal(t.samples.failure.native.retainedIRBytes,null);assert.equal(t.samples.failure.node.compiledWebAssemblyBytes,null);assert.equal(t.samples.failure.node.parentIsolateHeapUsedBytes,null);assert.equal(t.samples.failure.system.freeBytes,null);assert.equal(t.cleanup.nativeChildClosed,true);assert.equal(t.cleanup.guestQuiescenceAcknowledged,false);assert(!JSON.stringify(t).includes('TOKEN'));assert(!JSON.stringify(t).includes('/private'));
 const report=P.failureReport({...context,executionBudget:P.executionBudget(20000,'host-wine-probe-v1')},Error('cap'));assert.equal(report.executionBudget.maximumTranslationUnits,512);assert.equal(report.resourceTelemetry.cleanup.cacheEntries,0);
});
test('unavailable host and native memory APIs retain null measurements',()=>{
 const free=os.freemem;try{os.freemem=()=>{throw Error('Unavailable host memory API');};
  const snapshot=P.resourceSnapshot(undefined,{readMemory(){throw Error('Unavailable native memory API');}}),t=P.resourceTelemetryInfo({resourceSamples:{baseline:snapshot}});
  assert.equal(t.samples.baseline.system.freeBytes,null);assert.equal(t.samples.baseline.native.rssBytes,null);assert.equal(t.samples.baseline.native.source,'unavailable');assert(t.samples.baseline.node.rssBytes>0);
 }finally{os.freemem=free;}
});
test('native translation counts allow reuse while preserving single-instruction and rejection invariants',()=>{
 const native={units:100,guestInsts:100,failed:1};P.validateNative(native,653);P.validateNative(native,100);
 for(const change of [{units:0,guestInsts:0},{units:654,guestInsts:654},{units:1.5,guestInsts:1.5},{guestInsts:99},{failed:0},{failed:2}])
  assert.throws(()=>P.validateNative({...native,...change},653),assert.AssertionError);
});
test('entry transfer is checked at first MOV, independently of later RDI',()=>{
 const check=P.entryStackCheck(image([0x48,0x89,0xe7]));P.observeEntry(check,{status:0,rip:entry+3n},stackPointer);
 assert.equal(check.verified,true);assert.equal(check.observedRDI,stackPointer);
});
test('incorrect initial transfer and incorrect first continuation still fail',()=>{
 for(const [last,rdi]of [[{status:0,rip:entry+3n},1n],[{status:0,rip:entry+4n},stackPointer],[{status:2,rip:entry+3n},stackPointer]]){
  const check=P.entryStackCheck(image([0x48,0x89,0xe7]));assert.throws(()=>P.observeEntry(check,last,rdi),assert.AssertionError);assert.equal(check.verified,false);
 }
});
test('short, missing and different entry bytes remain explicitly unverified without extra reads',()=>{
 for(const bytes of [[],[0x48],[0x48,0x89],[0x90,0x90,0x90],[0x0f,0x0b]]){
  const check=P.entryStackCheck(image(bytes));P.observeEntry(check,{status:0,rip:entry+3n},stackPointer);
  assert.equal(check.applicable,false);assert.equal(check.verified,false);
 }
});
test('failure JSON is bounded, serializable and excludes paths, stacks and memory dumps',()=>{
 const error=Object.assign(Error('cannot open /workspace/private/secret.bin https://host.invalid/?token=PRIVATE '+ 'x'.repeat(100000)),{code:'ENOENT'});
 error.actual={};error.actual.self=error.actual;error.expected=1n<<100000n;error.stack='SECRET STACK';
 const progress={stage:'test',rip:entry,rdi:1n,instruction:Array(10000).fill(0x90),steps:Array.from({length:10000},()=>({rip:entry,status:0})),memory:new Uint8Array(1000000)};
 const report=P.failureReport({stage:'execute',input:{path:'/workspace/private',elf:Uint8Array.of(1),interpreter:Uint8Array.of(2)},progress,native:{units:3},cfg:{buildID:'test',coverageVersion:17}},error);
 const text=P.stringify(report);assert(text.length<12000);assert(!/secret\.bin|PRIVATE|SECRET STACK|1000000|workspace/.test(text));
 assert.equal(report.status,'probe-failed');assert.equal(report.error.expected,'[integer omitted]');assert.equal(report.progress.instruction.length,15);assert.equal(report.progress.steps.length,64);assert.equal(JSON.parse(text).progress.rdi,'0x1');
});
test('subprocess diagnostics distinguish startup failures from a confirmed intended kill',()=>{
 const startup=P.subprocessInfo({status:1,signal:null,stderr:'Error: preload failed'},{});
 assert.equal(startup.classification,'before-native-wrapper');assert.equal(startup.fault.killSent,false);
 const fault={phase:'kill-sent',stepRequests:3,killPointObserved:true,killRequested:true,killSent:true};
 for(const reportExists of [false,true]){
  const info=P.subprocessInfo({status:1,signal:null},{reportExists,wrapperStarted:true,fault});
  assert.equal(info.classification,reportExists?'kill-confirmed-report-present':'kill-confirmed-report-missing');assert.equal(info.fault.stepRequests,3);
 }
 const missing=P.subprocessInfo({status:null,error:Object.assign(Error('spawn /private/secret ENOENT'),{code:'ENOENT'})});
 assert.equal(missing.classification,'subprocess-startup-failed');assert.equal(missing.error.code,'ENOENT');
 const timeout=P.subprocessInfo({status:null,signal:'SIGTERM',error:Object.assign(Error('timed out'),{code:'ETIMEDOUT'})},{wrapperStarted:true,fault});
 assert.equal(timeout.classification,'subprocess-control-error');assert.equal(timeout.fault.killSent,true);assert.equal(timeout.signal,'SIGTERM');
});
test('real child startup stderr is bounded and removes host paths, credentials and stack frames',()=>{
 const child=spawnSync(process.execPath,['--eval',"throw Error('EARLY_CHILD_STARTUP /private/secret/file API_TOKEN=TOPSECRET token: OTHERSECRET https://hidden.invalid/?secret=value')"],{encoding:'utf8'});
 const info=P.subprocessInfo(child);assert.equal(info.status,1);assert.match(info.stderr,/EARLY_CHILD_STARTUP/);
 assert(!/TOPSECRET|OTHERSECRET|hidden\.invalid|secret\/file|\n\s*at\s/.test(info.stderr));assert(info.stderr.length<=1024);
 const report=P.contractFailure('native-child-died',[{mode:'calls',steps:6}],info,Error('Expected report absent'));
 assert.equal(report.status,'contract-failed');assert.equal(report.completedCases[0].steps,6);assert(P.stringify(report).length<4000);
 const quoted=P.subprocessInfo({status:1,stderr:"Error: cannot open '/private/highly confidential's folder/key'\n at load (/private/secret.js:1)"});
 assert(!/confidential|folder|secret\.js|\n\s*at\s/.test(quoted.stderr));assert.match(quoted.stderr,/cannot open/);
 assert(P.subprocessInfo({stderr:'x'.repeat(1000000)}).stderr.length<=1024);
});
