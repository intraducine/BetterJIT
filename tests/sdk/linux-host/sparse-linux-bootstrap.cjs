// SPDX-License-Identifier: GPL-3.0-or-later
// A bounded interpreter-entry probe, never a successful Wine command result.
const fs=require('fs'),path=require('path'),vm=require('vm'),assert=require('node:assert/strict'),crypto=require('crypto'),{Worker}=require('worker_threads');
const P=require('./sparse-linux-probe-report.cjs');
const serve=(...args)=>require('./native-step-contract.cjs').serve(...args);
const resources=path.resolve(__dirname,'../../../Sources/BetterJITLinux/Resources'),sha=b=>crypto.createHash('sha256').update(b).digest('hex');
for(const n of ['guest_memory','guest_memory_broker','thread_core'])vm.runInThisContext(fs.readFileSync(path.join(resources,'linux',n+'.js'),'utf8'));
vm.runInThisContext(fs.readFileSync(path.join(resources,'linux/web/sparse_process_host.js'),'utf8'));
function inputs(location) {
 if(location==='--synthetic-nops') {const F=require('./sparse-linux-image-fixture.cjs');return {path:'/test/synthetic-nops',elf:F.image(),interpreterPath:F.INTERP,interpreter:F.image({interpreter:true,calls:true,extensions:true,nops:true}),evidence:'Synthetic ELF interpreter with six architectural NOPs, accumulator extensions and nested direct calls; not Wine or a real libc.',minimumSteps:19,expectedSteps:19,expectedRax:'0xffffffffffffff80',expectedRdx:'0xffffffffffffffff'};}
 if(location==='--synthetic-extensions') {const F=require('./sparse-linux-image-fixture.cjs');return {path:'/test/synthetic-extensions',elf:F.image(),interpreterPath:F.INTERP,interpreter:F.image({interpreter:true,calls:true,extensions:true}),evidence:'Synthetic ELF interpreter with all six accumulator extensions and nested direct calls; not Wine or a real libc.',minimumSteps:13,expectedSteps:13,expectedRax:'0xffffffffffffff80',expectedRdx:'0xffffffffffffffff'};}
 if(location==='--synthetic-calls') {const F=require('./sparse-linux-image-fixture.cjs');return {path:'/test/synthetic-calls',elf:F.image(),interpreterPath:F.INTERP,interpreter:F.image({interpreter:true,calls:true}),evidence:'Synthetic ELF interpreter with nested direct calls and checked returns; not Wine or a real libc.',minimumSteps:6,expectedSteps:6};}
 if(location==='--synthetic') {const F=require('./sparse-linux-image-fixture.cjs');return {path:'/test/synthetic',elf:F.image(),interpreterPath:F.INTERP,interpreter:F.image({interpreter:true}),evidence:'Synthetic ELF layout and musl-shaped entry stub; not Wine or a real libc.',minimumSteps:2};}
 if(location==='--system-elf')return {path:'/bin/true',elf:new Uint8Array(fs.readFileSync('/bin/true')),interpreterPath:'/lib64/ld-linux-x86-64.so.2',interpreter:new Uint8Array(fs.readFileSync('/lib64/ld-linux-x86-64.so.2')),evidence:'Host-system true and glibc interpreter bytes; no Wine compatibility claim.',minimumSteps:1};
 const root=fs.realpathSync(location??'.build/device-linuxroot'),links=JSON.parse(fs.readFileSync(path.join(root,'.symlinks.json'))),modes=JSON.parse(fs.readFileSync(path.join(root,'.modes.json')));
 function read(guest) {
  let resolved=guest,hops=0;
  for(;;) {
   let changed=false;const parts=resolved.split('/').filter(Boolean);
   for(let i=1;i<=parts.length;i++) {const prefix='/'+parts.slice(0,i).join('/'),target=links[prefix];if(target===undefined)continue;
    assert.equal(typeof target,'string');assert(!target.includes('\0'));assert(++hops<=40,'Guest symlink loop');resolved=path.posix.resolve(path.posix.dirname(prefix),target,...parts.slice(i));changed=true;break;
   }
   if(!changed)break;
  }
  assert(Number.isInteger(modes[resolved])&&(modes[resolved]&0o111),'Executable mode required: '+resolved);
  const file=fs.realpathSync(path.join(root,resolved.slice(1)));assert(file.startsWith(root+path.sep),'Input must stay inside the staged guest root');return new Uint8Array(fs.readFileSync(file));
 }
 const provenance=JSON.parse(fs.readFileSync(path.join(root,'opt/wine-flat/.betterjit-wine-flat.json'))),elf=read('/opt/wine-flat/bin/wine'),interpreterPath='/lib/ld-musl-x86_64.so.1',interpreter=read(interpreterPath);
 assert.equal(sha(elf),provenance.filesSHA256.wine,'Must probe the exact adapted Wine binary recorded by preparation');
 return {path:'/opt/wine-flat/bin/wine',elf,interpreterPath,interpreter,evidence:'Exact prepared adapted Wine launcher and its staged musl interpreter, executed only to the first unsupported sparse instruction. Not a Wine command, nested CreateProcess, WebKit, phone, physical retirement or RAM result.',minimumSteps:2,provenance:{wineSourceCommit:provenance.wineSourceCommit,patchSHA256:provenance.patchSHA256}};
}
async function execute(get,cfg,state,input,context={}) {
 let kernel,host,timer;const workers=[],terminations=[];
 try {
  const result=await new Promise((resolve,reject)=>{
   timer=setTimeout(()=>reject(Error('Sparse interpreter bootstrap exceeded30seconds')),30000);
   host=new BetterJITSparseProcessHost({get,cfg,onFailure:reject,workerFactory:()=>{
    const worker=new Worker(path.join(__dirname,'sparse-browser-thread.cjs'),{workerData:{resources}}),record={worker,exited:false},adapter={onmessage:null,onerror:null,postMessage:m=>worker.postMessage(m),terminate:()=>{terminations.push(worker.terminate());}};workers.push(record);
    worker.on('message',data=>adapter.onmessage?.({data}));worker.on('error',e=>adapter.onerror?.({message:String(e)}));worker.on('exit',()=>{record.exited=true;});return adapter;
   }});
   kernel=new Worker(path.join(__dirname,'sparse-linux-bootstrap-kernel.cjs'),{workerData:{resources,cfg,state,...input}});kernel.on('error',reject);kernel.on('message',m=>{try{
    if(m.op==='spawn')host.spawn(m.spec);else if(m.op==='stop')host.stop(m.spec);else if(m.op==='drop')host.drop(m.spec);
    else if(m.op==='probe-progress')context.progress=P.progressInfo(m.diagnostic);
    else if(m.op==='fatal'){context.progress=P.progressInfo(m.diagnostic);reject(Object.assign(Error(m.error.message),m.error));}
    else if(m.op==='kernel-result')resolve(m);
   }catch(error){reject(error);}});
  });
  context.result={...result,stage:'terminal-result',rip:result.stoppedRip};
  await Promise.all(host.drops);assert(host.history.every(r=>r.acked&&!r.pending.size));assert(workers.every(w=>!w.exited));
  assert.equal(result.status,'unsupported-instruction');assert.equal(result.guestExitCode,null);assert(result.executedWasmSteps>=input.minimumSteps);assert(result.executedWasmSteps<64);
  if(input.expectedSteps!==undefined){assert.equal(result.executedWasmSteps,input.expectedSteps);assert.equal(result.stackPointerAfter,result.stackPointer);assert.equal(result.broker.requests,4);assert.equal(result.broker.ok,4);}
  if(input.expectedRax!==undefined){assert.equal(result.raxAfter,BigInt(input.expectedRax));assert.equal(result.rdxAfter,BigInt(input.expectedRdx));}
  return {...result,actualWorkersStillAlive:workers.length,nativeRequestsDrained:true};
 }finally{clearTimeout(timer);host?.close();await Promise.allSettled(terminations);await kernel?.terminate();}
}
function writeReport(output,report) {
 const text=P.stringify(report);if(output){fs.writeFileSync(output+'.tmp',text);fs.renameSync(output+'.tmp',output);}return text;
}
async function probe(selectInput,output,connect=serve) {
 const context={stage:'inputs'};
 try {
  const input=context.input=selectInput();context.stage='native-start';
  return await connect('guestmem=broker1',async get=>{
   try {
    context.stage='native-configuration';const cfg=context.cfg=await(await get('/xlat/config')).json(),state=new Uint8Array(await(await get('/xlat/state')).arrayBuffer());
    context.stage='execute';const result=await execute(get,cfg,state,input,context);
    context.stage='native-validation';const native=context.native=await(await get('/xlat/totals')).json();
    assert.equal(native.units,result.executedWasmSteps);assert.equal(native.guestInsts,result.executedWasmSteps);assert.equal(native.failed,1);
    const report={evidence:input.evidence,provenance:input.provenance,input:P.inputIdentity(input),cfg,native,result};writeReport(output,report);return report;
   } catch(error) {
    try{context.native=await(await get('/xlat/totals')).json();}catch(nativeError){context.nativeError=nativeError;}
    throw error;
   }
  });
 } catch(error) {writeReport(output,P.failureReport(context,error));throw error;}
}
module.exports={execute,inputs,probe};if(require.main===module)probe(()=>inputs(process.argv[4]),process.argv[3]).then(report=>console.log(P.stringify(report))).catch(e=>{console.error(P.stringify({status:'probe-failed',error:P.errorInfo(e)}));process.exitCode=1;});
