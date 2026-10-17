// SPDX-License-Identifier: GPL-3.0-or-later
// Real kernel/storage lifecycle with synthetic spilled producers; live FEX is separate.
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';
globalThis.self=globalThis;for(const n of ['guest_memory.js','guest_memory_broker.js','web/linux-kernel.js'])vm.runInThisContext(fs.readFileSync(new URL('../../Sources/BetterJITLinux/Resources/linux/'+n,import.meta.url),'utf8'));
const M=BetterJITGuestMemory,B=BetterJITGuestMemoryBroker,L=B.LIFECYCLE,{Kernel,SLOT_BASE,SLOT_SIZE,S_REQ,S_DONE,W_OCCUPIED}=LinuxBundle.require('./kernel.js');
const RIP=0x123400004000n,STACK=0x123456781000n,P=4096n;
const cfg={guestMemory:'broker1',memoryABI:1,stepABI:4,coverageVersion:23,stepHeaderBytes:96,memPages:33,memMaxPages:33,threadBase:65536,regArgs:0,callsViaDispatcher:false,maxInstructions:1,shared:true,ctx:256,stateSize:1024,ripOff:24,gregsOff:32,checkpoint:{version:1,cpu:{offset:256,size:1024,ripOffset:24,stackPointerOffset:64,generalRegistersOffset:32},lazyFlags:{offset:64,size:24},roundMode:{offset:112,size:4}}};
function fixture(t,{limitBytes=32*M.PAGE}={}){
 const budget=new M.BackingBudget({limitBytes}),space=new M.GuestAddressSpace(budget,{virtualLimit:1n<<47n}),spawned=[],stopped=[];
 space.mapAnonymous(RIP,P,3);space.write(RIP,Uint8Array.of(15,5,144));space.protect(RIP,P,5);space.mapAnonymous(STACK-P,P,3);
 const k=new Kernel({vfs:{},state:new Uint8Array(cfg.stateSize),log:()=>{},sparseLifecycleVersion:2,spawnSparseThread:d=>spawned.push(d),stopSparseThread:d=>stopped.push(d)},cfg),plans=[{status:0,rip:RIP,nextRip:RIP+2n,length:2,operation:5,width:0,instruction:Uint8Array.of(15,5)},{status:0,rip:RIP+2n,nextRip:RIP+3n,length:1,operation:0,width:0,instruction:Uint8Array.of(144)}],a=k.createSparseProcess({space,entryRip:RIP,plans}),seq=new Map();
 const base=th=>(SLOT_BASE+th.slot*SLOT_SIZE)>>2,g=th=>th.tb+cfg.ctx+cfg.gregsOff,reg=(th,i,x)=>x===undefined?th.sparse.view.getBigUint64(g(th)+i*8,true):th.sparse.view.setBigUint64(g(th)+i*8,BigInt.asUintN(64,x),true);
 function phase(th,p,status=0){const b=base(th),n=(seq.get(th)||0)+1;seq.set(th,n);for(const [i,x]of [[1,B.ABI.instructionBoundary],[2,th.sparse.token.generation],[3,n],[4,p],[5,status]])k.k64[(b>>1)+i]=BigInt(x);Atomics.store(k.k32,b,S_REQ);k.serviceRequests();return Atomics.load(k.k32,b);}
 function syscall(th,nr,{pid=0n,pointer=0n,options=0n,rusage=0n,stack=STACK}={}){Atomics.store(k.k32,base(th),0);th.sparse.view.setBigUint64(th.tb+cfg.ctx+cfg.ripOff,RIP,true);for(const [i,x]of [[0,nr],[4,stack],[7,pid],[6,pointer],[2,options],[10,rusage]])reg(th,i,x);assert.equal(phase(th,1),S_DONE);Atomics.store(k.k32,base(th),0);th.sparse.view.setBigUint64(th.tb+cfg.ctx+cfg.ripOff,RIP+2n,true);return phase(th,2,B.STEP.SYSCALL);}
 const fork=options=>syscall(a.thread,57n,options),ack=d=>{Atomics.store(k.k32,((SLOT_BASE+d.slot*SLOT_SIZE)>>2)+W_OCCUPIED,0);k.serviceRequests();};
 function ready(){const d=spawned.at(-1);Atomics.store(new Int32Array(d.startGate),0,L.READY);k.serviceRequests();return k.slots[d.slot];}
 function exit(th,code=23n){assert.equal(syscall(th,60n,{pid:code}),S_DONE);Atomics.store(k.k32,base(th),0);assert.equal(phase(th,3),S_DONE);}
 t.after(()=>{for(const r of k.sparseClones?.values()??[]){k.sparseBroker.unregister(r.made.thread.sparse.token);r.forkSpace?.close();}for(const th of k.threads.values())k.sparseBroker.unregister(th.sparse.token);for(const p of k.procs.values())p.mm.guest.close();space.close();});
 return {k,budget,space,a,spawned,stopped,base,reg,phase,syscall,fork,ready,exit,ack};
}
test('fork preparation publishes no child process or relationship until READY and isolates private storage',t=>{
 const f=fixture(t);f.a.thread.sigmask=0x200n;f.a.proc.cwd='/guest';f.a.proc.umask=0o077;f.space.write(STACK-16n,Uint8Array.of(7));assert.equal(f.fork(),B.ABI.parkedState);
 const pending=[...f.k.sparseClones.values()][0],staged=pending.made.proc;assert.equal(f.k.procs.size,1);assert.equal(f.a.proc.children.size,0);assert.notEqual(staged.mm.guest,f.space);assert.equal(staged.mm.guest.read(STACK-16n,1)[0],7);
 const child=f.ready();assert.equal(f.k.procs.size,2);assert.equal(f.a.proc.children.has(child.proc.pid),true);assert.equal(f.reg(f.a.thread,0),BigInt(child.proc.pid));assert.equal(f.reg(child,0),0n);assert.equal(child.sigmask,0x200n);assert.equal(child.proc.cwd,'/guest');assert.equal(child.proc.umask,0o077);assert.equal(child.proc.space,f.a.proc.space);
 child.proc.mm.guest.write(STACK-16n,Uint8Array.of(9));assert.equal(f.space.read(STACK-16n,1)[0],7);assert.notEqual(child.sparse.memory,f.a.worker.mem);
 f.syscall(f.a.thread,60n);assert.equal(f.k.k64[(f.base(f.a.thread)>>1)+8],2n,'parent must reap before exit in this profile');
 f.syscall(child,56n,{pid:0x10f00n,pointer:STACK});assert.equal(f.k.k64[(f.base(child)>>1)+8],2n,'fork child remains single-threaded');
});
test('fork preserves an eight-byte-aligned C call frame but refuses a misaligned stack before allocation',t=>{
 for(const stack of [STACK,STACK-8n]){const f=fixture(t);assert.equal(f.fork({stack}),B.ABI.parkedState);const child=f.ready();assert.equal(f.reg(child,4),stack);}
 const f=fixture(t),before=f.budget.stats().ownedPayloadBytes;assert.equal(f.fork({stack:STACK-4n}),S_DONE);assert.equal(f.k.k64[(f.base(f.a.thread)>>1)+8],2n);assert.equal(f.spawned.length,0);assert.equal(f.budget.stats().ownedPayloadBytes,before);
});
test('fork backing allocation failure returns ENOMEM without process, frame or byte changes',t=>{
 const f=fixture(t,{limitBytes:3*M.PAGE}),id=f.space.mappingInfo(STACK-8n).frameId;assert.equal(f.fork(),S_DONE);assert.equal(f.reg(f.a.thread,0),BigInt.asUintN(64,-12n));assert.equal(f.k.procs.size,1);assert.equal(f.spawned.length,0);assert.equal(f.budget.stats().ownedPayloadBytes,2*M.PAGE);assert.equal(f.space.mappingInfo(STACK-8n).frameId,id);
});
test('failed fork startup retains the copied address space until worker exit acknowledgement',t=>{
 const f=fixture(t);f.fork();const d=f.spawned[0],childSpace=[...f.k.sparseClones.values()][0].forkSpace;assert.equal(f.budget.stats().ownedPayloadBytes,4*M.PAGE);Atomics.store(new Int32Array(d.startGate),0,L.FAILED);f.k.serviceRequests();assert.equal(childSpace.stats().closed,false);assert.equal(f.k.procs.size,1);
 f.ack(d);assert.equal(childSpace.stats().closed,true);assert.equal(f.budget.stats().ownedPayloadBytes,2*M.PAGE);assert.equal(f.reg(f.a.thread,0),BigInt.asUintN(64,-11n));assert.equal(f.a.proc.children.size,0);
});
test('fork refuses unsupported descriptors, signal policy and multithreaded callers before effects',t=>{
 for(const mode of ['fd','blocked-sigchld','no-cld-wait','caught','multithread']){const f=fixture(t);if(mode==='fd')f.a.proc.fds.set(0,{});if(mode==='blocked-sigchld')f.a.thread.sigmask=1n<<16n;if(mode==='no-cld-wait')f.a.proc.actions[17].flags=2n;if(mode==='caught')f.a.proc.actions[17].handler=1n;if(mode==='multithread')f.k.createSparseThread(f.a.proc,{entryRip:RIP,plans:[...f.a.thread.sparse.plans.values()]});
  assert.equal(f.fork(),S_DONE);assert.equal(f.k.k64[(f.base(f.a.thread)>>1)+8],2n);assert.equal(f.spawned.length,0);assert.equal(f.reg(f.a.thread,0),57n);}
});
test('wait parks through logical child exit until host acknowledgement then copies status and reaps once',t=>{
 const f=fixture(t);f.fork();const child=f.ready(),d=f.spawned[0],pid=BigInt(child.proc.pid);assert.equal(f.syscall(f.a.thread,61n,{pid,pointer:STACK-8n}),B.ABI.parkedState);assert.throws(()=>f.k.sparseUserMemory(f.a.thread),/owner/);
 f.exit(child);assert.equal(Atomics.load(f.k.k32,f.base(f.a.thread)),B.ABI.parkedState);assert.equal(child.proc.sparseReaped,undefined);f.ack(d);assert.equal(f.reg(f.a.thread,0),pid);assert.equal(new DataView(f.space.read(STACK-8n,4).buffer).getUint32(0,true),0x1700);assert.equal(child.proc.sparseReaped,true);assert.equal(child.proc.mm.guest.stats().closed,true);assert.equal(f.a.proc.children.size,0);
 assert.equal(f.syscall(f.a.thread,61n,{pid}),S_DONE);assert.equal(f.reg(f.a.thread,0),BigInt.asUintN(64,-10n));
});
test('wait status EFAULT occurs after reaping and retry returns ECHILD, matching native Linux',t=>{
 for(const pointer of [1n,STACK-2n]){const f=fixture(t);f.fork();const child=f.ready(),pid=BigInt(child.proc.pid);f.exit(child);f.ack(f.spawned[0]);const before=f.space.read(STACK-8n,8);assert.equal(f.syscall(f.a.thread,61n,{pid,pointer}),S_DONE);assert.equal(f.reg(f.a.thread,0),BigInt.asUintN(64,-14n));assert.equal(child.proc.sparseReaped,true);assert.deepEqual(f.space.read(STACK-8n,8),before);f.syscall(f.a.thread,61n,{pid,pointer:STACK-8n});assert.equal(f.reg(f.a.thread,0),BigInt.asUintN(64,-10n));}
});
test('wait accepts NULL status and rejects unsupported PID/options/rusage without consuming the child',t=>{
 const f=fixture(t);f.fork();const child=f.ready(),pid=BigInt(child.proc.pid);f.exit(child);f.ack(f.spawned[0]);for(const args of [{pid:0n},{pid:BigInt.asUintN(64,-1n)},{pid,options:1n},{pid,rusage:STACK-8n}]){assert.equal(f.syscall(f.a.thread,61n,args),S_DONE);assert.equal(f.k.k64[(f.base(f.a.thread)>>1)+8],2n);assert.equal(child.proc.sparseReaped,undefined);}
 f.syscall(f.a.thread,61n,{pid});assert.equal(f.reg(f.a.thread,0),pid);assert.equal(child.proc.sparseReaped,true);
});
test('signal interrupts a parked wait without reaping or copying status',t=>{
 const f=fixture(t);f.fork();const child=f.ready(),pid=BigInt(child.proc.pid);f.syscall(f.a.thread,61n,{pid,pointer:STACK-8n});f.k.signalThread(f.a.thread,10);f.k.serviceRequests();assert.equal(f.reg(f.a.thread,0),BigInt.asUintN(64,-4n));assert.equal(child.proc.sparseReaped,undefined);assert.equal(f.k.sparseWaits.size,0);assert.deepEqual(f.space.read(STACK-8n,4),new Uint8Array(4));
});
test('stale memory owner cannot receive a parked wait reply or reap its child',t=>{
 const f=fixture(t);f.fork();const child=f.ready(),pid=BigInt(child.proc.pid);f.syscall(f.a.thread,61n,{pid,pointer:STACK-8n});const before=new Uint8Array(f.a.worker.mem.buffer).slice();f.a.proc.mm={...f.a.proc.mm};f.exit(child);f.ack(f.spawned[0]);assert.deepEqual(new Uint8Array(f.a.worker.mem.buffer),before);assert.equal(child.proc.sparseReaped,undefined);assert.equal(f.k.sparseWaits.size,0);
});
test('failed child worker cannot be reported as a successful guest wait status',t=>{
 const f=fixture(t);f.fork();const child=f.ready();f.ack(f.spawned[0]);assert.throws(()=>f.syscall(f.a.thread,61n,{pid:BigInt(child.proc.pid),pointer:STACK-8n}),/without a guest wait status/);assert.equal(child.proc.sparseReaped,undefined);assert.deepEqual(f.space.read(STACK-8n,4),new Uint8Array(4));
});
test('clone-only host capability does not silently enable fork or wait',t=>{
 const f=fixture(t);f.k.host.sparseLifecycleVersion=1;assert.equal(f.fork(),S_DONE);assert.equal(f.k.k64[(f.base(f.a.thread)>>1)+8],2n);assert.equal(f.spawned.length,0);f.syscall(f.a.thread,61n,{pid:101n});assert.equal(f.k.k64[(f.base(f.a.thread)>>1)+8],2n);
});
test('replaced child identity cannot be reaped by a stale parked wait',t=>{
 const f=fixture(t);f.fork();const child=f.ready(),pid=BigInt(child.proc.pid);f.syscall(f.a.thread,61n,{pid,pointer:STACK-8n});f.k.procs.set(child.proc.pid,{...child.proc});f.k.serviceRequests();assert.equal(f.reg(f.a.thread,0),BigInt.asUintN(64,-10n));assert.equal(child.proc.sparseReaped,undefined);assert.deepEqual(f.space.read(STACK-8n,4),new Uint8Array(4));
});
test('wait copyout allocation failure reaps with EFAULT and preserves the private-view destination',t=>{
 const f=fixture(t,{limitBytes:5*M.PAGE}),object=new M.SharedBacking(f.budget,P);t.after(()=>object.close());const at=STACK+P;
 f.space.mapShared(at,P,object,0n,{privateView:true});const frame=f.space.mappingInfo(at).frameId;f.fork();const child=f.ready(),pid=BigInt(child.proc.pid);f.exit(child);f.ack(f.spawned[0]);assert.equal(f.budget.stats().ownedPayloadBytes,5*M.PAGE);
 f.syscall(f.a.thread,61n,{pid,pointer:at});assert.equal(f.reg(f.a.thread,0),BigInt.asUintN(64,-14n));assert.equal(child.proc.sparseReaped,true);assert.equal(f.space.mappingInfo(at).frameId,frame);assert.deepEqual(f.space.read(at,4),new Uint8Array(4));assert.equal(f.budget.stats().ownedPayloadBytes,3*M.PAGE);
});
