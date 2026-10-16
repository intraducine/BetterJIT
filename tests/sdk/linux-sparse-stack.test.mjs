// SPDX-License-Identifier: GPL-3.0-or-later
// Production stack authority with synthetic producers; native/FEX tests separate.
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';
for(const n of ['guest_memory','guest_memory_broker'])vm.runInThisContext(fs.readFileSync(new URL('../../Sources/BetterJITLinux/Resources/linux/'+n+'.js',import.meta.url),'utf8'));
const M=BetterJITGuestMemory,B=BetterJITGuestMemoryBroker,{OP,FIELD:F,REASON:R}=B,RIP=0x123400004000n,STACK=0x223400000000n;
const layout={version:1,cpu:{offset:256,size:1024,ripOffset:24,stackPointerOffset:64,generalRegistersOffset:32},lazyFlags:{offset:64,size:24},roundMode:{offset:112,size:4}};
const pack=n=>{const b=new Uint8Array(8);new DataView(b.buffer).setBigUint64(0,n,true);return b;};
function plan(kind='push',reg=0,rex){const instruction=Uint8Array.from([...(rex===undefined?(reg<8?[]:[0x41]):[rex]),(kind==='push'?0x50:0x58)+(reg&7)]);return{status:0,operation:kind==='push'?OP.PUSH_REGISTER:OP.POP_REGISTER,width:8,rip:RIP,nextRip:RIP+BigInt(instruction.length),instruction,length:instruction.length,continuationKind:0,branchTarget:0n};}
function fixture(t,{kind='push',reg=0,sp=STACK+4093n,value=0x123456789abcdef0n,budget=new M.BackingBudget(),checkpointLayout=layout}={}){
 const space=new M.GuestAddressSpace(budget,{virtualLimit:1n<<47n});space.mapAnonymous(STACK,8192n,3);space.write(STACK,new Uint8Array(8192).fill(0xa5));
 const memory=B.createInternalMemory(),broker=new B.GuestMemoryBroker(),token=broker.register(0,{space,memory,checkpointLayout}),v=new DataView(memory.buffer),at=B.ABI.threadBase,cpu=at+256,g=cpu+32,q=new DataView(memory.buffer,at+B.ABI.scratchOffset,128),p=plan(kind,reg);
 for(const name of ['cpu','lazyFlags','roundMode']){const span=layout[name];new Uint8Array(memory.buffer,at+span.offset,span.size).fill(0xa5);}
 v.setBigUint64(cpu+24,RIP,true);v.setBigUint64(g+reg*8,value,true);v.setBigUint64(g+32,sp,true);
 if(kind==='pop'&&sp>=STACK&&sp+8n<=STACK+8192n)space.write(sp,pack(value));
 let checkpoint,sequence=0;const f={space,budget,memory,broker,token,v,q,at,cpu,g,p,sp,value,kind,reg};
 f.snapshot=()=>['cpu','lazyFlags','roundMode'].map(name=>{const span=layout[name];return new Uint8Array(memory.buffer,at+span.offset,span.size).slice();});
 f.begin=(extra={})=>checkpoint=broker.beginInstruction(token,{...p,stackRegister:reg,continuations:[p.nextRip],...extra});
 f.request=(extra={})=>{for(const [name,n]of Object.entries({magic:B.ABI.magic,version:1,sequence:++sequence,operation:kind==='push'?OP.WRITE:OP.READ,width:8,access:kind==='push'?2:1,address:kind==='push'?BigInt.asUintN(64,sp-8n):sp,rip:RIP,checkpoint,operand0:reg===4?sp:value,lease:token.generation,...extra}))typeof n==='bigint'?q.setBigUint64(F[name],n,true):q.setUint32(F[name],n,true);return broker.dispatch(token,{lease:token.generation,sequence});};
 f.spill=()=>{v.setBigUint64(cpu+24,p.nextRip,true);v.setBigUint64(g+32,sp+(kind==='push'?-8n:8n),true);if(kind==='pop')v.setBigUint64(g+reg*8,value,true);};
 f.finish=status=>broker.finishInstruction(token,{status,nextRip:p.nextRip});
 t.after(()=>{broker.unregister(token);space.close();f.alias?.close();f.backing?.close();assert.equal(budget.stats().ownedPayloadBytes,0);});return f;
}
test('compact register stack metadata derives all GPRs and refuses other encodings/forgeries',()=>{
 for(const kind of ['push','pop'])for(let reg=0;reg<16;reg++)for(const rex of reg<8?[undefined,0x40,0x44,0x48,0x4e]:[0x41,0x45,0x49,0x4f]){const p=plan(kind,reg,rex);assert.equal(B.stackRegister(p),reg);assert.deepEqual(B.instructionContinuations(p),[p.nextRip]);}
 for(const extra of [{width:4},{continuationKind:1},{branchTarget:RIP},{nextRip:RIP+2n},{instruction:Uint8Array.of(0xff,0xf0)},{instruction:Uint8Array.of(0x8f,0xc0)},{instruction:Uint8Array.of(0x66,0x50)},{instruction:Uint8Array.of(0x40,0x41,0x50)},{instruction:Uint8Array.of(0x6a,0)}])assert.throws(()=>B.instructionContinuations({...plan(),...extra}),/register stack/);
});
test('PUSH binds all source values to owned checkpoints, including old RSP',t=>{
 for(let reg=0;reg<16;reg++){const f=fixture(t,{reg});f.begin();const expected=f.snapshot();assert.equal(f.request().status,0);f.spill();new DataView(expected[0].buffer).setBigUint64(24,f.p.nextRip,true);new DataView(expected[0].buffer).setBigUint64(64,f.sp-8n,true);assert.equal(f.finish(0).status,0);assert.deepEqual(f.snapshot(),expected);assert.deepEqual(f.space.read(f.sp-8n,8),pack(reg===4?f.sp:f.value));}
});
test('POP changes only decoded destination and RSP; POP RSP accepts arbitrary64-bit data',t=>{
 for(let reg=0;reg<16;reg++)for(const value of [0n,0xffffffffffffffffn,0x123456789abcdef0n,1n<<47n]){const f=fixture(t,{kind:'pop',reg,value});f.begin();const before=f.space.read(STACK,8192),expected=f.snapshot();assert.equal(f.request().data,value);f.spill();const cpu=new DataView(expected[0].buffer);cpu.setBigUint64(24,f.p.nextRip,true);cpu.setBigUint64(64,f.sp+8n,true);cpu.setBigUint64(32+reg*8,value,true);assert.equal(f.finish(0).status,0);assert.deepEqual(f.snapshot(),expected);assert.deepEqual(f.space.read(STACK,8192),before);}
});
test('forged addresses, operands, widths, operations and checkpoints refuse with exact rollback',t=>{
 for(const kind of ['push','pop'])for(const change of [{address:STACK+512n},{width:4},{operation:3,access:3},{checkpoint:99n},{rip:RIP+1n},...(kind==='push'?[{operand0:999n}]:[])]){const f=fixture(t,{kind});f.begin();const before=f.snapshot(),bytes=f.space.read(STACK,8192);assert.equal(f.request(change).status,2);assert.equal(f.finish(2).rip,RIP);assert.deepEqual(f.snapshot(),before);assert.deepEqual(f.space.read(STACK,8192),bytes);}
 const f=fixture(t,{reg:4});f.begin();f.v.setBigUint64(f.g+32,f.sp-8n,true);assert.equal(f.request({operand0:f.sp-8n}).reason,R.CHECKPOINT);assert.equal(f.finish(2).rip,RIP);assert.equal(f.v.getBigUint64(f.g+32,true),f.sp);
});
test('canonical/range failures stop before storage effects, and POP may finish at one-past-window RSP',t=>{
 for(const kind of ['push','pop'])for(const sp of [1n<<47n,0xffffffffffffffffn,...(kind==='push'?[0n,4n]:[(1n<<47n)-4n])]){const f=fixture(t,{kind,sp});f.begin();const before=f.snapshot(),bytes=f.space.read(STACK,8192);assert.equal(f.request().reason,R.ADDRESS_DOMAIN);f.finish(2);assert.deepEqual(f.snapshot(),before);assert.deepEqual(f.space.read(STACK,8192),bytes);}
 for(const reg of [0,4]){const sp=(1n<<47n)-8n,f=fixture(t,{kind:'pop',reg,sp,value:0xffffffffffffffffn});f.space.mapAnonymous(sp&~4095n,4096n,3);f.space.write(sp,pack(f.value));f.begin();assert.equal(f.request().data,f.value);f.spill();assert.equal(f.finish(0).status,0);assert.equal(f.v.getBigUint64(f.g+32,true),reg===4?f.value:1n<<47n);}
});
test('cross-page map/protection faults restore full state and leave PUSH bytes untouched',t=>{
 for(const kind of ['push','pop'])for(const fault of ['unmapped','none','readonly']){
  const f=fixture(t,{kind,sp:STACK+(kind==='push'?4099n:4093n)});
  if(fault==='unmapped')f.space.unmap(STACK+4096n,4096n);else f.space.protect(STACK+4096n,4096n,fault==='none'?0:1);
  f.begin();const before=f.snapshot(),first=f.space.read(STACK,4096),result=f.request();
  if(kind==='pop'&&fault==='readonly'){assert.equal(result.status,0);f.spill();f.finish(0);}
  else{assert.equal(result.status,1);f.finish(1);assert.deepEqual(f.snapshot(),before);assert.deepEqual(f.space.read(STACK,4096),first);}
 }
});
test('PUSH stages both COW pages atomically and rechecks exact owner before commit',t=>{
 for(const limit of [8192,12288,16384]){const budget=new M.BackingBudget({limitBytes:limit}),f=fixture(t,{budget,sp:STACK+4099n});f.space.unmap(STACK,8192n);f.backing=new M.SharedBacking(budget,8192n);f.space.mapShared(STACK,8192n,f.backing,0n,{privateView:true});f.alias=new M.GuestAddressSpace(budget,{virtualLimit:1n<<47n});f.alias.mapShared(STACK,8192n,f.backing);
  f.begin();const before=f.snapshot(),owned=budget.stats().ownedPayloadBytes,result=f.request();if(limit<16384){assert.equal(result.reason,R.ALLOCATION);f.finish(1);assert.deepEqual(f.snapshot(),before);assert.deepEqual(f.space.read(STACK,8192),new Uint8Array(8192));assert.equal(budget.stats().ownedPayloadBytes,owned);}else{assert.equal(result.status,0);f.spill();f.finish(0);assert.deepEqual(f.space.read(f.sp-8n,8),pack(f.value));}assert.deepEqual(f.alias.read(STACK,8192),new Uint8Array(8192));
 }
 let f,retire=false;const budget=new M.BackingBudget({allocatePage:n=>{if(retire)f.broker.unregister(f.token);return new Uint8Array(n);}});f=fixture(t,{budget});f.space.unmap(STACK,8192n);f.backing=new M.SharedBacking(budget,8192n);f.space.mapShared(STACK,8192n,f.backing,0n,{privateView:true});f.begin();retire=true;assert.throws(()=>f.request(),/owner changed/);retire=false;assert.deepEqual(f.space.read(STACK,8192),new Uint8Array(8192));
});
test('successful state forgery and unsupported after a committed PUSH are fatal',t=>{
 for(const kind of ['push','pop'])for(const [name,offset]of [['cpu',0],['cpu',32+7*8],['cpu',64],['cpu',1023],['lazyFlags',0],['roundMode',0]]){const f=fixture(t,{kind,reg:5});f.begin();f.request();f.spill();const at=f.at+layout[name].offset+offset;f.v.setUint8(at,f.v.getUint8(at)^1);assert.throws(()=>f.finish(0),/unexpected checkpoint/);}
 const f=fixture(t);f.begin();f.request();assert.throws(()=>f.finish(2),/after a memory effect/);assert.deepEqual(f.space.read(f.sp-8n,8),pack(f.value));
 const g=fixture(t,{kind:'pop'});g.begin();g.request();g.q.setBigUint64(F.result0,g.value+1n,true);g.spill();g.v.setBigUint64(g.g,g.value+1n,true);assert.throws(()=>g.finish(0),/unexpected checkpoint/);
});
test('stack register BEGIN metadata requires a bound register/RSP layout and exact fallthrough',t=>{
 for(const change of [{stackRegister:-1},{stackRegister:16},{stackRegister:1.5},{nextRip:RIP+3n},{continuations:[]},{continuations:[RIP]}]){const f=fixture(t);assert.throws(()=>f.begin(change),/register stack/);}
 const f=fixture(t,{checkpointLayout:{...layout,cpu:{...layout.cpu,stackPointerOffset:72}}});assert.throws(()=>f.begin(),/register stack/);
});
test('dynamic stack headers derive the operand register and reject malformed metadata or prior coverage',()=>{
 const header=p=>{const b=new Uint8Array(96),v=new DataView(b.buffer);[0x31534a42,1,1,3,B.ABI.coverageVersion,0,p.operation,p.width].forEach((x,i)=>v.setUint32(i*4,x,true));v.setBigUint64(32,p.rip,true);v.setBigUint64(40,p.nextRip,true);v.setUint32(56,1,true);v.setUint32(60,p.length,true);b.set(p.instruction,64);v.setBigUint64(80,p.branchTarget,true);v.setUint32(88,p.continuationKind,true);return b;};
 for(const kind of ['push','pop'])for(let reg=0;reg<16;reg++)assert.equal(B.parseStepHeader(header(plan(kind,reg))).stackRegister,reg);
 for(const extra of [{width:4},{continuationKind:1},{branchTarget:RIP},{instruction:Uint8Array.of(0x6a)}])assert.throws(()=>B.parseStepHeader(header({...plan(),...extra})),/metadata/);
 const old=header(plan());new DataView(old.buffer).setUint32(16,13,true);assert.throws(()=>B.parseStepHeader(old),/ABI/);
});
test('PUSH/POP registrations reject duplicate RPCs and retired ownership, including slot reuse',t=>{
 const f=fixture(t);f.begin();f.request();assert.throws(()=>f.request(),/More than one/);
 const g=fixture(t,{kind:'pop'});g.begin();g.broker.unregister(g.token);assert.equal(g.request().accepted,false);const memory=B.createInternalMemory(),fresh=g.broker.register(0,{space:g.space,memory,checkpointLayout:layout});t.after(()=>g.broker.unregister(fresh));assert.throws(()=>g.finish(0),/Retired/);assert.equal(g.broker.dispatch(g.token,{lease:g.token.generation,sequence:2}).accepted,false);assert.equal(g.broker.stats().threads,1);
});
test('shared stacks expose the committed PUSH exactly once and POP never detaches backing',t=>{
 for(const kind of ['push','pop']){const f=fixture(t,{kind});f.space.unmap(STACK,8192n);f.backing=new M.SharedBacking(f.budget,8192n);f.space.mapShared(STACK,8192n,f.backing);f.alias=new M.GuestAddressSpace(f.budget,{virtualLimit:1n<<47n});f.alias.mapShared(STACK,8192n,f.backing);if(kind==='pop')f.space.write(f.sp,pack(f.value));const owned=f.budget.stats().ownedPayloadBytes;f.begin();assert.equal(f.request().status,0);f.spill();f.finish(0);assert.equal(f.budget.stats().ownedPayloadBytes,owned);assert.deepEqual(f.alias.read(kind==='push'?f.sp-8n:f.sp,8),pack(f.value));}
});
test('kernel static plans cannot override the byte-derived PUSH/POP register',t=>{
 globalThis.self=globalThis;for(const n of ['thread_core','web/linux-kernel'])vm.runInThisContext(fs.readFileSync(new URL('../../Sources/BetterJITLinux/Resources/linux/'+n+'.js',import.meta.url),'utf8'));
 const {Kernel}=LinuxBundle.require('./kernel.js'),cfg={guestMemory:'broker1',memoryABI:1,stepABI:3,coverageVersion:B.ABI.coverageVersion,stepHeaderBytes:96,memPages:33,memMaxPages:33,threadBase:65536,regArgs:0,callsViaDispatcher:false,maxInstructions:1,shared:true,ctx:256,stateSize:1024,ripOff:24,gregsOff:32,checkpoint:layout};
 for(const kind of ['push','pop'])for(const forged of [-1,0,16]){const space=new M.GuestAddressSpace(new M.BackingBudget(),{virtualLimit:1n<<47n}),p={...plan(kind,5),stackRegister:forged};space.mapAnonymous(RIP,4096n,3);space.write(RIP,p.instruction);space.protect(RIP,4096n,5);const k=new Kernel({state:new Uint8Array(1024),vfs:{},log:()=>{}},cfg),made=k.createSparseProcess({space,entryRip:RIP,plans:[p]});assert.equal(made.thread.sparse.plans.get(RIP).stackRegister,5);t.after(()=>{k.sparseBroker.unregister(made.thread.sparse.token);space.close();});}
});
