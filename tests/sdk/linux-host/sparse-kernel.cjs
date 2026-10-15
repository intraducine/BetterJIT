// SPDX-License-Identifier: GPL-3.0-or-later
const {workerData:d,parentPort}=require('worker_threads'),fs=require('fs'),path=require('path'),vm=require('vm'),assert=require('node:assert/strict');
const F=require('./sparse-fixture.cjs');globalThis.self=globalThis;
for(const name of ['guest_memory.js','guest_memory_broker.js','web/linux-kernel.js'])
 vm.runInThisContext(fs.readFileSync(path.join(d.resources,'linux',name),'utf8'));
const {Kernel}=LinuxBundle.require('./kernel.js'),M=BetterJITGuestMemory,B=BetterJITGuestMemoryBroker;
const budget=new M.BackingBudget({limitBytes:32*M.PAGE}),shared=new M.SharedBacking(budget,F.PAGE),spaces=[],processes=[];
const pack=value=>{const bytes=new Uint8Array(8);new DataView(bytes.buffer).setBigUint64(0,value,true);return bytes;};
let kernel,exited=0;
function snapshot(t) {
 return ['cpu','lazyFlags','roundMode'].map(name=>{const p=d.cfg.checkpoint[name];
  return new Uint8Array(t.proc.mm.mem.buffer,t.tb+p.offset,p.size).slice();});
}
const beforeFault=new Map(),records=[];
function step(t,result) {
 const i=processes.indexOf(t.proc),s=t.sparse,view=t.proc.mm.dv,g=t.tb+d.cfg.ctx+d.cfg.gregsOff;
 if(s.steps===12) {
  t.proc.mm.guest.protect(F.DATA+F.PAGE,F.PAGE,M.PROT.READ);
  beforeFault.set(t.tid,snapshot(t));
 }
 if(s.steps!==13)return;
 assert.equal(result.status,B.STEP.FAULT);assert.equal(result.rip,F.program[12].rip);
 assert.equal(result.memory.reason,B.REASON.PROTECTION);assert.equal(result.memory.faultAddress,F.DATA+F.PAGE);
 assert.deepEqual(snapshot(t),beforeFault.get(t.tid),'full CPU, lazy flags and rounding restored');
 const reg=r=>view.getBigUint64(g+r*8,true),values=Array.from({length:16},(_,r)=>reg(r));
 assert.equal(reg(0),F.SOURCE);assert.equal(reg(2),F.sentinel(i));assert.equal(reg(1),0xffffffffffffffffn);
 assert.equal(reg(10),F.sentinel(0));assert.equal(reg(11),F.sentinel(1));assert.equal(reg(12),F.sentinel(2));
 assert.equal(reg(13),F.sentinel(i));assert.equal(reg(14),F.FS_VALUE+BigInt(i));assert.equal(reg(15),F.GS_VALUE+BigInt(i));
 assert.deepEqual(t.proc.mm.guest.read(F.DATA+F.PAGE-4n,8),pack(F.sentinel(i)),'faulting store has no partial effect');
 assert.equal(t.proc.mm.guest.read(F.DATA&0xffffffffn,1)[0],0x42+i,'low-address alias is untouched');
 assert.equal(t.proc.mm.mem.buffer.byteLength,33*65536);assert.throws(()=>t.proc.mm.mem.grow(1),RangeError);
 records.push({pid:t.proc.pid,parentPid:t.proc.ppid,status:result.status,steps:s.steps,rip:result.rip,
  faultAddress:result.memory.faultAddress,faultReason:result.memory.reason,accessWidth:8,
  registers:values,fullCheckpointRestored:true,partialStorePrevented:true,internalBytes:t.proc.mm.mem.buffer.byteLength,
  privateFrame:t.proc.mm.guest.mappingInfo(F.DATA).frameId,shared:t.proc.mm.guest.mappingInfo(F.SHARED+BigInt(i)*F.PAGE)});
}
try {
 kernel=new Kernel({vfs:{},state:d.state,log:()=>{},sparseStep:step,sparseExit:()=>{if(++exited===3)kernel.done=true;}},d.cfg);
 // Executed fixture must not enter any of these unsafe syscall semantics.
 for(const name of ['request','attempt','reply','pendingFor','deliver','freezeRequest','syncShared'])
  kernel[name]=()=>{throw Error('Sparse fixture reached unsafe '+name);};
 for(let i=0;i<3;i++) {
  const space=i===0?new M.GuestAddressSpace(budget,{virtualLimit:1n<<47n}):spaces[i-1].fork();spaces.push(space);
  if(i===0) {
   space.mapAnonymous(F.DATA,F.PAGE,3);space.mapAnonymous(0x10000n,F.PAGE,3);space.mapAnonymous(F.DATA+F.PAGE,F.PAGE,3);
   space.mapAnonymous(F.CODE,F.PAGE,3);space.write(F.CODE,F.code);space.protect(F.CODE,F.PAGE,5);
   space.mapAnonymous(F.DATA+F.FS,F.PAGE,3);space.mapAnonymous(F.DATA+F.GS,F.PAGE,3);
   space.mapAnonymous(F.DATA&0xffffffffn,F.PAGE,3);space.mapShared(F.SHARED,F.PAGE,shared);
  } else {space.unmap(F.SHARED+BigInt(i-1)*F.PAGE,F.PAGE);space.mapShared(F.SHARED+BigInt(i)*F.PAGE,F.PAGE,shared);}
  space.write(F.DATA+16n,pack(0xffffffffffffffffn));space.write(F.DATA+F.FS+32n,pack(F.FS_VALUE+BigInt(i)));
  space.write(F.DATA+F.GS+40n,pack(F.GS_VALUE+BigInt(i)));space.write(F.DATA&0xffffffffn,Uint8Array.of(0x42+i));
  const made=kernel.createSparseProcess({space,entryRip:F.CODE,plans:d.plans,parentPid:i?processes[i-1].pid:0});
  processes.push(made.proc);
  const t=made.thread,view=made.proc.mm.dv,cpu=t.tb+d.cfg.ctx,g=cpu+d.cfg.gregsOff;
  new Uint8Array(made.worker.mem.buffer,cpu,d.cfg.stateSize).fill(0x20+i);
  view.setBigUint64(cpu+d.cfg.ripOff,F.CODE,true);
  for(const [reg,value]of [[0,F.sentinel(i)],[3,F.DATA],[8,F.SHARED+BigInt(i)*F.PAGE],
   [9,F.SHARED+BigInt(i)*F.PAGE+BigInt(i)*8n]])view.setBigUint64(g+reg*8,value,true);
  view.setBigUint64(cpu+d.cfg.fsOff,F.FS,true);view.setBigUint64(cpu+d.cfg.gsOff,F.GS,true);
  view.setUint32(t.tb+d.cfg.flagSpillAddr,0,true);view.setBigUint64(t.tb+d.cfg.flagSpillAddr+8,0x123456789abcdef0n,true);
  view.setBigUint64(t.tb+d.cfg.flagSpillAddr+16,0xfedcba9876543210n,true);view.setUint32(t.tb+0x70,i,true);
  parentPort.postMessage({op:'spawn',...made.worker});
 }
 kernel.run();assert.equal(kernel.stats.syscalls,0);assert.equal(records.length,3);
 assert.equal(new Set(records.map(r=>r.privateFrame)).size,3);
 assert.equal(new Set(records.map(r=>r.shared.objectId)).size,1);
 const backing=budget.stats();assert.equal(backing.privateFrames,21);assert.equal(backing.sharedFrames,1);
 const broker=kernel.sparseBroker.stats();assert.equal(broker.requests,36);assert.equal(broker.ok,33);assert.equal(broker.faults,3);
 for(const space of spaces)space.close();shared.close();assert.equal(budget.stats().ownedPayloadBytes,0);
 parentPort.postMessage({op:'result',records,broker,backing,afterClose:budget.stats(),syscalls:kernel.stats.syscalls});
} catch(error){parentPort.postMessage({op:'fatal',message:error.stack||String(error)});}
