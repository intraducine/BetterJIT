// SPDX-License-Identifier: GPL-3.0-or-later
const {workerData:d,parentPort}=require('worker_threads'),fs=require('fs'),path=require('path'),vm=require('vm'),assert=require('node:assert/strict'),crypto=require('crypto');
globalThis.self=globalThis;for(const n of ['guest_memory.js','guest_memory_broker.js','guest_image.js','web/linux-kernel.js'])vm.runInThisContext(fs.readFileSync(path.join(d.resources,'linux',n),'utf8'));
const M=BetterJITGuestMemory,I=BetterJITGuestImage,{Kernel,SLOT_BASE,SLOT_SIZE,W_OCCUPIED}=LinuxBundle.require('./kernel.js'),budget=new M.BackingBudget({limitBytes:32*1024*1024}),empty=new M.GuestAddressSpace(budget,{virtualLimit:1n<<47n}),enc=new TextEncoder(),stdout=crypto.createHash('sha256');let kernel,initial,image,inputFile,stdoutBytes=0;const births=[],commits=[],exits=[],quiesced=[];
try{
 image=I.prepare(empty,d.elf,{path:'/test/pipeline',argv:['/test/pipeline',...(d.case.noArgument?[]:[d.case.missing?'/test/absent':'/test/cat'])].map(x=>enc.encode(x)),envp:[]},crypto.getRandomValues(new Uint8Array(16)));empty.close();
 kernel=new Kernel({state:d.state,vfs:{},log:()=>{},sparseLifecycleVersion:5,sparseRetainInternalContexts:true,sparseAllowThreads:false,sparseAllowFutex:false,sparseExecutables:new I.ExecutableStore([{path:'/test/cat',bytes:d.cat}]),
  spawnSparseThread:s=>parentPort.postMessage({op:'spawn',spec:s}),stopSparseThread:s=>parentPort.postMessage({op:'stop',spec:s}),dropSparseSpace:s=>parentPort.postMessage({op:'drop',spec:s}),
  writeSparseOutput:({fd,bytes})=>{assert.equal(fd,1);stdout.update(bytes);stdoutBytes+=bytes.length;return bytes.length;},
  sparseCloneCreated:t=>births.push({pid:t.proc.pid,tid:t.tid}),sparseExecCommitted:t=>commits.push({pid:t.proc.pid,...t.sparse.executedImage}),
  sparseExit:t=>exits.push({pid:t.proc.pid,code:t.sparse.guestExitCode,status:t.sparse.terminalStatus}),
  sparseGuestQuiesced:(t,r)=>{quiesced.push({pid:t.proc.pid,slot:t.slot,...r});if([...kernel.procs.values()].every(p=>p.zombie)&&[...kernel.threads.values()].every(th=>kernel.sparseExecutionEnded(th))&&!kernel.sparseExecs?.size&&!kernel.sparseClones?.size)kernel.done=true;}
 },d.cfg);
 initial=kernel.createSparseProcess({space:image.space,entryRip:image.entry,dynamic:true,standardIO:true,standardInput:d.case.input});initial.proc.mm.catalog={id:initial.proc.space,refs:1};inputFile=initial.proc.fds.get(0).file;
 initial.thread.sparse.view.setBigUint64(initial.thread.tb+d.cfg.ctx+d.cfg.gregsOff+32,image.stackPointer,true);
 parentPort.postMessage({op:'spawn',spec:{...initial.worker,codes:image.codes}});kernel.run();
 const expected=d.case.noArgument?64:d.case.missing||d.case.cancel?71:0;assert.equal(exits.find(x=>x.pid===initial.proc.pid).code,expected);assert.equal(births.length,d.case.noArgument?0:1);assert.equal(commits.length,d.case.noArgument||d.case.missing||d.case.cancel?0:1);
 const contexts=[...kernel.threads.values(),...(kernel.sparseRetiredContexts??[])];assert(contexts.every(t=>t.sparse.executionQuiesced&&!t.sparse.retired));assert(contexts.every(t=>Atomics.load(kernel.k32,((SLOT_BASE+t.slot*SLOT_SIZE)>>2)+W_OCCUPIED)===1));
 if(!d.case.noArgument)assert.equal(kernel.procs.get(101).sparseReaped,true);kernel.closeSparseImage(initial.proc.mm);assert.equal(budget.stats().ownedPayloadBytes,0);assert.equal(kernel.sparseBroker.stats().threads,0);assert.equal(inputFile.refs,0);
 parentPort.postMessage({op:'kernel-result',id:d.case.id,exitCode:expected,stdoutBytes,stdoutSHA256:stdout.digest('hex'),stdin:{providedBytes:d.case.input.length,consumedBytes:inputFile.pos},births,commits,exits,quiesced,contexts:contexts.map(t=>({pid:t.proc.pid,slot:t.slot,steps:t.sparse.steps,executionQuiesced:true,workerRetirementAcknowledged:false})),internalContextsRetained:kernel.sparseContexts,internalBytesRetained:kernel.sparseContexts*33*65536,guestBacking:budget.stats(),broker:kernel.sparseBroker.stats(),workerRetirementAcknowledged:false});
}catch(error){parentPort.postMessage({op:'fatal',message:String(error.stack||error),contexts:[...(kernel?.threads.values()??[])].map(t=>({pid:t.proc.pid,slot:t.slot,last:t.sparse.last,steps:t.sparse.steps,pending:!!t.sparse.execPending}))});}
