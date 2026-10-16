// SPDX-License-Identifier: GPL-3.0-or-later
// Probe-only contracts and bounded diagnostics; never dump guest memory/state.
const assert=require('node:assert/strict'),crypto=require('crypto'),v8=require('node:v8'),os=require('node:os');
function executionBudget(maximumSteps=20000,translationProfile='default') {
  assert(Number.isSafeInteger(maximumSteps)&&maximumSteps>=1&&maximumSteps<=20000,'Probe step budget must be an integer in 1..20000');
  assert(translationProfile==='default'||translationProfile==='host-wine-probe-v1','Unknown bounded probe translation profile');
  return {maximumSteps,deadlineMs:30000,translationProfile,maximumTranslationUnits:translationProfile==='host-wine-probe-v1'?512:256,maximumTranslationBytes:2*1024*1024};
}
const nonnegative=value=>Number.isSafeInteger(value)&&value>=0?value:null;
function resourceSnapshot(host,nativeProcess) {
  let memory={},heap={},native={},system={};try{memory=process.memoryUsage();heap=v8.getHeapStatistics();}catch{}
  try{native=nativeProcess?.readMemory()??{};}catch{}
  try{system={totalBytes:os.totalmem(),freeBytes:os.freemem()};}catch{}
  return {host:{cacheEntries:host?.cache.size,receivedTranslationBytes:host?.cacheBytes,cache:host?.cacheStats?.(),pendingTranslations:host?.history.reduce((n,r)=>n+r.pending.size,0),
    outstandingRequests:host?.history.reduce((n,r)=>n+r.requests.size,0),retainedWorkerRecords:host?.history.length},
    node:{rssBytes:memory.rss,parentIsolateHeapUsedBytes:memory.heapUsed,parentIsolateHeapTotalBytes:memory.heapTotal,parentIsolateExternalBytes:memory.external,
      parentIsolateArrayBufferBytes:memory.arrayBuffers,parentIsolateMallocedBytes:heap.malloced_memory,parentIsolateHeapLimitBytes:heap.heap_size_limit},
    native,system};
}
function resourceTelemetryInfo(context) {
  const out={scope:'Host probe only: Node RSS includes its workers; V8 heap counters describe the parent isolate. Native RSS describes the separate owned translator process.',
    accounting:'These overlapping counters must not be summed as a retained-memory total. Received translation bytes are cumulative serialized data, not RAM or a pre-allocation bound.',
    samplingMoments:'beforeDrop precedes native catalogue destruction; failure precedes worker cleanup; afterCleanup follows Node worker teardown but precedes native-child shutdown. Native child lifecycle is finalized before report writing.',
    unmeasured:['compiled WebAssembly engine allocation','native allocator overhead and frontend arenas','worker-isolate heap breakdown','physical-device memory headroom'],samples:{}};
  const fields={host:['cacheEntries','receivedTranslationBytes','pendingTranslations','outstandingRequests','retainedWorkerRecords'],
    node:['rssBytes','parentIsolateHeapUsedBytes','parentIsolateHeapTotalBytes','parentIsolateExternalBytes','parentIsolateArrayBufferBytes','parentIsolateMallocedBytes','parentIsolateHeapLimitBytes'],
    native:['rssBytes','peakRSSBytes'],system:['totalBytes','freeBytes']};
  for(const stage of ['baseline','beforeDrop','failure','afterCleanup']){
    const sample=context.resourceSamples?.[stage];if(!sample)continue;const clean={samplingAvailable:sample.unavailable!==true};
    for(const [group,keys]of Object.entries(fields)){clean[group]={};for(const key of keys)clean[group][key]=nonnegative(sample[group]?.[key]);}
    clean.native.source=['linux-proc-status','darwin-ps-rss'].includes(sample.native?.source)?sample.native.source:'unavailable';
    clean.native.retainedIRBytes=null;clean.native.allocatorBytes=null;clean.node.compiledWebAssemblyBytes=null;out.samples[stage]=clean;
    const cache=sample.host?.cache;clean.host.cache={};
    for(const key of ['entries','retainedBytes','receivedBytes','pendingEntries','pinnedEntries','pinnedRequests','hits','misses','fetches','compileAttempts','compiled','failures','evictions','failedRemovals',
      'peakEntries','peakRetainedBytes','peakPendingEntries','peakPinnedEntries','peakPinnedRequests','maximumEntries','maximumReceivedBytes','maximumResidentBytes'])clean.host.cache[key]=nonnegative(cache?.[key]);
  }
  out.cacheAccounting='Retained bytes count serialized wire payload once per owned entry, including detached pinned entries until delivery drains. They exclude JS metadata, transient fetch/parse copies, worker clones and engine allocations. Exact hits/misses/fetch/compile/eviction counters include repeated translations; total unique RIPs/recompiles are unknown without retaining history.';
  out.recompilations=null;
  out.nativeIR={scope:'Native totals after execution/catalogue drops on success, or the latest reachable totals on failure. Current gauges exclude destroyed catalogues; catalogue-peak sums are not simultaneous process peaks. Data/List bytes and vector capacity exclude object/dependency/allocator/frontend overhead.'};
  for(const key of ['irCacheEntries','irOwnedEntries','irDataBytes','irListBytes','irBufferCapacityBytes','irCataloguePeakEntriesSum','irCataloguePeakOwnedEntriesSum','irCataloguePeakDataBytesSum','irCataloguePeakListBytesSum','irCataloguePeakBufferCapacityBytesSum','irGenerations','irCacheHits','irDiscards'])out.nativeIR[key]=nonnegative(context.native?.[key]);
  const cleanup=context.cleanup??{},lifecycle=context.nativeProcess?.lifecycle;
  out.cleanup={};for(const key of ['hostClosed','allExecutionWorkersExited','executionTerminationRequestsSettled','kernelTerminationSettled','guestQuiescenceAcknowledged'])out.cleanup[key]=typeof cleanup[key]==='boolean'?cleanup[key]:null;
  for(const key of ['cacheEntries','executionWorkersCreated'])out.cleanup[key]=nonnegative(cleanup[key]);
  out.cleanup.nativeChildCloseRequested=typeof lifecycle?.closeRequested==='boolean'?lifecycle.closeRequested:null;
  out.cleanup.nativeChildClosed=typeof lifecycle?.closed==='boolean'?lifecycle.closed:null;
  return out;
}
function validateCompletion(result,minimumSteps,budget) {
  assert(['unsupported-instruction','divide-error'].includes(result.status));assert.equal(result.guestExitCode,null);
  if(result.status==='divide-error'){assert.equal(result.exception?.kind,'divide-error');assert.equal(result.exception.vector,0);assert(['zero-divisor','quotient-overflow'].includes(result.exception.reason));assert.equal(typeof result.exception.rip,'bigint');assert.equal(result.exception.rip,result.stoppedRip);}
  assert(Number.isSafeInteger(result.executedWasmSteps)&&result.executedWasmSteps>=minimumSteps&&result.executedWasmSteps>0);
  assert(result.executedWasmSteps<=budget.maximumSteps,'Probe completion exceeded its execution budget');
}
function validateNative(native,executedWasmSteps,status='unsupported-instruction') {
  // Successful single-instruction translations may execute repeatedly from the host cache.
  assert(Number.isSafeInteger(native.units)&&native.units>=1&&native.units<=executedWasmSteps);
  assert.equal(native.guestInsts,native.units);assert.equal(native.failed,status==='divide-error'?0:1);
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
  if(['unsupported-instruction','divide-error'].includes(value.status))out.status=value.status;
  if(value.exception?.kind==='divide-error'&&value.exception.vector===0&&['zero-divisor','quotient-overflow'].includes(value.exception.reason)&&typeof value.exception.rip==='bigint')out.exception={kind:'divide-error',vector:0,reason:value.exception.reason,rip:value.exception.rip};
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
  if(context.executionBudget){report.executionBudget={};for(const key of ['maximumSteps','deadlineMs','maximumTranslationUnits','maximumTranslationBytes'])
    if(Number.isSafeInteger(context.executionBudget[key])&&context.executionBudget[key]>0)report.executionBudget[key]=context.executionBudget[key];
    if(['default','host-wine-probe-v1'].includes(context.executionBudget.translationProfile))report.executionBudget.translationProfile=context.executionBudget.translationProfile;}
  const provenance=context.input?.provenance;
  if(provenance){report.provenance={};for(const [key,length]of [['wineSourceCommit',40],['patchSHA256',64]])
    if(typeof provenance[key]==='string'&&new RegExp('^[0-9a-f]{'+length+'}$').test(provenance[key]))report.provenance[key]=provenance[key];}
  for(const key of ['buildID','coverageVersion','memoryABI','stepABI'])if(['number','string'].includes(typeof cfg[key]))report.configuration[key]=typeof cfg[key]==='string'?clean(cfg[key],64):cfg[key];
  for(const key of ['units','guestInsts','failed','unitBytes','cacheHits','diskHits'])if(Number.isFinite(native?.[key]))report.native[key]=native[key];
  if(context.nativeError)report.nativeError=errorInfo(context.nativeError);
  report.resourceTelemetry=resourceTelemetryInfo(context);
  return report;
}
const stringify=value=>JSON.stringify(value,(_key,v)=>typeof v==='bigint'?'0x'+v.toString(16):v,2)+'\n';
module.exports={executionBudget,resourceSnapshot,resourceTelemetryInfo,validateCompletion,validateNative,codeBytes,entryStackCheck,observeEntry,errorInfo,subprocessInfo,contractFailure,inputIdentity,progressInfo,failureReport,stringify};
