// SPDX-License-Identifier: GPL-3.0-or-later
// Owned ADD/SUB flag descriptors and read-only instruction transactions.
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';
for(const n of ['guest_memory','guest_memory_broker'])vm.runInThisContext(fs.readFileSync(new URL('../../Sources/BetterJITLinux/Resources/linux/'+n+'.js',import.meta.url),'utf8'));
const B=BetterJITGuestMemoryBroker,M=BetterJITGuestMemory,RIP=0x123400008000n,DATA=0x223400000000n,
 layout={version:1,cpu:{offset:256,size:1024,ripOffset:24,generalRegistersOffset:32,stackPointerOffset:64,parityRawOffset:240,auxiliaryRawOffset:244,nzcvOffset:248},lazyFlags:{offset:64,size:24},roundMode:{offset:112,size:4}};
function fixture(t,{width=8,sub=true,left=0xffffffffffffffffn,right=1n,seed=0xa5a5a5a5}={}){
 const instruction=Uint8Array.from([...(width===8?[0x48]:[]),sub?0x2b:3,0x10]),
  p={rip:RIP,nextRip:RIP+BigInt(instruction.length),operation:sub?B.OP.SUB_REGISTER_MEMORY:B.OP.ADD_REGISTER_MEMORY,width,instruction,length:instruction.length,continuationKind:0,branchTarget:0n};
 const field=sub?'subMemoryOperand':'addMemoryOperand';p[field]=sub?B.subMemoryOperand(p):B.addMemoryOperand(p);p.continuations=B.instructionContinuations(p);
 const memory=B.createInternalMemory(),v=new DataView(memory.buffer),tb=B.ABI.threadBase,cpu=tb+256,g=cpu+32,lazy=tb+64,
  q=new DataView(memory.buffer,tb+B.ABI.scratchOffset,128),budget=new M.BackingBudget(),space=new M.GuestAddressSpace(budget,{virtualLimit:1n<<47n});
 space.mapAnonymous(DATA,8192n,3);const bytes=new Uint8Array(8);new DataView(bytes.buffer).setBigUint64(0,right,true);space.write(DATA,bytes);
 for(const n of ['cpu','lazyFlags','roundMode'])new Uint8Array(memory.buffer,tb+layout[n].offset,layout[n].size).fill(0xa5);
 v.setBigUint64(cpu+24,RIP,true);v.setBigUint64(g,DATA,true);v.setBigUint64(g+16,left,true);v.setUint32(cpu+248,seed,true);
 const broker=new B.GuestMemoryBroker(),token=broker.register(0,{space,memory,checkpointLayout:layout}),kind=sub?(width===4?1:2):(width===4?19:20),
  a=BigInt.asUintN(width*8,left),b=BigInt.asUintN(width*8,right),result=BigInt.asUintN(width*8,sub?a-b:a+b);let checkpoint,sequence=0;
 const f={p,memory,v,tb,cpu,g,lazy,q,space,broker,token,kind,a,b,result,seed};
 f.snapshot=()=>['cpu','lazyFlags','roundMode'].map(n=>new Uint8Array(memory.buffer,tb+layout[n].offset,layout[n].size).slice());
 f.begin=()=>checkpoint=broker.beginInstruction(token,p);
 f.request=(extra={})=>{const seq=++sequence;for(const [key,value]of Object.entries({magic:B.ABI.magic,version:1,sequence:seq,operation:1,width,access:1,address:DATA,rip:RIP,checkpoint,lease:token.generation,...extra}))typeof value==='bigint'?q.setBigUint64(B.FIELD[key],value,true):q.setUint32(B.FIELD[key],value,true);return broker.dispatch(token,{lease:token.generation,sequence:seq});};
 f.spill=(materialized=false)=>{v.setBigUint64(cpu+24,p.nextRip,true);v.setBigUint64(g+16,result,true);v.setUint32(cpu+240,Number(BigInt.asUintN(32,result)),true);v.setUint32(cpu+244,Number(BigInt.asUintN(32,a^b)),true);v.setUint32(lazy,materialized?0:kind,true);v.setBigUint64(lazy+8,a,true);v.setBigUint64(lazy+16,b,true);if(materialized)v.setUint32(cpu+248,B.materializeArithmeticNZCV(kind,a,b,seed),true);};
 f.finish=status=>broker.finishInstruction(token,{status,nextRip:p.nextRip});
 t.after(()=>{broker.unregister(token);space.close();assert.equal(budget.stats().ownedPayloadBytes,0);});return f;
}
test('ADD/SUB accept equivalent materialized and matching lazy descriptors without rewriting them',t=>{
 for(const sub of [false,true])for(const width of [4,8])for(const materialized of [false,true])for(const seed of [0,0xffffffff]){
  const f=fixture(t,{sub,width,seed});f.begin();assert.equal(f.request().status,0);f.spill(materialized);const before=f.snapshot();assert.equal(f.finish(0).status,0);assert.deepEqual(f.snapshot(),before);
 }
});
test('ADD/SUB reject every changed NZCV bit in either representation',t=>{
 for(const sub of [false,true])for(const width of [4,8])for(const materialized of [false,true])for(let bit=0;bit<32;bit++){
  const f=fixture(t,{sub,width});f.begin();f.request();f.spill(materialized);f.v.setUint32(f.cpu+248,f.v.getUint32(f.cpu+248,true)^(1<<bit),true);assert.throws(()=>f.finish(0),/flags\/NZCV/);assert.throws(()=>f.broker.beginInstruction(f.token,f.p),/failed an invariant/);
 }
});
test('ADD/SUB bind FA/FB and reject unknown or wrong-family FK even when flags coincide',t=>{
 for(const sub of [false,true])for(const width of [4,8])for(const materialized of [false,true]){
  for(const offset of [8,16])for(const bit of [0n,4n,31n,32n,63n]){const f=fixture(t,{sub,width,left:0n,right:0n});f.begin();f.request();f.spill(materialized);f.v.setBigUint64(f.lazy+offset,f.v.getBigUint64(f.lazy+offset,true)^(1n<<bit),true);assert.throws(()=>f.finish(0),/operands\/kind/);}
  for(const kind of [1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,31,32,0xffffffff].filter(k=>k!==(sub?(width===4?1:2):(width===4?19:20)))){const f=fixture(t,{sub,width,left:0n,right:0n});f.begin();f.request();f.spill(materialized);f.v.setUint32(f.lazy,kind,true);assert.throws(()=>f.finish(0),/operands\/kind/);}
 }
});
test('ADD/SUB bind exact PF/AF, preserve other bytes and reject an invalid lazy-to-MAT transition',t=>{
 for(const sub of [false,true])for(const width of [4,8])for(const at of ['pf','af','gpr','padding','round','kind-only']){
  const f=fixture(t,{sub,width});f.begin();f.request();f.spill();const offset={pf:f.cpu+240,af:f.cpu+244,gpr:f.g+8,padding:f.lazy+4,round:f.tb+112}[at];
  if(at==='kind-only')f.v.setUint32(f.lazy,0,true);else f.v.setUint8(offset,f.v.getUint8(offset)^1);assert.throws(()=>f.finish(0),/changed/);
 }
});
test('owned FA/FB checks reject lazy corruption even when every reconstructed flag is unchanged',t=>{
 for(const sub of [false,true])for(const width of [4,8])for(const offset of [8,16]){
  const f=fixture(t,{sub,width,left:8n,right:1n});f.begin();f.request();f.spill();
  const canonical=B.materializeArithmeticNZCV(f.kind,f.a,f.b,f.seed);f.v.setBigUint64(f.lazy+offset,f.v.getBigUint64(f.lazy+offset,true)^1n,true);
  assert.equal(B.materializeArithmeticNZCV(f.kind,f.v.getBigUint64(f.lazy+8,true),f.v.getBigUint64(f.lazy+16,true),f.seed),canonical);
  assert.throws(()=>f.finish(0),/operands\/kind/);
 }
});
test('SUB typed read refusal restores the complete pre-instruction checkpoint',t=>{
 for(const width of [4,8])for(const fault of [false,true]){const f=fixture(t,{width});if(fault)f.space.protect(DATA,4096n,0);const before=f.snapshot();f.begin();assert.equal(f.request(fault?{}:{width:width===4?8:4}).status,fault?1:2);f.v.setBigUint64(f.g+16,44n,true);const result=f.finish(fault?1:2);assert.equal(result.rip,RIP);assert.deepEqual(f.snapshot(),before);}
});
test('SUB raw metadata derives full addressing and rejects forged byte/header contracts',()=>{
 for(const [bytes,fields]of [ [[0x2b,0x46,4],{register:0,base:6,displacement:4n}],[[0x4f,0x2b,0x54,0xac,0x80],{register:10,base:12,index:13,scale:4,displacement:-128n}],[[0x49,0x2b,0x15,0,0,0,0],{register:2,ripRelative:true,base:-1}] ]){
  const p={operation:18,width:bytes[0]>=0x48&&bytes[0]<=0x4f?8:4,rip:RIP,nextRip:RIP+BigInt(bytes.length),instruction:Uint8Array.from(bytes),continuationKind:0,branchTarget:0n};
  for(const [key,value]of Object.entries(fields))assert.equal(B.subMemoryOperand(p)[key],value);
  for(const change of [{operation:15},{width:2},{nextRip:p.nextRip+1n},{continuationKind:1},{branchTarget:RIP}])assert.throws(()=>B.subMemoryOperand({...p,...change}),/SUB metadata/);
 }
});
test('SUB request forgery, duplicate/missing reads and stale ownership cannot become success',t=>{
 for(const width of [4,8]){
  for(const extra of [{address:DATA+8n},{access:2},{operation:2},{rip:RIP+1n},{checkpoint:99n},{lease:99n},{sequence:99}]){
   const f=fixture(t,{width}),before=f.snapshot();f.begin();assert.equal(f.request(extra).status,2);f.v.setBigUint64(f.g+16,88n,true);assert.equal(f.finish(2).rip,RIP);assert.deepEqual(f.snapshot(),before);
  }
  const duplicate=fixture(t,{width});duplicate.begin();duplicate.request();assert.throws(()=>duplicate.request(),/More than one/);
  const missing=fixture(t,{width});missing.begin();missing.spill();assert.throws(()=>missing.finish(0),/post-state/);
  const old=fixture(t,{width});old.begin();old.broker.unregister(old.token);const replacement=old.broker.register(0,{space:old.space,memory:B.createInternalMemory(),checkpointLayout:layout});
  assert.equal(old.request().accepted,false);assert.throws(()=>old.finish(0),/Retired/);old.broker.unregister(replacement);
 }
});
test('SUB headers and static kernel plans rederive operands from exact executable bytes',t=>{
 globalThis.self=globalThis;for(const n of ['thread_core','web/linux-kernel'])vm.runInThisContext(fs.readFileSync(new URL('../../Sources/BetterJITLinux/Resources/linux/'+n+'.js',import.meta.url),'utf8'));
 const {Kernel}=LinuxBundle.require('./kernel.js'),cfg={guestMemory:'broker1',memoryABI:1,stepABI:4,coverageVersion:B.ABI.coverageVersion,stepHeaderBytes:96,memPages:33,memMaxPages:33,threadBase:65536,regArgs:0,callsViaDispatcher:false,maxInstructions:1,shared:true,ctx:256,stateSize:1024,ripOff:24,gregsOff:32,nzcvAddr:504,checkpoint:layout};
 for(const width of [4,8]){const f=fixture(t,{width}),p={...f.p,status:0},header=new Uint8Array(96),v=new DataView(header.buffer);
  [0x31534a42,1,1,4,B.ABI.coverageVersion,0,18,width].forEach((n,i)=>v.setUint32(i*4,n,true));v.setBigUint64(32,RIP,true);v.setBigUint64(40,p.nextRip,true);v.setUint32(56,1,true);v.setUint32(60,p.length,true);header.set(p.instruction,64);
  assert.deepEqual(B.parseStepHeader(header).subMemoryOperand,B.subMemoryOperand(p));v.setUint32(16,24,true);assert.throws(()=>B.parseStepHeader(header),/ABI/);v.setUint32(16,B.ABI.coverageVersion,true);v.setUint32(24,15,true);assert.throws(()=>B.parseStepHeader(header),/metadata/);
  const space=new M.GuestAddressSpace(new M.BackingBudget(),{virtualLimit:1n<<47n});space.mapAnonymous(RIP,4096n,3);space.write(RIP,p.instruction);space.protect(RIP,4096n,5);
  const k=new Kernel({state:new Uint8Array(1024),vfs:{},log:()=>{}},cfg),made=k.createSparseProcess({space,entryRip:RIP,plans:[{...p,subMemoryOperand:{register:15,base:14,index:13,scale:8,displacement:0n}}]});
  assert.deepEqual(made.thread.sparse.plans.get(RIP).subMemoryOperand,B.subMemoryOperand(p));t.after(()=>{k.sparseBroker.unregister(made.thread.sparse.token);space.close();});
 }
});
