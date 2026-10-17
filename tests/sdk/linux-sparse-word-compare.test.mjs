// SPDX-License-Identifier: GPL-3.0-or-later
// Broker contracts with modeled post-state; actual FEX/Wasm has a separate host matrix.
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';
globalThis.self=globalThis;
for(const name of ['guest_memory.js','guest_memory_broker.js','thread_core.js','web/linux-kernel.js'])vm.runInThisContext(fs.readFileSync(new URL('../../Sources/BetterJITLinux/Resources/linux/'+name,import.meta.url),'utf8'));
const M=BetterJITGuestMemory,B=BetterJITGuestMemoryBroker,RIP=0x123400008000n,DATA=0x123456780000n;
const layout={version:1,cpu:{offset:256,size:1024,ripOffset:24,stackPointerOffset:64,generalRegistersOffset:32,parityRawOffset:16,auxiliaryRawOffset:20,nzcvOffset:248},lazyFlags:{offset:64,size:24},roundMode:{offset:112,size:4}};
const cfg={guestMemory:'broker1',memoryABI:1,stepABI:4,coverageVersion:28,stepHeaderBytes:96,memPages:33,memMaxPages:33,threadBase:65536,regArgs:0,callsViaDispatcher:false,maxInstructions:1,shared:true,ctx:256,stateSize:1024,ripOff:24,gregsOff:32,nzcvAddr:504,checkpoint:layout};
function plan(code=[0x66,0x83,0x78,6,0x80]){const instruction=Uint8Array.from(code);return{status:0,operation:8,width:2,rip:RIP,nextRip:RIP+BigInt(code.length),length:code.length,instruction,continuationKind:0,branchTarget:0n,continuations:[RIP+BigInt(code.length)]};}
function header(p){const b=new Uint8Array(96),v=new DataView(b.buffer);[0x31534a42,1,1,4,B.ABI.coverageVersion,0,p.operation,p.width].forEach((n,i)=>v.setUint32(i*4,n,true));v.setBigUint64(32,p.rip,true);v.setBigUint64(40,p.nextRip,true);v.setUint32(56,1,true);v.setUint32(60,p.length,true);b.set(p.instruction,64);v.setBigUint64(80,p.branchTarget,true);v.setUint32(88,p.continuationKind,true);return b;}
function fixture(t,{p=plan(),source=0x8000,address=DATA}={}){
 p={...p,wordCompareOperand:B.wordCompareOperand(p)};const budget=new M.BackingBudget(),space=new M.GuestAddressSpace(budget,{virtualLimit:1n<<47n}),memory=B.createInternalMemory(),broker=new B.GuestMemoryBroker(),token=broker.register(0,{space,memory,checkpointLayout:layout}),v=new DataView(memory.buffer),tb=B.ABI.threadBase,g=tb+288,q=new DataView(memory.buffer,tb+B.ABI.scratchOffset,128);let sequence=0;
 space.mapAnonymous(DATA,8192n,3);space.write(address,Uint8Array.of(source&255,source>>8));new Uint8Array(memory.buffer,tb+layout.cpu.offset,layout.cpu.size).forEach((_,i,a)=>a[i]=(i*31+17)&255);v.setBigUint64(g,address-6n,true);v.setBigUint64(tb+280,RIP,true);v.setUint32(tb+layout.lazyFlags.offset,0,true);v.setUint32(tb+layout.cpu.offset+248,0x20000000,true);
 const close=()=>{broker.unregister(token);space.close();};t.after(close);const snapshot=()=>['cpu','lazyFlags','roundMode'].map(n=>{const p=layout[n];return new Uint8Array(memory.buffer,tb+p.offset,p.size).slice();});
 const begin=(extra={})=>broker.beginInstruction(token,{...p,...extra});
 const request=(extra={})=>{const fields={magic:B.ABI.magic,version:1,sequence:++sequence,operation:1,width:2,access:1,address,rip:RIP,checkpoint:v.getBigUint64(tb+B.ABI.scratchOffset+B.FIELD.checkpoint,true),lease:token.generation,...extra};for(const[name,n]of Object.entries(fields))typeof n==='bigint'?q.setBigUint64(B.FIELD[name],n,true):q.setUint32(B.FIELD[name],n,true);return broker.dispatch(token,{lease:token.generation,sequence});};
 const start=extra=>{const checkpoint=begin(extra);q.setBigUint64(B.FIELD.checkpoint,checkpoint,true);return checkpoint;};
 const post=()=>{const imm=p.wordCompareOperand.immediate;v.setBigUint64(tb+280,p.nextRip,true);v.setUint32(tb+272,(source-imm)>>>0,true);v.setUint32(tb+276,imm&16?(~source)>>>0:source,true);v.setUint32(tb+64,1,true);v.setBigUint64(tb+72,BigInt(source)<<16n,true);v.setBigUint64(tb+80,BigInt(imm)<<16n,true);};
 const finish=status=>broker.finishInstruction(token,{status,nextRip:p.nextRip});return{p,budget,space,memory,broker,token,v,tb,g,q,snapshot,start,request,post,finish};
}
test('word CMP metadata derives signed immediates and all base/index REX forms; rejects expanded prefixes and register writes',()=>{
 let decoded=0;
 for(const rex of [0,...Array.from({length:8},(_,i)=>0x40+i)])for(const opcode of [0x81,0x83])for(const mod of [0,1,2])for(let rm=0;rm<8;rm++)for(const sib of rm===4?Array.from({length:256},(_,i)=>i):[0]){
  if(rm===4&&mod===0&&(sib&7)===5&&(rex&1))continue;
  const displacement=mod===1?1:mod===2||mod===0&&(rm===5||rm===4&&(sib&7)===5)?4:0,code=[0x66,...(rex?[rex]:[]),opcode,(mod<<6)|0x38|rm,...(rm===4?[sib]:[]),...Array(displacement).fill(0),...(opcode===0x83?[0x80]:[0,0x80])],p=plan(code),o=B.wordCompareOperand(p);
  assert.equal(o.immediate,opcode===0x83?0xff80:0x8000);assert.equal(o.length,code.length);assert(Object.isFrozen(o));assert.deepEqual(B.parseStepHeader(header(p)).wordCompareOperand,o);decoded++;
 }
 assert(decoded>10000);
 for(const code of [[0x66,0x83,0xf8,0],[0x66,0x80,0x38,0],[0x66,0x82,0x38,0],[0x66,0x48,0x83,0x38,0],[0x66,0x41,0x83,0x3c,0x25,0,0,0,0,0],[0x48,0x66,0x83,0x38,0],...[0xf0,0xf2,0xf3,0x64,0x65,0x67,0x66].map(x=>[x,0x66,0x83,0x38,0])])assert.throws(()=>B.wordCompareOperand(plan(code)),/metadata/);
 const p=plan();for(let n=0;n<p.length;n++)assert.throws(()=>B.wordCompareOperand(plan([...p.instruction.slice(0,n)])),/metadata/);
 for(const changes of [{width:4},{operation:1},{continuationKind:1},{branchTarget:RIP},{rip:1n<<47n},{nextRip:p.nextRip+1n},{length:99}])assert.throws(()=>B.wordCompareOperand({...p,...changes}),/metadata/);
 for(const coverage of [27,29]){const b=header(p);new DataView(b.buffer).setUint32(16,coverage,true);assert.throws(()=>B.parseStepHeader(b),/ABI/);}
});
test('word CMP BEGIN requires complete decoded operands and captures mutable caller metadata by value',t=>{
 for(const changes of [{wordCompareOperand:undefined},{wordCompareOperand:{...B.wordCompareOperand(plan()),base:16}},{wordCompareOperand:{...B.wordCompareOperand(plan()),immediate:65536}},{nextRip:RIP+99n}]){const f=fixture(t);assert.throws(()=>f.start(changes),/metadata/);}
 const f=fixture(t),operand={...f.p.wordCompareOperand};f.start({wordCompareOperand:operand});operand.base=15;operand.immediate=0;operand.displacement=0n;assert.equal(f.request().status,0);f.post();assert.equal(f.finish(0).rip,f.p.nextRip);
});
test('word CMP READ is bound to BEGIN address, width, RIP and checkpoint; refusals roll back without reading another address',t=>{
 for(const change of [{address:DATA+4096n},{width:4},{operation:2,access:2},{rip:RIP+1n},{checkpoint:999n}]){const f=fixture(t);f.space.protect(DATA+4096n,4096n,0);f.start();const before=f.snapshot(),mapped=f.space.read(DATA,4096);assert.equal(f.request(change).status,2);assert.equal(f.q.getUint32(B.FIELD.reason,true),B.REASON.CHECKPOINT);assert.equal(f.finish(2).rip,RIP);assert.deepEqual(f.snapshot(),before);assert.deepEqual(f.space.read(DATA,4096),mapped);}
});
test('word CMP accepts only exact word flags, shifted lazy operands and unchanged GPR/round/unused state',t=>{
 for(const source of [0,1,15,16,0x7fff,0x8000,0xffff])for(const imm of [0,1,15,16,0x80,0xff]){const f=fixture(t,{source,p:plan([0x66,0x83,0x78,6,imm])});f.space.protect(DATA,8192n,1);f.start();const before=f.snapshot(),bytes=f.space.read(DATA,8192),accounting=f.budget.stats();assert.equal(f.request().status,0);f.post();assert.equal(f.finish(0).status,0);assert.deepEqual(f.space.read(DATA,8192),bytes);assert.deepEqual(f.budget.stats(),accounting);assert.deepEqual(f.snapshot()[2],before[2]);}
});
test('word CMP FINISH rejects semantic flag aliases, wrong descriptor kinds, high operand bits and unrelated writes',t=>{
 for(const name of ['kind','materialized-kind','FA-high','FB-high','PF-high','AF-high','NZCV-unused','padding','GPR','round','RIP']){const f=fixture(t);f.start();assert.equal(f.request().status,0);f.post();const at={kind:64,'materialized-kind':64,'FA-high':76,'FB-high':84,'PF-high':274,'AF-high':278,'NZCV-unused':504,padding:68,GPR:296,round:112,RIP:280}[name];if(name==='materialized-kind')f.v.setUint32(f.tb+at,0,true);else f.v.setUint8(f.tb+at,f.v.getUint8(f.tb+at)^1);assert.throws(()=>f.finish(0),B.BrokerInvariantError);}
});
test('word CMP late read protection fault preserves every checkpoint span; an unowned FAULT cannot restore a forged state',t=>{
 const f=fixture(t,{address:DATA+4095n});f.start();const before=f.snapshot();f.space.protect(DATA+4096n,4096n,0);assert.equal(f.request().status,1);assert.equal(f.q.getBigUint64(B.FIELD.faultAddress,true),DATA+4096n);assert.equal(f.finish(1).rip,RIP);assert.deepEqual(f.snapshot(),before);
 const other=fixture(t);other.start();assert.throws(()=>other.finish(1),/typed memory fault/);
});
test('kernel static plans rederive word CMP metadata from executable bytes and pass the owned operand at BEGIN',t=>{
 const {Kernel,SLOT_BASE,SLOT_SIZE}=LinuxBundle.require('./kernel.js'),p=plan(),budget=new M.BackingBudget(),space=new M.GuestAddressSpace(budget,{virtualLimit:1n<<47n});space.mapAnonymous(RIP,4096n,3);space.write(RIP,p.instruction);space.protect(RIP,4096n,5);space.mapAnonymous(DATA,4096n,3);
 const k=new Kernel({state:new Uint8Array(1024),vfs:{},log:()=>{}},cfg),made=k.createSparseProcess({space,entryRip:RIP,plans:[{...p,wordCompareOperand:{base:15,immediate:999}}]}),thread=made.thread,s=thread.sparse;t.after(()=>{k.sparseBroker.unregister(s.token);space.close();});
 assert.deepEqual(k.sparsePlan(thread).wordCompareOperand,B.wordCompareOperand(p));s.view.setBigUint64(thread.tb+288,DATA-6n,true);const base=(SLOT_BASE+thread.slot*SLOT_SIZE)>>3;
 for(const[offset,value]of [[1,BigInt(B.ABI.instructionBoundary)],[2,s.token.generation],[3,1n],[4,1n],[5,0n]])k.k64[base+offset]=value;
 assert.doesNotThrow(()=>k.sparseRequest(thread));assert(s.view.getBigUint64(thread.tb+B.ABI.scratchOffset+B.FIELD.checkpoint,true)>0n);
});
