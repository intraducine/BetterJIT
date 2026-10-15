// SPDX-License-Identifier: GPL-3.0-or-later
const {workerData:d,parentPort}=require('worker_threads'),fs=require('fs'),path=require('path'),vm=require('vm'),assert=require('node:assert/strict'),Factory=require('./sparse-fork-fixture.cjs'),F=Factory.make({badStatus:d.scenario==='bad-status'}),hasChild=!['missing-continuation','terminate-before-ready'].includes(d.scenario);
globalThis.self=globalThis;for(const n of ['guest_memory.js','guest_memory_broker.js','web/linux-kernel.js'])vm.runInThisContext(fs.readFileSync(path.join(d.resources,'linux',n),'utf8'));
const M=BetterJITGuestMemory,{Kernel}=LinuxBundle.require('./kernel.js'),budget=new M.BackingBudget(),space=new M.GuestAddressSpace(budget,{virtualLimit:1n<<47n}),shared=new M.SharedBacking(budget,F.PAGE),births=[],exits=[];let kernel,initial,waits=0;
try {
 kernel=new Kernel({state:d.state,vfs:{},log:()=>{},sparseLifecycleVersion:2,spawnSparseThread:spec=>parentPort.postMessage({op:'spawn',...spec}),stopSparseThread:spec=>parentPort.postMessage({op:'stop',...spec}),
  sparseCloneCreated:t=>births.push({pid:t.proc.pid,tid:t.tid,...t.sparse.createdBy}),sparseWaitQueued:()=>{waits++;parentPort.postMessage({op:'wait-queued'});},
  sparseExit:t=>{const s=t.proc.mm.guest;exits.push({pid:t.proc.pid,tid:t.tid,code:t.sparse.guestExitCode,status:t.sparse.terminalStatus,privateBytes:[...s.read(F.DATA,48)],frame:s.mappingInfo(F.DATA).frameId});},
  sparseWorkerRetired:()=>{const count=hasChild?2:1;if(exits.length===count&&[...kernel.threads.values()].every(t=>t.sparse.retired))kernel.done=true;}
 },d.cfg);
 for(const n of ['request','attempt','reply','pendingFor','deliver','freezeRequest','syncShared'])kernel[n]=()=>{throw Error('unsafe '+n);};
 space.mapAnonymous(F.CODE,F.PAGE,3);space.write(F.CODE,F.image);space.protect(F.CODE,F.PAGE,5);space.mapAnonymous(F.DATA,F.PAGE,3);space.mapAnonymous(F.DATA&0xffffffffn,F.PAGE,3);space.write(F.DATA&0xffffffffn,new Uint8Array(48).fill(0x77));space.mapShared(F.SHARED,F.PAGE,shared);
 initial=kernel.createSparseProcess({space,entryRip:F.CODE,plans:d.plans});initial.thread.sigmask=1n<<9n;parentPort.postMessage({op:'spawn',...initial.worker});kernel.run();
 const parent=exits.find(e=>e.pid===initial.proc.pid),read=(e,off)=>new DataView(Uint8Array.from(e.privateBytes).buffer).getBigUint64(off,true);
 assert.deepEqual(space.read(F.DATA&0xffffffffn,48),new Uint8Array(48).fill(0x77));assert.equal(kernel.sparseClones.size,0);assert.equal(kernel.sparseWaits?.size??0,0);
 if(hasChild) {
  assert.equal(births.length,1);const b=births[0],child=exits.find(e=>e.pid===b.pid),proc=kernel.procs.get(b.pid);
  assert.equal(b.syscall,57);assert.equal(b.parentPid,initial.proc.pid);assert.equal(b.rip,F.program.find(p=>p.name==='fork').rip);assert.notEqual(proc.mm.guest,space);assert.equal(proc.sparseReaped,true);assert.equal(proc.mm.guest.stats().closed,true);assert.equal(initial.proc.children.size,0);
  assert.equal(read(parent,0),BigInt(b.pid));assert.equal(read(child,0),0n);assert.equal(read(parent,8),17n);assert.equal(read(child,8),43n);assert.equal(read(parent,16),d.scenario==='bad-status'?0n:23n<<8n);assert.equal(read(parent,24),85n);assert.equal(read(parent,32),d.scenario==='bad-status'?BigInt.asUintN(64,-14n):BigInt(b.pid));assert.equal(read(parent,40),BigInt.asUintN(64,-10n));assert.notEqual(parent.frame,child.frame);
  assert.equal(parent.code,17);assert.equal(child.code,23);assert.equal(waits,1);assert.equal(kernel.procs.size,2);
 }else{assert.equal(births.length,0);assert.equal(read(parent,0),BigInt.asUintN(64,-11n));assert.equal(parent.code,31);assert.equal(kernel.procs.size,1);}
 for(const e of exits)assert.equal(e.status,0);
 const records=[...kernel.threads.values()].map(t=>({pid:t.proc.pid,tid:t.tid,steps:t.sparse.steps,syscalls:t.sparse.syscalls,guestExitCode:t.sparse.guestExitCode,retired:t.sparse.retired}));space.close();shared.close();assert.equal(budget.stats().ownedPayloadBytes,0);
 parentPort.postMessage({op:'kernel-result',births,exits,records,waits,afterClose:budget.stats(),broker:kernel.sparseBroker.stats()});
}catch(error){space.close();shared.close();parentPort.postMessage({op:'fatal',message:error.stack||String(error)});}
