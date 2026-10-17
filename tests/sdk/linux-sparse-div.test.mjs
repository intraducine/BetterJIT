// SPDX-License-Identifier: GPL-3.0-or-later
// Real broker/kernel ownership and worker transport; synthetic Wasm producer.
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';import {Worker} from 'node:worker_threads';import {fileURLToPath} from 'node:url';
globalThis.self=globalThis;
for(const file of ['guest_memory.js','guest_memory_broker.js','thread_core.js','web/linux-kernel.js'])vm.runInThisContext(fs.readFileSync(new URL('../../Sources/BetterJITLinux/Resources/linux/'+file,import.meta.url),'utf8'));
const M=BetterJITGuestMemory,B=BetterJITGuestMemoryBroker,{Kernel,SLOT_BASE,SLOT_SIZE,S_REQ,S_DONE}=LinuxBundle.require('./kernel.js'),RIP=0x123400004000n;
const layout={version:1,cpu:{offset:256,size:1024,ripOffset:24,stackPointerOffset:64,generalRegistersOffset:32},lazyFlags:{offset:64,size:24},roundMode:{offset:112,size:4}};
const cfg={guestMemory:'broker1',memoryABI:1,stepABI:4,coverageVersion:24,stepHeaderBytes:96,memPages:33,memMaxPages:33,threadBase:65536,regArgs:0,callsViaDispatcher:false,maxInstructions:1,shared:true,ctx:256,stateSize:1024,ripOff:24,gregsOff:32,checkpoint:layout};
function plan(width=4,reg=1,rex){const instruction=Uint8Array.from([...(rex===undefined?(width===8||reg>=8?[0x40|(width===8?8:0)|(reg>=8?1:0)]:[]):[rex]),0xf7,0xf0+(reg&7)]);return{status:0,operation:17,width,rip:RIP,nextRip:RIP+BigInt(instruction.length),length:instruction.length,instruction,continuationKind:0,branchTarget:0n};}
function header(p){const b=new Uint8Array(96),v=new DataView(b.buffer);[0x31534a42,1,1,4,24,0,p.operation,p.width].forEach((x,i)=>v.setUint32(i*4,x,true));v.setBigUint64(32,p.rip,true);v.setBigUint64(40,p.nextRip,true);v.setUint32(56,1,true);v.setUint32(60,p.length,true);v.setBigUint64(80,p.branchTarget,true);v.setUint32(88,p.continuationKind,true);b.set(p.instruction,64);return b;}
function fixture(t,{width=4,reg=1,low=7n,high=0n,divisor=0n,retained=false,host={}}={}){
 const p=plan(width,reg),budget=new M.BackingBudget(),space=new M.GuestAddressSpace(budget,{virtualLimit:1n<<47n});space.mapAnonymous(RIP,4096n,3);space.write(RIP,p.instruction);space.protect(RIP,4096n,5);
 const stops=[],drops=[],k=new Kernel({vfs:{},state:new Uint8Array(1024),log:()=>{},...(retained?{sparseRetainInternalContexts:true,stopSparseThread:x=>stops.push(x),dropSparseSpace:x=>drops.push(x)}:{}),...host},cfg),made=k.createSparseProcess({space,entryRip:RIP,plans:[{...p,divisionOperand:{register:15,length:99}}]}),s=made.thread.sparse,at=made.thread.tb,g=at+288,base=(SLOT_BASE+made.thread.slot*SLOT_SIZE)>>2,b64=base>>1;
 for(const n of ['cpu','lazyFlags','roundMode']){const l=layout[n];new Uint8Array(s.memory.buffer,at+l.offset,l.size).fill(0xa5);}s.view.setBigUint64(at+280,RIP,true);s.view.setBigUint64(g,low,true);s.view.setBigUint64(g+16,high,true);if(reg!==0&&reg!==2)s.view.setBigUint64(g+reg*8,divisor,true);
 let sequence=0;
 const phase=(which,status=0,{seq=++sequence,lease=s.token.generation}={})=>{k.k64[b64+1]=BigInt(B.ABI.instructionBoundary);k.k64[b64+2]=lease;k.k64[b64+3]=BigInt(seq);k.k64[b64+4]=BigInt(which);k.k64[b64+5]=BigInt(status);Atomics.store(k.k32,base,S_REQ);k.serviceRequests();assert.equal(Atomics.load(k.k32,base),S_DONE);Atomics.store(k.k32,base,0);return Number(k.k64[b64+8]);};
 const begin=()=>k.sparseBroker.beginInstruction(s.token,{...p,continuations:[p.nextRip],divisionOperand:B.divisionOperand(p)}),finish=status=>k.sparseBroker.finishInstruction(s.token,{status,nextRip:p.nextRip});
 t.after(()=>{for(const th of k.threads.values())k.sparseBroker.unregister(th.sparse.token);space.close();assert.equal(budget.stats().ownedPayloadBytes,0);});return{k,s,p,budget,space,stops,drops,phase,begin,finish,at,g,base,b64,...made};
}
const snapshot=f=>['cpu','lazyFlags','roundMode'].map(n=>{const p=layout[n];return new Uint8Array(f.s.memory.buffer,f.at+p.offset,p.size).slice();});
test('DIV metadata derives all exact F7/6 register encodings and rejects expanded forms or old ABI',()=>{
 for(const rex of [undefined,...Array.from({length:16},(_,i)=>0x40+i)])for(let rm=0;rm<8;rm++){const p=plan(rex&8?8:4,rm+(rex&1?8:0),rex),parsed=B.parseStepHeader(header(p));assert.deepEqual(parsed.divisionOperand,{register:rm+(rex&1?8:0),length:p.length});assert.deepEqual(parsed.continuations,[p.nextRip]);}
 for(const instruction of [[0xf7,0x31],[0xf7,0xf9],[0xf6,0xf1],[0x66,0xf7,0xf1],[0x67,0xf7,0xf1],[0x40,0x41,0xf7,0xf1],[0x48,0x66,0xf7,0xf1],[0xf0,0xf7,0xf1],[0xf2,0xf7,0xf1],[0xf3,0xf7,0xf1],[0xf7],[0xf7,0xf1,0]]){const p={...plan(),instruction:Uint8Array.from(instruction),length:instruction.length,nextRip:RIP+BigInt(instruction.length)};assert.throws(()=>B.parseStepHeader(header(p)),/metadata/);}
 for(const changes of [{width:2},{width:8},{continuationKind:1},{branchTarget:RIP},{nextRip:RIP+3n},{rip:1n<<47n}])assert.throws(()=>B.parseStepHeader(header({...plan(),...changes})),/metadata/);
 for(const [offset,value]of [[12,3],[12,5],[16,23],[16,25]]){const b=header(plan());new DataView(b.buffer).setUint32(offset,value,true);assert.throws(()=>B.parseStepHeader(b),/ABI/);}
 assert.equal(B.STEP.DIVIDE_ERROR,5);assert(!Object.values(B.STEP).includes(4));
});
test('BEGIN owns masked operands and precise zero/overflow reasons, including RAX/RDX aliases',t=>{
 for(const width of [4,8])for(const reg of [0,1,2,8,15])for(const [low,high,d]of [[0n,0n,0n],[7n,3n,3n],[9n,4n,3n],[2n,1n,3n]]){
  const f=fixture(t,{width,reg,low:width===4?low|0xaabbccdd00000000n:low,high:width===4?high|0x1234567800000000n:high,divisor:width===4?d|0xdeadbeef00000000n:d}),selected=reg===0?low:reg===2?high:d,fault=selected===0n||high>=selected;
  f.begin();const before=snapshot(f);
  if(fault){const result=f.finish(5);assert.deepEqual(result.exception,{kind:'divide-error',vector:0,reason:selected===0n?'zero-divisor':'quotient-overflow',rip:RIP});assert(Object.isFrozen(result.exception));assert.equal(result.memory,null);assert.equal(result.rip,RIP);}
  else{const n=(high<<BigInt(width*8))|low;f.s.view.setBigUint64(f.g,n/selected,true);f.s.view.setBigUint64(f.g+16,n%selected,true);f.s.view.setBigUint64(f.at+280,f.p.nextRip,true);assert.equal(f.finish(0).status,0);const v=new DataView(before[0].buffer);v.setBigUint64(24,f.p.nextRip,true);v.setBigUint64(32,n/selected,true);v.setBigUint64(48,n%selected,true);}
  assert.deepEqual(snapshot(f),before);assert.equal(f.k.sparseBroker.stats().requests,0);
 }
});
test('typed divide error cannot hide any checkpoint mutation, guest-memory result, success or another operation',t=>{
 for(const [name,offset]of [['cpu',0],['cpu',24],['cpu',32],['cpu',48],['cpu',1000],['lazyFlags',0],['lazyFlags',23],['roundMode',3]]){const f=fixture(t);f.begin();const at=f.at+layout[name].offset+offset;f.s.view.setUint8(at,f.s.view.getUint8(at)^1);assert.throws(()=>f.finish(5),/changed checkpoint/);}
 {const f=fixture(t);f.begin();assert.throws(()=>f.finish(0),/despite/);}
 {const f=fixture(t,{divisor:3n});f.begin();assert.throws(()=>f.finish(5),/owned failing/);}
 {const f=fixture(t);f.k.sparseBroker.beginInstruction(f.s.token,{rip:RIP,operation:0,width:0});assert.throws(()=>f.finish(5),/owned failing/);}
 {const f=fixture(t),q=new DataView(f.s.memory.buffer,f.at+B.ABI.scratchOffset,128);const generation=f.begin();
  for(const [key,value]of Object.entries({magic:B.ABI.magic,version:1,sequence:1,operation:1,width:4,access:1,address:RIP,rip:RIP,checkpoint:generation,lease:f.s.token.generation}))typeof value==='bigint'?q.setBigUint64(B.FIELD[key],value,true):q.setUint32(B.FIELD[key],value,true);
  assert.equal(f.k.sparseBroker.dispatch(f.s.token,{lease:f.s.token.generation,sequence:1}).status,2);assert.throws(()=>f.finish(5),/owned failing/);}
 for(const status of [1,3,4,6]){const f=fixture(t);f.begin();assert.throws(()=>f.finish(status),/typed memory fault|syscall|Unknown/);}
 {const f=fixture(t);f.begin();f.k.sparseBroker.unregister(f.s.token);assert.throws(()=>f.finish(5),/Retired/);}
 {const f=fixture(t);f.begin();const other=f.k.createSparseThread(f.proc,{entryRip:RIP,plans:[f.p]});assert.throws(()=>f.k.sparseBroker.finishInstruction(other.thread.sparse.token,{status:5,nextRip:f.p.nextRip}),/No instruction/);}
});
test('successful DIV accepts only exact quotient/remainder/RIP and preserves every other checkpoint byte',t=>{
 for(const at of [256,256+32,256+48,256+24,256+64,64,64+23,112]){const f=fixture(t,{low:17n,high:1n,divisor:3n});f.begin();const n=(1n<<32n)|17n;f.s.view.setBigUint64(f.g,n/3n,true);f.s.view.setBigUint64(f.g+16,n%3n,true);f.s.view.setBigUint64(f.at+280,f.p.nextRip,true);f.s.view.setUint8(f.at+at,f.s.view.getUint8(f.at+at)^1);assert.throws(()=>f.finish(0),/post-state|unexpected checkpoint/);}
});
test('kernel requires exact owned FINISH, sequence, lease and RIP before terminal status5; no normal wait status',t=>{
 {const f=fixture(t);assert.equal(f.s.plans.get(RIP).divisionOperand.register,1);f.phase(1);assert.equal(f.phase(2,5),5);assert.equal(f.phase(3,5),0);assert.equal(f.s.exception.kind,'divide-error');assert.equal(f.s.guestExitCode,undefined);assert.equal(f.proc.sparseGuestExit,undefined);assert.equal(f.k.sparseBroker.stats().threads,0);assert.throws(()=>f.k.sparseReap(f.thread,f.proc,0n),/without a guest wait status/);}
 for(const mode of ['without-BEGIN','without-FINISH','stale-lease','replay-sequence','changed-RIP','success-terminal','another-BEGIN']){const f=fixture(t);
  if(mode==='without-BEGIN'){assert.throws(()=>f.phase(3,5),/Unowned/);continue;}f.phase(1);
  if(mode==='without-FINISH'){assert.throws(()=>f.phase(3,5),/during an instruction/);continue;}
  if(mode==='stale-lease'){assert.throws(()=>f.phase(2,5,{lease:f.s.token.generation+1n}),/Stale/);continue;}
  f.phase(2,5);
  if(mode==='replay-sequence')assert.throws(()=>f.phase(3,5,{seq:2}),/sequence/);
  if(mode==='changed-RIP'){f.s.view.setBigUint64(f.at+280,RIP+1n,true);assert.throws(()=>f.phase(3,5),/Unowned/);}
  if(mode==='success-terminal')assert.throws(()=>f.phase(3,0),/Invalid sparse terminal/);
  if(mode==='another-BEGIN')assert.throws(()=>f.phase(1),/requires terminal/);
 }
});
test('session stop prevents same-pass later requests and clone/exec/READY/wait servicing',()=>{
 const k=Object.create(Kernel.prototype),calls=[];k.k32=new Int32Array(new SharedArrayBuffer(4096));k.slots=[];
 for(let slot=0;slot<2;slot++){k.slots[slot]={slot,sparse:{}};Atomics.store(k.k32,(SLOT_BASE+slot*SLOT_SIZE)>>2,S_REQ);}
 k.sparseGuestQuiesced=()=>false;k.sparseRequest=t=>{calls.push('request:'+t.slot);k.sparseSessionStop={};};k.serviceSparseSessionStop=()=>{calls.push('drain');return true;};
 k.sparseClones=new Map([[1,{}]]);k.sparseExecs=new Map([[1,{}]]);k.sparseWaits=new Map([[1,{}]]);for(const n of ['Clones','Execs','Waits'])k['serviceSparse'+n]=()=>{calls.push(n);};
 // W_OCCUPIED must remain set while the synthetic workers own these slots.
 for(let slot=0;slot<2;slot++)Atomics.store(k.k32,((SLOT_BASE+slot*SLOT_SIZE)>>2)+26,1);
 assert.equal(k.serviceRequests(),true);assert.deepEqual(calls,['request:0','drain']);
});
test('exception session retains every image and broker owner until all controlled worker drains, then drops once',t=>{
 const f=fixture(t,{retained:true}),other=f.k.createSparseThread(f.proc,{entryRip:RIP,plans:[f.p]});f.proc.mm.catalog={id:1,refs:1};
 f.phase(1);f.phase(2,5);f.phase(3,5);f.k.stopSparseSession(f.thread);assert.deepEqual(f.stops,[{slot:other.thread.slot,lease:other.worker.lease}]);
 assert.equal(f.k.serviceRequests(),false);assert.equal(f.k.done,undefined);assert.equal(f.k.sparseBroker.stats().threads,1);assert.equal(f.drops.length,0);assert(f.budget.stats().ownedPayloadBytes>0);
 Atomics.store(new Int32Array(f.worker.quiescence),0,1);assert.equal(f.k.serviceRequests(),true);assert.equal(f.k.done,undefined);assert.equal(f.drops.length,0);
 Atomics.store(new Int32Array(other.worker.quiescence),0,2);f.k.serviceRequests();assert.equal(f.k.done,true);assert.equal(f.k.sparseBroker.stats().threads,0);assert.equal(f.budget.stats().ownedPayloadBytes,0);assert.deepEqual(f.drops,[{space:1}]);assert.equal(f.proc.sparseGuestExit,undefined);assert.equal(other.thread.sparse.guestExitCode,undefined);
 for(const w of [f.worker,other.worker])assert.equal(Atomics.load(new Int32Array(w.ksab),((SLOT_BASE+w.slot*SLOT_SIZE)>>2)+26),1,'physical occupancy retained');
});
test('exception drain owns staged exec/clone contexts and their images until the last receipt',t=>{
 const f=fixture(t,{retained:true}),old=f.k.createSparseThread(f.proc,{entryRip:RIP,plans:[f.p]});f.proc.mm.catalog={id:1,refs:1};
 const stagedSpace=new M.GuestAddressSpace(f.budget,{virtualLimit:1n<<47n});stagedSpace.mapAnonymous(RIP,4096n,3);stagedSpace.write(RIP,f.p.instruction);stagedSpace.protect(RIP,4096n,5);t.after(()=>stagedSpace.close());
 const mm={guest:stagedSpace,sparse:true,catalog:{id:2,refs:1}},exec=f.k.allocateSparseThread(f.proc,{entryRip:RIP,plans:[f.p],publish:false,mm,spaceId:2},f.k.newTid()),clone=f.k.allocateSparseThread(f.proc,{entryRip:RIP,plans:[f.p],publish:false},f.k.newTid()),execTimer={dead:false},cloneTimer={dead:false};
 f.phase(1);f.phase(2,5);f.phase(3,5);
 // Install staged ownership at the stop boundary; ordinary clone/exec state
 // machines are tested separately and must not run these synthetic records.
 f.k.sparseExecs=new Map([[exec.thread.slot,{old:old.thread,made:exec,oldMM:f.proc.mm,mm,timer:execTimer}]]);f.k.sparseClones=new Map([[clone.thread.slot,{made:clone,timer:cloneTimer}]]);
 f.k.stopSparseSession(f.thread);assert.equal(f.k.sparseSessionStop.contexts.length,4);assert.equal(f.stops.length,3);
 for(const w of [f.worker,old.worker,exec.worker])Atomics.store(new Int32Array(w.quiescence),0,w===f.worker?1:2);
 f.k.serviceRequests();assert.equal(f.k.done,undefined);assert.equal(f.drops.length,0);assert.equal(f.k.sparseBroker.stats().threads,1);assert.equal(execTimer.dead,false);
 Atomics.store(new Int32Array(clone.worker.quiescence),0,2);f.k.serviceRequests();assert.equal(f.k.done,true);assert.equal(f.k.sparseBroker.stats().threads,0);assert.equal(f.budget.stats().ownedPayloadBytes,0);assert.deepEqual(f.drops,[{space:1},{space:2}]);assert.equal(execTimer.dead,true);assert.equal(cloneTimer.dead,true);assert.equal(f.k.sparseExecs.size,0);assert.equal(f.k.sparseClones.size,0);
});
async function workerRun(t,runStatus,finishCompletion){const f=fixture(t),root=fileURLToPath(new URL('../../Sources/BetterJITLinux/Resources/linux/',import.meta.url));
 const worker=new Worker(`const {parentPort,workerData:d}=require('node:worker_threads'),fs=require('fs'),vm=require('vm');globalThis.self=globalThis;for(const n of ['guest_memory','guest_memory_broker','thread_core'])vm.runInThisContext(fs.readFileSync(d.root+n+'.js','utf8'));const module=new WebAssembly.Module(Uint8Array.from([0,97,115,109,1,0,0,0,1,5,1,96,0,1,127,3,2,1,0,7,7,1,3,114,117,110,0,0,10,6,1,4,0,65,d.runStatus,11]));FexLinuxThread.runThread({data:d,stepBroker:async(_space,rip)=>({status:0,rip,module})}).then(result=>parentPort.postMessage({result}),e=>parentPort.postMessage({error:String(e)}));`,{eval:true,workerData:{...f.worker,root,runStatus,maximumSteps:1,requestTimeoutMs:1000}});
 t.after(()=>worker.terminate());const complete=f.k.completeSparseTransport;f.k.completeSparseTransport=function(th,lease,seq,result,allowDead){if(this.k64[f.b64+4]===2n&&finishCompletion!==undefined)result=BigInt(finishCompletion);return complete.call(this,th,lease,seq,result,allowDead);};
 let kernelError;const timer=setInterval(()=>{try{f.k.serviceRequests();}catch(e){kernelError=e;clearInterval(timer);}},1);t.after(()=>clearInterval(timer));
 const message=await new Promise((resolve,reject)=>{worker.once('message',resolve);worker.once('error',reject);});clearInterval(timer);return{f,message,kernelError};
}
test('actual blocking worker counts run() then accepts only matching DIVIDE_ERROR FINISH and terminal exchange',async t=>{
 const {f,message,kernelError}=await workerRun(t,5,5);assert.equal(kernelError,undefined);assert.equal(message.result.status,5);assert.equal(message.result.executed,1);assert.equal(message.result.guestExitCode,undefined);assert.equal(f.s.exception.kind,'divide-error');assert.equal(f.thread.dead,true);
 for(const [status,completion,pattern]of [[5,0,/divide-error step completion/],[2,5,/failed step completion/],[4,undefined,/typed step exit/],[0,5,/mailbox deadline/]]){const r=await workerRun(t,status,completion);assert.match(r.message.error,pattern);assert.equal(r.f.thread.dead,false);if(status===0)assert.match(String(r.kernelError),/despite/);}
});
