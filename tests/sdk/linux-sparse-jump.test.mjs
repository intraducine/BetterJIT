// SPDX-License-Identifier: GPL-3.0-or-later
// Production authority/metadata/cache gates with synthetic CPU producers.
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';
globalThis.self=globalThis;
for(const file of ['guest_memory.js','guest_memory_broker.js','thread_core.js','web/linux-kernel.js'])vm.runInThisContext(fs.readFileSync(new URL('../../Sources/BetterJITLinux/Resources/linux/'+file,import.meta.url),'utf8'));
const M=BetterJITGuestMemory,B=BetterJITGuestMemoryBroker,{FIELD:F,OP,REASON:R}=B,{Kernel,SLOT_BASE,SLOT_SIZE,S_REQ,S_DONE}=LinuxBundle.require('./kernel.js');
const RIP=0x123400004000n,TARGET=0x223400008000n;
const layout={version:1,cpu:{offset:256,size:1024,ripOffset:24,stackPointerOffset:64,generalRegistersOffset:32},lazyFlags:{offset:64,size:24},roundMode:{offset:112,size:4}};
function plan(reg=0,rex){const instruction=Uint8Array.from([...(rex===undefined?(reg<8?[]:[0x41]):[rex]),0xff,0xe0+(reg&7)]);return {status:0,rip:RIP,nextRip:RIP+BigInt(instruction.length),operation:OP.JUMP_REGISTER,width:0,length:instruction.length,instruction,continuationKind:5,branchTarget:0n};}
function fixture(t,{reg=0,target=TARGET,cpu=layout.cpu}={}){
 const budget=new M.BackingBudget(),space=new M.GuestAddressSpace(budget,{virtualLimit:1n<<47n});space.mapAnonymous(RIP,4096n,5);space.mapAnonymous(TARGET,8192n,5);
 const memory=B.createInternalMemory(),view=new DataView(memory.buffer),broker=new B.GuestMemoryBroker(),token=broker.register(0,{space,memory,checkpointLayout:{...layout,cpu}}),at=B.ABI.threadBase,q=new DataView(memory.buffer,at+B.ABI.scratchOffset,128);
 new Uint8Array(memory.buffer,at+256,1024).fill(0xa5);view.setBigUint64(at+256+24,RIP,true);view.setBigUint64(at+256+32+reg*8,target,true);
 let sequence=0,generation;const f={budget,space,memory,view,broker,token,q,at};
 f.begin=(extra={})=>generation=broker.beginInstruction(token,{...plan(reg),sourceRegister:reg,continuations:[],...extra});
 f.request=(extra={})=>{for(const [name,value]of Object.entries({magic:B.ABI.magic,version:1,sequence:++sequence,operation:OP.JUMP_REGISTER,width:0,access:4,address:target,rip:RIP,checkpoint:generation,lease:token.generation,...extra}))typeof value==='bigint'?q.setBigUint64(F[name],value,true):q.setUint32(F[name],value,true);return broker.dispatch(token,{lease:token.generation,sequence});};
 f.spill=(pc=target)=>view.setBigUint64(at+256+24,pc,true);f.finish=status=>broker.finishInstruction(token,{status,nextRip:plan(reg).nextRip});
 t.after(()=>{broker.unregister(token);space.close();f.backing?.close();assert.equal(budget.stats().ownedPayloadBytes,0);});return f;
}
test('register JMP metadata derives every GPR and accepts ignored REX bits without widening encoding scope',()=>{
 for(let reg=0;reg<16;reg++)for(const rex of reg<8?[undefined,0x40,0x44,0x48,0x4e]:[0x41,0x45,0x49,0x4f]){const p=plan(reg,rex);assert.equal(B.jumpSourceRegister(p),reg);assert.deepEqual(B.instructionContinuations(p),[]);}
 const p=plan();for(const change of [{width:8},{continuationKind:1},{branchTarget:TARGET},{nextRip:RIP+3n},{rip:1n<<47n},{instruction:Uint8Array.of(0xff,0x20)},{instruction:Uint8Array.of(0xff,0xd0)},{instruction:Uint8Array.of(0x66,0xff,0xe0)},{instruction:Uint8Array.of(0x40,0x41,0xff,0xe0)},{instruction:Uint8Array.of(0xff,0xe0,0)}])assert.throws(()=>B.instructionContinuations({...p,...change}),/register jump/);
});
test('all source registers resolve from the private checkpoint and preserve CPU/flags/rounding',t=>{
 for(let reg=0;reg<16;reg++){const f=fixture(t,{reg});f.begin();const before=new Uint8Array(f.memory.buffer,f.at+256,1024).slice();assert.equal(f.request().data,TARGET);f.spill();const done=f.finish(0);new DataView(before.buffer).setBigUint64(24,TARGET,true);assert.deepEqual(new Uint8Array(f.memory.buffer,f.at+256,1024),before);assert.equal(done.rip,TARGET);assert.equal(f.broker.stats().requests,1);}
});
test('forged target/request metadata cannot redirect a checkpointed register',t=>{
 for(const change of [{address:TARGET+1n},{operation:OP.READ,width:8,access:1},{width:8},{access:1},{checkpoint:99n},{rip:RIP+1n}]){const f=fixture(t);f.begin();f.view.setBigUint64(f.at+256+32,TARGET+1n,true);assert.equal(f.request(change).status,2);assert.equal(f.finish(2).rip,RIP);assert.equal(f.view.getBigUint64(f.at+256+32,true),TARGET);}
});
test('invalid/noncanonical/nonprivate/unreadable/nonexecutable targets refuse with exact rollback',t=>{
 for(const kind of ['unmapped','NX','RWX','execute-only','shared','private-view','noncanonical','u64-max']){
  const target=kind==='noncanonical'?1n<<47n:kind==='u64-max'?0xffffffffffffffffn:TARGET,f=fixture(t,{target});
  if(kind==='unmapped')f.space.unmap(TARGET,8192n);
  if(kind==='NX')f.space.protect(TARGET,8192n,1);if(kind==='RWX')f.space.protect(TARGET,8192n,7);if(kind==='execute-only')f.space.protect(TARGET,8192n,4);
  if(['shared','private-view'].includes(kind)){f.space.unmap(TARGET,8192n);f.backing=new M.SharedBacking(f.budget,8192n);f.space.mapShared(TARGET,8192n,f.backing,0n,{prot:5,privateView:kind==='private-view'});}
  f.begin();const before=new Uint8Array(f.memory.buffer,f.at+256,1024).slice();assert.equal(f.request().reason,R.CONTROL_TARGET,kind);assert.equal(f.finish(2).rip,RIP);assert.deepEqual(new Uint8Array(f.memory.buffer,f.at+256,1024),before);
 }
});
test('authority revocation after RPC downgrades FINISH and restores all checkpoint spans',t=>{
 for(const kind of ['unmapped','NX','RWX','execute-only','shared','private-view']){const f=fixture(t);f.begin();const before=layoutSnapshot(f);assert.equal(f.request().status,0);f.spill();
  if(kind==='unmapped')f.space.unmap(TARGET,8192n);if(kind==='NX')f.space.protect(TARGET,8192n,1);if(kind==='RWX')f.space.protect(TARGET,8192n,7);if(kind==='execute-only')f.space.protect(TARGET,8192n,4);
  if(['shared','private-view'].includes(kind)){f.space.unmap(TARGET,8192n);f.backing=new M.SharedBacking(f.budget,8192n);f.space.mapShared(TARGET,8192n,f.backing,0n,{prot:5,privateView:kind==='private-view'});}
  const done=f.finish(0);assert.equal(done.status,2,kind);assert.equal(done.rip,RIP);assert.equal(done.memory.reason,R.CONTROL_TARGET);assert.deepEqual(layoutSnapshot(f),before);
 }
});
function layoutSnapshot(f){return ['cpu','lazyFlags','roundMode'].map(name=>{const p=layout[name];return new Uint8Array(f.memory.buffer,f.at+p.offset,p.size).slice();});}
test('missing/duplicate RPC, forged successful PC and retired owner remain fatal',t=>{
 {const f=fixture(t);f.begin();f.spill();assert.throws(()=>f.finish(0),/post-state/);}
 {const f=fixture(t);f.begin();f.request();assert.throws(()=>f.request(),/More than one/);}
 {const f=fixture(t);f.begin();f.request();f.q.setBigUint64(F.result0,TARGET+1n,true);f.spill(TARGET+1n);assert.throws(()=>f.finish(0),/post-state/);}
 {const f=fixture(t);f.begin();f.broker.unregister(f.token);assert.equal(f.request().accepted,false);assert.throws(()=>f.finish(0),/Retired/);}
});
test('register checkpoint window and BEGIN metadata are bounded and independent of mutable request fields',t=>{
 for(const offset of [-1,1,24,904,1.5]){const f=fixture(t);assert.throws(()=>f.broker.register(1,{space:f.space,memory:B.createInternalMemory(),checkpointLayout:{...layout,cpu:{...layout.cpu,generalRegistersOffset:offset}}}),/offset/);}
 const {generalRegistersOffset,...without}=layout.cpu,f=fixture(t,{cpu:without});assert.throws(()=>f.begin(),/register jump/);
 const g=fixture(t);for(const change of [{sourceRegister:-1},{sourceRegister:16},{sourceRegister:1.5},{nextRip:1n<<47n},{continuations:[TARGET]}])assert.throws(()=>g.begin(change),/register jump/);
});
function kernelFixture(t,{sourceRegister=15}={}){
 const budget=new M.BackingBudget(),space=new M.GuestAddressSpace(budget,{virtualLimit:1n<<47n}),p={...plan(),sourceRegister};space.mapAnonymous(RIP,4096n,3);space.write(RIP,p.instruction);space.protect(RIP,4096n,5);space.mapAnonymous(TARGET,4096n,3);space.write(TARGET,Uint8Array.of(0xb8,1,0,0,0));space.protect(TARGET,4096n,5);
 const cfg={guestMemory:'broker1',memoryABI:1,stepABI:3,coverageVersion:B.ABI.coverageVersion,stepHeaderBytes:96,memPages:33,memMaxPages:33,threadBase:65536,regArgs:0,callsViaDispatcher:false,maxInstructions:1,shared:true,ctx:256,stateSize:1024,ripOff:24,gregsOff:32,checkpoint:layout};
 const k=new Kernel({vfs:{},state:new Uint8Array(1024),log:()=>{}},cfg),made=k.createSparseProcess({space,entryRip:RIP,plans:[p,{status:0,operation:0,width:0,rip:TARGET,nextRip:TARGET+5n,length:5,instruction:Uint8Array.of(0xb8,1,0,0,0)}]}),s=made.thread.sparse,base=(SLOT_BASE+made.thread.slot*SLOT_SIZE)>>2,b64=base>>1;let boundary=0;
 s.view.setBigUint64(made.thread.tb+288,TARGET,true);s.view.setBigUint64(made.thread.tb+288+15*8,TARGET+999n,true);
 const phase=(which,status=0)=>{k.k64[b64+1]=BigInt(B.ABI.instructionBoundary);k.k64[b64+2]=s.token.generation;k.k64[b64+3]=BigInt(++boundary);k.k64[b64+4]=BigInt(which);k.k64[b64+5]=BigInt(status);Atomics.store(k.k32,base,S_REQ);k.serviceRequests();assert.equal(Atomics.load(k.k32,base),S_DONE);Atomics.store(k.k32,base,0);return Number(k.k64[b64+8]);};
 t.after(()=>{k.sparseBroker.unregister(s.token);space.close();});return {k,space,budget,s,phase,...made};
}
test('kernel rederives static source metadata and propagates typed target revocation',t=>{
 const f=kernelFixture(t),{s}=f;assert.equal(s.plans.get(RIP).sourceRegister,0);assert.equal(f.phase(1),0);const q=new DataView(s.memory.buffer,B.ABI.threadBase+B.ABI.scratchOffset,128);
 for(const [name,value]of Object.entries({magic:B.ABI.magic,version:1,sequence:1,operation:OP.JUMP_REGISTER,width:0,access:4,address:TARGET,rip:RIP,checkpoint:1n,lease:s.token.generation}))typeof value==='bigint'?q.setBigUint64(F[name],value,true):q.setUint32(F[name],value,true);
 assert.equal(f.k.sparseBroker.dispatch(s.token,{lease:s.token.generation,sequence:1}).status,0);s.view.setBigUint64(f.thread.tb+280,TARGET,true);f.space.protect(TARGET,4096n,1);assert.equal(f.phase(2),2);assert.equal(s.last.status,2);assert.equal(s.view.getBigUint64(f.thread.tb+280,true),RIP);
});
test('after a completed JMP, cached target instructions require their entire current private executable bytes',t=>{
 for(const kind of ['same-private','changed-second-byte','NX','RWX','shared','private-view']){const f=kernelFixture(t);f.s.view.setBigUint64(f.thread.tb+280,TARGET,true);
  // The transfer already completed; the next admission owns any failure.
  if(kind==='same-private'){f.space.unmap(TARGET,4096n);f.space.mapAnonymous(TARGET,4096n,3);f.space.write(TARGET,Uint8Array.of(0xb8,1,0,0,0));f.space.protect(TARGET,4096n,5);assert.equal(f.k.sparsePlan(f.thread).rip,TARGET);continue;}
  if(kind==='changed-second-byte'){f.space.protect(TARGET,4096n,3);f.space.write(TARGET+1n,Uint8Array.of(2));f.space.protect(TARGET,4096n,5);}
  if(kind==='NX')f.space.protect(TARGET,4096n,1);if(kind==='RWX')f.space.protect(TARGET,4096n,7);
  if(['shared','private-view'].includes(kind)){f.space.unmap(TARGET,4096n);const backing=new M.SharedBacking(f.budget,4096n);f.space.mapShared(TARGET,4096n,backing,0n,{prot:5,privateView:kind==='private-view'});t.after(()=>backing.close());}
  assert.throws(()=>f.k.sparsePlan(f.thread),/bytes changed|executable-alias|protection/);assert.equal(f.s.view.getBigUint64(f.thread.tb+280,true),TARGET);
 }
});
test('successful JMP cannot forge any CPU, lazy-flag or rounding byte beyond RIP',t=>{
 for(const [name,offset]of [['cpu',0],['cpu',32],['cpu',64],['cpu',184],['cpu',1023],['lazyFlags',0],['lazyFlags',23],['roundMode',0],['roundMode',3]]){
  const f=fixture(t);f.begin();f.request();f.spill();const at=f.at+layout[name].offset+offset;f.view.setUint8(at,f.view.getUint8(at)^1);assert.throws(()=>f.finish(0),/non-RIP checkpoint/);
 }
 // A malformed successful state is fatal even when target authority also changed.
 const f=fixture(t);f.begin();f.request();f.spill();f.view.setUint8(f.at+layout.roundMode.offset,1);f.space.protect(TARGET,8192n,1);assert.throws(()=>f.finish(0),/non-RIP checkpoint/);
});
test('dynamic header parsing derives source register and rejects forged control metadata and old coverage',()=>{
 function header(p){const b=new Uint8Array(96),v=new DataView(b.buffer);[0x31534a42,1,1,3,B.ABI.coverageVersion,0,p.operation,p.width].forEach((x,i)=>v.setUint32(i*4,x,true));v.setBigUint64(32,p.rip,true);v.setBigUint64(40,p.nextRip,true);v.setUint32(56,1,true);v.setUint32(60,p.length,true);b.set(p.instruction,64);v.setBigUint64(80,p.branchTarget,true);v.setUint32(88,p.continuationKind,true);return b;}
 for(let reg=0;reg<16;reg++)assert.equal(B.parseStepHeader(header(plan(reg))).sourceRegister,reg);
 for(const change of [{width:8},{continuationKind:0},{branchTarget:TARGET},{instruction:Uint8Array.of(0xff,0x20)}])assert.throws(()=>B.parseStepHeader(header({...plan(),...change})),/metadata/);
 const h=header(plan());new DataView(h.buffer).setUint32(16,13,true);assert.throws(()=>B.parseStepHeader(h),/ABI/);
});
test('static caller-supplied source indices cannot override instruction bytes',t=>{
 for(const sourceRegister of [-1,16,0xffff]){const f=kernelFixture(t,{sourceRegister});assert.equal(f.s.plans.get(RIP).sourceRegister,0);}
});
