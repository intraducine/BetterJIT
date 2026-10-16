// SPDX-License-Identifier: GPL-3.0-or-later
// Probe harness regressions; deliberate test-only corruption/death must fail.
const fs=require('fs'),path=require('path'),os=require('os'),assert=require('node:assert/strict'),{spawnSync}=require('child_process');
const {probe,inputs}=require('./sparse-linux-bootstrap.cjs'),P=require('./sparse-linux-probe-report.cjs');
const binary=path.resolve(process.argv[2]),directory=fs.mkdtempSync(path.join(os.tmpdir(),'betterjit-probe-')),records=[];
const quote=s=>"'"+s.replace(/'/g,"'\\''")+"'";
async function main(){try{
 for(const mode of ['calls','extensions','nops','clobber','different-entry']){
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
 const missingOutput=path.join(directory,'missing-native.json'),missing=spawnSync(process.execPath,[cli,path.join(directory,'absent-native'),missingOutput,'--synthetic-calls'],{encoding:'utf8',timeout:15000});
 assert.equal(missing.status,1);const missingReport=JSON.parse(fs.readFileSync(missingOutput));assert.equal(missingReport.status,'probe-failed');assert.equal(missingReport.stage,'native-start');assert(!JSON.stringify(missingReport).includes(directory));records.push({mode:'native-start-failed',report:missingReport});
 // Corrupt the initial RSP before spawning the guest worker. The real entry
 // MOV executes; its first-step check must catch the incorrect transfer.
 const corrupt=path.join(directory,'corrupt.cjs');fs.writeFileSync(corrupt,`const t=require('worker_threads'),W=t.Worker;t.Worker=class extends W{
 constructor(file,options){super(file,options);if(String(file).endsWith('/sparse-linux-bootstrap-kernel.cjs'))this.probeCfg=options.workerData.cfg;}
 emit(event,message,...rest){if(event==='message'&&message?.op==='spawn'&&this.probeCfg){const c=this.probeCfg,s=message.spec;new DataView(s.mem.buffer).setBigUint64(s.tb+c.ctx+c.gregsOff+32,1n,true);}return super.emit(event,message,...rest);}};`);
 const wrongOutput=path.join(directory,'wrong-entry.json'),wrong=spawnSync(process.execPath,['--require',corrupt,cli,binary,wrongOutput,'--synthetic-calls'],{encoding:'utf8',timeout:15000});
 assert.equal(wrong.status,1,wrong.stderr);const wrongReport=JSON.parse(fs.readFileSync(wrongOutput));
 assert.equal(wrongReport.status,'probe-failed');assert.match(wrongReport.error.message,/Entry MOV RDI,RSP/);assert.equal(wrongReport.progress.executedWasmSteps,1);
 assert.equal(wrongReport.progress.entryStackValidation.verified,false);assert.equal(wrongReport.progress.entryStackValidation.observedRDI,'0x1');records.push({mode:'wrong-initial-transfer',report:wrongReport});
 // Kill the actual native child at its third step request. Its statistics
 // endpoint is then unavailable; the failure report must retain prior progress.
 const pid=path.join(directory,'native.pid'),wrapper=path.join(directory,'native.sh');fs.writeFileSync(wrapper,'#!/bin/sh\nprintf %s "$$" > '+quote(pid)+'\nexec '+quote(binary)+' "$@"\n',{mode:0o700});
 const kill=path.join(directory,'kill.cjs');fs.writeFileSync(kill,`const fs=require('fs'),original=global.fetch;let steps=0;global.fetch=(url,...args)=>{if(String(url).includes('/xlat/step?')&&++steps===3)process.kill(Number(fs.readFileSync(${JSON.stringify(pid)},'utf8')),'SIGTERM');return original(url,...args);};`);
 const deadOutput=path.join(directory,'dead.json'),dead=spawnSync(process.execPath,['--require',kill,cli,wrapper,deadOutput,'--synthetic-calls'],{encoding:'utf8',timeout:15000});
 assert.equal(dead.status,1,dead.stderr);const deadReport=JSON.parse(fs.readFileSync(deadOutput));
 assert.equal(deadReport.status,'probe-failed');assert.equal(deadReport.nativeAvailable,false);assert(deadReport.progress.executedWasmSteps>=1);assert(deadReport.nativeError);records.push({mode:'native-child-died',report:deadReport});
 // An assertion after a completed kernel result must preserve that result.
 const bad=inputs('--synthetic-calls');bad.expectedSteps=7;const badOutput=path.join(directory,'postcondition.json');
 await assert.rejects(probe(()=>bad,badOutput),assert.AssertionError);const badReport=JSON.parse(fs.readFileSync(badOutput));
 assert.equal(badReport.status,'probe-failed');assert.equal(badReport.result.executedWasmSteps,6);assert.equal(badReport.nativeAvailable,true);records.push({mode:'postcondition-failed',report:badReport});
 const result={evidence:'Actual FEX/Wasm probe-harness contracts, including deliberate initial-state corruption and native-child death. No Wine or physical-device evidence.',records};
 const text=P.stringify(result);if(process.argv[3])fs.writeFileSync(process.argv[3],text);console.log(text);
 }finally{fs.rmSync(directory,{recursive:true,force:true});}}
main().catch(error=>{console.error(error);process.exitCode=1;});
