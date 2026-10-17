// SPDX-License-Identifier: GPL-3.0-or-later
// Portable broker ownership controls; actual FEX/hardware tests are separate.
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';
globalThis.self=globalThis;
for(const n of ['guest_memory','guest_memory_broker','thread_core','web/linux-kernel'])vm.runInThisContext(fs.readFileSync(new URL('../../Sources/BetterJITLinux/Resources/linux/'+n+'.js',import.meta.url),'utf8'));
const D=JSON.parse(fs.readFileSync(new URL('./linux-host/sparse-unary-cases.json',import.meta.url))),M=BetterJITGuestMemory,B=BetterJITGuestMemoryBroker,RIP=0x123400008000n;
const layout={version:1,cpu:{offset:256,size:1024,ripOffset:24,stackPointerOffset:64,generalRegistersOffset:32,parityRawOffset:16,auxiliaryRawOffset:20,nzcvOffset:248},lazyFlags:{offset:64,size:24},roundMode:{offset:112,size:4}};
function plan(code){const p={status:0,operation:6,width:0,rip:RIP,nextRip:RIP+BigInt(code.length),length:code.length,instruction:Uint8Array.from(code),continuationKind:0,branchTarget:0n};return{...p,continuations:B.instructionContinuations(p),unaryOperand:B.unaryOperand(p)};}
function header(p){const b=new Uint8Array(96),v=new DataView(b.buffer);[0x31534a42,1,1,4,B.ABI.coverageVersion,0,p.operation,p.width].forEach((n,i)=>v.setUint32(i*4,n,true));v.setBigUint64(32,p.rip,true);v.setBigUint64(40,p.nextRip,true);v.setUint32(56,1,true);v.setUint32(60,p.length,true);b.set(p.instruction,64);return b;}
const posts=[
 {code:[0x49,0xf7,0xdc],input:0x8000000000000000n,result:0x8000000000000000n,kind:2,fa:0n,fb:0x8000000000000000n,pf:0,af:0},
 {code:[0x66,0xf7,0xd8],input:0x123456789abc8000n,result:0x123456789abc8000n,kind:1,fa:0n,fb:0x80000000n,pf:0x65438000,af:0x9abc8000},
 {code:[0xf6,0xdc],input:0x12345678abcd8001n,result:0x12345678abcd8001n,kind:1,fa:0n,fb:0x80000000n,pf:0xff543280,af:0xabcd80},
 {code:[0xf7,0xd0],input:0x1234567880000000n,result:0x7fffffffn},
 {code:[0x66,0xf7,0xd0],input:0x123456789abc8000n,result:0x123456789abc7fffn},
 {code:[0xf6,0xd4],input:0x123456789abc8001n,result:0x123456789abc7f01n},
 {code:[0xff,0xc0],input:0xdeadbeef7fffffffn,result:0x80000000n,kind:9,fa:0x7fffffffn,fb:1n,pf:0x80000000,af:0x7fffffff,nzcv:0,carry:true},
 {code:[0x66,0xff,0xc0],input:0x123456789abcffffn,result:0x123456789abc0000n,kind:0,fa:0xffff0000n,fb:0x10000n,pf:0x10000,af:0xffff,nzcv:0x40000000,carry:true},
 {code:[0xfe,0xc4],input:0x123456789abc7f01n,result:0x123456789abc8001n,kind:0,fa:0x7f000000n,fb:0x1000000n,pf:0x80,af:0x7f,nzcv:0x90000000,carry:true},
 {code:[0x48,0xff,0xc8],input:0x8000000000000000n,result:0x7fffffffffffffffn,kind:8,fa:0x8000000000000000n,fb:1n,pf:0xffffffff,af:0,nzcv:0x20000000}
];
function fixture(t,row=posts[0]){const p=plan(row.code),memory=B.createInternalMemory(),v=new DataView(memory.buffer),tb=B.ABI.threadBase,g=tb+288,budget=new M.BackingBudget(),space=new M.GuestAddressSpace(budget),broker=new B.GuestMemoryBroker(),token=broker.register(0,{space,memory,checkpointLayout:layout});
 new Uint8Array(memory.buffer,tb+256,1024).forEach((_,i,a)=>a[i]=(i*37+19)&255);for(let r=0;r<16;r++)v.setBigUint64(g+r*8,r===p.unaryOperand.register?row.input:0xfedcba9876540000n+BigInt(r),true);v.setBigUint64(tb+280,RIP,true);v.setUint32(tb+64,0,true);v.setUint32(tb+68,0x98765432,true);v.setBigUint64(tb+72,0x123456789abcdef0n,true);v.setBigUint64(tb+80,0xfedcba9876543210n,true);v.setUint32(tb+504,row.carry?0:0x20000000,true);v.setUint32(tb+112,3,true);
 const snapshot=()=>['cpu','lazyFlags','roundMode'].map(n=>{const p=layout[n];return new Uint8Array(memory.buffer,tb+p.offset,p.size).slice();});const begin=(extra={})=>broker.beginInstruction(token,{...p,...extra}),finish=status=>broker.finishInstruction(token,{status,nextRip:p.nextRip});
 const post=()=>{v.setBigUint64(tb+280,p.nextRip,true);v.setBigUint64(g+p.unaryOperand.register*8,row.result,true);if(row.kind!==undefined){v.setUint32(tb+64,row.kind,true);v.setBigUint64(tb+72,row.fa,true);v.setBigUint64(tb+80,row.fb,true);v.setUint32(tb+272,row.pf,true);v.setUint32(tb+276,row.af,true);}if(row.nzcv!==undefined)v.setUint32(tb+504,row.nzcv,true);};
 t.after(()=>{broker.unregister(token);space.close();assert.equal(budget.stats().ownedPayloadBytes,0);});return{p,memory,v,tb,g,budget,space,broker,token,snapshot,begin,finish,post};}
