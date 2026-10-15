// SPDX-License-Identifier: GPL-3.0-or-later
// Actual kernel routing with a synthetic producer; live FEX evidence is separate.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
globalThis.self=globalThis;
for(const file of ['guest_memory.js','guest_memory_broker.js','thread_core.js','web/linux-kernel.js'])
 vm.runInThisContext(fs.readFileSync(new URL('../../Sources/BetterJITLinux/Resources/linux/'+file,import.meta.url),'utf8'));
const {Kernel,SLOT_BASE,SLOT_SIZE,S_REQ,S_DONE}=LinuxBundle.require('./kernel.js');
const M=BetterJITGuestMemory,B=BetterJITGuestMemoryBroker,RIP=0x123400004000n,AT=0x123456780000n;
const cfg={guestMemory:'broker1',memoryABI:1,stepABI:2,coverageVersion:2,memPages:33,memMaxPages:33,threadBase:65536,
 regArgs:0,callsViaDispatcher:false,maxInstructions:1,shared:true,
 ctx:256,stateSize:1024,ripOff:24,gregsOff:32,checkpoint:{version:1,cpu:{offset:256,size:1024,ripOffset:24},
 lazyFlags:{offset:64,size:24},roundMode:{offset:112,size:4}}};
function setup(t) {
 const budget=new M.BackingBudget(),space=new M.GuestAddressSpace(budget,{virtualLimit:1n<<47n});t.after(()=>space.close());
 space.mapAnonymous(RIP,4096n,3);space.write(RIP,Uint8Array.of(0x48,0x8b,0x03));space.protect(RIP,4096n,5);space.mapAnonymous(AT,4096n,3);
 const k=new Kernel({vfs:{},state:new Uint8Array(cfg.stateSize),log:()=>{}},cfg);
 const plan={status:0,rip:RIP,nextRip:RIP+3n,length:3,operation:1,width:8,instruction:Uint8Array.of(0x48,0x8b,0x03)};
 const {thread,proc,worker}=k.createSparseProcess({space,entryRip:RIP,plans:[plan]});
 const base=(SLOT_BASE+thread.slot*SLOT_SIZE)>>2,b64=base>>1;
 const scratch=new DataView(worker.mem.buffer,worker.tb+B.ABI.scratchOffset,128);
 let boundary=0;
 function send(nr,seq,phase=0,status=0,lease=worker.lease) {
  k.k64[b64+1]=BigInt(nr);k.k64[b64+2]=lease;k.k64[b64+3]=BigInt(seq);k.k64[b64+4]=BigInt(phase);k.k64[b64+5]=BigInt(status);
  Atomics.store(k.k32,base,S_REQ);assert.equal(k.serviceRequests(),true);assert.equal(Atomics.load(k.k32,base),S_DONE);
  assert.equal(k.k32[base+1],0);Atomics.store(k.k32,base,0);return Number(k.k64[b64+8]);
 }
 const phase=(p,status)=>send(B.ABI.instructionBoundary,++boundary,p,status);
 return {k,space,thread,proc,worker,scratch,send,phase,plan,base};
}
test('memory requests bypass syscall, signal, snapshot, reply and syncShared semantics',t=>{
 const f=setup(t);
 for(const name of ['request','attempt','reply','pendingFor','deliver','freezeRequest','syncShared'])f.k[name]=()=>{throw Error('unsafe '+name);};
 f.space.write(AT,new Uint8Array(8).fill(255));f.phase(1);f.k.signalThread(f.thread,1);
 for(const [name,value]of Object.entries({magic:B.ABI.magic,version:1,sequence:1,operation:1,width:8,access:1,
  address:AT,rip:RIP,checkpoint:1n,lease:f.worker.lease})) {
  if(typeof value==='bigint')f.scratch.setBigUint64(B.FIELD[name],value,true);else f.scratch.setUint32(B.FIELD[name],value,true);
 }
 assert.equal(f.send(B.ABI.memoryRequest,1),0);assert.equal(f.scratch.getBigUint64(B.FIELD.result0,true),0xffffffffffffffffn);
 assert.equal(f.thread.pending,1n);assert.equal(f.k.stats.syscalls,0);
 new DataView(f.worker.mem.buffer).setBigUint64(f.worker.tb+cfg.ctx+cfg.ripOff,RIP+3n,true);f.phase(2,0);
 f.thread.pending=0n;f.phase(3);assert.equal(f.thread.dead,true);assert.equal(f.k.sparseBroker.stats().threads,0);
});
test('a stale mailbox lease cannot touch current scratch or begin a checkpoint',t=>{
 const f=setup(t),before=new Uint8Array(f.scratch.buffer,f.scratch.byteOffset,128).slice();
 assert.throws(()=>f.send(B.ABI.memoryRequest,1,0,0,f.worker.lease+1n),/Stale/);
 assert.deepEqual(new Uint8Array(f.scratch.buffer,f.scratch.byteOffset,128),before);assert.equal(f.k.sparseBroker.stats().requests,0);
});
test('writable/shared executable code, shared address-space reuse and code changes are refused',t=>{
 const f=setup(t);assert.throws(()=>f.k.createSparseProcess({space:f.space,entryRip:RIP,plans:[f.plan]}),/independent/);
 f.space.protect(RIP,4096n,7);assert.throws(()=>f.phase(1),/executable-alias/);
 f.space.write(RIP,Uint8Array.of(0x90));f.space.protect(RIP,4096n,5);assert.throws(()=>f.phase(1),/bytes changed/);
 const b=new M.BackingBudget(),o=new M.SharedBacking(b,4096n),s=new M.GuestAddressSpace(b);t.after(()=>o.close());t.after(()=>s.close());
 s.mapShared(0x10000n,4096n,o,0n,{prot:5});assert.throws(()=>s.executableSnapshot(0x10000n,1),/executable-alias/);
});
test('ordinary syscall/ELF entry and pending signals fail explicitly at safe boundaries',t=>{
 const f=setup(t);assert.throws(()=>f.k.request(f.thread),/cannot enter/);assert.throws(()=>f.k.boot([],[]),/not implemented/);
 assert.throws(()=>f.k.deliver(f.thread),/signal frames/);assert.throws(()=>f.k.exitThread(f.thread,0),/step boundary/);
 assert.throws(()=>f.k.exitProcess(f.proc,0),/step boundary/);
 const tooWide=new M.GuestAddressSpace(new M.BackingBudget(),{virtualLimit:1n<<48n});t.after(()=>tooWide.close());
 assert.throws(()=>f.k.createSparseProcess({space:tooWide,entryRip:RIP,plans:[f.plan]}),/canonical/);
 f.thread.pending=1n;assert.throws(()=>f.phase(1),/signals\/snapshots/);assert.equal(f.k.stats.syscalls,0);
});
test('process signals queue until a boundary and snapshots refuse before touching a sparse worker',t=>{
 const f=setup(t);LinuxBundle.require('./snapshot.js');
 const before=new Uint8Array(f.worker.mem.buffer).slice();let error;
 f.k.freeze(1000,e=>error=e);assert.equal(error,'Sparse snapshots are unsupported');assert.equal(f.k.freezing,undefined);
 f.k.killProcess(f.proc,9);assert.equal(f.thread.dead,false);assert.equal(f.thread.pending,1n<<8n);
 assert.deepEqual(new Uint8Array(f.worker.mem.buffer),before);assert.throws(()=>f.phase(1),/signals\/snapshots/);
});
test('boundary replay and success without full post-state are fatal rather than passing',t=>{
 const f=setup(t);f.phase(1);assert.throws(()=>f.send(B.ABI.instructionBoundary,1,1),/sequence/);
 const g=setup(t);g.phase(1);assert.throws(()=>g.phase(2,0),/post-state/);
});
test('step parser rejects incompatible or malformed typed native headers',()=>{
 const bytes=new Uint8Array(80),v=new DataView(bytes.buffer);
 [0x31534a42,1,1,2,2,2].forEach((x,i)=>v.setUint32(i*4,x,true));
 assert.equal(FexLinuxThread.parseBrokerStep(bytes).status,2);
 v.setUint32(4,2,true);assert.throws(()=>FexLinuxThread.parseBrokerStep(bytes),/ABI/);
 v.setUint32(4,1,true);v.setUint32(20,0,true);assert.throws(()=>FexLinuxThread.parseBrokerStep(bytes),/metadata/);
});
test('threads share guest storage but own separate fixed internal contexts under an explicit capacity',t=>{
 const f=setup(t),all=[{thread:f.thread,worker:f.worker}];
 for(let i=1;i<B.ABI.maximumThreads;i++)all.push(f.k.createSparseThread(f.proc,{entryRip:RIP,plans:[f.plan]}));
 assert.equal(new Set(all.map(x=>x.worker.mem)).size,8);assert.equal(f.proc.threads.size,8);
 const at=B.ABI.threadBase+cfg.ctx+64;
 for(const [i,x]of all.entries()) {
  x.thread.sparse.view.setBigUint64(at,BigInt(i+1),true);assert.equal(x.worker.mem.buffer.byteLength,33*65536);
  assert.throws(()=>x.worker.mem.grow(1),RangeError);t.after(()=>f.k.sparseBroker.unregister(x.thread.sparse.token));
  f.k.cpu(x.thread).set(0,BigInt(i+100));
 }
 assert.equal(f.proc.mm.dv.getBigUint64(at,true),1n);
 assert.equal(all[1].thread.sparse.view.getBigUint64(at,true),2n);
 for(const [i,x]of all.entries())assert.equal(f.k.cpu(x.thread).get(0),BigInt(i+100));
 assert.throws(()=>f.k.cpu({proc:f.proc,tb:f.thread.tb}),/Authenticated/);
 assert.throws(()=>f.k.createSparseThread(f.proc,{entryRip:RIP,plans:[f.plan]}),/capacity/);
 f.phase(3);assert.equal(f.proc.zombie,false,'other live threads keep the process live');
 assert.throws(()=>f.k.cpu(f.thread),/Authenticated/);
});
