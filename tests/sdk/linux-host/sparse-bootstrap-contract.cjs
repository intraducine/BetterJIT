// SPDX-License-Identifier: GPL-3.0-or-later
// Probe harness regressions; deliberate test-only corruption/death must fail.
const fs=require('fs'),path=require('path'),os=require('os'),assert=require('node:assert/strict'),{spawnSync}=require('child_process');
const {probe,inputs,execute}=require('./sparse-linux-bootstrap.cjs'),P=require('./sparse-linux-probe-report.cjs');
const binary=path.resolve(process.argv[2]),directory=fs.mkdtempSync(path.join(os.tmpdir(),'betterjit-probe-')),records=[];
let phase='controls',subprocess;
const quote=s=>"'"+s.replace(/'/g,"'\\''")+"'";
function save(report){const text=P.stringify(report);if(process.argv[3]){fs.writeFileSync(process.argv[3]+'.tmp',text);fs.renameSync(process.argv[3]+'.tmp',process.argv[3]);}return text;}
async function main(){try{
 for(const mode of ['calls','extensions','nops','clobber','different-entry']){
  phase=mode;
  const input=inputs('--synthetic-'+(mode==='clobber'||mode==='different-entry'?'calls':mode));
  if(mode==='clobber'){input.interpreter.set([0x48,0xbf,1,0,0,0,0,0,0,0,0x0f,0x0b],0x100f);input.expectedSteps=input.minimumSteps=7;}
  if(mode==='different-entry'){input.interpreter.set([0x90,0x90,0x90],0x1000);input.expectedSteps=input.minimumSteps=8;}
  const report=await probe(()=>input,path.join(directory,mode+'.json'));
  assert.equal(report.result.executedWasmSteps,input.expectedSteps);assert.equal(report.result.broker.requests,4);
  assert.equal(report.result.entryStackValidation.applicable,mode!=='different-entry');assert.equal(report.result.entryStackValidation.verified,mode!=='different-entry');
  assert.equal(report.result.rdiAfter,mode==='clobber'?1n:mode==='different-entry'?0n:report.result.stackPointer);
  records.push({mode,steps:report.result.executedWasmSteps,entryStackValidation:report.result.entryStackValidation,rdiAfter:report.result.rdiAfter});
 }
 const cli=path.join(__dirname,'sparse-linux-bootstrap.cjs');
 phase='native-start-failed';
 const missingOutput=path.join(directory,'missing-native.json'),missing=spawnSync(process.execPath,[cli,path.join(directory,'absent-native'),missingOutput,'--synthetic-calls'],{encoding:'utf8',timeout:15000});
 subprocess=P.subprocessInfo(missing,{reportExists:fs.existsSync(missingOutput)});
 assert.equal(missing.status,1);const missingReport=JSON.parse(fs.readFileSync(missingOutput));assert.equal(missingReport.status,'probe-failed');assert.equal(missingReport.stage,'native-start');assert(!JSON.stringify(missingReport).includes(directory));records.push({mode:'native-start-failed',report:missingReport});
 // Corrupt the initial RSP before spawning the guest worker. The real entry
 // MOV executes; its first-step check must catch the incorrect transfer.
 const corrupt=path.join(directory,'corrupt.cjs');fs.writeFileSync(corrupt,`const t=require('worker_threads'),W=t.Worker;t.Worker=class extends W{
 constructor(file,options){super(file,options);if(String(file).endsWith('/sparse-linux-bootstrap-kernel.cjs'))this.probeCfg=options.workerData.cfg;}
 emit(event,message,...rest){if(event==='message'&&message?.op==='spawn'&&this.probeCfg){const c=this.probeCfg,s=message.spec;new DataView(s.mem.buffer).setBigUint64(s.tb+c.ctx+c.gregsOff+32,1n,true);}return super.emit(event,message,...rest);}};`);
 const wrongOutput=path.join(directory,'wrong-entry.json'),wrong=spawnSync(process.execPath,['--require',corrupt,cli,binary,wrongOutput,'--synthetic-calls'],{encoding:'utf8',timeout:15000});
 phase='wrong-initial-transfer';subprocess=P.subprocessInfo(wrong,{reportExists:fs.existsSync(wrongOutput)});
 assert.equal(wrong.status,1,P.stringify(subprocess));assert(subprocess.reportExists,'Incorrect-transfer subprocess did not retain its report');const wrongReport=JSON.parse(fs.readFileSync(wrongOutput));
 assert.equal(wrongReport.status,'probe-failed');assert.match(wrongReport.error.message,/Entry MOV RDI,RSP/);assert.equal(wrongReport.progress.executedWasmSteps,1);
 assert.equal(wrongReport.progress.entryStackValidation.verified,false);assert.equal(wrongReport.progress.entryStackValidation.observedRDI,'0x1');records.push({mode:'wrong-initial-transfer',report:wrongReport});
 // Kill the actual native child at its third step request. Its statistics
 // endpoint is then unavailable; the failure report must retain prior progress.
 const pid=path.join(directory,'native.pid'),wrapper=path.join(directory,'native.sh');fs.writeFileSync(wrapper,'#!/bin/sh\nprintf %s "$$" > '+quote(pid)+'\nexec '+quote(binary)+' "$@"\n',{mode:0o700});
 const events=path.join(directory,'kill-events.json'),kill=path.join(directory,'kill.cjs');
 fs.writeFileSync(kill,`const fs=require('fs'),assert=require('node:assert/strict'),{isMainThread}=require('worker_threads');
 const fault={phase:'preload-start',stepRequests:0,killPointObserved:false,killRequested:false,killSent:false};
 const mark=phase=>{fault.phase=phase;if(isMainThread)fs.writeFileSync(${JSON.stringify(events)},JSON.stringify(fault));};
 mark('preload-start');const original=global.fetch;global.fetch=(url,...args)=>{
 if(String(url).includes('/xlat/step?')){fault.stepRequests++;mark('translation-request');if(fault.stepRequests===3){
 fault.killPointObserved=true;mark('kill-point');const target=Number(fs.readFileSync(${JSON.stringify(pid)},'utf8'));
 assert(Number.isSafeInteger(target)&&target>1&&target!==process.pid,'Fault target must be the owned native child');
 fault.killRequested=true;mark('kill-requested');process.kill(target,'SIGTERM');fault.killSent=true;mark('kill-sent');}}
 return original(url,...args);};mark('preload-ready');`);
 phase='native-child-died';
 const deadOutput=path.join(directory,'dead.json'),dead=spawnSync(process.execPath,['--require',kill,cli,wrapper,deadOutput,'--synthetic-calls'],{encoding:'utf8',timeout:15000});
 const state={reportExists:fs.existsSync(deadOutput),wrapperStarted:fs.existsSync(pid)};
 subprocess=P.subprocessInfo(dead,state);
 try{if(fs.existsSync(events))subprocess=P.subprocessInfo(dead,{...state,fault:JSON.parse(fs.readFileSync(events))});}
 catch(error){subprocess.faultReadError=P.errorInfo(error);}
 const executable=file=>{try{fs.accessSync(file,fs.constants.X_OK);return true;}catch{return false;}};
 subprocess.fixture={platform:process.platform,architecture:process.arch,nodeVersion:process.version,nativeExecutable:executable(binary),wrapperExecutable:executable(wrapper),wrapperStrategy:'POSIX shell exec'};
 save({...P.contractFailure(phase,records,subprocess,Error('Validating retained native-death report')),status:'contract-checkpoint'});
 assert.equal(dead.status,1,P.stringify(subprocess));assert(subprocess.fault.killSent,'Owned native kill was not confirmed');assert.equal(subprocess.fault.stepRequests,3);assert(subprocess.reportExists,'Native-death subprocess did not retain its report');
 const deadReport=JSON.parse(fs.readFileSync(deadOutput));
 assert.equal(deadReport.status,'probe-failed');assert.equal(deadReport.nativeAvailable,false);assert(deadReport.progress.executedWasmSteps>=1);assert(deadReport.nativeError);records.push({mode:'native-child-died',subprocess,report:deadReport});
 // An assertion after a completed kernel result must preserve that result.
 phase='postcondition-failed';subprocess=undefined;const bad=inputs('--synthetic-calls');bad.expectedSteps=7;const badOutput=path.join(directory,'postcondition.json');
 await assert.rejects(probe(()=>bad,badOutput),assert.AssertionError);const badReport=JSON.parse(fs.readFileSync(badOutput));
 assert.equal(badReport.status,'probe-failed');assert.equal(badReport.result.executedWasmSteps,6);assert.equal(badReport.nativeAvailable,true);records.push({mode:'postcondition-failed',report:badReport});
 // A finite guest loop reuses four translations, exceeding the trace-history
 // length without approaching the actual execution budget. This is not Wine.
 phase='cached-loop';const loop=inputs('--synthetic');loop.minimumSteps=258;
 loop.interpreter.set([0x48,0x89,0xe7,0xb8,0x80,0,0,0,0x48,0x83,0xe8,1,0x75,0xfa,0x0f,0x0b],0x1000);
 loop.evidence='Synthetic finite 128-iteration register loop ending at UD2; not Wine.';
 const loopReport=await probe(()=>loop,path.join(directory,'cached-loop.json'));
 assert.equal(loopReport.result.executedWasmSteps,258);assert.equal(loopReport.native.units,4);assert.equal(loopReport.native.guestInsts,4);assert.equal(loopReport.native.failed,1);
 assert.equal(loopReport.result.raxAfter,0n);assert.equal(loopReport.result.steps.length,64);assert.equal(loopReport.result.executionBudget.maximumSteps,20000);
 records.push({mode:'cached-loop',steps:loopReport.result.executedWasmSteps,native:loopReport.native,executionBudget:loopReport.result.executionBudget});
 // The same real worker must reject exhaustion, retaining partial progress
 // rather than claiming that a still-running loop reached an unsupported stop.
 phase='step-budget-exhausted';const limitedOutput=path.join(directory,'step-budget.json');
 await assert.rejects(probe(()=>({...loop,maximumSteps:64}),limitedOutput),/Sparse instruction limit exceeded/);
 const limited=JSON.parse(fs.readFileSync(limitedOutput));assert.equal(limited.status,'probe-failed');assert.equal(limited.result,null);
 assert.equal(limited.progress.executedWasmSteps,64);assert.equal(limited.executionBudget.maximumSteps,64);assert.equal(limited.native.units,4);assert.equal(limited.native.failed,0);
 records.push({mode:'step-budget-exhausted',report:limited});
 // Cross the actual dynamic-kernel/worker/mailbox boundary with operation11,
 // then quiesce at UD2. The direct memory matrix separately checks bytes/flags.
 phase='memory-add';const memoryAdd=inputs('--synthetic'),dataAddress=require('./sparse-linux-image-fixture.cjs').BASE+0x3180n,addressBytes=new Uint8Array(8);
 new DataView(addressBytes.buffer).setBigUint64(0,dataAddress,true);memoryAdd.minimumSteps=4;memoryAdd.evidence='Synthetic ELF interpreter with one non-LOCK ADD memory through the production sparse kernel; not Wine.';
 memoryAdd.interpreter.set([0x48,0x89,0xe7,0x48,0xb8,...addressBytes,0x48,0xba,1,0,0,0,0,0,0,0,0x48,1,0x10,0x0f,0x0b],0x1000);
 const memoryAddReport=await probe(()=>memoryAdd,path.join(directory,'memory-add.json')),added=memoryAddReport.result;
 assert.equal(added.executedWasmSteps,4);assert.equal(added.broker.requests,1);assert.equal(added.broker.ok,1);assert.equal(added.raxAfter,dataAddress);assert.equal(added.rdxAfter,1n);
 assert.equal(added.nativeRequestsDrained,true);assert.equal(added.guestBacking.ownedPayloadBytes,0);assert.equal(added.guestAccessQuiescenceAcknowledged,true);
 records.push({mode:'memory-add',steps:added.executedWasmSteps,broker:added.broker,native:memoryAddReport.native});
 // Run register-only shifts through the actual dynamic-kernel worker, including
 // a masked-zero CL count and dword upper clearing. No memory shift is used.
 phase='register-shifts';const shifts=inputs('--synthetic');shifts.minimumSteps=8;
 shifts.interpreter.set([0x48,0x89,0xe7,0x48,0xb8,1,0,0,0,0,0,0,0x80,0x48,0xd1,0xe8,0xb9,0x40,0,0,0,0x48,0xd3,0xe8,0xc1,0xe0,0x20,0x48,0xba,0xf7,0xff,0xff,0xff,0xff,0xff,0xff,0xff,0x48,0xc1,0xfa,2,0x0f,0x0b],0x1000);
 shifts.evidence='Synthetic ELF interpreter with register SHL/SHR/SAR through the production sparse kernel; not Wine.';
 const shiftReport=await probe(()=>shifts,path.join(directory,'register-shifts.json')),shifted=shiftReport.result;
 assert.equal(shifted.executedWasmSteps,8);assert.equal(shifted.raxAfter,0n);assert.equal(shifted.rdxAfter,0xfffffffffffffffdn);assert.equal(shifted.broker.requests,0);
 assert.equal(shifted.nativeRequestsDrained,true);assert.equal(shifted.guestBacking.ownedPayloadBytes,0);assert.equal(shifted.guestAccessQuiescenceAcknowledged,true);
 records.push({mode:'register-shifts',steps:shifted.executedWasmSteps,broker:shifted.broker,native:shiftReport.native});
 // The same register JMP runs in the dynamic production kernel and worker.
 // Revoke the separate target page after RPC to prove typed rollback exits
 // once, rather than retrying a restored RIP until the instruction budget.
 for(const revoked of [false,true]){
  phase=revoked?'register-jump-revoked':'register-jump';const jump=inputs('--synthetic'),F=require('./sparse-linux-image-fixture.cjs');
  jump.minimumSteps=3;jump.maximumSteps=8;jump.testRevokeJumpBeforeFinish=revoked;
  jump.evidence='Synthetic ELF register-indirect JMP through the production sparse kernel and worker; test-only target revocation, not Wine.';
  const v=new DataView(jump.interpreter.buffer);v.setBigUint64(64+56+32,0x1100n,true);v.setBigUint64(64+56+40,0x2000n,true);
  const target=new Uint8Array(8);new DataView(target.buffer).setBigUint64(0,F.BASE+0x2000n,true);
  jump.interpreter.set([0x48,0x89,0xe7,0x48,0xb8,...target,0xff,0xe0,0x0f,0x0b],0x1000);jump.interpreter.set([0x0f,0x0b],0x2000);
  const report=revoked?await require('./native-step-contract.cjs').serve('guestmem=broker1',async get=>{
   const cfg=await(await get('/xlat/config')).json(),state=new Uint8Array(await(await get('/xlat/state')).arrayBuffer()),result=await execute(get,cfg,state,jump),native=await(await get('/xlat/totals')).json();
   assert.equal(native.failed,0);assert.equal(native.units,3);assert.equal(native.guestInsts,3);return {result,native};
  }):await probe(()=>jump,path.join(directory,phase+'.json')),result=report.result;
  assert.equal(result.executedWasmSteps,3);assert.equal(result.broker.requests,1);assert.equal(result.stoppedRip,F.BASE+(revoked?0x100dn:0x2000n));
  assert.equal(result.steps.at(-1).status,revoked?2:0);assert.equal(result.guestExitCode,null);assert.equal(result.guestAccessQuiescenceAcknowledged,true);
  records.push({mode:phase,steps:result.executedWasmSteps,stoppedRip:result.stoppedRip,broker:result.broker,native:report.native});
 }
 // Change an operand byte after the second jump to an already cached
 // target. The successful JMP stays completed; cached target Wasm must never
 // run after the full instruction bytes cease to match its admission header.
 phase='cached-jump-target-changed';const cachedJump=inputs('--synthetic'),F=require('./sparse-linux-image-fixture.cjs'),target=F.BASE+0x2000n,targetBytes=new Uint8Array(8);
 cachedJump.minimumSteps=3;cachedJump.maximumSteps=12;cachedJump.testChangeCachedJumpTarget=true;
 const cv=new DataView(cachedJump.interpreter.buffer);cv.setBigUint64(64+56+32,0x1100n,true);cv.setBigUint64(64+56+40,0x2000n,true);new DataView(targetBytes.buffer).setBigUint64(0,target,true);
 cachedJump.interpreter.set([0x48,0x89,0xe7,0x48,0xb8,...targetBytes,0xff,0xe0,0x0f,0x0b],0x1000);cachedJump.interpreter.set([0xba,1,0,0,0,0xff,0xe0],0x2000);
 cachedJump.evidence='Synthetic ELF with cached register-JMP target operand mutation; full-byte admission must fail before cached Wasm executes.';
 const changedOutput=path.join(directory,'cached-jump-target-changed.json');await assert.rejects(probe(()=>cachedJump,changedOutput),/Sparse executable bytes changed/);
 const changed=JSON.parse(fs.readFileSync(changedOutput));assert.equal(changed.status,'probe-failed');assert.equal(changed.result,null);assert.equal(changed.progress.executedWasmSteps,5);assert.equal(BigInt(changed.progress.rip),target);assert.equal(BigInt(changed.progress.rdx),1n);assert.equal(changed.native.units,5);assert.equal(changed.native.failed,0);
 records.push({mode:phase,report:changed});
 // Production dynamic admission must derive stack operands from exact bytes.
 phase='register-stack';const stack=inputs('--synthetic');stack.minimumSteps=7;
 stack.interpreter.set([0x48,0x89,0xe7,0x55,0x54,0x58,0x5d,0x57,0x5c,0x0f,0x0b],0x1000);
 stack.evidence='Synthetic ELF compact register PUSH/POP, including old-RSP PUSH and POP RSP overwrite; not Wine.';
 const stackReport=await probe(()=>stack,path.join(directory,phase+'.json')),stacked=stackReport.result;
 assert.equal(stacked.executedWasmSteps,7);assert.equal(stacked.broker.requests,6);assert.equal(stacked.stackPointerAfter,stacked.stackPointer);assert.equal(stacked.raxAfter,stacked.stackPointer-8n);
 records.push({mode:phase,steps:stacked.executedWasmSteps,broker:stacked.broker,native:stackReport.native});
 // Runtime refusals have no compiler failure. Keep the Wine probe's ordinary
 // compiler-boundary postcondition intact and assert this fixture separately.
 for(const mode of ['push-underflow','pop-RSP-data']){
  phase=mode;const fault=inputs('--synthetic');fault.minimumSteps=mode==='push-underflow'?3:5;
  fault.interpreter.set(mode==='push-underflow'?[0x48,0x89,0xe7,0x48,0xbc,4,0,0,0,0,0,0,0,0x55,0x0f,0x0b]:[0x48,0x89,0xe7,0x48,0xb8,255,255,255,255,255,255,255,255,0x50,0x5c,0x55,0x0f,0x0b],0x1000);
  fault.evidence='Synthetic ELF register stack runtime refusal after exact checkpoint; arbitrary POP RSP data is accepted before the next access.';
  const report=await require('./native-step-contract.cjs').serve('guestmem=broker1',async get=>{
   const cfg=await(await get('/xlat/config')).json(),state=new Uint8Array(await(await get('/xlat/state')).arrayBuffer()),result=await execute(get,cfg,state,fault),native=await(await get('/xlat/totals')).json();assert.equal(native.failed,0);return{result,native};
  }),r=report.result;
  assert.equal(r.executedWasmSteps,fault.minimumSteps);assert.equal(r.broker.requests,mode==='push-underflow'?1:3);assert.equal(r.broker.unsupported,1);assert.equal(r.steps.at(-1).status,2);assert.equal(r.stackPointerAfter,mode==='push-underflow'?4n:0xffffffffffffffffn);
  assert.equal(r.stoppedRip,require('./sparse-linux-image-fixture.cjs').BASE+(mode==='push-underflow'?0x100dn:0x100fn));records.push({mode,steps:r.executedWasmSteps,broker:r.broker,native:report.native});
 }
 // Exact production dynamic metadata, checked READ and old-address aliasing.
 for(const readOnly of [false,true]){
  phase='register-memory-add'+(readOnly?'-readonly':'');const input=inputs('--synthetic'),F=require('./sparse-linux-image-fixture.cjs'),pointer=new Uint8Array(8);new DataView(pointer.buffer).setBigUint64(0,F.BASE+0x3180n,true);
  input.minimumSteps=6;new DataView(input.interpreter.buffer).setBigUint64(0x2180,7n,true);
  if(readOnly)new DataView(input.interpreter.buffer).setUint32(64+2*56+4,4,true);
  input.interpreter.set([0x48,0x89,0xe7,0x48,0xb8,...pointer,0x48,0xba,1,0,0,0,0xef,0xbe,0xad,0xde,0x48,3,0x10,3,0x10,0x48,3,0,0x0f,0x0b],0x1000);
  input.evidence='Synthetic ELF register-destination memory ADD, both widths, upper32 clearing and old-base destination alias; not Wine.';
  const report=await probe(()=>input,path.join(directory,phase+'.json')),r=report.result;
  assert.equal(r.executedWasmSteps,6);assert.equal(r.broker.requests,3);assert.equal(r.broker.ok,3);assert.equal(r.raxAfter,F.BASE+0x3187n);assert.equal(r.rdxAfter,15n);assert.equal(r.stoppedRip,F.BASE+0x101fn);
  records.push({mode:phase,steps:r.executedWasmSteps,broker:r.broker,native:report.native,raxAfter:r.raxAfter,rdxAfter:r.rdxAfter});
 }
 const result={evidence:'Actual FEX/Wasm probe-harness contracts, including deliberate initial-state corruption and native-child death. No Wine or physical-device evidence.',records};
 console.log(save(result));
 }finally{fs.rmSync(directory,{recursive:true,force:true});}}
main().catch(error=>{
 process.exitCode=1;const report=P.contractFailure(phase,records,subprocess,error);
 try{save(report);}catch(writeError){report.reportWriteError=P.errorInfo(writeError);}
 console.error(P.stringify(report));
});
