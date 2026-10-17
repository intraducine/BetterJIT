// SPDX-License-Identifier: GPL-3.0-or-later
// Portable broker controls; actual FEX and hardware evidence are separate.
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';
globalThis.self=globalThis;for(const n of ['guest_memory','guest_memory_broker','thread_core','web/linux-kernel'])vm.runInThisContext(fs.readFileSync(new URL('../../Sources/BetterJITLinux/Resources/linux/'+n+'.js',import.meta.url),'utf8'));
const D=JSON.parse(fs.readFileSync(new URL('./linux-host/sparse-vector-moves-cases.json',import.meta.url))),M=BetterJITGuestMemory,B=BetterJITGuestMemoryBroker,RIP=0x123400008000n;
const layout={version:1,cpu:{offset:256,size:1024,ripOffset:24,stackPointerOffset:64,generalRegistersOffset:32,parityRawOffset:16,auxiliaryRawOffset:20,nzcvOffset:248,xmmRegisters:{version:1,offset:512,stride:16,count:16,bytes:16}},lazyFlags:{offset:64,size:24},roundMode:{offset:112,size:4}};
const encoding=(f,rex,m)=>[...(f.prefix?[f.prefix]:[]),...(rex===undefined?[]:[rex]),15,f.opcode,0xc0|m];
function plan(code){const p={status:0,operation:6,width:0,rip:RIP,nextRip:RIP+BigInt(code.length),length:code.length,instruction:Uint8Array.from(code),continuationKind:0,branchTarget:0n};return{...p,continuations:B.instructionContinuations(p),vectorMoveOperand:B.vectorMoveOperand(p)};}
function header(p){const b=new Uint8Array(96),v=new DataView(b.buffer);[0x31534a42,1,1,4,B.ABI.coverageVersion,0,p.operation,p.width].forEach((n,i)=>v.setUint32(i*4,n,true));v.setBigUint64(32,p.rip,true);v.setBigUint64(40,p.nextRip,true);v.setUint32(56,1,true);v.setUint32(60,p.length,true);b.set(p.instruction,64);return b;}
function fixture(t,code=[0x66,0x48,15,0x6e,0xc7],L=structuredClone(layout)){
 const p=plan(code),memory=B.createInternalMemory(),v=new DataView(memory.buffer),tb=B.ABI.threadBase,budget=new M.BackingBudget(),space=new M.GuestAddressSpace(budget),broker=new B.GuestMemoryBroker(),token=broker.register(0,{space,memory,checkpointLayout:L});
 for(const n of ['cpu','lazyFlags','roundMode']){const s=L[n],a=new Uint8Array(memory.buffer,tb+s.offset,s.size);for(let i=0;i<a.length;i++)a[i]=(i*37+19)&255;}v.setBigUint64(tb+280,RIP,true);
 const snapshot=()=>['cpu','lazyFlags','roundMode'].map(n=>{const p=L[n];return new Uint8Array(memory.buffer,tb+p.offset,p.size).slice();});let saved;
 const begin=(extra={})=>{const n=broker.beginInstruction(token,{...p,...extra});saved=snapshot();return n;},finish=status=>broker.finishInstruction(token,{status,nextRip:p.nextRip});
 function post(){const u=p.vectorMoveOperand,g=32,x=512,dest=u.kind===2?g+u.register*8:x+u.register*16,src=u.kind===1?g+u.source*8:x+u.source*16,a=saved[0].slice();if(u.kind!==5)a.fill(0,dest,dest+(u.kind===2?8:16));a.set(saved[0].subarray(src,src+u.width),dest);new DataView(a.buffer).setBigUint64(24,p.nextRip,true);new Uint8Array(memory.buffer,tb+256,1024).set(a);}
 t.after(()=>{broker.unregister(token);space.close();assert.equal(budget.stats().ownedPayloadBytes,0);});return{p,memory,v,tb,budget,space,broker,token,snapshot,begin,finish,post,L};
}
test('vector movement independently decodes all 21760 legacy prefix/register aliases',()=>{
 let count=0;for(const f of D.forms)for(const rex of [undefined,...Array.from({length:16},(_,i)=>0x40+i)])for(let m=0;m<64;m++){
  const c=encoding(f,rex,m),p=plan(c),r=(m>>3)+((rex&4)?8:0),rm=(m&7)+((rex&1)?8:0);assert.deepEqual(p.vectorMoveOperand,{kind:f.kind,width:f.width||(rex&8?8:4),register:f.reverse?rm:r,source:f.reverse?r:rm,length:c.length});assert(Object.isFrozen(p.vectorMoveOperand));assert.deepEqual(B.parseStepHeader(header(p)).vectorMoveOperand,p.vectorMoveOperand);count++;
 }assert.equal(count,21760);
});
test('vector decoder refuses truncated/memory/MMX/VEX/arithmetic and invalid wire metadata',()=>{
 for(const f of D.forms){const c=encoding(f,0x4f,1);for(let n=0;n<c.length;n++)assert.throws(()=>plan(c.slice(0,n)),/metadata/);for(const b of [[...(f.prefix?[f.prefix]:[]),15,f.opcode,0],[0x67,...c],[0xf0,...c],[0x40,...c],[0x66,...(f.prefix?[]:[0x66]),...c]])assert.throws(()=>plan(b),/metadata/);}
 for(const b of [[15,0x6e,0xc0],[15,0x7e,0xc0],[0xc5,0xf9,0x6e,0xc0],[0x66,15,0xef,0xc0],[0xf2,15,0x6f,0xc0]])assert.throws(()=>plan(b),/metadata/);
 const p=plan([0x66,0x48,15,0x6e,0xc7]);for(const c of [{operation:0},{width:16},{continuationKind:1},{branchTarget:RIP},{nextRip:RIP+99n},{length:3},{rip:1n<<47n}])assert.throws(()=>B.vectorMoveOperand({...p,...c}),/metadata/);
});
test('optional XMM descriptor is versioned, bounded, aligned and disjoint from scalar state',t=>{
 for(const change of [{version:2},{stride:32},{count:8},{bytes:8},{offset:513},{offset:-16},{offset:1024},{offset:16},{offset:32},{offset:240},{offset:NaN}]){const L=structuredClone(layout);Object.assign(L.cpu.xmmRegisters,change);assert.throws(()=>fixture(t,undefined,L),/XMM/);}
 const L=structuredClone(layout);delete L.cpu.xmmRegisters;const f=fixture(t,undefined,L);assert.throws(()=>f.begin(),/metadata/);const g=fixture(t);g.L.cpu.xmmRegisters.offset=0;g.L.cpu.xmmRegisters.stride=32;g.begin();g.post();assert.equal(g.finish(0).status,0);
});
test('all movement widths, self aliases and high slots preserve every undeclared checkpoint byte',t=>{
 for(const f of D.forms)for(const rex of [undefined,0x48,0x4f])for(const m of [0,1,63]){const x=fixture(t,encoding(f,rex,m));x.begin();const before=x.snapshot();x.post();assert.equal(x.finish(0).status,0);assert.deepEqual(x.snapshot()[1],before[1]);assert.deepEqual(x.snapshot()[2],before[2]);assert.equal(x.broker.stats().requests,0);}
});
test('vector BEGIN copies descriptors and rejects incompatible scalar profiles',t=>{
 for(const c of [{kind:0},{kind:6},{width:2},{register:16},{source:-1},{source:16},{length:6}]){const f=fixture(t);assert.throws(()=>f.begin({vectorMoveOperand:{...f.p.vectorMoveOperand,...c}}),/metadata/);}
 for(const c of [{unaryOperand:{kind:2,width:8,register:0,shift:0,length:3}},{conditionOperand:{code:0,width:8,register:0,source:0,length:3}},{wordCompareOperand:{}},{wordLogicalOperand:{}},{width:8},{operation:0}]){const f=fixture(t);assert.throws(()=>f.begin(c),/metadata|admission/);}
 const f=fixture(t),o={...f.p.vectorMoveOperand};f.begin({vectorMoveOperand:o});o.source=15;o.register=15;o.width=4;f.post();assert.equal(f.finish(0).status,0);
});
test('vector FINISH rejects corruption in destination, flags, other slots, upper halves and padding',t=>{
 for(const form of D.forms)for(const at of [0,16,20,32,120,248,256,511,512,520,528,640,768,1023,'lazy','round']){
  const f=fixture(t,encoding(form,0x48,1));f.begin();f.post();const address=at==='lazy'?f.tb+64:at==='round'?f.tb+112:f.tb+256+at;f.v.setUint8(address,f.v.getUint8(address)^1);assert.throws(()=>f.finish(0),B.BrokerInvariantError);
 }
});
test('vector unsupported completion restores the full owned checkpoint without guest data access',t=>{
 for(const form of D.forms){const f=fixture(t,encoding(form,0x4f,63));f.begin();const before=f.snapshot();f.post();assert.equal(f.finish(2).rip,RIP);assert.deepEqual(f.snapshot(),before);assert.equal(f.broker.stats().requests,0);}
});
test('kernel rederives vector operands from executable bytes and ignores supplied descriptors',t=>{
 const {Kernel}=LinuxBundle.require('./kernel.js');for(const form of D.forms){const p=plan(encoding(form,0x4f,1)),budget=new M.BackingBudget(),space=new M.GuestAddressSpace(budget,{virtualLimit:1n<<47n});space.mapAnonymous(RIP,4096n,3);space.write(RIP,p.instruction);space.protect(RIP,4096n,5);const cfg={guestMemory:'broker1',memoryABI:1,stepABI:4,coverageVersion:B.ABI.coverageVersion,stepHeaderBytes:96,memPages:33,memMaxPages:33,threadBase:65536,regArgs:0,callsViaDispatcher:false,maxInstructions:1,shared:true,ctx:256,stateSize:1024,ripOff:24,gregsOff:32,nzcvAddr:504,xmmOff:512,checkpoint:layout},k=new Kernel({state:new Uint8Array(1024),vfs:{},log:()=>{}},cfg),made=k.createSparseProcess({space,entryRip:RIP,plans:[{...p,vectorMoveOperand:{kind:2,width:1,register:15,source:0}}]}),s=made.thread.sparse;t.after(()=>{k.sparseBroker.unregister(s.token);space.close();});assert.deepEqual(k.sparsePlan(made.thread).vectorMoveOperand,p.vectorMoveOperand);}
});
test('forged vector memory RPC cannot change guest bytes/accounting; an unowned FAULT is fatal',t=>{
 const f=fixture(t),address=0x10000n;f.space.mapAnonymous(address,4096n,3);f.space.write(address,Uint8Array.of(0x5a));const generation=f.begin(),before=f.snapshot(),bytes=f.space.read(address,16),account=f.budget.stats(),q=new DataView(f.memory.buffer,f.tb+B.ABI.scratchOffset,128);
 for(const [name,value]of Object.entries({magic:B.ABI.magic,version:1,sequence:1,operation:2,width:16,access:2,address,rip:RIP,checkpoint:generation,lease:f.token.generation,operand0:0xffn}))typeof value==='bigint'?q.setBigUint64(B.FIELD[name],value,true):q.setUint32(B.FIELD[name],value,true);
 assert.equal(f.broker.dispatch(f.token,{lease:f.token.generation,sequence:1}).status,2);assert.equal(f.finish(2).rip,RIP);assert.deepEqual(f.snapshot(),before);assert.deepEqual(f.space.read(address,16),bytes);assert.deepEqual(f.budget.stats(),account);const other=fixture(t);other.begin();assert.throws(()=>other.finish(1),/typed memory fault/);
});
