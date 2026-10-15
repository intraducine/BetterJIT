// SPDX-License-Identifier: GPL-3.0-or-later
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';
globalThis.self=globalThis;for(const n of ['guest_memory.js','guest_memory_broker.js','web/linux-kernel.js'])vm.runInThisContext(fs.readFileSync(new URL('../../Sources/BetterJITLinux/Resources/linux/'+n,import.meta.url),'utf8'));
const M=BetterJITGuestMemory,B=BetterJITGuestMemoryBroker,{Kernel,SLOT_BASE,SLOT_SIZE,S_REQ,S_DONE,W_OCCUPIED}=LinuxBundle.require('./kernel.js'),CODE=0x123400004000n,DATA=0x123456780000n,P=4096n;
const cfg={guestMemory:'broker1',memoryABI:1,stepABI:3,coverageVersion:6,stepHeaderBytes:96,memPages:33,memMaxPages:33,threadBase:65536,regArgs:0,callsViaDispatcher:false,maxInstructions:1,shared:true,ctx:256,stateSize:1024,ripOff:24,gregsOff:32,checkpoint:{version:1,cpu:{offset:256,size:1024,ripOffset:24},lazyFlags:{offset:64,size:24},roundMode:{offset:112,size:4}}};
function fixture(t,{input=Uint8Array.of(65,66,67,68,69),allocatePage}={}){const budget=new M.BackingBudget({allocatePage}),space=new M.GuestAddressSpace(budget,{virtualLimit:1n<<47n}),writes=[];space.mapAnonymous(CODE,P,3);space.write(CODE,Uint8Array.of(15,5,144));space.protect(CODE,P,5);space.mapAnonymous(DATA,P,3);space.write(DATA,Uint8Array.of(65,66,67,68,69));const k=new Kernel({state:new Uint8Array(cfg.stateSize),vfs:{},log:()=>{},sparseLifecycleVersion:5,sparseProcessLifecycle:false,writeSparseOutput:r=>{writes.push(r);return r.bytes.length;}},cfg),a=k.createSparseProcess({space,entryRip:CODE,standardIO:true,standardInput:input,plans:[{status:0,rip:CODE,nextRip:CODE+2n,length:2,operation:5,width:0,instruction:Uint8Array.of(15,5)},{status:0,rip:CODE+2n,nextRip:CODE+3n,length:1,operation:0,width:0,instruction:Uint8Array.of(144)}]}),th=a.thread,g=th.tb+cfg.ctx+cfg.gregsOff,base=(SLOT_BASE+th.slot*SLOT_SIZE)>>2,v=th.sparse.view;let sequence=0;
 const reg=(i,n)=>n===undefined?v.getBigUint64(g+i*8,true):v.setBigUint64(g+i*8,BigInt.asUintN(64,n),true);
 const phase=(p,status=0)=>{for(const [i,n]of [[1,B.ABI.instructionBoundary],[2,a.worker.lease],[3,++sequence],[4,p],[5,status]])k.k64[(base>>1)+i]=BigInt(n);Atomics.store(k.k32,base,S_REQ);k.serviceRequests();return Atomics.load(k.k32,base);};
 function call({nr=0n,fd=0n,pointer=DATA,count=5n}={}){Atomics.store(k.k32,base,0);v.setBigUint64(th.tb+cfg.ctx+cfg.ripOff,CODE,true);for(const [i,n]of [[0,nr],[7,fd],[6,pointer],[2,count]])reg(i,n);phase(1);Atomics.store(k.k32,base,0);v.setBigUint64(th.tb+cfg.ctx+cfg.ripOff,CODE+2n,true);return phase(2,3);}
 t.after(()=>{k.sparseBroker.unregister(th.sparse.token);k.closeSparseOutputs(a.proc);space.close();});return{k,a,th,space,budget,writes,reg,v,base,call,phase,inputFile:a.proc.fds.get(0).file};
}

