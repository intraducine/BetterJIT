// SPDX-License-Identifier: GPL-3.0-or-later
// Broker ownership and mutation controls; actual FEX/native execution is separate.
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';
globalThis.self=globalThis;
for(const n of ['guest_memory','guest_memory_broker','thread_core','web/linux-kernel'])vm.runInThisContext(fs.readFileSync(new URL('../../Sources/BetterJITLinux/Resources/linux/'+n+'.js',import.meta.url),'utf8'));
const M=BetterJITGuestMemory,B=BetterJITGuestMemoryBroker,RIP=0x123400008000n,DATA=0x123456780000n;
const layout={version:1,cpu:{offset:256,size:1024,ripOffset:24,stackPointerOffset:64,generalRegistersOffset:32,parityRawOffset:16,auxiliaryRawOffset:20,nzcvOffset:248},lazyFlags:{offset:64,size:24},roundMode:{offset:112,size:4}};
function plan(code,operation=6,width=0){const instruction=Uint8Array.from(code),nextRip=RIP+BigInt(code.length),branch=operation===7,near=code.length===6,p={status:0,operation,width,rip:RIP,nextRip,length:code.length,instruction,continuationKind:branch?2:0,branchTarget:branch?nextRip+BigInt(near?new DataView(instruction.buffer).getInt32(2,true):(code[1]<<24)>>24):0n};return{...p,continuations:B.instructionContinuations(p),...B.scalarOperands(p)};}
function header(p){const b=new Uint8Array(96),v=new DataView(b.buffer);[0x31534a42,1,1,4,B.ABI.coverageVersion,0,p.operation,p.width].forEach((n,i)=>v.setUint32(i*4,n,true));v.setBigUint64(32,p.rip,true);v.setBigUint64(40,p.nextRip,true);v.setUint32(56,1,true);v.setUint32(60,p.length,true);b.set(p.instruction,64);v.setBigUint64(80,p.branchTarget,true);v.setUint32(88,p.continuationKind,true);return b;}
function fixture(t,p){const memory=B.createInternalMemory(),v=new DataView(memory.buffer),tb=B.ABI.threadBase,budget=new M.BackingBudget(),space=new M.GuestAddressSpace(budget,{virtualLimit:1n<<47n}),broker=new B.GuestMemoryBroker(),token=broker.register(0,{space,memory,checkpointLayout:layout}),g=tb+288;space.mapAnonymous(DATA,8192n,3);let sequence=0;new Uint8Array(memory.buffer,tb+256,1024).forEach((_,i,a)=>a[i]=(i*31+17)&255);v.setBigUint64(tb+280,RIP,true);v.setUint32(tb+64,0,true);v.setBigUint64(tb+72,0x123456789abcdef0n,true);v.setBigUint64(tb+80,0xfedcba9876543210n,true);v.setUint32(tb+504,0x20000000,true);v.setUint32(tb+272,0,true);
 t.after(()=>{broker.unregister(token);space.close();assert.equal(budget.stats().ownedPayloadBytes,0);});
 const snapshot=()=>['cpu','lazyFlags','roundMode'].map(n=>{const p=layout[n];return new Uint8Array(memory.buffer,tb+p.offset,p.size).slice();});
 const begin=(extra={})=>broker.beginInstruction(token,{...p,...extra}),finish=(status=0,nextRip=p.nextRip)=>broker.finishInstruction(token,{status,nextRip});
 const read=(address,checkpoint)=>{const q=new DataView(memory.buffer,tb+B.ABI.scratchOffset,128);for(const [k,n]of Object.entries({magic:B.ABI.magic,version:1,sequence:++sequence,operation:1,width:2,access:1,address,rip:RIP,checkpoint,lease:token.generation}))typeof n==='bigint'?q.setBigUint64(B.FIELD[k],n,true):q.setUint32(B.FIELD[k],n,true);return broker.dispatch(token,{lease:token.generation,sequence});};
 return{p,memory,v,tb,g,budget,space,broker,token,snapshot,begin,finish,read};}
