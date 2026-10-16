// SPDX-License-Identifier: GPL-3.0-or-later
// Production broker authority with synthetic CPU/RPC producers; no FEX claim.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
for(const name of ['guest_memory','guest_memory_broker'])vm.runInThisContext(fs.readFileSync(new URL('../../Sources/BetterJITLinux/Resources/linux/'+name+'.js',import.meta.url),'utf8'));
const M=BetterJITGuestMemory,B=BetterJITGuestMemoryBroker,{OP,STEP,FIELD:F,REASON:R}=B;
const RIP=0x123400004000n,TARGET=RIP+128n,STACK=0x223400000000n;
const layout={version:1,cpu:{offset:256,size:1024,ripOffset:24,stackPointerOffset:64},lazyFlags:{offset:64,size:24},roundMode:{offset:112,size:4}};
const pack=n=>{const b=new Uint8Array(8);new DataView(b.buffer).setBigUint64(0,n,true);return b;};
function fixture(t,{stack=STACK+128n,checkpointLayout=layout,budget=new M.BackingBudget()}={}){
 const space=new M.GuestAddressSpace(budget,{virtualLimit:1n<<47n});space.mapAnonymous(RIP,4096n,5);space.mapAnonymous(STACK,8192n,3);
 const memory=B.createInternalMemory(),broker=new B.GuestMemoryBroker(),token=broker.register(0,{space,memory,checkpointLayout}),v=new DataView(memory.buffer),q=new DataView(memory.buffer,B.ABI.threadBase+B.ABI.scratchOffset,128),cpu=B.ABI.threadBase+256;
 new Uint8Array(memory.buffer,cpu,1024).fill(0xa5);v.setBigUint64(cpu+24,RIP,true);v.setBigUint64(cpu+64,stack,true);
 let sequence=0,checkpoint;const f={budget,space,memory,broker,token,v,q,cpu,stack};
 t.after(()=>{broker.unregister(token);space.close();f.extraBacking?.close();assert.equal(budget.stats().ownedPayloadBytes,0);});
 f.begin=(op=OP.CALL,extra={})=>checkpoint=broker.beginInstruction(token,{rip:RIP,operation:op,width:8,nextRip:RIP+(op===OP.CALL?5n:1n),continuations:op===OP.CALL?[TARGET]:[],...extra});
 f.request=(op=OP.WRITE,extra={})=>{
  const values={magic:B.ABI.magic,version:B.ABI.version,sequence:++sequence,operation:op,width:8,access:op===OP.WRITE?2:1,address:op===OP.WRITE?stack-8n:stack,rip:RIP,checkpoint,operand0:RIP+5n,lease:token.generation,...extra};
  for(const [k,value]of Object.entries(values))if(typeof value==='bigint')q.setBigUint64(F[k],value,true);else q.setUint32(F[k],value,true);
  return broker.dispatch(token,{lease:token.generation,sequence});
 };
 f.spill=(pc=TARGET,sp=stack-8n)=>{v.setBigUint64(cpu+24,pc,true);v.setBigUint64(cpu+64,sp,true);};
 f.finish=status=>broker.finishInstruction(token,{status,nextRip:RIP+5n});return f;
}
test('CALL continuation derives exact signed target and rejects wrap, truncation, prefixes and forged fields',()=>{
 const p={operation:OP.CALL,width:8,rip:RIP,nextRip:RIP+5n,instruction:Uint8Array.of(0xe8,0xfb,0xff,0xff,0xff),continuationKind:3,branchTarget:RIP};
 assert.deepEqual(B.instructionContinuations(p),[RIP]);
 for(const extra of [{branchTarget:RIP&0xffffffffn},{nextRip:RIP+4n},{width:4},{continuationKind:1},
  {instruction:Uint8Array.of(0xe8,0,0,0)},{instruction:Uint8Array.of(0x66,0xe8,0,0,0,0)},
  {rip:0n,nextRip:5n,branchTarget:0xffffffffffffffffn,instruction:Uint8Array.of(0xe8,0xfa,0xff,0xff,0xff)},
  {rip:(1n<<47n)-6n,nextRip:(1n<<47n)-1n,branchTarget:1n<<47n,instruction:Uint8Array.of(0xe8,1,0,0,0)}])assert.throws(()=>B.instructionContinuations({...p,...extra}));
 const ret={operation:OP.RETURN,width:8,rip:RIP,nextRip:RIP+1n,instruction:Uint8Array.of(0xc3),continuationKind:4,branchTarget:0n};
 assert.deepEqual(B.instructionContinuations(ret),[]);
 for(const extra of [{branchTarget:TARGET},{continuationKind:3},{instruction:Uint8Array.of(0xc2,8,0)},{width:4}])assert.throws(()=>B.instructionContinuations({...ret,...extra}));
});
test('CALL snapshots its finite target, writes the exact full return PC and requires complete post-RSP',t=>{
 const f=fixture(t),targets=[TARGET];f.begin(OP.CALL,{continuations:targets});targets[0]=RIP;
 assert.equal(f.request().status,0);assert.deepEqual(f.space.read(f.stack-8n,8),pack(RIP+5n));
 f.spill(TARGET,f.stack);assert.throws(()=>f.finish(0),/post-state/);
});
test('RET FINISH binds to broker-owned stack data, not mutable scratch result/PC',t=>{
 const f=fixture(t);f.space.write(f.stack,pack(TARGET));f.begin(OP.RETURN);assert.equal(f.request(OP.READ).status,0);
 f.q.setBigUint64(F.result0,TARGET+1n,true);f.spill(TARGET+1n,f.stack+8n);assert.throws(()=>f.finish(0),/post-state/);
});
test('RET succeeds with the checked stack PC and exact RSP increment without modifying stack bytes',t=>{
 const f=fixture(t);f.space.write(f.stack,pack(TARGET));f.begin(OP.RETURN);assert.equal(f.request(OP.READ).status,0);
 f.spill(TARGET,f.stack+8n);assert.equal(f.finish(0).rip,TARGET);assert.deepEqual(f.space.read(f.stack,8),pack(TARGET));
});
test('duplicate stack RPC and success without a successful stack effect are fatal',t=>{
 const f=fixture(t);f.begin();assert.equal(f.request().status,0);assert.throws(()=>f.request(),/More than one/);
 const g=fixture(t);g.begin();g.spill();assert.throws(()=>g.finish(0),/post-state/);
});
test('forged stack address, return operand and wrong read/write operation refuse without stack changes',t=>{
 for(const extra of [{address:STACK+256n},{operand0:0n},{operation:OP.READ,access:1}]){
  const f=fixture(t);f.begin();const before=f.space.read(STACK,4096);assert.equal(f.request(OP.WRITE,extra).status,2);
  assert.equal(f.finish(2).rip,RIP);assert.deepEqual(f.space.read(STACK,4096),before);
 }
});
test('noncanonical/overflowing stacks and invalid executable targets refuse before CALL write',t=>{
 for(const stack of [0n,4n,1n<<47n,0xffffffffffffffffn]){
  const f=fixture(t,{stack});f.begin();assert.equal(f.request().reason,R.ADDRESS_DOMAIN);assert.equal(f.finish(2).rip,RIP);
 }
 for(const kind of ['unmapped','writable','execute-only','shared']){
  const f=fixture(t);let backing;
  if(kind==='unmapped')f.space.unmap(RIP,4096n);
  if(kind==='writable')f.space.protect(RIP,4096n,7);
  if(kind==='execute-only')f.space.protect(RIP,4096n,4);
  if(kind==='shared'){backing=new M.SharedBacking(f.budget,4096n);f.extraBacking=backing;f.space.unmap(RIP,4096n);f.space.mapShared(RIP,4096n,backing,0n,{prot:5});}
  f.begin();const before=f.space.read(STACK,4096);assert.equal(f.request().reason,R.CONTROL_TARGET);f.finish(2);assert.deepEqual(f.space.read(STACK,4096),before);
 }
});
test('checked control requires an owned stack checkpoint offset and rejects malformed layout/BEGIN metadata',t=>{
 for(const offset of [-1,1,24,1020,1.5])assert.throws(()=>new B.GuestMemoryBroker().register(0,{space:new M.GuestAddressSpace(new M.BackingBudget()),memory:B.createInternalMemory(),checkpointLayout:{...layout,cpu:{...layout.cpu,stackPointerOffset:offset}}}),/offset/);
 const f=fixture(t,{checkpointLayout:{...layout,cpu:{offset:256,size:1024,ripOffset:24}}});assert.throws(()=>f.begin(),/stack control/);
 const g=fixture(t);for(const extra of [{nextRip:RIP+4n},{continuations:[1n<<47n]},{continuations:[TARGET,TARGET+1n]},{width:4}])assert.throws(()=>g.begin(OP.CALL,extra));
});
test('retirement during CALL COW preparation cancels staged storage before a return-address write',t=>{
 let f,retire=false;const budget=new M.BackingBudget({allocatePage:n=>{if(retire)f.broker.unregister(f.token);return new Uint8Array(n);}});
 f=fixture(t,{budget});f.space.unmap(STACK,8192n);f.extraBacking=new M.SharedBacking(budget,8192n);f.space.mapShared(STACK,8192n,f.extraBacking,0n,{privateView:true});
 f.begin();const owned=budget.stats().ownedPayloadBytes;retire=true;assert.throws(()=>f.request(),/owner changed/);retire=false;
 assert.deepEqual(f.space.read(STACK,8192),new Uint8Array(8192));assert.equal(budget.stats().ownedPayloadBytes,owned);
});
test('unsupported after a completed CALL write is fatal and cannot pretend the memory effect rolled back',t=>{
 const f=fixture(t);f.begin();assert.equal(f.request().status,0);assert.throws(()=>f.finish(STEP.UNSUPPORTED),/after a memory effect/);
 assert.deepEqual(f.space.read(f.stack-8n,8),pack(RIP+5n));
});
