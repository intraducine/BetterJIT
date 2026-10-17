// SPDX-License-Identifier: GPL-3.0-or-later
// Compact register PUSH/POP through actual FEX/Wasm and the production broker.
const fs=require('fs'),path=require('path'),os=require('os'),vm=require('vm'),assert=require('node:assert/strict'),{spawnSync}=require('child_process');
const {serve}=require('./native-step-contract.cjs'),golden=require('./sparse-stack-oracle.json');
for(const n of ['guest_memory','guest_memory_broker','thread_core'])vm.runInThisContext(fs.readFileSync(path.resolve(__dirname,'../../../Sources/BetterJITLinux/Resources/linux',n+'.js'),'utf8'));
const M=BetterJITGuestMemory,B=BetterJITGuestMemoryBroker,CODE=0x123400008000n,STACK=0x223400000000n;
const pack=n=>{const b=new Uint8Array(8);new DataView(b.buffer).setBigUint64(0,n,true);return b;};
function oracle(){if(process.platform!=='linux'||process.arch!=='x64')return{supported:false,reason:'Retained native Linux x86-64 results checked against fresh FEX/Wasm; no fresh native x86 execution on this host'};const dir=fs.mkdtempSync(path.join(os.tmpdir(),'betterjit-stack-'));try{const file=path.join(dir,'oracle'),build=spawnSync(process.env.CC||'cc',['-O2','-mno-red-zone','-Wall','-Wextra','-Werror',path.join(__dirname,'sparse-stack-oracle.c'),'-o',file],{encoding:'utf8'});assert.equal(build.status,0,build.stderr);const run=spawnSync(file,[],{encoding:'utf8'});assert.equal(run.status,0,run.stderr);assert.deepEqual(JSON.parse(run.stdout),golden);return{supported:true,rows:golden.length};}finally{fs.rmSync(dir,{recursive:true,force:true});}}
async function main(){const nativeOracle=oracle(),records=[],failures=[],refusals=[];let checks=0,executedWasmSteps=0;
 for(const row of golden){assert.equal(row.flagsBefore,row.flagsAfter);for(const k of ['otherGPRsPreserved','stackPointerCorrect','dataCorrect','memoryCorrect'])assert.equal(row[k],true);}
 await serve('guestmem=broker1',async(get,log)=>{
 const cfg=await(await get('/xlat/config')).json(),state=new Uint8Array(await(await get('/xlat/state')).arrayBuffer());assert.equal(cfg.coverageVersion,25);let pos=0n;
 async function request(bytes,rip=CODE+(pos+=32n)){await get('/xlat/code?addr='+rip.toString(16),{method:'POST',body:Uint8Array.from(bytes)});return FexLinuxThread.parseBrokerStep(new Uint8Array(await(await get('/xlat/step?rip='+rip)).arrayBuffer()));}
 async function compile(bytes,rip){const u=await request(bytes,rip);assert.equal(u.status,0,[...bytes]+': '+log());u.module=await WebAssembly.compile(u.code);assert(WebAssembly.Module.imports(u.module).every(i=>i.module==='e'&&['mem','tb','memory'].includes(i.name)));return u;}
 const add=await compile([0x83,0xc0,1]),syscall=await compile([0x0f,0x05]),units=[];
 for(const kind of ['push','pop'])for(let reg=0;reg<16;reg++)for(const rex of reg<8?[undefined,0x40,0x44,0x48,0x4e]:[0x41,0x45,0x49,0x4f]){const u=await compile([...(rex===undefined?[]:[rex]),(kind==='push'?0x50:0x58)+(reg&7)]);assert.equal(u.stackRegister,reg);assert.equal(u.operation,kind==='push'?B.OP.PUSH_REGISTER:B.OP.POP_REGISTER);assert.equal(u.width,8);assert.equal(u.continuationKind,0);assert.equal(u.branchTarget,0n);assert.deepEqual(u.continuations,[u.nextRip]);units.push({kind,reg,rex,u});}
 function fixture({sp=STACK+128n,backing='private',limitBytes=1024*1024}={}){const budget=new M.BackingBudget({limitBytes}),space=new M.GuestAddressSpace(budget,{virtualLimit:1n<<47n});space.mapAnonymous(CODE,8192n,5);let shared,alias;
  if(backing==='private-view'){shared=new M.SharedBacking(budget,8192n);space.mapShared(STACK,8192n,shared,0n,{privateView:true});alias=new M.GuestAddressSpace(budget,{virtualLimit:1n<<47n});alias.mapShared(STACK,8192n,shared);}else if(backing!=='unmapped'){space.mapAnonymous(STACK,8192n,3);space.write(STACK,new Uint8Array(8192).fill(0xa5));}
  const memory=B.createInternalMemory(),view=new DataView(memory.buffer),broker=new B.GuestMemoryBroker(),token=broker.register(0,{space,memory,checkpointLayout:cfg.checkpoint}),tb=B.ABI.threadBase,g=tb+cfg.ctx+cfg.gregsOff,q=new DataView(memory.buffer,tb+B.ABI.scratchOffset,128);new Uint8Array(memory.buffer,tb+cfg.ctx,state.length).set(state);for(let i=0;i<16;i++)view.setBigUint64(g+i*8,0xdeadbeef00000000n+BigInt(i),true);view.setBigUint64(g+32,sp,true);view.setUint32(tb+cfg.checkpoint.roundMode.offset,2,true);let sequence=0;
  const f={budget,space,shared,alias,memory,view,broker,token,tb,g,q,sp};
  f.snapshot=()=>['cpu','lazyFlags','roundMode'].map(name=>{const p=cfg.checkpoint[name];return new Uint8Array(memory.buffer,tb+p.offset,p.size).slice();});
  f.step=async(u,{alter,afterRun}={})=>{view.setBigUint64(tb+cfg.ctx+cfg.ripOff,u.rip,true);const generation=broker.beginInstruction(token,u);q.setBigUint64(B.FIELD.checkpoint,generation,true);const before=f.snapshot(),oldSP=view.getBigUint64(g+32,true);
   const instance=await WebAssembly.instantiate(u.module,{e:{mem:memory,tb:new WebAssembly.Global({value:'i32'},tb),memory:()=>{q.setUint32(B.FIELD.sequence,++sequence,true);q.setBigUint64(B.FIELD.lease,token.generation,true);alter?.(f);return broker.dispatch(token,{lease:token.generation,sequence}).status;}}});
   const status=instance.exports.run();executedWasmSteps++;afterRun?.(f);const done=broker.finishInstruction(token,{status,nextRip:u.nextRip});
   if([B.OP.PUSH_REGISTER,B.OP.POP_REGISTER].includes(u.operation)){if(done.status===0){const cpu=new DataView(before[0].buffer);cpu.setBigUint64(cfg.ripOff,u.nextRip,true);cpu.setBigUint64(cfg.gregsOff+32,oldSP+(u.operation===B.OP.PUSH_REGISTER?-8n:8n),true);if(u.operation===B.OP.POP_REGISTER)cpu.setBigUint64(cfg.gregsOff+u.stackRegister*8,done.memory.data,true);}assert.deepEqual(f.snapshot(),before,'complete CPU/lazy/round preservation or rollback');}
   return done;
  };f.close=()=>{broker.unregister(token);space.close();alias?.close();shared?.close();assert.equal(budget.stats().ownedPayloadBytes,0);};return f;
 }
 for(const unit of units)for(const backing of ['private',...(unit.rex===undefined||unit.rex===0x41?['private-view']:[])]){const {kind,reg,rex,u}=unit;let count=0;
  for(const row of golden.filter(r=>r.kind===kind&&r.register===reg))for(const offset of backing==='private'?[128n,129n,4093n,4099n,8191n]:[128n,4093n,4099n]){
   // POP at8191 would cross the mapping. Keep that address as a fault case.
   const sp=STACK+(kind==='pop'&&offset===8191n?8184n:offset),f=fixture({sp,backing});try{
    f.view.setBigUint64(f.g,BigInt(row.seed),true);await f.step(add);const value=BigInt(row.value);if(kind==='push'&&reg!==4)f.view.setBigUint64(f.g+reg*8,value,true);if(kind==='pop')f.space.write(sp,pack(value));const before=f.space.read(STACK,8192),expected=before.slice();
    if(kind==='push')expected.set(pack(reg===4?sp:value),Number(sp-STACK-8n));const owned=f.budget.stats().ownedPayloadBytes,done=await f.step(u);assert.equal(done.status,0);assert.deepEqual(f.space.read(STACK,8192),expected);if(kind==='pop')assert.equal(f.budget.stats().ownedPayloadBytes,owned);
    await f.step(syscall);assert.equal(f.view.getBigUint64(f.g+88,true)&0x8d5n,BigInt(row.flagsAfter));assert.equal(f.broker.stats().requests,1);if(f.alias&&kind==='push')assert.deepEqual(f.alias.read(STACK,8192),new Uint8Array(8192));checks++;count++;
   }finally{f.close();}
  }records.push({kind,reg,rex:rex??null,backing,checks:count});
 }
 const push=units.find(x=>x.kind==='push'&&x.reg===5).u,pop=units.find(x=>x.kind==='pop'&&x.reg===5).u,popSP=units.find(x=>x.kind==='pop'&&x.reg===4).u;
 for(const kind of ['push','pop'])for(const spec of [
  {name:'unmapped',backing:'unmapped',status:1,reason:B.REASON.UNMAPPED},
  {name:'cross-unmapped',sp:STACK+8191n,status:1,reason:B.REASON.UNMAPPED,popOnly:true},
  {name:'cross-protection',sp:STACK+(kind==='push'?4099n:4093n),protect:0,status:1,reason:B.REASON.PROTECTION},
  {name:'noncanonical',sp:1n<<47n,status:2,reason:B.REASON.ADDRESS_DOMAIN},
  {name:'u64-max',sp:0xffffffffffffffffn,status:2,reason:B.REASON.ADDRESS_DOMAIN},
  {name:'push-underflow',sp:4n,status:2,reason:B.REASON.ADDRESS_DOMAIN,pushOnly:true},
  {name:'pop-range-overflow',sp:(1n<<47n)-4n,status:2,reason:B.REASON.ADDRESS_DOMAIN,popOnly:true},
  {name:'forged-address',alter:f=>f.q.setBigUint64(B.FIELD.address,STACK+16n,true),status:2,reason:B.REASON.CHECKPOINT},
  {name:'forged-width',alter:f=>f.q.setUint32(B.FIELD.width,4,true),status:2,reason:B.REASON.CHECKPOINT},
  {name:'forged-checkpoint',alter:f=>f.q.setBigUint64(B.FIELD.checkpoint,999n,true),status:2,reason:B.REASON.CHECKPOINT},
  {name:'forged-operand',alter:f=>f.q.setBigUint64(B.FIELD.operand0,999n,true),status:2,reason:B.REASON.CHECKPOINT,pushOnly:true}
 ]){if(spec.popOnly&&kind!=='pop'||spec.pushOnly&&kind!=='push')continue;const f=fixture(spec);try{if(spec.protect!==undefined)f.space.protect(STACK+4096n,4096n,spec.protect);const first=spec.backing==='unmapped'?null:f.space.read(STACK,4096),owned=f.budget.stats().ownedPayloadBytes,done=await f.step(kind==='push'?push:pop,{alter:spec.alter});assert.equal(done.status,spec.status,kind+spec.name);assert.equal(done.memory.reason,spec.reason,kind+spec.name);if(first)assert.deepEqual(f.space.read(STACK,4096),first);assert.equal(f.budget.stats().ownedPayloadBytes,owned);failures.push({kind,name:spec.name,reason:done.memory.reason});}finally{f.close();}}
 for(const limitBytes of [16384,20480,24576]){const f=fixture({sp:STACK+4099n,backing:'private-view',limitBytes});try{const before=f.space.read(STACK,8192),owned=f.budget.stats().ownedPayloadBytes,done=await f.step(push);if(limitBytes<24576){assert.equal(done.status,1);assert.equal(done.memory.reason,B.REASON.ALLOCATION);assert.deepEqual(f.space.read(STACK,8192),before);assert.equal(f.budget.stats().ownedPayloadBytes,owned);}else assert.equal(done.status,0);assert.deepEqual(f.alias.read(STACK,8192),new Uint8Array(8192));failures.push({kind:'push',name:'cross-COW-limit-'+limitBytes,status:done.status});}finally{f.close();}}
 for(const u of [pop,popSP]){const sp=(1n<<47n)-8n,f=fixture({sp});try{f.space.mapAnonymous(sp&~4095n,4096n,3);f.space.write(sp,pack(0xffffffffffffffffn));assert.equal((await f.step(u)).status,0);assert.equal(f.view.getBigUint64(f.g+32,true),u===popSP?0xffffffffffffffffn:1n<<47n);}finally{f.close();}}
 for(const u of [push,pop]){const f=fixture();try{await assert.rejects(f.step(u,{afterRun:()=>f.view.setUint32(f.tb+cfg.checkpoint.roundMode.offset,3,true)}),/unexpected checkpoint/);}finally{f.close();}}
 for(const [name,bytes]of Object.entries({pushWord:[0x66,0x50],popWord:[0x66,0x58],pushImmediate:[0x6a,1],pushImmediate32:[0x68,1,0,0,0],pushMemory:[0xff,0x30],popMemory:[0x8f,0],pushGroupRegister:[0xff,0xf0],popGroupRegister:[0x8f,0xc0],pushFS:[0x0f,0xa0],popFS:[0x0f,0xa1],segment:[0x64,0x55],address:[0x67,0x55],lock:[0xf0,0x55],rep:[0xf3,0x55],doubleRex:[0x40,0x41,0x55],truncated:[0x41]})){const u=await request(bytes);assert.equal(u.status,2,name);assert.equal(u.code.length,0);refusals.push(name);}
 for(const rip of [(1n<<47n)-1n,(1n<<64n)-32n]){assert.equal((await request([0x55],rip)).status,2);refusals.push('source-domain-'+rip);}
 const report={evidence:'Native Linux x86-64 register PUSH/POP oracle and actual FEX-generated Wasm through checked sparse storage; not Wine completion, physical device or JIT replacement evidence.',nativeOracle,coverageVersion:cfg.coverageVersion,buildID:cfg.buildID,encodings:units.length,checks,executedWasmSteps,records,failures,refusals};if(process.argv[3])fs.writeFileSync(process.argv[3],JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({...report,records:records.length,failures:failures.length,refusals:refusals.length}));
 });}
if(require.main===module)main().catch(error=>{console.error(error);process.exitCode=1;});
