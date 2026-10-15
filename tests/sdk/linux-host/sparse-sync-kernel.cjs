// SPDX-License-Identifier: GPL-3.0-or-later
const fs=require('fs'),path=require('path'),vm=require('vm'),assert=require('node:assert/strict'),{workerData:d,parentPort}=require('worker_threads');
const F=require('./sparse-sync-fixture.cjs');globalThis.self=globalThis;
for(const n of ['guest_memory.js','guest_memory_broker.js','web/linux-kernel.js'])vm.runInThisContext(fs.readFileSync(path.join(d.resources,'linux',n),'utf8'));
const M=BetterJITGuestMemory,{Kernel}=LinuxBundle.require('./kernel.js'),budget=new M.BackingBudget({limitBytes:64*M.PAGE}),
 shared=new M.SharedBacking(budget,F.PAGE),spaces=[],made=[],oldValues=[],events=[],control=new Int32Array(d.barrier);
let kernel,exited=0,otherProcessProgressed=false;
const userCopies={copyIn:0,bytes:0};
const reg=(t,index)=>t.sparse.view.getBigUint64(t.tb+d.cfg.ctx+d.cfg.gregsOff+index*8,true);
try {
 kernel=new Kernel({vfs:{},state:d.state,log:()=>{},
  sparseFutexQueued:(t,request)=>{
   if(t.proc.index===0){const release=request.private?5:7;Atomics.store(control,release,1);Atomics.notify(control,release);}
   else {
    assert.equal(t.proc.index,2);assert.equal(request.private,true);
    if(request.address===F.PRIVATE+0x204n)kernel.addTimer(0,()=>kernel.signalThread(t,10));
   }
  },
  sparseStep:(t,result)=>{
   const index=t.sparse.fixtureIndex,e=F.programs[index].entries[t.sparse.steps-1];
   if(e.name==='counter-add'){assert.equal(reg(t,0),result.memory.data);oldValues.push(result.memory.data);}
   if(e.name==='counter-cas-success'){assert.equal(result.memory.data,48n);assert.equal(reg(t,0),48n);}
   if(e.name==='counter-cas-mismatch'){assert.equal(result.memory.data,48n);assert.equal(reg(t,0),48n);}
   if(e.name==='private-progress-store') {
    assert.ok(made[0].thread.sparse.parked);otherProcessProgressed=true;Atomics.store(control,11,1);Atomics.notify(control,11);
   }
   if(result.syscall) {
    const expected={'private-wait':0n,'shared-wait':0n,'private-wake-other-mm':0n,'shared-wake-alias':1n,'compare-mismatch':-11n,
     'private-timeout':-110n,'private-wake-same-mm-other-alias':0n,'private-wake-same-mm-same-va':1n,'signal-cancelled-wait':-4n}[e.name];
    assert.equal(result.result,expected,e.name);
    if(e.name==='private-wake-other-mm') {
     assert.ok(made[0].thread.sparse.parked,'PRIVATE wake must leave other mm parked');Atomics.store(control,9,1);Atomics.notify(control,9);
    }
    if(e.name==='private-wake-same-mm-other-alias')assert.ok(made[0].thread.sparse.parked,'same-mm alias must remain a different PRIVATE key');
    events.push({pid:t.proc.pid,name:e.name,result:result.result,rip:result.rip});
   }
  },sparseExit:()=>{if(++exited===4)kernel.done=true;}},d.cfg);
 for(const name of ['request','attempt','reply','pendingFor','deliver','freezeRequest','syncShared'])kernel[name]=()=>{throw Error('unsafe '+name);};
 for(let i=0;i<3;i++) {
  const space=new M.GuestAddressSpace(budget,{virtualLimit:1n<<47n});spaces.push(space);
  space.mapAnonymous(F.CODE,4n*F.PAGE,3);space.write(F.CODE,F.image);space.protect(F.CODE,4n*F.PAGE,5);
  space.mapAnonymous(F.PRIVATE,F.PAGE,3);space.mapShared(F.SHARED+BigInt(i)*0x10000n,F.PAGE,shared);
  const timeout=new Uint8Array(16);new DataView(timeout.buffer).setBigInt64(8,50000000n,true);space.write(F.PRIVATE+0x100n,timeout);
  if(i===0){space.write(F.SHARED+0x108n,Uint8Array.of(7,0,0,0));space.mapShared(F.ALIAS,F.PAGE,shared);}
  const p=F.programs[i],m=kernel.createSparseProcess({space,entryRip:p.entry,plans:d.plans[i],parentPid:i?made[i-1].proc.pid:0});
  m.proc.index=i;m.thread.sparse.fixtureIndex=i;made.push(m);
  const v=m.thread.sparse.view,g=m.thread.tb+d.cfg.ctx+d.cfg.gregsOff;
  v.setBigUint64(g+3*8,F.SHARED+BigInt(i)*0x10000n,true);v.setBigUint64(g+9*8,F.PRIVATE,true);
  parentPort.postMessage({op:'spawn',...m.worker,index:i,stopRip:p.stopRip,maximumSteps:p.entries.length,pauses:p.pauses});
 }
 const observer=F.programs[3],extra=kernel.createSparseThread(made[0].proc,{entryRip:observer.entry,plans:d.plans[3]});
 extra.thread.sparse.fixtureIndex=3;made.push(extra);
 assert.notEqual(extra.worker.mem,made[0].worker.mem);assert.equal(extra.proc,made[0].proc);
 parentPort.postMessage({op:'spawn',...extra.worker,index:3,stopRip:observer.stopRip,maximumSteps:observer.entries.length,pauses:observer.pauses});
 const copyIn=kernel.sparseBroker.copyIn.bind(kernel.sparseBroker);
 kernel.sparseBroker.copyIn=(token,address,length)=>{
  assert.equal(token,made[2].thread.sparse.token);assert.equal(address,F.PRIVATE+0x100n);assert.equal(length,16);
  userCopies.copyIn++;userCopies.bytes+=length;return copyIn(token,address,length);
 };
 kernel.run();assert.deepEqual(userCopies,{copyIn:1,bytes:16});assert.equal(otherProcessProgressed,true);assert.equal(oldValues.length,48);
 assert.deepEqual([...oldValues].sort((a,b)=>Number(a-b)),Array.from({length:48},(_,i)=>BigInt(i)));
 assert.equal(new DataView(spaces[0].read(F.SHARED,8).buffer).getBigUint64(0,true),99n);
 assert.equal(reg(made[0].thread,12),0n);assert.equal(reg(made[0].thread,13),0n);
 assert.equal(reg(made[1].thread,12),0n);assert.equal(reg(made[1].thread,13),1n);assert.equal(reg(made[1].thread,15),99n);
 assert.equal(reg(made[2].thread,14),48n);assert.equal(reg(made[2].thread,13),BigInt.asUintN(64,-11n));assert.equal(reg(made[2].thread,15),F.PRIVATE_VALUE);
 assert.equal(reg(made[2].thread,12),BigInt.asUintN(64,-110n));assert.equal(reg(made[3].thread,12),0n);assert.equal(reg(made[3].thread,13),1n);
 assert.deepEqual(spaces[0].read(F.PRIVATE,8),new Uint8Array(8));assert.deepEqual(spaces[1].read(F.PRIVATE,8),new Uint8Array(8));
 assert.equal(kernel.stats.syscalls,0);assert.equal(events.length,9);
 assert.equal(reg(made[2].thread,0),BigInt.asUintN(64,-4n));assert.notEqual(made[2].thread.pending,0n);
 assert.deepEqual(kernel.sparseBroker.futexStats(),{waiting:0,queued:4,completed:4});
 const records=made.map(m=>({pid:m.proc.pid,tid:m.thread.tid,parentPid:m.proc.ppid,steps:m.thread.sparse.steps,syscalls:m.thread.sparse.syscalls,
  internalBytes:m.worker.mem.buffer.byteLength,terminalStatus:m.proc.exitStatus,privateFrame:m.proc.mm.guest.mappingInfo(F.PRIVATE).frameId}));
 for(const m of made)assert.throws(()=>m.worker.mem.grow(1),RangeError);
 const backing=budget.stats();for(const s of spaces)s.close();shared.close();assert.equal(budget.stats().ownedPayloadBytes,0);
 parentPort.postMessage({op:'result',records,events,userCopies,atomicOldValues:oldValues,finalCounter:99n,otherProcessProgressed,
  broker:kernel.sparseBroker.stats(),futex:kernel.sparseBroker.futexStats(),backing,afterClose:budget.stats(),syscalls:kernel.stats.syscalls});
}catch(error){parentPort.postMessage({op:'fatal',message:error.stack||String(error)});}