test('unary metadata independently derives all widths, GPR/high-byte and ignored prefix/REX aliases',()=>{
 let count=0;for(const op of D.operations)for(const byte of [false,true])for(const word of [false,true])for(const rex of [undefined,...Array.from({length:16},(_,i)=>0x40+i)])for(let rm=0;rm<8;rm++){
  const code=[...(word?[0x66]:[]),...(rex===undefined?[]:[rex]),byte?op.byteOpcode:op.wideOpcode,0xc0|op.group<<3|rm],p=plan(code),shift=byte&&rex===undefined&&rm>=4?8:0;
  assert.deepEqual(p.unaryOperand,{kind:op.kind,width:byte?1:rex&8?8:word?2:4,shift,register:shift?rm-4:rm+(rex&1?8:0),length:code.length});assert.deepEqual(B.parseStepHeader(header(p)).unaryOperand,p.unaryOperand);assert(Object.isFrozen(p.unaryOperand));count++;
 }assert.equal(count,2176);
});
test('unary metadata rejects memory effects, other groups, prefixes, truncation and forged wire fields',()=>{
 for(const op of D.operations)for(const code of [[op.byteOpcode,op.group<<3],[op.wideOpcode,op.group<<3],[0x67,op.wideOpcode,0xc0|op.group<<3],[0xf0,op.wideOpcode,0xc0|op.group<<3],[0xf3,op.wideOpcode,0xc0|op.group<<3],[0x40,0x66,op.wideOpcode,0xc0|op.group<<3],[0x66,0x66,op.wideOpcode,0xc0|op.group<<3]])assert.throws(()=>plan(code),/metadata/);
 const p=plan([0x49,0xf7,0xdc]);for(let n=0;n<p.length;n++)assert.throws(()=>plan([...p.instruction.slice(0,n)]),/metadata/);
 for(const c of [{operation:0},{width:8},{continuationKind:1},{branchTarget:RIP},{nextRip:RIP+99n},{length:2},{rip:1n<<47n}])assert.throws(()=>B.unaryOperand({...p,...c}),/metadata/);
});
test('unary full checkpoint contracts cover zero-extension, high-byte merging, signed minima and preserved carry',t=>{
 for(const row of posts){const f=fixture(t,row);f.begin();f.post();assert.equal(f.finish(0).status,0);assert.equal(f.broker.stats().requests,0);}
});
test('NOT preserves every flag byte and all lazy/rounding bytes, including an opaque old descriptor',t=>{
 for(const row of posts.filter(r=>r.kind===undefined)){const f=fixture(t,row);f.v.setUint32(f.tb+64,0xfedcba98,true);f.begin();const before=f.snapshot();f.post();f.finish(0);assert.deepEqual(f.snapshot()[1],before[1]);assert.deepEqual(f.snapshot()[2],before[2]);}
});
test('unary BEGIN copies its operand and rejects incompatible or malformed contracts',t=>{
 for(const change of [{kind:0},{width:3},{shift:1},{register:16},{length:5}]){const f=fixture(t);assert.throws(()=>f.begin({unaryOperand:{...f.p.unaryOperand,...change}}),/metadata/);}
 const f=fixture(t),o={...f.p.unaryOperand};f.begin({unaryOperand:o});o.register=0;o.kind=2;o.width=1;f.post();assert.equal(f.finish(0).status,0);
 const c=fixture(t);assert.throws(()=>c.begin({wordLogicalOperand:{register:12,kind:1,mask:1,length:3}}),/metadata/);
});
test('unary FINISH rejects altered results, upper bits, flags, padding, rounding and unrelated GPRs',t=>{
 for(const row of posts)for(const field of ['result','upper','PF','AF','NZCV','kind','FA','FB','padding','round','unrelated']){const f=fixture(t,row);f.begin();f.post();const at={result:f.g+f.p.unaryOperand.register*8,upper:f.g+f.p.unaryOperand.register*8+7,PF:f.tb+272,AF:f.tb+276,NZCV:f.tb+504,kind:f.tb+64,FA:f.tb+72,FB:f.tb+80,padding:f.tb+68,round:f.tb+112,unrelated:f.g+((f.p.unaryOperand.register+1)%16)*8}[field];f.v.setUint8(at,f.v.getUint8(at)^1);assert.throws(()=>f.finish(0),B.BrokerInvariantError);}
});
test('unary unsupported completion restores all owned spans without guest data access',t=>{
 for(const row of posts){const f=fixture(t,row);f.begin();const before=f.snapshot();f.post();assert.equal(f.finish(2).rip,RIP);assert.deepEqual(f.snapshot(),before);assert.equal(f.broker.stats().requests,0);}
});
test('kernel ignores caller unary descriptors and rederives them from executable bytes',t=>{
 const {Kernel}=LinuxBundle.require('./kernel.js');for(const row of posts){const p=plan(row.code),budget=new M.BackingBudget(),space=new M.GuestAddressSpace(budget,{virtualLimit:1n<<47n});space.mapAnonymous(RIP,4096n,3);space.write(RIP,p.instruction);space.protect(RIP,4096n,5);const cfg={guestMemory:'broker1',memoryABI:1,stepABI:4,coverageVersion:B.ABI.coverageVersion,stepHeaderBytes:96,memPages:33,memMaxPages:33,threadBase:65536,regArgs:0,callsViaDispatcher:false,maxInstructions:1,shared:true,ctx:256,stateSize:1024,ripOff:24,gregsOff:32,nzcvAddr:504,checkpoint:layout},k=new Kernel({state:new Uint8Array(1024),vfs:{},log:()=>{}},cfg),made=k.createSparseProcess({space,entryRip:RIP,plans:[{...p,unaryOperand:{kind:2,register:15,width:1}}]}),s=made.thread.sparse;t.after(()=>{k.sparseBroker.unregister(s.token);space.close();});assert.deepEqual(k.sparsePlan(made.thread).unaryOperand,p.unaryOperand);}
});
test('a forged unary memory request cannot publish storage and an unowned FAULT is fatal',t=>{
 const f=fixture(t),address=0x10000n;f.space.mapAnonymous(address,4096n,3);f.space.write(address,Uint8Array.of(0x5a));const generation=f.begin(),before=f.snapshot(),bytes=f.space.read(address,16),account=f.budget.stats(),q=new DataView(f.memory.buffer,f.tb+B.ABI.scratchOffset,128);
 for(const [name,value]of Object.entries({magic:B.ABI.magic,version:1,sequence:1,operation:2,width:1,access:2,address,rip:RIP,checkpoint:generation,lease:f.token.generation,operand0:0xffn}))typeof value==='bigint'?q.setBigUint64(B.FIELD[name],value,true):q.setUint32(B.FIELD[name],value,true);
 assert.equal(f.broker.dispatch(f.token,{lease:f.token.generation,sequence:1}).status,2);assert.equal(f.finish(2).rip,RIP);assert.deepEqual(f.snapshot(),before);assert.deepEqual(f.space.read(address,16),bytes);assert.deepEqual(f.budget.stats(),account);
 const other=fixture(t);other.begin();assert.throws(()=>other.finish(1),/typed memory fault/);
});
