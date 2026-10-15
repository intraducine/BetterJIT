// SPDX-License-Identifier: GPL-3.0-or-later
// Bounded static process tree; guest storage is authority-owned. Fixed worker
// contexts/occupied slots remain retained even after guest-access quiescence.
'use strict';
importScripts('../guest_memory.js','../guest_memory_broker.js','../guest_image.js','linux-kernel.js');
const M=BetterJITGuestMemory,I=BetterJITGuestImage,{Kernel}=LinuxBundle.require('./kernel.js');
let ownedKernel,ownedImage,ownedBudget;
onmessage=({data:d})=>{onmessage=null;try{
 Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,1,0);
 ownedBudget=new M.BackingBudget({limitBytes:32*1024*1024});const empty=new M.GuestAddressSpace(ownedBudget,{virtualLimit:1n<<47n}),encoder=new TextEncoder();
 try{ownedImage=I.prepare(empty,d.elf,{path:d.argv[0],argv:d.argv.map(x=>encoder.encode(x)),envp:Object.entries(d.env).map(([k,v])=>encoder.encode(k+'='+v))},crypto.getRandomValues(new Uint8Array(16)));}finally{empty.close();}
 const births=[],commits=[],exits=[],quiesced=[];
 ownedKernel=new Kernel({state:d.state,vfs:{},log:()=>{},sparseLifecycleVersion:5,sparseRetainInternalContexts:true,sparseAllowThreads:false,sparseAllowFutex:false,
  sparseExecutables:new I.ExecutableStore(d.executables),
  spawnSparseThread:spec=>postMessage({op:'spawn',spec}),stopSparseThread:spec=>postMessage({op:'stop',spec}),dropSparseSpace:spec=>postMessage({op:'drop',spec}),
  writeSparseOutput:({fd,bytes})=>{postMessage({op:'output',fd,bytes});return bytes.length;},
  sparseCloneCreated:t=>births.push({pid:t.proc.pid,tid:t.tid}),sparseExecCommitted:t=>commits.push({pid:t.proc.pid,...t.sparse.executedImage}),
  sparseExecFailed:()=>{throw Error('Sparse exec failed after irreversible old-image stop');},
  sparseExit:t=>{if(t.sparse.terminalStatus!==0)throw new I.ImageUnsupported('Sparse process reached an unsupported instruction/syscall');exits.push({pid:t.proc.pid,code:t.sparse.guestExitCode});},
  sparseGuestQuiesced:(t,r)=>{if(r.failed)throw Error('Sparse process failed without a guest exit status');quiesced.push({pid:t.proc.pid,slot:t.slot,...r});if([...ownedKernel.procs.values()].every(p=>p.zombie)&&[...ownedKernel.threads.values()].every(th=>ownedKernel.sparseExecutionEnded(th))&&!ownedKernel.sparseClones?.size&&!ownedKernel.sparseExecs?.size)ownedKernel.done=true;}
 },d.cfg);
 const a=ownedKernel.createSparseProcess({space:ownedImage.space,entryRip:ownedImage.entry,dynamic:true,standardIO:true,standardInput:d.input}),input=a.proc.fds.get(0).file;
 a.proc.mm.catalog={id:a.proc.space,refs:1};a.thread.sparse.view.setBigUint64(a.thread.tb+d.cfg.ctx+d.cfg.gregsOff+32,ownedImage.stackPointer,true);
 postMessage({op:'spawn',spec:{...a.worker,codes:ownedImage.codes}});ownedKernel.run();
 const contexts=[...ownedKernel.threads.values(),...(ownedKernel.sparseRetiredContexts??[])],exit=a.thread.sparse.guestExitCode;
 if(exit===undefined||!contexts.every(t=>t.sparse.executionQuiesced&&!t.sparse.retired))throw Error('Incomplete sparse process quiescence');
 ownedKernel.closeSparseImage(a.proc.mm);
 postMessage({op:'process-result',exitCode:exit,steps:contexts.reduce((n,t)=>n+t.sparse.steps,0),stdin:{providedBytes:d.input.length,consumedBytes:input.pos,positiveReads:contexts.reduce((n,t)=>n+(t.sparse.inputReadCalls??0),0)},births,commits,exits,quiesced,internalContextsRetained:ownedKernel.sparseContexts,internalBytesRetained:ownedKernel.sparseContexts*33*65536,guestBacking:ownedBudget.stats(),broker:ownedKernel.sparseBroker.stats(),guestAccessQuiescenceAcknowledged:true,workerRetirementAcknowledged:false,internalContextsRetainedUntilSessionTeardown:true});
}catch(error){postMessage({op:error instanceof I.ImageUnsupported?'unsupported':'failure',message:String(error)});}};
