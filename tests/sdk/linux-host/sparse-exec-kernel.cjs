// SPDX-License-Identifier: GPL-3.0-or-later
const {workerData:d,parentPort}=require('worker_threads'),fs=require('fs'),path=require('path'),vm=require('vm'),assert=require('node:assert/strict'),F=require('./sparse-exec-fixture.cjs');
globalThis.self=globalThis;for(const n of ['guest_memory.js','guest_memory_broker.js','guest_image.js','web/linux-kernel.js'])vm.runInThisContext(fs.readFileSync(path.join(d.resources,'linux',n),'utf8'));
const M=BetterJITGuestMemory,I=BetterJITGuestImage,{Kernel}=LinuxBundle.require('./kernel.js'),budget=new M.BackingBudget(),space=new M.GuestAddressSpace(budget,{virtualLimit:1n<<47n}),births=[],commits=[],exits=[],failed=['missing-file','malformed','terminate-before-ready','terminate-during-translation'].includes(d.scenario);let kernel,initial,oldImage;
try{
 let bytes=F.elf().bytes;if(d.scenario==='malformed')bytes=Uint8Array.of(127,69);if(d.scenario==='unsupported-entry')bytes[4096]=0xcc;
 kernel=new Kernel({state:d.state,vfs:{},log:()=>{},sparseLifecycleVersion:3,
  sparseExecutables:new I.ExecutableStore(d.scenario==='missing-file'?[]:[{path:'/bin/second',bytes}]),
  spawnSparseThread:s=>parentPort.postMessage({op:'spawn',...s}),stopSparseThread:s=>parentPort.postMessage({op:'stop',...s}),dropSparseSpace:s=>parentPort.postMessage({op:'drop',...s}),
  sparseCloneCreated:t=>{births.push({pid:t.proc.pid,tid:t.tid,slot:t.slot,lease:t.sparse.token.generation});oldImage=t.proc.mm;},
  sparseExecCommitted:(t,old)=>{assert.equal(old.sparse.retired,true);assert.equal(oldImage.guest.stats().closed,true);assert.notEqual(t.sparse.memory,old.sparse.memory);assert.equal(t.tid,old.tid);assert.equal(t.sigmask,1n<<9n);assert.throws(()=>t.proc.mm.guest.read(F.CODE,1),M.MemoryFault);commits.push({pid:t.proc.pid,tid:t.tid,slot:t.slot,lease:t.sparse.token.generation,...t.sparse.executedImage});},
  sparseExit:t=>{const s=t.sparse;exits.push({pid:t.proc.pid,tid:t.tid,slot:t.slot,code:s.guestExitCode,status:s.terminalStatus,...(!s.executedImage?{data:[...s.space.read(F.DATA,32)]}:{})});},
  sparseWorkerRetired:()=>{if(d.scenario==='unsupported-entry'){
    const child=[...kernel.procs.values()].find(p=>p.pid!==initial.proc.pid);if(child?.zombie&&[...child.threads.values()].every(t=>t.sparse.retired)){
     kernel.sparseWaits.clear();initial.thread.sparse.waitPending=null;
     if(initial.thread.sparse.retired)kernel.done=true;
     else if(!kernel.profileStop){kernel.profileStop=true;parentPort.postMessage({op:'stop',slot:initial.thread.slot,lease:initial.thread.sparse.token.generation});}
    }
   }else if(exits.length===2&&[...kernel.threads.values()].every(t=>t.sparse.retired))kernel.done=true;}
 },d.cfg);
 for(const n of ['request','attempt','reply','pendingFor','deliver','freezeRequest','syncShared'])kernel[n]=()=>{throw Error('unsafe '+n);};
 const b=F.bootstrap();space.mapAnonymous(F.CODE,F.PAGE,3);space.write(F.CODE,b.image);space.protect(F.CODE,F.PAGE,5);space.mapAnonymous(F.DATA,F.PAGE,3);space.write(F.DATA,b.data);
 initial=kernel.createSparseProcess({space,entryRip:F.CODE,plans:d.plans});initial.thread.sigmask=1n<<9n;parentPort.postMessage({op:'spawn',...initial.worker});kernel.run();
 assert.equal(births.length,1);assert.equal(kernel.sparseExecs?.size??0,0);assert.equal(kernel.sparseBroker.stats().threads,0);
 const child=kernel.procs.get(births[0].pid);assert.equal(child.pid,101);
 if(d.scenario==='unsupported-entry'){
  const t=child.threads.get(child.pid),s=t.sparse;assert.equal(s.terminalStatus,2);assert.equal(s.guestExitCode,undefined);assert.equal(s.view.getBigUint64(t.tb+d.cfg.ctx+d.cfg.ripOff,true),b.program.find(p=>p.name==='exec').rip);assert.equal(child.mm,oldImage);assert.equal(oldImage.guest.stats().closed,false);assert.equal(commits.length,0);
 }else{
  const p=exits.find(e=>e.pid===initial.proc.pid),c=exits.find(e=>e.pid===child.pid),v=new DataView(Uint8Array.from(p.data).buffer);assert.equal(p.code,17);assert.equal(p.status,0);assert.equal(v.getBigUint64(0,true),101n);assert.equal(v.getBigUint64(16,true),101n);assert.equal(v.getUint32(8,true),(failed?31:37)<<8);assert.equal(c.code,failed?31:37);if(failed){const errno=d.scenario==='missing-file'?-2n:d.scenario==='malformed'?-8n:-11n;assert.equal(new DataView(Uint8Array.from(c.data).buffer).getBigUint64(24,true),BigInt.asUintN(64,errno));}assert.equal(child.sparseReaped,true);assert.equal(child.mm.guest.stats().closed,true);assert.equal(commits.length,failed?0:1);
 }
 const records=[...kernel.threads.values(),...(kernel.sparseRetiredContexts??[])].map(t=>({pid:t.proc.pid,tid:t.tid,slot:t.slot,steps:t.sparse.steps,syscalls:t.sparse.syscalls,retired:t.sparse.retired,code:t.sparse.guestExitCode,replaced:!!t.sparse.execStop}));
 for(const t of kernel.threads.values())kernel.sparseBroker.unregister(t.sparse.token);for(const p of kernel.procs.values())kernel.closeSparseImage(p.mm);space.close();assert.equal(budget.stats().ownedPayloadBytes,0);
 parentPort.postMessage({op:'kernel-result',scenario:d.scenario,births,commits,exits,records,broker:kernel.sparseBroker.stats(),afterClose:budget.stats()});
}catch(error){space.close();parentPort.postMessage({op:'fatal',message:d.scenario+': '+(error.stack||String(error))+' records='+JSON.stringify([...kernel.threads.values()].map(t=>({pid:t.proc.pid,dead:t.dead,last:t.sparse.last,guestExit:t.sparse.guestExitCode,steps:t.sparse.steps})),(_k,x)=>typeof x==='bigint'?'0x'+x.toString(16):x)});}
