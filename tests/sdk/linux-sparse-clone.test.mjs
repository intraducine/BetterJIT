// SPDX-License-Identifier: GPL-3.0-or-later
// Real kernel/broker lifecycle with synthetic spills; actual FEX clone fixture is separate.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
globalThis.self=globalThis;
for(const n of ['guest_memory.js','guest_memory_broker.js','web/linux-kernel.js'])vm.runInThisContext(fs.readFileSync(new URL('../../Sources/BetterJITLinux/Resources/linux/'+n,import.meta.url),'utf8'));
const M=BetterJITGuestMemory,B=BetterJITGuestMemoryBroker,L=B.LIFECYCLE,{Kernel,SLOT_BASE,SLOT_SIZE,S_REQ,S_DONE,W_OCCUPIED}=LinuxBundle.require('./kernel.js');
const RIP=0x123400004000n,STACK=0x123456781000n,P=4096n;
const cfg={guestMemory:'broker1',memoryABI:1,stepABI:3,coverageVersion:15,stepHeaderBytes:96,memPages:33,memMaxPages:33,threadBase:65536,
 regArgs:0,callsViaDispatcher:false,maxInstructions:1,shared:true,ctx:256,stateSize:1024,ripOff:24,gregsOff:32,
 checkpoint:{version:1,cpu:{offset:256,size:1024,ripOffset:24,stackPointerOffset:64,generalRegistersOffset:32},lazyFlags:{offset:64,size:24},roundMode:{offset:112,size:4}}};
