// SPDX-License-Identifier: GPL-3.0-or-later
// Probe-only contracts and bounded diagnostics; never dump guest memory/state.
const assert=require('node:assert/strict'),crypto=require('crypto');
function executionBudget(maximumSteps=20000) {
  assert(Number.isSafeInteger(maximumSteps)&&maximumSteps>=1&&maximumSteps<=20000,'Probe step budget must be an integer in 1..20000');
  return {maximumSteps,deadlineMs:30000};
}
function validateCompletion(result,minimumSteps,budget) {
  assert.equal(result.status,'unsupported-instruction');assert.equal(result.guestExitCode,null);
  assert(Number.isSafeInteger(result.executedWasmSteps)&&result.executedWasmSteps>=minimumSteps&&result.executedWasmSteps>0);
  assert(result.executedWasmSteps<=budget.maximumSteps,'Probe completion exceeded its execution budget');
}
function validateNative(native,executedWasmSteps) {
  // Successful single-instruction translations may execute repeatedly from the host cache.
  assert(Number.isSafeInteger(native.units)&&native.units>=1&&native.units<=executedWasmSteps);
  assert.equal(native.guestInsts,native.units);assert.equal(native.failed,1);
}
function codeBytes(codes,rip,maximum) {
  const code=codes.find(c=>rip>=c.address&&rip-c.address<BigInt(c.bytes.length));
  if(!code)return [];
  const offset=Number(rip-code.address);
  return [...code.bytes.subarray(offset,offset+maximum)];
}
function entryStackCheck(image) {
  const bytes=codeBytes(image.codes,image.entry,3),applicable=bytes.length===3&&bytes[0]===0x48&&bytes[1]===0x89&&bytes[2]===0xe7;
  return {applicable,verified:false,reason:applicable?'MOV RDI,RSP':bytes.length<3?'entry bytes unavailable':'different entry instruction',
    expectedNextRip:image.entry+3n,expectedRDI:image.stackPointer};
}
function observeEntry(check,last,rdi) {
  if(!check.applicable)return;
  check.observedRip=last.rip;check.observedRDI=rdi;
  assert.equal(last.status,0,'Entry MOV must complete successfully');
  assert.equal(last.rip,check.expectedNextRip,'Entry MOV must have its exact fallthrough');
  assert.equal(rdi,check.expectedRDI,'Entry MOV RDI,RSP must transfer the prepared initial stack');
  check.verified=true;
}
function clean(value,limit=1024) {
  return String(value??'').slice(0,2048).replace(/\b(?:https?|file):\/\/\S+/gi,'[url]')
    .replace(/(^|[\s"'(=])(?:\/|\.\.?[\\/]|[A-Za-z]:[\\/])[^\r\n]*/gm,'$1[path]')
    .replace(/\b[A-Za-z]:[\\/][^\s"'<>()[\]{}]+/g,'[path]')
    .replace(/\/[^\s"'<>()[\]{}:,;]+/g,'[path]').slice(0,limit);
}
function errorInfo(error) {
  const result={name:clean(error?.name??'Error',64),message:clean(error?.message??error)};
  if(typeof error?.code==='string'&&/^[A-Z_0-9]{1,64}$/.test(error.code))result.code=error.code;
  for(const key of ['actual','expected'])if(['bigint','number','boolean'].includes(typeof error?.[key])){
    const value=error[key];result[key]=typeof value==='bigint'&&(value>0xffffffffffffffffn||value< -0xffffffffffffffffn)?'[integer omitted]':value;
  }
  return result;
}
function subprocessInfo(child,{reportExists=false,wrapperStarted=false,fault={}}={}) {
  const stderr=String(child.stderr??'').slice(0,8192).split('\n').filter(line=>!/^\s*at\s/.test(line))
    .join('\n').replace(/\b[A-Za-z_][A-Za-z0-9_]*\s*=\s*(?:"[^"\n]*"|'[^'\n]*'|[^\s]+)/g,'[assignment redacted]')
    .replace(/\b(?:token|password|secret|authorization|cookie|api[_-]?key)\s*:\s*(?:"[^"\n]*"|'[^'\n]*'|[^\s]+)/gi,'[credential redacted]');
  const info={status:Number.isInteger(child.status)?child.status:null,signal:typeof child.signal==='string'&&/^SIG[A-Z0-9]{1,16}$/.test(child.signal)?child.signal:null,
    stderr:clean(stderr),reportExists:reportExists===true,wrapperStarted:wrapperStarted===true,
    fault:{phase:clean(fault.phase??'not observed',64),stepRequests:Number.isSafeInteger(fault.stepRequests)?fault.stepRequests:0,
      killPointObserved:fault.killPointObserved===true,killRequested:fault.killRequested===true,killSent:fault.killSent===true}};
  if(child.error)info.error=errorInfo(child.error);
  info.classification=child.error?(['ENOENT','EACCES','ENOEXEC'].includes(child.error.code)?'subprocess-startup-failed':'subprocess-control-error'):info.fault.killSent?
    (info.reportExists?'kill-confirmed-report-present':'kill-confirmed-report-missing'):
    info.fault.killRequested?'kill-not-confirmed':info.fault.killPointObserved?'at-kill-point-before-signal':
    info.fault.stepRequests?'before-kill-point':info.wrapperStarted?'before-first-translation':'before-native-wrapper';
  return info;
}
function contractFailure(phase,records,subprocess,error) {
  return {schema:1,status:'contract-failed',evidence:'Probe harness regression failure; this command does not execute Wine.',phase:clean(phase,64),error:errorInfo(error),subprocess,
    completedCases:records.slice(0,16).map(record=>({mode:clean(record.mode,64),steps:record.steps,
      failureStatus:record.report?.status==='probe-failed'?'probe-failed':undefined,progressSteps:record.report?.progress?.executedWasmSteps}))};
}
function inputIdentity(input) {
  if(!input)return null;
  const guestPath=value=>typeof value==='string'&&/^\/(?:test|opt\/wine-flat|lib|lib64|bin)\/[a-zA-Z0-9_./-]{1,160}$/.test(value)?value:'[guest path omitted]';
  const sha=bytes=>bytes instanceof Uint8Array?crypto.createHash('sha256').update(bytes).digest('hex'):null;
  return {path:guestPath(input.path),elfSHA256:sha(input.elf),elfBytes:input.elf instanceof Uint8Array?input.elf.length:null,
    interpreterPath:guestPath(input.interpreterPath),interpreterSHA256:sha(input.interpreter),interpreterBytes:input.interpreter instanceof Uint8Array?input.interpreter.length:null};
}
function progressInfo(value) {
  if(!value)return null;
  const out={stage:clean(value.stage,64)};
  for(const key of ['entry','rip','stackPointer','rsp','rdi','rax','rdx','stackPointerAfter','rdiAfter','raxAfter','rdxAfter','executedWasmSteps','terminalStatus','guestAccessQuiescenceAcknowledged','workerRetirementAcknowledged','internalContextsRetained','internalBytesRetained'])
    if(['bigint','number','boolean'].includes(typeof value[key]))out[key]=value[key];
  if(value.status==='unsupported-instruction')out.status=value.status;
  if(value.guestExitCode===null||Number.isInteger(value.guestExitCode))out.guestExitCode=value.guestExitCode;
  const check=value.entryStackValidation;
  if(check){out.entryStackValidation={applicable:check.applicable===true,verified:check.verified===true,reason:clean(check.reason,64)};
    for(const key of ['expectedNextRip','expectedRDI','observedRip','observedRDI'])if(typeof check[key]==='bigint')out.entryStackValidation[key]=check[key];}
  if(Array.isArray(value.instruction))out.instruction=value.instruction.slice(0,15).filter(n=>Number.isInteger(n)&&n>=0&&n<=255);
  const steps=value.steps??(value.lastStep?[value.lastStep]:[]);
  if(Array.isArray(steps))out.steps=steps.slice(-64).filter(s=>typeof s?.rip==='bigint'&&Number.isInteger(s.status)).map(s=>({rip:s.rip,status:s.status}));
  return out;
}
function failureReport(context,error) {
  const cfg=context.cfg??{},native=context.native;
  const report={schema:1,status:'probe-failed',evidence:'Bounded interpreter probe failure; no successful guest exit or Wine compatibility result.',
    stage:clean(context.stage,64),input:inputIdentity(context.input),error:errorInfo(error),nativeAvailable:!!native,
    progress:progressInfo(context.progress),result:progressInfo(context.result),configuration:{},native:{}};
  if(context.executionBudget){report.executionBudget={};for(const key of ['maximumSteps','deadlineMs'])
    if(Number.isSafeInteger(context.executionBudget[key])&&context.executionBudget[key]>0)report.executionBudget[key]=context.executionBudget[key];}
  const provenance=context.input?.provenance;
  if(provenance){report.provenance={};for(const [key,length]of [['wineSourceCommit',40],['patchSHA256',64]])
    if(typeof provenance[key]==='string'&&new RegExp('^[0-9a-f]{'+length+'}$').test(provenance[key]))report.provenance[key]=provenance[key];}
  for(const key of ['buildID','coverageVersion','memoryABI','stepABI'])if(['number','string'].includes(typeof cfg[key]))report.configuration[key]=typeof cfg[key]==='string'?clean(cfg[key],64):cfg[key];
  for(const key of ['units','guestInsts','failed','unitBytes','cacheHits','diskHits'])if(Number.isFinite(native?.[key]))report.native[key]=native[key];
  if(context.nativeError)report.nativeError=errorInfo(context.nativeError);
  return report;
}
const stringify=value=>JSON.stringify(value,(_key,v)=>typeof v==='bigint'?'0x'+v.toString(16):v,2)+'\n';
module.exports={executionBudget,validateCompletion,validateNative,codeBytes,entryStackCheck,observeEntry,errorInfo,subprocessInfo,contractFailure,inputIdentity,progressInfo,failureReport,stringify};
