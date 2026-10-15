// SPDX-License-Identifier: GPL-3.0-or-later
// Real broker/storage bytes; synthetic producer and checkpoint layout, no FEX claim.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
for(const name of ['guest_memory','guest_memory_broker'])vm.runInThisContext(fs.readFileSync(
 new URL('../../Sources/BetterJITLinux/Resources/linux/'+name+'.js',import.meta.url),'utf8'));
const {PAGE,PROT,BackingBudget,GuestAddressSpace,SharedBacking}=BetterJITGuestMemory;
const {ABI,FIELD:F,STATUS:S,REASON:R,OP,STEP,createInternalMemory,GuestMemoryBroker,BrokerInvariantError}=BetterJITGuestMemoryBroker;
const P=BigInt(PAGE),AT=0x123456780000n,RIP=0x123400004000n,RW=PROT.READ|PROT.WRITE;
// Native code exports these fields using sizeof/offsetof; this fixture uses a
// deliberately small fake CPU layout, including bytes beyond the GPR region.
const layout={version:1,cpu:{offset:0x100,size:1024,ripOffset:24},lazyFlags:{offset:0x40,size:24},roundMode:{offset:0x70,size:4}};
function fixture(t,{budget=new BackingBudget(),broker=new GuestMemoryBroker(),slot=0,space}={}) {
 space??=new GuestAddressSpace(budget,{virtualLimit:1n<<48n});t.after(()=>space.close());
 const memory=createInternalMemory(),view=new DataView(memory.buffer),scratch=new DataView(memory.buffer,ABI.threadBase+ABI.scratchOffset,ABI.scratchBytes);
 const token=broker.register(slot,{space,memory,checkpointLayout:layout});t.after(()=>broker.unregister(token));
 const cpu=ABI.threadBase+layout.cpu.offset;
 const setRip=rip=>view.setBigUint64(cpu+layout.cpu.ripOffset,rip,true);
 let sequence=0;
 const begin=(operation=OP.READ,width=8,rip=RIP)=>{setRip(rip);return broker.beginInstruction(token,{rip,operation,width});};
 function request({operation=OP.READ,width=8,address=AT,value=0n,rip=RIP,checkpoint=1n,...fields}={}) {
  sequence++;
  for(const [key,x]of Object.entries({magic:ABI.magic,version:ABI.version,sequence,operation,width,
   access:operation===OP.READ?PROT.READ:PROT.WRITE,address,rip,checkpoint,operand0:value,lease:token.generation,...fields}))
   if(typeof x==='bigint')scratch.setBigUint64(F[key],x,true);else scratch.setUint32(F[key],x,true);
  return broker.dispatch(token,{lease:token.generation,sequence});
 }
 return {budget,broker,slot,space,memory,view,scratch,token,cpu,setRip,begin,request};
}
function complete(f,rip=RIP+3n){f.setRip(rip);return f.broker.finishInstruction(f.token,{status:STEP.OK,nextRip:rip});}