function fixture(t,{spawn,stop}={}) {
 const space=new M.GuestAddressSpace(new M.BackingBudget(),{virtualLimit:1n<<47n});t.after(()=>space.close());
 space.mapAnonymous(RIP,P,3);space.write(RIP,Uint8Array.of(15,5,144));space.protect(RIP,P,5);space.mapAnonymous(STACK-P,P,3);
 const spawned=[],stopped=[],k=new Kernel({state:new Uint8Array(cfg.stateSize),vfs:{},log:()=>{},sparseLifecycleVersion:1,
  spawnSparseThread:d=>{spawned.push(d);spawn?.(d);},stopSparseThread:d=>{stopped.push(d);stop?.(d);}},cfg);
 const plans=[{status:0,rip:RIP,nextRip:RIP+2n,length:2,operation:5,width:0,instruction:Uint8Array.of(15,5)},
  {status:0,rip:RIP+2n,nextRip:RIP+3n,length:1,operation:0,width:0,instruction:Uint8Array.of(144)}];
 const a=k.createSparseProcess({space,entryRip:RIP,plans}),th=a.thread,v=th.sparse.view,g=th.tb+cfg.ctx+cfg.gregsOff,base=(SLOT_BASE+th.slot*SLOT_SIZE)>>2,b64=base>>1;let seq=0;
 const reg=(i,value)=>value===undefined?v.getBigUint64(g+i*8,true):v.setBigUint64(g+i*8,BigInt.asUintN(64,value),true);
 function phase(p,status=0){k.k64[b64+1]=BigInt(B.ABI.instructionBoundary);k.k64[b64+2]=a.worker.lease;k.k64[b64+3]=BigInt(++seq);k.k64[b64+4]=BigInt(p);k.k64[b64+5]=BigInt(status);Atomics.store(k.k32,base,S_REQ);k.serviceRequests();return Atomics.load(k.k32,base);}
 function begin({nr=56n,flags=0x10f00n,stack=STACK,ptid=0n,ctid=0n,tls=0n}={}){
  v.setBigUint64(th.tb+cfg.ctx+cfg.ripOff,RIP,true);for(const [i,x]of [[0,nr],[7,flags],[6,stack],[2,ptid],[10,ctid],[8,tls]])reg(i,x);
  assert.equal(phase(1),S_DONE);Atomics.store(k.k32,base,0);v.setBigUint64(th.tb+cfg.ctx+cfg.ripOff,RIP+2n,true);return phase(2,B.STEP.SYSCALL);
 }
 const ack=d=>{Atomics.store(k.k32,((SLOT_BASE+d.slot*SLOT_SIZE)>>2)+W_OCCUPIED,0);k.serviceRequests();};
 t.after(()=>{k.sparseBroker.unregister(th.sparse.token);for(const r of k.sparseClones?.values()??[])k.sparseBroker.unregister(r.made.thread.sparse.token);for(const x of k.threads.values())k.sparseBroker.unregister(x.sparse.token);});
 return {k,space,a,th,v,g,base,b64,reg,phase,begin,spawned,stopped,ack};
}
test('guest clone stages complete state and publishes only after exact worker READY',t=>{
 const f=fixture(t);f.th.sigmask=0x400n;new Uint8Array(f.v.buffer,f.th.tb+64,24).fill(37);f.v.setUint32(f.th.tb+112,0xdeadbeef,true);f.reg(15,0xfedcba9876543210n);
 assert.equal(f.begin(),B.ABI.parkedState);assert.equal(f.k.threads.size,1);assert.equal(f.a.proc.threads.size,1);assert.equal(f.spawned.length,1);
 const d=f.spawned[0],child=[...f.k.sparseClones.values()][0].made.thread;
 assert.equal(f.k.slots[d.slot],null);assert.equal(f.k.sparseBroker.stats().threads,2);assert.equal(child.sigmask,f.th.sigmask);
 assert.equal(child.sparse.view.getBigUint64(f.g,true),0n);assert.equal(child.sparse.view.getBigUint64(f.g+32,true),STACK);
 assert.equal(child.sparse.view.getBigUint64(f.g+15*8,true),0xfedcba9876543210n);assert.equal(child.sparse.view.getUint32(child.tb+112,true),0xdeadbeef);
 assert.deepEqual(new Uint8Array(child.sparse.memory.buffer,child.tb+64,24),new Uint8Array(24).fill(37));assert.throws(()=>f.k.sparseUserMemory(f.th),/owner/);
 Atomics.store(new Int32Array(d.startGate),0,L.READY);f.k.serviceRequests();assert.equal(f.k.threads.size,2);assert.equal(f.a.proc.threads.size,2);
 assert.equal(f.reg(0),BigInt(child.tid));assert.equal(child.sparse.createdBy.rip,RIP);assert.equal(Atomics.load(new Int32Array(d.startGate),0),L.RUN);
 assert.equal(f.k.sparseClones.size,0);assert.equal(f.k.timers[0].dead,true);
});
test('unsupported clone flags, TID/TLS options, stack and missing host contract restore prestate before spawn',t=>{
 for(const args of [{flags:0n},{flags:0x10f11n},{flags:0x90f00n},{ptid:STACK},{ctid:STACK},{tls:1n},{stack:0n},{stack:STACK+1n},{stack:STACK-8n},{stack:STACK+P},{nr:57n},{nr:59n}]) {
  const f=fixture(t);assert.equal(f.begin(args),S_DONE);assert.equal(f.k.k64[f.b64+8],2n);assert.equal(f.v.getBigUint64(f.th.tb+cfg.ctx+cfg.ripOff,true),RIP);
  assert.equal(f.reg(0),args.nr??56n);assert.equal(f.spawned.length,0);assert.equal(f.k.threads.size,1);
 }
 const f=fixture(t);delete f.k.host.stopSparseThread;assert.equal(f.begin(),S_DONE);assert.equal(f.spawned.length,0);
 const bounded=fixture(t);bounded.k.host.sparseAllowThreads=false;assert.equal(bounded.begin(),S_DONE);assert.equal(bounded.spawned.length,0);assert.equal(bounded.k.k64[bounded.b64+8],2n);
});
test('failed startup retains resources until acknowledged exit then returns EAGAIN without publication',t=>{
 const f=fixture(t);f.begin();const d=f.spawned[0];Atomics.store(new Int32Array(d.startGate),0,L.FAILED);f.k.serviceRequests();
 assert.equal(f.stopped.length,1);assert.equal(f.k.sparseBroker.stats().threads,2);assert.equal(f.k.threads.size,1);assert.equal(Atomics.load(f.k.k32,f.base),B.ABI.parkedState);
 f.ack(d);assert.equal(f.reg(0),BigInt.asUintN(64,-11n));assert.equal(f.k.sparseBroker.stats().threads,1);assert.equal(f.k.sparseClones.size,0);assert.equal(f.k.timers[0].dead,true);
 Atomics.store(new Int32Array(d.startGate),0,L.READY);f.k.serviceRequests();assert.equal(f.k.threads.size,1);
});
test('startup deadline requests exact-lease stop and cannot release a live worker slot',t=>{
 const f=fixture(t);f.begin();const d=f.spawned[0];f.k.timers[0].fn();f.k.serviceRequests();
 assert.deepEqual(f.stopped,[{slot:d.slot,lease:d.lease}]);assert.equal(f.k.allocSlot(),2);assert.equal(f.k.sparseClones.size,1);f.ack(d);assert.equal(f.k.allocSlot(),d.slot);
});
test('readiness with a corrupted lease cannot publish a child',t=>{
 const f=fixture(t);f.begin();const d=f.spawned[0];new BigUint64Array(d.startGate)[1]=d.lease+1n;
 Atomics.store(new Int32Array(d.startGate),0,L.READY);f.k.serviceRequests();assert.equal(f.k.threads.size,1);
 assert.equal(Atomics.load(new Int32Array(d.startGate),0),L.CANCEL);f.ack(d);assert.equal(f.reg(0),BigInt.asUintN(64,-11n));
});
test('late readiness from a failed worker cannot publish a reused slot',t=>{
 const f=fixture(t);f.begin();const old=f.spawned[0];Atomics.store(new Int32Array(old.startGate),0,L.FAILED);f.k.serviceRequests();f.ack(old);
 Atomics.store(f.k.k32,f.base,0);f.begin();const fresh=f.spawned[1];assert.equal(fresh.slot,old.slot);assert.notEqual(fresh.lease,old.lease);
 Atomics.store(new Int32Array(old.startGate),0,L.READY);f.k.serviceRequests();assert.equal(f.k.threads.size,1);
 Atomics.store(new Int32Array(fresh.startGate),0,L.READY);f.k.serviceRequests();assert.equal(f.k.threads.size,2);assert.equal(f.k.slots[fresh.slot].sparse.token.generation,fresh.lease);
});
test('changed continuation code or stack permissions cancel before publication',t=>{
 for(const codeChange of [false,true]) {
  const f=fixture(t);f.begin();const d=f.spawned[0];
  if(codeChange){f.space.protect(RIP,P,3);f.space.write(RIP+2n,Uint8Array.of(0));f.space.protect(RIP,P,5);}
  else f.space.protect(STACK-P,P,1);
  Atomics.store(new Int32Array(d.startGate),0,L.READY);f.k.serviceRequests();assert.equal(f.k.threads.size,1);f.ack(d);assert.equal(f.reg(0),BigInt.asUintN(64,-11n));
 }
});
test('uncertain spawn callback failure is stopped and acknowledged before reporting failure',t=>{
 const f=fixture(t,{spawn:()=>{throw Error('channel closed after submission');}});assert.equal(f.begin(),B.ABI.parkedState);assert.equal(f.stopped.length,1);
 assert.equal(f.k.sparseClones.size,1);f.ack(f.spawned[0]);assert.equal(f.reg(0),BigInt.asUintN(64,-11n));assert.equal(f.k.threads.size,1);
});
test('caller signal cancels uncommitted creation before child publication',t=>{
 const f=fixture(t);f.begin();const d=f.spawned[0];f.k.signalThread(f.th,10);Atomics.store(new Int32Array(d.startGate),0,L.READY);f.k.serviceRequests();
 assert.equal(Atomics.load(new Int32Array(d.startGate),0),L.CANCEL);f.ack(d);assert.equal(f.reg(0),BigInt.asUintN(64,-4n));assert.equal(f.k.threads.size,1);assert.equal(f.th.pending,1n<<9n);
});
test('caller death or owner replacement cancels startup without a late parent reply',t=>{
 for(const mode of ['death','mm','thread','process']) {
  const f=fixture(t);f.begin();const d=f.spawned[0],before=new Uint8Array(f.v.buffer).slice();
  if(mode==='death')Atomics.store(f.k.k32,f.base+W_OCCUPIED,0);
  else if(mode==='mm')f.a.proc.mm={...f.a.proc.mm};else if(mode==='thread')f.k.threads.delete(f.th.tid);else f.k.procs.delete(f.a.proc.pid);
  Atomics.store(new Int32Array(d.startGate),0,L.READY);f.k.serviceRequests();f.ack(d);
  assert.deepEqual(new Uint8Array(f.v.buffer),before);assert.equal(f.k.threads.size,mode==='thread'?0:1);assert.equal(f.k.sparseClones.size,0);
 }
});
test('cancelled allocations still consume the eight-context profile bound',t=>{
 const f=fixture(t);
 for(let i=1;i<8;i++){assert.equal(f.begin(),B.ABI.parkedState);const d=f.spawned.at(-1);Atomics.store(new Int32Array(d.startGate),0,L.FAILED);f.k.serviceRequests();f.ack(d);Atomics.store(f.k.k32,f.base,0);}
 assert.equal(f.begin(),S_DONE);assert.equal(f.reg(0),BigInt.asUintN(64,-11n));assert.equal(f.spawned.length,7);assert.equal(f.k.sparseBroker.stats().threads,1);
});
test('guest thread exit has a distinct completion and preserves its eight-bit code',t=>{
 const f=fixture(t);assert.equal(f.begin({nr:60n,flags:0x123n}),S_DONE);assert.equal(f.k.k64[f.b64+8],BigInt(L.syscallExit));assert.equal(f.th.sparse.guestExitCode,0x23);
 Atomics.store(f.k.k32,f.base,0);assert.equal(f.phase(3),S_DONE);assert.equal(f.th.dead,true);assert.deepEqual(f.a.proc.sparseGuestExit,{lastThreadCode:0x23});
});
