// SPDX-License-Identifier: GPL-3.0-or-later
// Broker authority with synthetic spills; native arithmetic evidence is separate.
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';
for(const n of ['guest_memory','guest_memory_broker'])vm.runInThisContext(fs.readFileSync(new URL('../../Sources/BetterJITLinux/Resources/linux/'+n+'.js',import.meta.url),'utf8'));
const M=BetterJITGuestMemory,B=BetterJITGuestMemoryBroker,{OP,FIELD:F}=B,RIP=0x123400004000n,DATA=0x223400000000n;
const layout={version:1,cpu:{offset:256,size:1024,ripOffset:24,generalRegistersOffset:32,stackPointerOffset:64,parityRawOffset:240,auxiliaryRawOffset:244,nzcvOffset:248},lazyFlags:{offset:64,size:24},roundMode:{offset:112,size:4}};
const pack=n=>{const a=new Uint8Array(8);new DataView(a.buffer).setBigUint64(0,BigInt.asUintN(64,n),true);return a;};
function plan(bytes=[0x48,3,0x78,0x20]){const instruction=Uint8Array.from(bytes),p={status:0,operation:15,width:bytes[0]>=0x48&&bytes[0]<=0x4f?8:4,rip:RIP,nextRip:RIP+BigInt(bytes.length),instruction,length:instruction.length,continuationKind:0,branchTarget:0n};return{...p,addMemoryOperand:B.addMemoryOperand(p),continuations:[p.nextRip]};}
function fixture(t,{bytes,value=1n,destination=0xffffffffffffffffn,address=DATA,budget=new M.BackingBudget()}={}){
 const p=plan(bytes),memory=B.createInternalMemory(),v=new DataView(memory.buffer),at=B.ABI.threadBase,cpu=at+256,g=cpu+32,q=new DataView(memory.buffer,at+B.ABI.scratchOffset,128),space=new M.GuestAddressSpace(budget,{virtualLimit:1n<<47n});space.mapAnonymous(DATA,8192n,3);space.write(address,pack(value));
 const broker=new B.GuestMemoryBroker(),token=broker.register(0,{space,memory,checkpointLayout:layout});
 for(const n of ['cpu','lazyFlags','roundMode']){const s=layout[n];new Uint8Array(memory.buffer,at+s.offset,s.size).fill(0xa5);}
 for(let r=0;r<16;r++)v.setBigUint64(g+r*8,0xdeadbeef00000000n+BigInt(r),true);
 v.setBigUint64(cpu+24,RIP,true);v.setBigUint64(g,address-32n,true);v.setBigUint64(g+p.addMemoryOperand.register*8,destination,true);
 let checkpoint,sequence=0;const f={p,memory,v,at,cpu,g,q,budget,space,broker,token,value,destination,address};
 f.snapshot=()=>['cpu','lazyFlags','roundMode'].map(n=>{const s=layout[n];return new Uint8Array(memory.buffer,at+s.offset,s.size).slice();});
 f.begin=(extra={})=>checkpoint=broker.beginInstruction(token,{...p,...extra});
 f.request=(extra={})=>{for(const [n,x]of Object.entries({magic:B.ABI.magic,version:1,sequence:++sequence,operation:1,width:p.width,access:1,address,rip:RIP,checkpoint,lease:token.generation,...extra}))typeof x==='bigint'?q.setBigUint64(F[n],x,true):q.setUint32(F[n],x,true);return broker.dispatch(token,{lease:token.generation,sequence});};
 f.spill=()=>{const read=BigInt.asUintN(p.width*8,value),sum=BigInt.asUintN(p.width*8,destination+read);v.setBigUint64(cpu+24,p.nextRip,true);v.setBigUint64(g+p.addMemoryOperand.register*8,sum,true);v.setUint32(cpu+240,Number(BigInt.asUintN(32,sum)),true);v.setUint32(cpu+244,Number(BigInt.asUintN(32,destination^read)),true);};
 f.finish=status=>broker.finishInstruction(token,{status,nextRip:p.nextRip});
 t.after(()=>{broker.unregister(token);space.close();assert.equal(budget.stats().ownedPayloadBytes,0);});return f;
}
test('ADD memory metadata checks widths, exact lengths, register selection and64-bit address forms',()=>{
 for(const [bytes,expected]of [
  [[0x48,3,0x78,0x20],{register:7,base:0,index:-1,displacement:32n}],
  [[0x4f,3,0x54,0xac,0x80],{register:10,base:12,index:13,scale:4,displacement:-128n}],
  [[0x48,3,0x3d,0xfc,0xff,0xff,0xff],{register:7,base:-1,index:-1,ripRelative:true,displacement:-4n}],
  [[0x49,3,0x3d,0,0,0,0],{register:7,base:-1,ripRelative:true}],
  [[0x4a,3,0x04,0x20],{register:0,base:0,index:12,scale:1}],
  [[3,0x04,0x85,0,0,1,0],{register:0,base:-1,index:0,scale:4,displacement:65536n}]
 ]){const p=plan(bytes);for(const [n,x]of Object.entries(expected))assert.equal(p.addMemoryOperand[n],x);assert.deepEqual(B.instructionContinuations(p),[p.nextRip]);}
 for(const bytes of [[0x66,3,0x10],[0x67,3,0x10],[0x64,0x48,3,0x10],[0xf0,0x48,3,0x10],[0x48,3,0xd0],[0x48,3],[0x48,3,0x54],[0x48,3,0x54,0x8c],[0x40,0x48,3,0x10],[0x49,3,4,0x25,0,0,0,0]])assert.throws(()=>plan(bytes),/ADD metadata/);
 const p=plan();for(const extra of [{width:4},{operation:8},{nextRip:p.nextRip+1n},{branchTarget:RIP},{continuationKind:1}])assert.throws(()=>B.addMemoryOperand({...p,...extra}),/ADD metadata/);
});
test('ADD preserves memory and unrelated state, clears upper32 and accepts arbitrary RSP result data',t=>{
 for(const bytes of [[0x48,3,0x78,0x20],[3,0x78,0x20],[0x48,3,0x60,0x20],[3,0x60,0x20]])for(const value of [0n,1n,0x80000000n,0xffffffffffffffffn]){
  const f=fixture(t,{bytes,value});f.begin();const before=f.space.read(DATA,8192);assert.equal(f.request().status,0);f.spill();assert.equal(f.finish(0).status,0);assert.deepEqual(f.space.read(DATA,8192),before);
  assert.equal(f.v.getBigUint64(f.g+f.p.addMemoryOperand.register*8,true),BigInt.asUintN(f.p.width*8,f.destination+BigInt.asUintN(f.p.width*8,value)));
 }
});
test('ADD binds old address/destination and read result to owned checkpoints',t=>{
 const f=fixture(t);f.begin();f.v.setBigUint64(f.g,DATA+64n,true);assert.equal(f.request().status,0);f.v.setBigUint64(f.g,DATA-32n,true);f.q.setBigUint64(F.result0,99n,true);f.space.write(DATA,pack(99n));f.spill();assert.equal(f.finish(0).status,0);
 const a=fixture(t,{bytes:[0x48,3,0],destination:DATA,address:DATA});a.v.setBigUint64(a.g,DATA,true);a.begin();assert.equal(a.request().status,0);a.spill();assert.equal(a.finish(0).status,0);assert.equal(a.v.getBigUint64(a.g,true),DATA+1n);
});
test('ADD refuses forged requests and restores all checkpoint spans after typed failure',t=>{
 for(const change of [{address:DATA+8n},{operation:2,access:2},{width:4},{checkpoint:99n},{rip:RIP+1n}]){const f=fixture(t);f.begin();const before=f.snapshot(),bytes=f.space.read(DATA,8192);assert.equal(f.request(change).status,2);f.v.setBigUint64(f.g,77n,true);assert.equal(f.finish(2).rip,RIP);assert.deepEqual(f.snapshot(),before);assert.deepEqual(f.space.read(DATA,8192),bytes);}
});
test('ADD read faults preserve bytes and COW accounting with complete register/flag rollback',t=>{
 for(const mode of ['unmapped','protected','write-only']){const f=fixture(t,{address:DATA+4093n});if(mode==='unmapped')f.space.unmap(DATA+4096n,4096n);else f.space.protect(DATA+4096n,4096n,mode==='write-only'?2:0);f.begin();const before=f.snapshot(),owned=f.budget.stats().ownedPayloadBytes,bytes=f.space.read(DATA,4096);assert.equal(f.request().status,1);f.v.setUint8(f.cpu+240,3);f.finish(1);assert.deepEqual(f.snapshot(),before);assert.equal(f.budget.stats().ownedPayloadBytes,owned);assert.deepEqual(f.space.read(DATA,4096),bytes);}
 const f=fixture(t);f.space.protect(DATA,8192n,1);f.begin();assert.equal(f.request().status,0);f.spill();assert.equal(f.finish(0).status,0);
});
test('ADD FINISH rejects destination, flags, unrelated CPU, lazy padding and rounding corruption',t=>{
 for(const [span,offset]of [['cpu',32],['cpu',32+7*8],['cpu',240],['cpu',244],['cpu',255],['lazyFlags',4],['roundMode',0]]){const f=fixture(t);f.begin();f.request();f.spill();const at=f.at+layout[span].offset+offset;f.v.setUint8(at,f.v.getUint8(at)^1);assert.throws(()=>f.finish(0),/changed/);}
 const f=fixture(t);f.begin();f.request();f.spill();f.v.setUint32(f.cpu+248,0x1234,true);assert.equal(f.finish(0).status,0,'Only the precise NZCV word may vary with lazy representation');
});
test('ADD BEGIN requires exact GPR/flag layouts and finite fallthrough metadata',t=>{
 for(const extra of [{continuations:[]},{nextRip:RIP+9n},{addMemoryOperand:{...plan().addMemoryOperand,register:16}},{addMemoryOperand:{...plan().addMemoryOperand,scale:3}}]){const f=fixture(t);assert.throws(()=>f.begin(extra),/ADD metadata/);}
 for(const fields of [{parityRawOffset:32},{auxiliaryRawOffset:240},{nzcvOffset:1023},{parityRawOffset:undefined}]){const memory=B.createInternalMemory(),space=new M.GuestAddressSpace(new M.BackingBudget(),{virtualLimit:1n<<47n}),broker=new B.GuestMemoryBroker();assert.throws(()=>broker.register(0,{space,memory,checkpointLayout:{...layout,cpu:{...layout.cpu,...fields}}}),/flag checkpoint/);space.close();}
});
test('ADD read never detaches private-view pages, even with the entire backing budget consumed',t=>{
 const f=fixture(t,{address:DATA+4093n,budget:new M.BackingBudget({limitBytes:8192})});f.space.unmap(DATA,8192n);const backing=new M.SharedBacking(f.budget,8192n),alias=new M.GuestAddressSpace(f.budget,{virtualLimit:1n<<47n});f.space.mapShared(DATA,8192n,backing,0n,{privateView:true});alias.mapShared(DATA,8192n,backing);alias.write(f.address,pack(f.value));const owned=f.budget.stats().ownedPayloadBytes,frames=[f.space.mappingInfo(DATA).frameId,f.space.mappingInfo(DATA+4096n).frameId];
 f.begin();assert.equal(f.request().status,0);f.spill();f.finish(0);assert.equal(f.budget.stats().ownedPayloadBytes,owned);assert.deepEqual([f.space.mappingInfo(DATA).frameId,f.space.mappingInfo(DATA+4096n).frameId],frames);assert.deepEqual(alias.read(f.address,8),pack(f.value));alias.close();backing.close();
});
test('ADD duplicate/missing RPCs and retired registrations fail without changing a fresh owner',t=>{
 const f=fixture(t);f.begin();f.request();assert.throws(()=>f.request(),/More than one/);
 const missing=fixture(t);missing.begin();missing.spill();assert.throws(()=>missing.finish(0),/post-state/);
 const old=fixture(t);old.begin();old.broker.unregister(old.token);assert.equal(old.request().accepted,false);const token=old.broker.register(0,{space:old.space,memory:B.createInternalMemory(),checkpointLayout:layout});assert.equal(old.request().accepted,false);assert.throws(()=>old.finish(0),/Retired/);old.broker.unregister(token);
});
test('ADD dynamic headers bind exact memory operands and reject prior coverage14',()=>{
 const header=()=>{const p=plan(),b=new Uint8Array(96),v=new DataView(b.buffer);[0x31534a42,1,1,4,B.ABI.coverageVersion,0,15,8].forEach((n,i)=>v.setUint32(i*4,n,true));v.setBigUint64(32,p.rip,true);v.setBigUint64(40,p.nextRip,true);v.setUint32(56,1,true);v.setUint32(60,p.instruction.length,true);b.set(p.instruction,64);return b;};
 const p=B.parseStepHeader(header());assert.equal(p.addMemoryOperand.register,7);assert.equal(p.addMemoryOperand.base,0);const old=header();new DataView(old.buffer).setUint32(16,14,true);assert.throws(()=>B.parseStepHeader(old),/ABI/);const forged=header();forged[64]=0x49;forged[66]=4;forged[67]=0x25;assert.throws(()=>B.parseStepHeader(forged),/metadata/);
});
test('kernel static ADD plans derive operands from bytes and bind the exact NZCV checkpoint word',t=>{
 globalThis.self=globalThis;for(const n of ['thread_core','web/linux-kernel'])vm.runInThisContext(fs.readFileSync(new URL('../../Sources/BetterJITLinux/Resources/linux/'+n+'.js',import.meta.url),'utf8'));
 const {Kernel}=LinuxBundle.require('./kernel.js'),cfg={guestMemory:'broker1',memoryABI:1,stepABI:4,coverageVersion:B.ABI.coverageVersion,stepHeaderBytes:96,memPages:33,memMaxPages:33,threadBase:65536,regArgs:0,callsViaDispatcher:false,maxInstructions:1,shared:true,ctx:256,stateSize:1024,ripOff:24,gregsOff:32,nzcvAddr:504,checkpoint:layout};
 for(const forged of [-1,0,16]){const space=new M.GuestAddressSpace(new M.BackingBudget(),{virtualLimit:1n<<47n}),p={...plan(),addMemoryOperand:{register:forged,base:15,index:14,scale:8,displacement:0n}};space.mapAnonymous(RIP,4096n,3);space.write(RIP,p.instruction);space.protect(RIP,4096n,5);const k=new Kernel({state:new Uint8Array(1024),vfs:{},log:()=>{}},cfg),made=k.createSparseProcess({space,entryRip:RIP,plans:[p]});assert.deepEqual(made.thread.sparse.plans.get(RIP).addMemoryOperand,B.addMemoryOperand(p));t.after(()=>{k.sparseBroker.unregister(made.thread.sparse.token);space.close();});}
 const space=new M.GuestAddressSpace(new M.BackingBudget(),{virtualLimit:1n<<47n}),k=new Kernel({state:new Uint8Array(1024),vfs:{},log:()=>{}},{...cfg,nzcvAddr:508});assert.throws(()=>k.createSparseProcess({space,entryRip:RIP,plans:[plan()]}),/configuration/);space.close();
});