test('internal memory has an actual fixed 33-page maximum independent of guest VA',t=>{
 const f=fixture(t);assert.equal(f.memory.buffer.byteLength,33*65536);assert.throws(()=>f.memory.grow(1),RangeError);
 assert.equal(f.space.stats().virtualLimit,1n<<48n);
 assert.throws(()=>f.broker.register(1,{space:f.space,memory:new WebAssembly.Memory({initial:33,maximum:65536,shared:true}),checkpointLayout:layout}),TypeError);
 assert.throws(()=>f.broker.register(1,{space:f.space,memory:f.memory,checkpointLayout:layout}),TypeError);
});
test('three registered spaces preserve full high pointers and independent all-one values',t=>{
 const broker=new GuestMemoryBroker(),budget=new BackingBudget({limitBytes:3*PAGE});
 const ff=[0,1,2].map(slot=>fixture(t,{broker,budget,slot}));
 for(const [i,f]of ff.entries()) {
  f.space.mapAnonymous(AT,P,RW);f.begin(OP.WRITE);const value=0xffffffffffffffffn-BigInt(i);
  assert.equal(f.request({operation:OP.WRITE,value}).status,S.OK);complete(f);
  const checkpoint=f.begin();const result=f.request({checkpoint});
  assert.equal(result.data,value);assert.equal(result.status,S.OK);assert.equal(f.scratch.getBigUint64(F.result0,true),value);
  assert.equal(f.scratch.getBigUint64(F.address,true),AT);complete(f);
 }
 assert.equal(budget.stats().ownedPayloadBytes,3*PAGE);assert.equal(broker.stats().threads,3);
});
test('typed status is separate from zero, sign bit and all-one scalar data',t=>{
 const f=fixture(t);f.space.mapAnonymous(AT,P,RW);
 for(const width of [1,2,4,8])for(const value of [0n,1n<<BigInt(width*8-1),(1n<<BigInt(width*8))-1n]) {
  let checkpoint=f.begin(OP.WRITE,width);assert.equal(f.request({operation:OP.WRITE,width,value,checkpoint}).status,S.OK);complete(f);
  checkpoint=f.begin(OP.READ,width);assert.equal(f.request({width,checkpoint}).data,value);complete(f);
 }
});
test('cross-page store validates both pages and restores complete pre-state on fault',t=>{
 const f=fixture(t);f.space.mapAnonymous(AT,P,RW);f.space.mapAnonymous(AT+P,P,PROT.READ);
 for(const p of [layout.cpu,layout.lazyFlags,layout.roundMode])new Uint8Array(f.memory.buffer,ABI.threadBase+p.offset,p.size).fill(0xa5);
 const checkpoint=f.begin(OP.WRITE),before=new Uint8Array(f.memory.buffer).slice();
 // Model Wasm locals eventually spilled with changed GPR/SIMD/flags/rounding bytes.
 for(const p of [layout.cpu,layout.lazyFlags,layout.roundMode])new Uint8Array(f.memory.buffer,ABI.threadBase+p.offset,p.size).fill(0x5a);
 const result=f.request({operation:OP.WRITE,address:AT+P-4n,value:0xffffffffffffffffn,checkpoint});
 assert.equal(result.status,S.FAULT);assert.equal(result.reason,R.PROTECTION);assert.equal(result.faultAddress,AT+P);assert.equal(result.rip,RIP);
 assert.deepEqual(f.space.read(AT+P-4n,8),new Uint8Array(8));
 const finished=f.broker.finishInstruction(f.token,{status:STEP.FAULT});assert.equal(finished.rip,RIP);
 for(const p of [layout.cpu,layout.lazyFlags,layout.roundMode])assert.deepEqual(
  new Uint8Array(f.memory.buffer,ABI.threadBase+p.offset,p.size),before.subarray(ABI.threadBase+p.offset,ABI.threadBase+p.offset+p.size));
});
test('cross-page transfers gather nonadjacent real frames and do not alias internal scratch',t=>{
 const f=fixture(t);f.space.mapAnonymous(AT,P,RW);f.space.mapAnonymous(0x200000n,P,RW);f.space.mapAnonymous(AT+P,P,RW);
 let checkpoint=f.begin(OP.WRITE);assert.equal(f.request({operation:OP.WRITE,address:AT+P-3n,value:0x8877665544332211n,checkpoint}).status,S.OK);complete(f);
 checkpoint=f.begin();assert.equal(f.request({address:AT+P-3n,checkpoint}).data,0x8877665544332211n);complete(f);
 f.space.write(0x200000n,Uint8Array.of(99));assert.equal(f.scratch.getUint32(F.magic,true),ABI.magic);
});
test('full i64 endpoint and high unmapped address fault without low-address truncation',t=>{
 const f=fixture(t);f.space.mapAnonymous(0x56780000n,P,RW);f.space.write(0x56780000n,Uint8Array.of(42));
 let checkpoint=f.begin();let r=f.request({checkpoint});assert.equal(r.reason,R.UNMAPPED);assert.equal(r.faultAddress,AT);
 f.broker.finishInstruction(f.token,{status:STEP.FAULT});
 checkpoint=f.begin();r=f.request({address:0xffffffffffffffffn,checkpoint});assert.equal(r.status,S.FAULT);assert.equal(r.reason,R.RANGE);
 assert.equal(r.faultAddress,0xffffffffffffffffn);f.broker.finishInstruction(f.token,{status:STEP.FAULT});
});
test('canonical shared aliases are visible through the same synchronous authority',t=>{
 const b=new BackingBudget(),broker=new GuestMemoryBroker(),shared=new SharedBacking(b,P);t.after(()=>shared.close());
 const a=fixture(t,{budget:b,broker}),c=fixture(t,{budget:b,broker,slot:1});
 a.space.mapShared(AT,P,shared);c.space.mapShared(AT+P,P,shared);
 let checkpoint=a.begin(OP.WRITE);a.request({operation:OP.WRITE,value:0x123456789abcdef0n,checkpoint});complete(a);
 checkpoint=c.begin();assert.equal(c.request({address:AT+P,checkpoint}).data,0x123456789abcdef0n);complete(c);
 assert.equal(b.stats().sharedFrames,1);
});
test('allocation failure is a typed fault and leaves a private view unchanged',t=>{
 const budget=new BackingBudget({limitBytes:PAGE}),object=new SharedBacking(budget,P);t.after(()=>object.close());
 const f=fixture(t,{budget});f.space.mapShared(AT,P,object,0n,{privateView:true});f.begin(OP.WRITE);
 const r=f.request({operation:OP.WRITE,value:1n});assert.equal(r.status,S.FAULT);assert.equal(r.reason,R.ALLOCATION);
 assert.equal(f.space.mappingInfo(AT).kind,'private-view');assert.deepEqual(f.space.read(AT,8),new Uint8Array(8));
 f.broker.finishInstruction(f.token,{status:STEP.FAULT});
});
test('retired lease and late mailbox cannot read or overwrite a reused slot scratch',t=>{
 const broker=new GuestMemoryBroker(),old=fixture(t,{broker});broker.unregister(old.token);
 const fresh=fixture(t,{broker});const before=new Uint8Array(fresh.scratch.buffer,fresh.scratch.byteOffset,ABI.scratchBytes).slice();
 assert.deepEqual(broker.dispatch(old.token,{lease:old.token.generation,sequence:1}),{accepted:false,reason:R.STALE_LEASE});
 assert.deepEqual(broker.dispatch(fresh.token,{lease:old.token.generation,sequence:1}),{accepted:false,reason:R.STALE_LEASE});
 assert.deepEqual(new Uint8Array(fresh.scratch.buffer,fresh.scratch.byteOffset,ABI.scratchBytes),before);
 assert.equal(broker.unregister(old.token),false);assert.equal(broker.stats().threads,1);
 assert.throws(()=>new GuestMemoryBroker().beginInstruction(fresh.token,{rip:RIP}),BrokerInvariantError);
});
test('duplicate sequence cannot apply a write twice, including in the next instruction',t=>{
 const f=fixture(t);f.space.mapAnonymous(AT,P,RW);f.begin(OP.WRITE);f.request({operation:OP.WRITE,value:1n});complete(f);
 f.space.write(AT,Uint8Array.of(2));f.begin(OP.WRITE);
 assert.equal(f.broker.dispatch(f.token,{lease:f.token.generation,sequence:1}).reason,R.SEQUENCE);
 assert.equal(f.space.read(AT,1)[0],2);assert.equal(f.scratch.getUint32(F.completedSequence,true),1);
 const r=f.request({operation:OP.WRITE,value:3n,checkpoint:2n});assert.equal(r.status,S.OK);complete(f);
});
test('protocol, width, access and uncovered atomic operations fail before storage effects',t=>{
 for(const [fields,reason]of [[{magic:0},R.PROTOCOL],[{version:2},R.PROTOCOL],[{lease:999n},R.PROTOCOL],
  [{width:16},R.WIDTH],[{access:PROT.READ},R.ACCESS],[{operation:OP.CAS},R.OPCODE],[{operation:OP.FETCH_ADD},R.OPCODE]]) {
  const f=fixture(t);f.space.mapAnonymous(AT,P,RW);f.begin(OP.WRITE);
  const r=f.request({operation:OP.WRITE,value:0xffffffffffffffffn,...fields});
  assert.equal(r.status,S.UNSUPPORTED);assert.equal(r.reason,reason);assert.equal(r.data,0n);assert.equal(r.faultAddress,0n);
  assert.deepEqual(f.space.read(AT,8),new Uint8Array(8));f.broker.finishInstruction(f.token,{status:STEP.UNSUPPORTED});
 }
});
test('checkpoint generation, full RIP and admitted operation must match before an effect',t=>{
 for(const fields of [{checkpoint:0n},{rip:RIP+(1n<<32n)},{operation:OP.WRITE}]) {
  const f=fixture(t);f.space.mapAnonymous(AT,P,RW);f.begin();
  assert.equal(f.request(fields).reason,R.CHECKPOINT);f.broker.finishInstruction(f.token,{status:STEP.UNSUPPORTED});
 }
 const f=fixture(t);assert.equal(f.request().reason,R.CHECKPOINT);
});
test('stale result bytes are cleared before a fault is published',t=>{
 const f=fixture(t);f.space.mapAnonymous(AT,P,RW);f.space.write(AT,new Uint8Array(8).fill(255));f.begin();
 assert.equal(f.request().data,0xffffffffffffffffn);complete(f);const checkpoint=f.begin();
 const r=f.request({address:AT+P,checkpoint});assert.equal(r.status,S.FAULT);assert.equal(f.scratch.getBigUint64(F.result0,true),0n);
 assert.equal(f.scratch.getBigUint64(F.result1,true),0n);assert.equal(f.scratch.getUint32(F.completedSequence,true),2);
 f.broker.finishInstruction(f.token,{status:STEP.FAULT});
});
test('invalid checkpoint spans and unsafe step transitions are explicit invariant failures',t=>{
 const f=fixture(t);
 for(const bad of [{...layout,version:0},{...layout,cpu:{...layout.cpu,ripOffset:1020}},
  {...layout,lazyFlags:{offset:0x100,size:24}},{...layout,roundMode:{offset:ABI.scratchOffset,size:4}}])
  assert.throws(()=>f.broker.register(1,{space:f.space,memory:createInternalMemory(),checkpointLayout:bad}),TypeError);
 assert.throws(()=>f.broker.beginInstruction(f.token,{rip:RIP}),BrokerInvariantError);
 const g=fixture(t,{slot:2});g.begin(OP.READ);assert.throws(()=>complete(g),BrokerInvariantError);
 const h=fixture(t,{slot:3});h.space.mapAnonymous(AT,P,RW);h.begin();h.request();
 assert.throws(()=>h.request(),BrokerInvariantError);assert.throws(()=>complete(h),BrokerInvariantError);
});
test('register-only checkpoint commits full u64 next RIP without invoking memory dispatch',t=>{
 const f=fixture(t);f.begin(0,0);const rip=RIP+(1n<<32n);assert.equal(complete(f,rip).rip,rip);
 assert.deepEqual(f.broker.stats(),{threads:1,requests:0,ok:0,faults:0,unsupported:0,rejected:0});
});
test('unexpected storage errors and unsupported exits after effects cannot become passing results',t=>{
 const f=fixture(t);f.space.mapAnonymous(AT,P,RW);f.begin();
 f.space.read=()=>{throw new Error('injected internal failure');};assert.throws(()=>f.request(),BrokerInvariantError);
 assert.throws(()=>f.broker.finishInstruction(f.token,{status:STEP.FAULT}),BrokerInvariantError);
 const g=fixture(t);g.space.mapAnonymous(AT,P,RW);g.begin(OP.WRITE);g.request({operation:OP.WRITE,value:7n});
 assert.throws(()=>g.broker.finishInstruction(g.token,{status:STEP.UNSUPPORTED}),BrokerInvariantError);
 assert.equal(g.space.read(AT,1)[0],7); // Fatal invariant, never a claimed rolled-back instruction.
});
