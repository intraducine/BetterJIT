// SPDX-License-Identifier: GPL-3.0-or-later
// Synthetic broker authority checks; native/FEX logical flag evidence is separate.
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';
for(const n of ['guest_memory','guest_memory_broker'])vm.runInThisContext(fs.readFileSync(new URL('../../Sources/BetterJITLinux/Resources/linux/'+n+'.js',import.meta.url),'utf8'));
const M=BetterJITGuestMemory,B=BetterJITGuestMemoryBroker,{OP,FIELD:F}=B,RIP=0x123400004000n,DATA=0x223400000000n;
const layout={version:1,cpu:{offset:256,size:1024,ripOffset:24,generalRegistersOffset:32,stackPointerOffset:64,parityRawOffset:240,auxiliaryRawOffset:244,nzcvOffset:248},lazyFlags:{offset:64,size:24},roundMode:{offset:112,size:4}};
const pack=n=>{const a=new Uint8Array(8);new DataView(a.buffer).setBigUint64(0,BigInt.asUintN(64,n),true);return a;};
function plan(bytes=[0x48,9,0x74,0x24,0x88]){const instruction=Uint8Array.from(bytes),p={status:0,operation:OP.OR_MEMORY,width:bytes[0]>=0x48&&bytes[0]<=0x4f?8:4,rip:RIP,nextRip:RIP+BigInt(bytes.length),instruction,length:instruction.length,continuationKind:0,branchTarget:0n};return{...p,orMemoryOperand:B.orMemoryOperand(p),continuations:[p.nextRip]};}
function fixture(t,{bytes,source=0x8000000000000001n,value=0xdeadbeef0000000en,address=DATA,budget=new M.BackingBudget()}={}){
 const p=plan(bytes),memory=B.createInternalMemory(),v=new DataView(memory.buffer),at=B.ABI.threadBase,cpu=at+256,g=cpu+32,q=new DataView(memory.buffer,at+B.ABI.scratchOffset,128),space=new M.GuestAddressSpace(budget,{virtualLimit:1n<<47n});space.mapAnonymous(DATA,8192n,3);space.write(address,pack(value));
 const broker=new B.GuestMemoryBroker(),token=broker.register(0,{space,memory,checkpointLayout:layout});
 for(const n of ['cpu','lazyFlags','roundMode']){const s=layout[n];new Uint8Array(memory.buffer,at+s.offset,s.size).fill(0xa5);}
 for(let r=0;r<16;r++)v.setBigUint64(g+r*8,0xdeadbeef00000000n+BigInt(r),true);
 v.setBigUint64(cpu+24,RIP,true);v.setBigUint64(g+32,address+120n,true);v.setBigUint64(g+48,source,true);
 let checkpoint,sequence=0;const f={p,memory,v,at,cpu,g,q,budget,space,broker,token,source,value,address};
 f.snapshot=()=>['cpu','lazyFlags','roundMode'].map(n=>{const s=layout[n];return new Uint8Array(memory.buffer,at+s.offset,s.size).slice();});
 f.begin=(extra={})=>checkpoint=broker.beginInstruction(token,{...p,...extra});
 f.request=(extra={})=>{for(const [n,x]of Object.entries({magic:B.ABI.magic,version:1,sequence:++sequence,operation:16,width:p.width,access:3,address,operand0:source,rip:RIP,checkpoint,lease:token.generation,...extra}))typeof x==='bigint'?q.setBigUint64(F[n],x,true):q.setUint32(F[n],x,true);return broker.dispatch(token,{lease:token.generation,sequence});};
 f.spill=()=>{v.setBigUint64(cpu+24,p.nextRip,true);v.setUint32(cpu+240,Number(BigInt.asUintN(32,value|source)),true);};
 f.finish=status=>broker.finishInstruction(token,{status,nextRip:p.nextRip});
 t.after(()=>{broker.unregister(token);space.close();assert.equal(budget.stats().ownedPayloadBytes,0);});return f;
}
test('OR byte metadata decodes exact source, width, RSP/SIB/RIP and signed displacement',()=>{
 for(const [bytes,expected]of [
  [[0x48,9,0x74,0x24,0x88],{register:6,base:4,index:-1,displacement:-120n}],
  [[0x4f,9,0x54,0xac,0x80],{register:10,base:12,index:13,scale:4,displacement:-128n}],
  [[0x49,9,0x15,0,0,0,0],{register:2,base:-1,ripRelative:true}],
  [[0x4a,9,0x04,0x20],{register:0,base:0,index:12,scale:1}],
  [[9,0x04,0x85,0,0,1,0],{register:0,base:-1,index:0,scale:4,displacement:65536n}]
 ]){const p=plan(bytes);for(const [n,x]of Object.entries(expected))assert.equal(p.orMemoryOperand[n],x);assert.deepEqual(B.instructionContinuations(p),[p.nextRip]);}
 for(const bytes of [[0x66,9,0x10],[0x67,9,0x10],[0x64,0x48,9,0x10],[0xf0,0x48,9,0x10],[0x48,9,0xd0],[0x48,9],[0x48,9,0x54],[0x48,9,0x54,0x8c],[0x40,0x48,9,0x10],[0x49,9,4,0x25,0,0,0,0],[0x41,9,4,0x25,0,0,0,0]])assert.throws(()=>plan(bytes),/OR memory metadata/);
 const p=plan();for(const extra of [{width:4},{operation:11},{nextRip:p.nextRip+1n},{branchTarget:RIP},{continuationKind:1}])assert.throws(()=>B.orMemoryOperand({...p,...extra}),/OR memory metadata/);
});
test('OR writes only selected memory width and preserves all GPRs and AF raw',t=>{
 for(const bytes of [[0x48,9,0x74,0x24,0x88],[9,0x74,0x24,0x88]])for(const source of [0n,1n,0x80000000n,0xffffffffffffffffn]){
  const f=fixture(t,{bytes,source});f.begin();const before=f.snapshot();assert.equal(f.request().data,BigInt.asUintN(f.p.width*8,f.value));f.spill();assert.equal(f.finish(0).status,0);
  const mask=(1n<<BigInt(f.p.width*8))-1n;assert.deepEqual(f.space.read(DATA,8),pack((f.value&~mask)|((f.value|source)&mask)));
  assert.deepEqual(new Uint8Array(f.memory.buffer,f.g,128),before[0].subarray(32,160));assert.equal(f.v.getUint32(f.cpu+244,true),0xa5a5a5a5);
 }
});
test('OR owns old source and address even if mutable spill or scratch fields change',t=>{
 const f=fixture(t);f.begin();f.v.setBigUint64(f.g+32,1n,true);f.v.setBigUint64(f.g+48,2n,true);assert.equal(f.request().status,0);f.q.setBigUint64(F.result0,99n,true);f.v.setBigUint64(f.g+32,DATA+120n,true);f.v.setBigUint64(f.g+48,f.source,true);f.spill();assert.equal(f.finish(0).status,0);assert.deepEqual(f.space.read(DATA,8),pack(f.value|f.source));
});
test('OR rejects forged address/source/opcode/width/checkpoint/access before memory commit',t=>{
 for(const change of [{address:DATA+8n},{operand0:2n},{operation:11},{operation:4},{operation:2,access:2},{width:4},{checkpoint:99n},{rip:RIP+1n},{access:1},{access:2}]){const f=fixture(t);f.begin();const before=f.snapshot(),bytes=f.space.read(DATA,8192);assert.equal(f.request(change).status,2);f.v.setBigUint64(f.g,77n,true);assert.equal(f.finish(2).rip,RIP);assert.deepEqual(f.snapshot(),before);assert.deepEqual(f.space.read(DATA,8192),bytes);}
});
test('even zero or already-set OR requires both read and write permission',t=>{
 for(const source of [0n,15n])for(const protection of [1,2,0]){const f=fixture(t,{source,value:15n});f.space.protect(DATA,8192n,protection);f.begin();const before=f.snapshot();assert.equal(f.request().status,1);f.finish(1);assert.deepEqual(f.snapshot(),before);f.space.protect(DATA,8192n,3);assert.deepEqual(f.space.read(DATA,8),pack(15n));}
});
test('cross-page OR faults restore every checkpoint span without a partial write',t=>{
 for(const mode of ['unmapped','read-only','write-only','protected']){const f=fixture(t,{address:DATA+4093n});if(mode==='unmapped')f.space.unmap(DATA+4096n,4096n);else f.space.protect(DATA+4096n,4096n,{ 'read-only':1,'write-only':2,protected:0}[mode]);f.begin();const before=f.snapshot(),owned=f.budget.stats().ownedPayloadBytes,bytes=f.space.read(DATA,4096);assert.equal(f.request().status,1);assert.equal(f.q.getBigUint64(F.faultAddress,true),DATA+4096n);f.v.setUint8(f.cpu+240,3);f.finish(1);assert.deepEqual(f.snapshot(),before);assert.equal(f.budget.stats().ownedPayloadBytes,owned);assert.deepEqual(f.space.read(DATA,4096),bytes);}
});
test('OR FINISH checks all GPRs, PF/AF raw, lazy padding, rounding and exact fallthrough',t=>{
 for(const [span,offset]of [['cpu',32],['cpu',64],['cpu',80],['cpu',240],['cpu',244],['cpu',255],['lazyFlags',4],['roundMode',0]]){const f=fixture(t);f.begin();f.request();f.spill();const at=f.at+layout[span].offset+offset;f.v.setUint8(at,f.v.getUint8(at)^1);assert.throws(()=>f.finish(0),/changed/);}
 const f=fixture(t);f.begin();f.request();f.spill();f.v.setUint32(f.cpu+248,0x1234,true);assert.equal(f.finish(0).status,0,'Only precise NZCV word and lazy representation may vary');
 const bad=fixture(t);bad.begin();bad.request();bad.spill();bad.v.setBigUint64(bad.cpu+24,bad.p.nextRip+1n,true);assert.throws(()=>bad.broker.finishInstruction(bad.token,{status:0,nextRip:bad.p.nextRip+1n}),/fallthrough/);
});
test('OR BEGIN requires bounded operand metadata and complete flag layout',t=>{
 for(const extra of [{continuations:[]},{nextRip:RIP+9n},{orMemoryOperand:{...plan().orMemoryOperand,register:16}},{orMemoryOperand:{...plan().orMemoryOperand,scale:3}}]){const f=fixture(t);assert.throws(()=>f.begin(extra),/OR memory metadata/);}
 const f=fixture(t);const memory=B.createInternalMemory(),token=f.broker.register(1,{space:f.space,memory,checkpointLayout:{...layout,cpu:{offset:256,size:1024,ripOffset:24,stackPointerOffset:64,generalRegistersOffset:32}}});new DataView(memory.buffer).setBigUint64(B.ABI.threadBase+280,RIP,true);assert.throws(()=>f.broker.beginInstruction(token,plan()),/OR memory metadata/);f.broker.unregister(token);
});
test('OR duplicate/missing requests and retired capabilities fail closed',t=>{
 const f=fixture(t);f.begin();f.request();assert.throws(()=>f.request(),/More than one/);
 const missing=fixture(t);missing.begin();missing.spill();assert.throws(()=>missing.finish(0),/post-state/);
 const old=fixture(t);old.begin();old.broker.unregister(old.token);assert.equal(old.request().accepted,false);const fresh=old.broker.register(0,{space:old.space,memory:B.createInternalMemory(),checkpointLayout:layout});assert.equal(old.request().accepted,false);assert.throws(()=>old.finish(0),/Retired/);old.broker.unregister(fresh);
});
test('OR dynamic header binds exact operands and rejects prior coverage15',()=>{
 const header=()=>{const p=plan(),b=new Uint8Array(96),v=new DataView(b.buffer);[0x31534a42,1,1,4,B.ABI.coverageVersion,0,16,8].forEach((n,i)=>v.setUint32(i*4,n,true));v.setBigUint64(32,p.rip,true);v.setBigUint64(40,p.nextRip,true);v.setUint32(56,1,true);v.setUint32(60,p.instruction.length,true);b.set(p.instruction,64);return b;};
 const p=B.parseStepHeader(header());assert.equal(p.orMemoryOperand.register,6);assert.equal(p.orMemoryOperand.base,4);const old=header();new DataView(old.buffer).setUint32(16,15,true);assert.throws(()=>B.parseStepHeader(old),/ABI/);
});
test('kernel static OR plans rederive source and address operands from bytes',t=>{
 globalThis.self=globalThis;for(const n of ['thread_core','web/linux-kernel'])vm.runInThisContext(fs.readFileSync(new URL('../../Sources/BetterJITLinux/Resources/linux/'+n+'.js',import.meta.url),'utf8'));
 const {Kernel}=LinuxBundle.require('./kernel.js'),cfg={guestMemory:'broker1',memoryABI:1,stepABI:4,coverageVersion:B.ABI.coverageVersion,stepHeaderBytes:96,memPages:33,memMaxPages:33,threadBase:65536,regArgs:0,callsViaDispatcher:false,maxInstructions:1,shared:true,ctx:256,stateSize:1024,ripOff:24,gregsOff:32,nzcvAddr:504,checkpoint:layout};
 for(const forged of [-1,0,16]){const space=new M.GuestAddressSpace(new M.BackingBudget(),{virtualLimit:1n<<47n}),p={...plan(),orMemoryOperand:{register:forged,base:15,index:14,scale:8,displacement:0n}};space.mapAnonymous(RIP,4096n,3);space.write(RIP,p.instruction);space.protect(RIP,4096n,5);const k=new Kernel({state:new Uint8Array(1024),vfs:{},log:()=>{}},cfg),made=k.createSparseProcess({space,entryRip:RIP,plans:[p]});assert.deepEqual(made.thread.sparse.plans.get(RIP).orMemoryOperand,B.orMemoryOperand(p));t.after(()=>{k.sparseBroker.unregister(made.thread.sparse.token);space.close();});}
});