test('finite stdin owns a snapshot, returns successive short reads and EOF without exposing source storage',t=>{
 const input=Uint8Array.of(65,66,67,68,69),f=fixture(t,{input});input.fill(0);assert.equal(f.inputFile.refs,1);
 f.call({count:2n});assert.equal(f.reg(0),2n);assert.deepEqual(f.space.read(DATA,2),Uint8Array.of(65,66));assert.equal(f.inputFile.pos,2);
 f.call({pointer:DATA+8n,count:8n});assert.equal(f.reg(0),3n);assert.deepEqual(f.space.read(DATA+8n,3),Uint8Array.of(67,68,69));assert.equal(f.inputFile.pos,5);
 f.call({pointer:1n,count:9n});assert.equal(f.reg(0),0n);f.call({pointer:0n,count:0n});assert.equal(f.reg(0),0n);assert.equal(f.inputFile.pos,5);
});
test('missing/write-only descriptors and first-byte faults never consume input or modify destination bytes',t=>{
 const f=fixture(t),before=f.space.read(DATA,16);
 for(const [args,errno]of [[{fd:1n},9],[{fd:3n},9],[{pointer:DATA&0xffffffffn},14],[{pointer:1n<<63n},14]]){f.call(args);assert.equal(f.reg(0),BigInt.asUintN(64,-BigInt(errno)));assert.equal(f.inputFile.pos,0);assert.deepEqual(f.space.read(DATA,16),before);}
 f.space.protect(DATA,P,1);f.call({count:1n});assert.equal(f.reg(0),BigInt.asUintN(64,-14n));assert.equal(f.inputFile.pos,0);
});
test('partially faulting destinations restore the syscall boundary and leave guest bytes and input untouched',t=>{
 for(const protectedPage of [false,true]){const f=fixture(t);if(protectedPage){f.space.mapAnonymous(DATA+P,P,3);f.space.protect(DATA+P,P,1);}const before=f.space.read(DATA+P-3n,3);f.call({pointer:DATA+P-3n,count:5n});assert.equal(f.k.k64[(f.base>>1)+8],2n);assert.equal(f.reg(0),0n);assert.equal(f.v.getBigUint64(f.th.tb+cfg.ctx+cfg.ripOff,true),CODE);assert.deepEqual(f.space.read(DATA+P-3n,3),before);assert.equal(f.inputFile.pos,0);assert.equal(f.th.sparse.unsupported.syscall,0n);assert.match(f.th.sparse.unsupported.reason,/partially faulting/);}
});
test('requested address-domain checks precede EOF but EOF needs no writable mapping',t=>{
 const f=fixture(t,{input:new Uint8Array(0)}),limit=f.space.stats().virtualLimit;
 for(const args of [{pointer:limit-1n,count:2n},{pointer:1n<<63n,count:0n}]){f.call(args);assert.equal(f.reg(0),BigInt.asUintN(64,-14n));}
 f.call({pointer:limit,count:0n});assert.equal(f.reg(0),0n);f.call({pointer:DATA&0xffffffffn,count:5n});assert.equal(f.reg(0),0n);
});
test('oversized reads or unowned descriptor policies refuse before syscall effects with the input cursor unchanged',t=>{
 for(const policy of ['size','cloexec','foreign']){const f=fixture(t);if(policy==='cloexec')f.a.proc.fds.get(0).cloexec=true;if(policy==='foreign')f.a.proc.fds.set(3,{file:{},cloexec:false});f.call({count:policy==='size'?65537n:1n});assert.equal(f.k.k64[(f.base>>1)+8],2n);assert.equal(f.reg(0),0n);assert.equal(f.v.getBigUint64(f.th.tb+cfg.ctx+cfg.ripOff,true),CODE);assert.equal(f.inputFile.pos,0);}
});
test('prepared-copyout allocation failure returns ENOMEM before consuming stdin or publishing private bytes',t=>{
 let fail=false;const f=fixture(t,{allocatePage:n=>{if(fail)throw new RangeError('injected stdin detach failure');return new Uint8Array(n);}}),object=new M.SharedBacking(f.budget,P);t.after(()=>object.close());f.space.unmap(DATA,P);f.space.mapShared(DATA,P,object,0n,{privateView:true});const id=f.space.mappingInfo(DATA).frameId;fail=true;f.call();assert.equal(f.reg(0),BigInt.asUintN(64,-12n));assert.equal(f.inputFile.pos,0);assert.equal(f.space.mappingInfo(DATA).frameId,id);assert.deepEqual(f.space.read(DATA,8),new Uint8Array(8));
});
test('cursor reentry during preparation is fatal before guest/input commit, never a false successful read',t=>{
 let mutate;const f=fixture(t,{allocatePage:n=>{mutate?.();return new Uint8Array(n);}}),object=new M.SharedBacking(f.budget,P);t.after(()=>object.close());f.space.unmap(DATA,P);f.space.mapShared(DATA,P,object,0n,{privateView:true});mutate=()=>{f.inputFile.pos=1;};assert.throws(()=>f.call(),/Finite stdin changed/);assert.deepEqual(f.space.read(DATA,5),new Uint8Array(5));assert.notEqual(Atomics.load(f.k.k32,f.base),S_DONE);
});
test('stdin requires the new host contract and refuses aliased, resizable or oversized input snapshots before process publication',t=>{
 const f=fixture(t);for(const input of [new Uint8Array(new SharedArrayBuffer(1)),new Uint8Array(new ArrayBuffer(1,{maxByteLength:2})),new Uint8Array(1024*1024+1)]){const space=f.space.createEmpty(),size=f.k.procs.size;t.after(()=>space.close());assert.throws(()=>f.k.createSparseProcess({space,entryRip:CODE,standardIO:true,standardInput:input}),TypeError);assert.equal(f.k.procs.size,size);}
 const space=f.space.createEmpty();t.after(()=>space.close());f.k.host.sparseLifecycleVersion=4;assert.throws(()=>f.k.createSparseProcess({space,entryRip:CODE,standardIO:true,standardInput:Uint8Array.of(1)}),/capability 5/);
});
