// SPDX-License-Identifier: GPL-3.0-or-later
// Actual dedicated kernel route with a synthetic spilled syscall producer.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
globalThis.self=globalThis;
for(const name of ['guest_memory.js','guest_memory_broker.js','web/linux-kernel.js'])vm.runInThisContext(fs.readFileSync(
 new URL('../../Sources/BetterJITLinux/Resources/linux/'+name,import.meta.url),'utf8'));
const M=BetterJITGuestMemory,B=BetterJITGuestMemoryBroker,{Kernel,SLOT_BASE,SLOT_SIZE,S_REQ,S_DONE,S_BUSY,W_OCCUPIED}=LinuxBundle.require('./kernel.js');
const RIP=0x123400004000n,AT=0x123456780000n,P=4096n;
const cfg={guestMemory:'broker1',memoryABI:1,stepABI:2,coverageVersion:2,memPages:33,memMaxPages:33,threadBase:65536,
 regArgs:0,callsViaDispatcher:false,maxInstructions:1,shared:true,ctx:256,stateSize:1024,ripOff:24,gregsOff:32,
 checkpoint:{version:1,cpu:{offset:256,size:1024,ripOffset:24},lazyFlags:{offset:64,size:24},roundMode:{offset:112,size:4}}};
function setup(t) {
 const budget=new M.BackingBudget(),object=new M.SharedBacking(budget,P);t.after(()=>object.close());const spaces=[],steps=[];
 const k=new Kernel({vfs:{},state:new Uint8Array(cfg.stateSize),log:()=>{},sparseStep:(th,r)=>steps.push({tid:th.tid,result:r.result})},cfg);
 const plan={status:0,rip:RIP,nextRip:RIP+2n,length:2,operation:5,width:0,instruction:Uint8Array.of(0x0f,0x05)};
 function make(index) {
  const space=new M.GuestAddressSpace(budget,{virtualLimit:1n<<47n});spaces.push(space);t.after(()=>space.close());
  space.mapAnonymous(RIP,P,3);space.write(RIP,plan.instruction);space.protect(RIP,P,5);space.mapShared(AT+BigInt(index)*P,P,object);
  const made=k.createSparseProcess({space,entryRip:RIP,plans:[plan]}),th=made.thread,v=made.proc.mm.dv,
   b64=(SLOT_BASE+th.slot*SLOT_SIZE)>>3,b32=b64*2,g=th.tb+cfg.ctx+cfg.gregsOff;
  let sequence=0;
  function phase(p,status=0) {
   k.k64[b64+1]=BigInt(B.ABI.instructionBoundary);k.k64[b64+2]=made.worker.lease;k.k64[b64+3]=BigInt(++sequence);
   k.k64[b64+4]=BigInt(p);k.k64[b64+5]=BigInt(status);Atomics.store(k.k32,b32,S_REQ);k.serviceRequests();
   return Atomics.load(k.k32,b32);
  }
  function begin({address=AT+BigInt(index)*P,op=0,value=0n,timeout=0n,nr=202n}={}) {
   v.setBigUint64(th.tb+cfg.ctx+cfg.ripOff,RIP,true);
   for(const [r,x]of [[0,nr],[7,address],[6,BigInt(op)],[2,value],[10,timeout]])v.setBigUint64(g+r*8,BigInt.asUintN(64,x),true);
   assert.equal(phase(1),S_DONE);Atomics.store(k.k32,b32,0);v.setBigUint64(th.tb+cfg.ctx+cfg.ripOff,RIP+2n,true);
   return phase(2,B.STEP.SYSCALL);
  }
  const result=()=>v.getBigInt64(g,true),ack=()=>Atomics.store(k.k32,b32,0);
  return {...made,space,phase,begin,result,ack,b32,v};
 }
 return {k,budget,object,steps,make,spaces};
}
test('a futex wait parks only its slot and a shared alias wake completes it without syscall hooks',t=>{
 const f=setup(t),a=f.make(0),b=f.make(1);
 for(const name of ['request','attempt','reply','pendingFor','deliver','freezeRequest','syncShared'])f.k[name]=()=>{throw Error('unsafe '+name);};
 assert.equal(a.begin(),S_BUSY);assert.equal(f.k.sparseBroker.futexStats().waiting,1);assert.equal(f.steps.length,0);
 assert.equal(b.begin({op:1,value:1n}),S_DONE);assert.equal(b.result(),1n);assert.equal(Atomics.load(f.k.k32,a.b32),S_DONE);assert.equal(a.result(),0n);
 assert.equal(f.k.stats.syscalls,0);assert.equal(f.k.sparseBroker.futexStats().waiting,0);assert.equal(f.steps.length,2);
});
test('PRIVATE wake in another mm cannot wake a canonical shared alias waiter',t=>{
 const f=setup(t),a=f.make(0),b=f.make(1);assert.equal(a.begin({op:128}),S_BUSY);
 assert.equal(b.begin({op:129,value:1n}),S_DONE);assert.equal(b.result(),0n);assert.equal(Atomics.load(f.k.k32,a.b32),S_BUSY);
 f.k.sparseBroker.cancelFutex(a.thread.sparse.parked,-110n);assert.equal(a.result(),-110n);
});
test('compare mismatch precedes a zero timeout and timeout completes a matching wait exactly once',t=>{
 const f=setup(t),a=f.make(0);a.space.mapAnonymous(AT+2n*P,P,3);const timeout=AT+2n*P;
 assert.equal(a.begin({value:1n,timeout}),S_DONE);assert.equal(a.result(),-11n);assert.equal(f.k.timers.length,0);a.ack();
 assert.equal(a.begin({timeout}),S_BUSY);const timer=f.k.timers[0];timer.fn();assert.equal(a.result(),-110n);assert.equal(timer.dead,true);
 const before=f.steps.length;timer.fn();assert.equal(f.steps.length,before);assert.equal(f.k.sparseBroker.futexStats().waiting,0);
});
test('a signal cancels a parked wait at a spilled boundary without delivering a frame',t=>{
 const f=setup(t),a=f.make(0);assert.equal(a.begin(),S_BUSY);f.k.signalThread(a.thread,10);
 assert.equal(a.result(),-4n);assert.equal(Atomics.load(f.k.k32,a.b32),S_DONE);assert.notEqual(a.thread.pending,0n);
 assert.equal(f.k.sparseBroker.futexStats().waiting,0);a.ack();assert.throws(()=>a.phase(1),/signals\/snapshots/);
});
test('retirement cancels a timer/key lease and a late timeout cannot reply to a reused slot',t=>{
 const f=setup(t),a=f.make(0);a.space.mapAnonymous(AT+2n*P,P,3);
 assert.equal(a.begin({timeout:AT+2n*P}),S_BUSY);const timer=f.k.timers[0],token=a.thread.sparse.token;
 f.k.sparseBroker.unregister(token);a.thread.dead=true;f.k.slots[a.thread.slot]=null;
 // Simulate the explicit host acknowledgement after the old worker terminated.
 Atomics.store(f.k.k32,a.b32+W_OCCUPIED,0);
 const fresh=f.make(1),before=new Uint8Array(fresh.worker.mem.buffer).slice();assert.equal(fresh.thread.slot,a.thread.slot);
 timer.fn();assert.equal(timer.dead,true);assert.equal(Atomics.load(f.k.k32,fresh.b32),0);
 assert.deepEqual(new Uint8Array(fresh.worker.mem.buffer),before);assert.equal(f.k.sparseBroker.futexStats().waiting,0);
});
test('recognized bad futex arguments return errno while uncovered syscalls restore pre-state',t=>{
 const f=setup(t),a=f.make(0);assert.equal(a.begin({address:AT+1n}),S_DONE);assert.equal(a.result(),-22n);a.ack();
 assert.equal(a.begin({address:AT+4n*P}),S_DONE);assert.equal(a.result(),-14n);a.ack();
 assert.equal(a.begin({op:1,value:-1n}),S_DONE);assert.equal(a.result(),-22n);a.ack();
 assert.equal(a.begin({nr:39n}),S_DONE);assert.equal(f.k.k64[a.b32/2+8],2n);
 assert.equal(a.v.getBigUint64(a.thread.tb+cfg.ctx+cfg.ripOff,true),RIP);assert.equal(a.result(),39n);
});