function cmpPost(f,left,right,immediate){const{v,tb,p}=f;v.setBigUint64(tb+280,p.nextRip,true);v.setUint32(tb+272,Number(BigInt.asUintN(32,left-right)),true);v.setUint32(tb+276,Number(BigInt.asUintN(32,immediate===undefined?left^right:immediate&16?~left:left)),true);v.setUint32(tb+64,1,true);v.setBigUint64(tb+72,(left&65535n)<<16n,true);v.setBigUint64(tb+80,(right&65535n)<<16n,true);}
const truth=(cc,n,p)=>{const c=!(n&0x20000000),z=!!(n&0x40000000),s=!!(n&0x80000000),o=!!(n&0x10000000),even=[...(p&255).toString(2)].filter(x=>x==='1').length%2===0;return[o,!o,c,!c,z,!z,c||z,!c&&!z,s,!s,even,!even,s!==o,s===o,z||s!==o,!z&&s===o][cc];};
test('all word CMP register pairs and directions derive exact operand roles from bytes',()=>{
 for(const op of [0x39,0x3b])for(let a=0;a<16;a++)for(let b=0;b<16;b++){const rex=(a>=8?1:0)|(b>=8?4:0),p=plan([0x66,...(rex?[0x40|rex]:[]),op,0xc0|(b&7)<<3|(a&7)]),o=p.wordCompareOperand;assert.equal(o.kind,3);assert.equal(o.leftRegister,op===0x39?a:b);assert.equal(o.rightRegister,op===0x39?b:a);assert.deepEqual(B.parseStepHeader(header(p)).wordCompareOperand,o);}
 for(const code of [[0x66,0x3d,0,0x80],[0x66,0x41,0x83,0xff,0x80],[0x66,0x39,0x48,6],[0x66,0x3b,0x48,6]]){const p=plan(code,code[1]===0x39||code[1]===0x3b?8:6,code[1]===0x39||code[1]===0x3b?2:0);assert.deepEqual(B.parseStepHeader(header(p)).wordCompareOperand,p.wordCompareOperand);}
 for(const code of [[0x66,0x48,0x39,0xc8],[0x67,0x66,0x39,0xc8],[0x66,0x39],[0x66,0x3d,0],[0x66,0x83,0xf8,0,0]])assert.throws(()=>B.wordCompareOperand({instruction:Uint8Array.from(code)}));
});
test('register CMP owns full low-32 PF/AF, masked word NZCV operands and all unrelated state',t=>{
 for(const[left,right]of [[0x12345678aabbffffn,0x87654321ffff0001n],[0x8000n,0x7fffn],[0n,0n]])for(const code of [[0x66,0x39,0xc8],[0x66,0x3b,0xc1]]){const f=fixture(t,plan(code));f.v.setBigUint64(f.g,left,true);f.v.setBigUint64(f.g+8,right,true);f.begin();cmpPost(f,left,right);assert.equal(f.finish().status,0);}
 for(const imm of [0,16,0x80]){const f=fixture(t,plan([0x66,0x83,0xf8,imm])),left=0x12345678abcdef01n,right=BigInt(imm&128?imm|0xff00:imm);f.v.setBigUint64(f.g,left,true);const o={...f.p.wordCompareOperand};f.begin({wordCompareOperand:o});o.leftRegister=15;o.immediate=0;cmpPost(f,left,right,Number(right));assert.equal(f.finish().status,0);}
});
test('both memory/register CMP directions bind their sole read and roll back cross-page faults',t=>{
 for(const op of [0x39,0x3b]){const f=fixture(t,plan([0x66,op,0x48,6],8,2));f.v.setBigUint64(f.g,DATA+4089n,true);f.v.setBigUint64(f.g+8,0x123456789abc8000n,true);f.space.write(DATA+4095n,Uint8Array.of(0xff));f.space.protect(DATA+4096n,4096n,0);const checkpoint=f.begin(),before=f.snapshot(),bytes=f.space.read(DATA,4096),account=f.budget.stats();assert.equal(f.read(DATA+4095n,checkpoint).status,1);assert.equal(f.finish(1).rip,RIP);assert.deepEqual(f.snapshot(),before);assert.deepEqual(f.space.read(DATA,4096),bytes);assert.deepEqual(f.budget.stats(),account);}
});
test('word CMP rejects changed operands, flags, padding and unrelated state at FINISH',t=>{
 for(const at of [64,72,80,272,276,504,68,296,112]){const f=fixture(t,plan([0x66,0x39,0xc8]));f.v.setBigUint64(f.g,0x89abcdefn,true);f.v.setBigUint64(f.g+8,0x12345678n,true);f.begin();cmpPost(f,0x89abcdefn,0x12345678n);f.v.setUint8(f.tb+at,f.v.getUint8(f.tb+at)^1);assert.throws(()=>f.finish(),B.BrokerInvariantError);}
});
test('word logical decoding owns signed masks, accumulator forms and every selected GPR',()=>{
 for(const group of [1,4,6])for(let r=0;r<16;r++)for(const alias of [0,2,4,6])for(const op of [0x81,0x83]){const rex=(r>=8?1:0)|alias,p=plan([0x66,...(rex?[0x40|rex]:[]),op,0xc0|group<<3|(r&7),...(op===0x83?[0x80]:[0,0x80])]);assert.equal(p.wordLogicalOperand.register,r);assert.equal(p.wordLogicalOperand.mask,op===0x83?0xff80:0x8000);assert.deepEqual(B.parseStepHeader(header(p)).wordLogicalOperand,p.wordLogicalOperand);}
 for(const op of [0x0d,0x25,0x35])assert.equal(plan([0x66,op,0xff,0xff]).wordLogicalOperand.register,0);
});
test('word logical FINISH preserves upper 48 bits, AF and rounding and rejects corrupt result/lazy state',t=>{
 for(const at of [null,288,272,276,504,64,72,80,68,112]){const f=fixture(t,plan([0x66,0x83,0xf0,0x80])),input=0x12345678abcdef01n,result=input^0xff80n;f.v.setBigUint64(f.g,input,true);f.begin();f.v.setBigUint64(f.tb+280,f.p.nextRip,true);f.v.setBigUint64(f.g,result,true);f.v.setUint32(f.tb+272,Number(result&0xffffffffn),true);f.v.setUint32(f.tb+64,21,true);f.v.setBigUint64(f.tb+72,(result&65535n)<<16n,true);if(at!==null){f.v.setUint8(f.tb+at,f.v.getUint8(f.tb+at)^1);assert.throws(()=>f.finish(),B.BrokerInvariantError);}else assert.equal(f.finish().status,0);}
});
test('all 16 Jcc and CMOV conditions decode every GPR pair, REX width, branch length and direction',()=>{
 for(let cc=0;cc<16;cc++){for(const code of [[0x70+cc,0x80],[0x0f,0x80+cc,0xff,0xff,0xff,0x7f]]){const p=plan(code,7);assert.equal(p.conditionOperand.code,cc);assert.deepEqual(B.parseStepHeader(header(p)).conditionOperand,p.conditionOperand);}
  for(let r=0;r<16;r++)for(let source=0;source<16;source++)for(const wide of [0,8]){const rex=wide|(r>=8?4:0)|(source>=8?1:0),p=plan([...(rex?[0x40|rex]:[]),15,0x40+cc,0xc0|(r&7)<<3|(source&7)]);assert.deepEqual(p.conditionOperand,{code:cc,width:wide?8:4,register:r,source,length:p.length});}}
 for(const code of [[0x66,15,0x4c,0xc1],[15,0x4c,1],[0x67,15,0x4c,0xc1]])assert.throws(()=>B.conditionOperand({instruction:Uint8Array.from(code)}));
});
test('condition truth table uses all five owned flag bits and treats scalar lazy carry correctly',()=>{
 for(let cc=0;cc<16;cc++)for(let n=0;n<16;n++)for(const pf of [0x89abcdee,0x89abcdef])assert.equal(B.conditionHolds(cc,n<<28,pf),truth(cc,n<<28,pf));
 for(const [kind,a,b,stored,expected]of [[1,0n,1n,0,0x80000000],[2,0n,1n,0,0x80000000],[3,0x7fffffffn,1n,0,0x90000000],[19,0x7fffffffn,1n,0,0xb0000000],[21,0n,0xdeadbeefn,0,0x60000000],[7,0n,1n,0x20000000,0xa0000000]])assert.equal(B.materializeScalarNZCV(kind,a,b,stored),expected);
 for(const kind of [11,12,13,14,16,27,255])assert.throws(()=>B.materializeScalarNZCV(kind,0n,0n,0));assert.throws(()=>B.materializeScalarNZCV(1,1n<<32n,0n,0));
});
test('Jcc FINISH binds the condition to its owned target and preserves all non-RIP CPU state',t=>{
 for(let cc=0;cc<16;cc++)for(const corrupt of [false,true]){const f=fixture(t,plan([0x70+cc,0x40],7));f.begin();const taken=truth(cc,0x20000000,0),target=taken?f.p.branchTarget:f.p.nextRip;f.v.setBigUint64(f.tb+280,corrupt?(taken?f.p.nextRip:f.p.branchTarget):target,true);if(cc!==10&&cc!==11)f.v.setUint32(f.tb+64,0,true);if(corrupt)assert.throws(()=>f.finish(),B.BrokerInvariantError);else assert.equal(f.finish().rip,target);}
});
test('CMOV32 clears upper bits on false/equal-register paths and owns source and full flag representation',t=>{
 for(const cc of [4,10,11,12,15])for(const same of [false,true])for(const corrupt of [null,296,276,112,68,504]){const f=fixture(t,plan([15,0x40+cc,same?0xc0:0xc1])),destination=0x12345678aabbccddn,source=same?destination:0xfedcba9876543210n,taken=truth(cc,0x20000000,0);f.v.setBigUint64(f.g,destination,true);f.v.setBigUint64(f.g+8,source,true);f.begin();f.v.setBigUint64(f.g,BigInt.asUintN(32,taken?source:destination),true);f.v.setBigUint64(f.tb+280,f.p.nextRip,true);if(cc===10||cc===11)f.v.setBigUint64(f.tb+72,cc===10?1n:0n,true);if(corrupt!==null){f.v.setUint8(f.tb+corrupt,f.v.getUint8(f.tb+corrupt)^1);assert.throws(()=>f.finish(),B.BrokerInvariantError);}else assert.equal(f.finish().status,0);}
});
test('register-only refusals restore all spans without a data request',t=>{
 for(const code of [[0x66,0x39,0xc8],[0x66,0x83,0xe0,0xff],[15,0x4c,0xc1],[0x7c,1]]){const f=fixture(t,plan(code,code[0]===0x7c?7:6));f.begin();const before=f.snapshot();f.v.setBigUint64(f.g,99n,true);assert.equal(f.finish(2).rip,RIP);assert.deepEqual(f.snapshot(),before);assert.equal(f.broker.stats().requests,0);}
});
test('BEGIN rejects conflicting/malformed scalar profiles and owns copied condition metadata',t=>{
 const p=plan([15,0x4c,0xc1]);
 for(const change of [{conditionOperand:{...p.conditionOperand,source:16}},{conditionOperand:{...p.conditionOperand,width:2}},{conditionOperand:{...p.conditionOperand,code:16}},{conditionOperand:{...p.conditionOperand,length:4}},{wordLogicalOperand:{register:0,kind:1,mask:0,length:4}},{wordCompareOperand:{...plan([0x66,0x83,0xf8,0]).wordCompareOperand}}]){const f=fixture(t,p);assert.throws(()=>f.begin(change),/metadata/);}
 const f=fixture(t,p),operand={...p.conditionOperand};f.v.setBigUint64(f.g,0x12345678aabbccddn,true);f.begin({conditionOperand:operand});operand.code=4;operand.source=0;f.v.setBigUint64(f.g,0xaabbccddn,true);f.v.setBigUint64(f.tb+280,p.nextRip,true);assert.equal(f.finish().status,0);
});
test('kernel rederives scalar profiles from executable bytes despite forged caller metadata',t=>{
 const {Kernel}=LinuxBundle.require('./kernel.js');
 for(const p of [plan([0x66,0x39,0xc8]),plan([0x66,0x83,0xe0,0xff]),plan([15,0x4c,0xc1]),plan([0x7c,1],7)]){
  const cfg={guestMemory:'broker1',memoryABI:1,stepABI:4,coverageVersion:B.ABI.coverageVersion,stepHeaderBytes:96,memPages:33,memMaxPages:33,threadBase:65536,regArgs:0,callsViaDispatcher:false,maxInstructions:1,shared:true,ctx:256,stateSize:1024,ripOff:24,gregsOff:32,nzcvAddr:504,checkpoint:layout},budget=new M.BackingBudget(),space=new M.GuestAddressSpace(budget,{virtualLimit:1n<<47n});space.mapAnonymous(RIP,4096n,3);space.write(RIP,p.instruction);space.protect(RIP,4096n,5);
  const k=new Kernel({state:new Uint8Array(1024),vfs:{},log:()=>{}},cfg),made=k.createSparseProcess({space,entryRip:RIP,plans:[{...p,conditionOperand:{code:0,source:15},wordLogicalOperand:{mask:0},wordCompareOperand:{immediate:999}}]}),s=made.thread.sparse;t.after(()=>{k.sparseBroker.unregister(s.token);space.close();assert.equal(budget.stats().ownedPayloadBytes,0);});
  const approved=k.sparsePlan(made.thread);for(const field of ['wordCompareOperand','wordLogicalOperand','conditionOperand'])assert.deepEqual(approved[field],p[field]);
 }
});
