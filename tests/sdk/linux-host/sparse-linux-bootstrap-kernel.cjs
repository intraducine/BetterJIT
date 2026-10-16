// SPDX-License-Identifier: GPL-3.0-or-later
const {workerData:d,parentPort}=require('worker_threads'),fs=require('fs'),path=require('path'),vm=require('vm'),assert=require('node:assert/strict');
globalThis.self=globalThis;
for(const n of ['guest_memory.js','guest_memory_broker.js','guest_image.js','guest_linux_image.js','web/linux-kernel.js'])vm.runInThisContext(fs.readFileSync(path.join(d.resources,'linux',n),'utf8'));
const M=BetterJITGuestMemory,I=BetterJITGuestImage,L=BetterJITGuestLinuxImage,{Kernel,SLOT_BASE,SLOT_SIZE,W_OCCUPIED}=LinuxBundle.require('./kernel.js');
const budget=new M.BackingBudget({limitBytes:32*1024*1024}),empty=new M.GuestAddressSpace(budget,{virtualLimit:1n<<47n}),enc=new TextEncoder();
let kernel,image,initial;const quiesced=[],steps=[];
try {
 image=L.prepare(empty,d.elf,{path:d.path,argv:[d.path,'cmd','/c','ver'].map(s=>enc.encode(s)),envp:[enc.encode('WINEARCH=win64')]},crypto.getRandomValues(new Uint8Array(16)),new I.ExecutableStore([{path:d.interpreterPath,bytes:d.interpreter}]));empty.close();
 const peak=budget.stats().ownedPayloadBytes;
 kernel=new Kernel({state:d.state,vfs:{},log:()=>{},sparseLifecycleVersion:5,sparseRetainInternalContexts:true,sparseAllowThreads:false,sparseAllowFutex:false,
  spawnSparseThread:spec=>parentPort.postMessage({op:'spawn',spec}),stopSparseThread:spec=>parentPort.postMessage({op:'stop',spec}),dropSparseSpace:spec=>parentPort.postMessage({op:'drop',spec}),
  writeSparseOutput:()=>{throw Error('Interpreter bootstrap unexpectedly wrote output');},
  sparseStep:(t,last)=>steps.push({rip:last.rip,status:last.status}),
  sparseExit:t=>{assert.equal(t.sparse.terminalStatus,2);assert.equal(t.sparse.guestExitCode,undefined);},
  sparseGuestQuiesced:(t,r)=>{assert.equal(r.failed,false);quiesced.push(r);kernel.done=true;}
 },d.cfg);
 initial=kernel.createSparseProcess({space:image.space,entryRip:image.entry,dynamic:true,standardIO:true,standardInput:new Uint8Array(0)});initial.proc.mm.catalog={id:initial.proc.space,refs:1};
 const t=initial.thread,g=t.tb+d.cfg.ctx+d.cfg.gregsOff;t.sparse.view.setBigUint64(g+32,image.stackPointer,true);
 parentPort.postMessage({op:'spawn',spec:{...initial.worker,codes:image.codes}});kernel.run();
 assert(t.sparse.executionQuiesced&&!t.sparse.retired);assert.equal(t.sparse.terminalStatus,2);assert.equal(t.sparse.guestExitCode,undefined);
 assert(t.sparse.steps>0);assert.equal(quiesced.length,1);assert.equal(Atomics.load(kernel.k32,((SLOT_BASE+t.slot*SLOT_SIZE)>>2)+W_OCCUPIED),1);
 const rip=t.sparse.view.getBigUint64(t.tb+d.cfg.ctx+d.cfg.ripOff,true),instruction=image.space.executableSnapshot(rip,15),rdi=t.sparse.view.getBigUint64(g+56,true);
 assert.equal(rdi,image.stackPointer,'The actual interpreter entry must receive the guest initial stack');
 const result={entry:image.entry,imageEntry:image.imageEntry,loadBias:image.loadBias,interpreter:image.interpreter,stackPointer:image.stackPointer,stackPointerAfter:t.sparse.view.getBigUint64(g+32,true),raxAfter:t.sparse.view.getBigUint64(g,true),rdxAfter:t.sparse.view.getBigUint64(g+16,true),phdr:image.phdr,
  status:'unsupported-instruction',guestExitCode:null,stoppedRip:rip,instruction:[...instruction],executedWasmSteps:t.sparse.steps,steps,peakGuestBackingBytes:peak,
  relocationsApplied:image.relocationsApplied,tlsInitialized:image.tlsInitialized,relroSealed:image.relroSealed,
  guestAccessQuiescenceAcknowledged:true,workerRetirementAcknowledged:false,internalContextsRetained:kernel.sparseContexts,internalBytesRetained:kernel.sparseContexts*33*65536};
 kernel.closeSparseImage(initial.proc.mm);assert.equal(budget.stats().ownedPayloadBytes,0);assert.equal(kernel.sparseBroker.stats().threads,0);
 parentPort.postMessage({op:'kernel-result',...result,guestBacking:budget.stats(),broker:kernel.sparseBroker.stats()});
}catch(error){parentPort.postMessage({op:'fatal',message:String(error.stack||error)});}
