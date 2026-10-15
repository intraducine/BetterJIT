// SPDX-License-Identifier: GPL-3.0-or-later
const {workerData:d,parentPort}=require('worker_threads'),fs=require('fs'),path=require('path'),vm=require('vm'),assert=require('node:assert/strict');
const F=require('./sparse-clone-fixture.cjs');globalThis.self=globalThis;
for(const n of ['guest_memory.js','guest_memory_broker.js','web/linux-kernel.js'])vm.runInThisContext(fs.readFileSync(path.join(d.resources,'linux',n),'utf8'));
const M=BetterJITGuestMemory,{Kernel}=LinuxBundle.require('./kernel.js'),budget=new M.BackingBudget(),space=new M.GuestAddressSpace(budget,{virtualLimit:1n<<47n});
let kernel;const births=[],exits=[],expectedThreads=d.scenario==='success'?2:1;
try {
 kernel=new Kernel({vfs:{},state:d.state,log:()=>{},sparseLifecycleVersion:1,
  spawnSparseThread:spec=>parentPort.postMessage({op:'spawn',...spec}),
  stopSparseThread:spec=>parentPort.postMessage({op:'stop',...spec}),
  sparseCloneCreated:t=>births.push({tid:t.tid,pid:t.proc.pid,...t.sparse.createdBy}),
  sparseExit:t=>{exits.push({tid:t.tid,code:t.sparse.guestExitCode,status:t.sparse.terminalStatus});},
  sparseWorkerRetired:()=>{if(exits.length===expectedThreads&&[...kernel.threads.values()].every(t=>t.sparse.retired))kernel.done=true;}
 },d.cfg);
 for(const n of ['request','attempt','reply','pendingFor','deliver','freezeRequest','syncShared'])kernel[n]=()=>{throw Error('unsafe '+n);};
 space.mapAnonymous(F.CODE,F.PAGE,3);space.write(F.CODE,F.image);space.protect(F.CODE,F.PAGE,5);
 space.mapAnonymous(F.DATA,3n*F.PAGE,3);space.mapAnonymous(F.DATA&0xffffffffn,3n*F.PAGE,3);
 space.write((F.PARENT_STACK&0xffffffffn)-8n,new Uint8Array(8).fill(0x77));space.write((F.CHILD_STACK&0xffffffffn)-8n,new Uint8Array(8).fill(0x77));
 const initial=kernel.createSparseProcess({space,entryRip:F.CODE,plans:d.plans});initial.thread.sigmask=1n<<9n;
 parentPort.postMessage({op:'spawn',...initial.worker});kernel.run();
 assert.equal(kernel.procs.size,1);assert.equal(kernel.threads.size,expectedThreads);assert.equal(births.length,expectedThreads-1);assert.equal(kernel.sparseClones.size,0);
 const child=[...kernel.threads.values()].find(t=>t!==initial.thread),read=at=>new DataView(space.read(at,8).buffer).getBigUint64(0,true);
 if(child) {
  assert.equal(births[0].syscall,56);assert.equal(births[0].parentTid,initial.thread.tid);assert.equal(births[0].stack,F.CHILD_STACK);
  assert.equal(births[0].rip,F.program.find(p=>p.name==='clone').rip);assert.equal(child.sigmask,initial.thread.sigmask);assert.notEqual(child.sparse.memory,initial.worker.mem);
 }
 assert.equal(read(F.PARENT_STACK-8n),child?BigInt(child.tid):BigInt.asUintN(64,-11n));assert.equal(read(F.CHILD_STACK-8n),0n);
 for(const top of [F.PARENT_STACK,F.CHILD_STACK])assert.deepEqual(space.read((top&0xffffffffn)-8n,8),new Uint8Array(8).fill(0x77));
 assert.equal(initial.proc.zombie,true);
 assert.deepEqual(exits.map(x=>x.code).sort((a,b)=>a-b),child?[0,child.tid&255]:[245]);for(const e of exits)assert.equal(e.status,0);
 const records=[...kernel.threads.values()].map(t=>({tid:t.tid,pid:t.proc.pid,steps:t.sparse.steps,syscalls:t.sparse.syscalls,guestExitCode:t.sparse.guestExitCode,retired:t.sparse.retired,internalBytes:t.sparse.memory.buffer.byteLength}));
 space.close();assert.equal(budget.stats().ownedPayloadBytes,0);
 parentPort.postMessage({op:'kernel-result',births,exits,records,afterClose:budget.stats(),broker:kernel.sparseBroker.stats()});
}catch(error){space.close();parentPort.postMessage({op:'fatal',message:error.stack||String(error)});}
