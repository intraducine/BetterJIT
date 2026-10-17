// SPDX-License-Identifier: GPL-3.0-or-later
// Checked CALL/RET effects in actual FEX-generated sparse Wasm; host evidence.
const fs=require('fs'),path=require('path'),vm=require('vm'),os=require('os');
const {spawnSync}=require('child_process'),assert=require('node:assert/strict');
const {serve}=require('./native-step-contract.cjs'),golden=require('./sparse-call-oracle.json');
for(const name of ['guest_memory','guest_memory_broker','thread_core'])vm.runInThisContext(fs.readFileSync(path.resolve(__dirname,
 '../../../Sources/BetterJITLinux/Resources/linux',name+'.js'),'utf8'));
const M=BetterJITGuestMemory,B=BetterJITGuestMemoryBroker,CODE=0x123400008000n,STACK=0x223400000000n;
const pack=value=>{const b=new Uint8Array(8);new DataView(b.buffer).setBigUint64(0,value,true);return b;};
function call(rip,target){const bytes=new Uint8Array(5);bytes[0]=0xe8;new DataView(bytes.buffer).setInt32(1,Number(target-rip-5n),true);return bytes;}
function oracle(){
 if(process.platform!=='linux'||process.arch!=='x64')return {supported:false,reason:'Native oracle requires Linux x86-64; retained native results still checked against fresh FEX/Wasm'};
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'betterjit-call-'));try{
  const binary=path.join(dir,'oracle'),build=spawnSync(process.env.CC||'cc',['-O2','-mno-red-zone','-Wall','-Wextra','-Werror',path.join(__dirname,'sparse-call-oracle.c'),'-o',binary],{encoding:'utf8'});
  assert.equal(build.status,0,build.stderr);const run=spawnSync(binary,[],{encoding:'utf8'});assert.equal(run.status,0,run.stderr);assert.deepEqual(JSON.parse(run.stdout),golden);return {supported:true,rows:golden.length};
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
}
async function main(){const nativeOracle=oracle();for(const row of golden){assert.equal(row.flagsAfter,row.flags);assert.equal(row.callStackDelta,-8);assert.equal(row.finalStackDelta,0);assert.equal(row.returnMatches,true);}await serve('guestmem=broker1',async(get,log)=>{
 const cfg=await(await get('/xlat/config')).json(),state=new Uint8Array(await(await get('/xlat/state')).arrayBuffer()),records=[],failures=[];
 assert.equal(cfg.checkpoint.cpu.stackPointerOffset,cfg.gregsOff+32);
 async function request(rip,bytes){await get('/xlat/code?addr='+rip.toString(16),{method:'POST',body:bytes});return FexLinuxThread.parseBrokerStep(new Uint8Array(await(await get('/xlat/step?rip='+rip)).arrayBuffer()));}
 async function compile(rip,bytes){const unit=await request(rip,Uint8Array.from(bytes));assert.equal(unit.status,0,[...bytes]+': '+log());assert.equal(unit.nextRip,rip+BigInt(bytes.length));assert.deepEqual(unit.instruction,Uint8Array.from(bytes));unit.module=await WebAssembly.compile(unit.code);assert(WebAssembly.Module.imports(unit.module).every(i=>i.module==='e'&&['mem','tb','memory'].includes(i.name)));return unit;}
 const modes={};for(const [name,rip,target]of [['forward',CODE,CODE+64n],['backward',CODE+64n,CODE],['zero',CODE+128n,CODE+133n]])modes[name]={call:await compile(rip,call(rip,target)),ret:await compile(target,[0xc3])};
 modes.indirect={call:await compile(CODE+320n,[0xff,0xd0]),ret:await compile(CODE+64n,[0xc3]),register:0};
 const add=await compile(CODE+256n,[1,0xd8]),syscall=await compile(CODE+272n,[15,5]);
 function fixture({offset=128n,kind='private',budgetBytes=65536,stackProt=3,target='rx',sp}={}){
  const budget=new M.BackingBudget({limitBytes:budgetBytes}),space=new M.GuestAddressSpace(budget,{virtualLimit:1n<<47n});
  space.mapAnonymous(CODE,4096n,3);space.write(CODE,new Uint8Array(4096).fill(0x90));space.protect(CODE,4096n,5);
  let backing,alias;
  if(kind==='private-view'){backing=new M.SharedBacking(budget,8192n);space.mapShared(STACK,8192n,backing,0n,{privateView:true});alias=new M.GuestAddressSpace(budget,{virtualLimit:1n<<47n});alias.mapShared(STACK,8192n,backing);}
  else if(kind!=='unmapped'){space.mapAnonymous(STACK,8192n,3);space.write(STACK,new Uint8Array(8192).fill(0xa5));space.protect(STACK,8192n,stackProt);}
  const memory=B.createInternalMemory(),broker=new B.GuestMemoryBroker(),token=broker.register(0,{space,memory,checkpointLayout:cfg.checkpoint}),view=new DataView(memory.buffer),tb=B.ABI.threadBase,g=tb+cfg.ctx+cfg.gregsOff;
  new Uint8Array(memory.buffer,tb+cfg.ctx,state.length).set(state);for(let i=0;i<16;i++)view.setBigUint64(g+i*8,0x1020304000000000n+BigInt(i),true);
  view.setBigUint64(g+32,sp??STACK+offset,true);view.setUint32(tb+cfg.checkpoint.roundMode.offset,2,true);
  if(target==='rw')space.protect(CODE,4096n,3);if(target==='rwx')space.protect(CODE,4096n,7);if(target==='unmapped')space.unmap(CODE,4096n);
  let sequence=0;const f={budget,space,memory,broker,token,view,tb,g,backing,alias};
  f.step=async(unit,{alter}={})=>{
   view.setBigUint64(tb+cfg.ctx+cfg.ripOff,unit.rip,true);
   const checkpoint=broker.beginInstruction(token,{...unit,nextRip:unit.nextRip});view.setBigUint64(tb+B.ABI.scratchOffset+B.FIELD.checkpoint,checkpoint,true);
   const instance=await WebAssembly.instantiate(unit.module,{e:{mem:memory,tb:new WebAssembly.Global({value:'i32'},tb),memory:()=>{
    view.setUint32(tb+B.ABI.scratchOffset+B.FIELD.sequence,++sequence,true);view.setBigUint64(tb+B.ABI.scratchOffset+B.FIELD.lease,token.generation,true);alter?.(f);
    return broker.dispatch(token,{lease:token.generation,sequence}).status;
   }}});
   const before=['cpu','lazyFlags','roundMode'].map(n=>{const s=cfg.checkpoint[n];return new Uint8Array(memory.buffer,tb+s.offset,s.size).slice();});
   const status=instance.exports.run(),done=broker.finishInstruction(token,{status,nextRip:unit.nextRip});
   if(status===0&&[B.OP.CALL,B.OP.RETURN].includes(unit.operation)){
    const expected=before[0].slice(),cpu=new DataView(expected.buffer);cpu.setBigUint64(cfg.ripOff,done.rip,true);
    cpu.setBigUint64(cfg.checkpoint.cpu.stackPointerOffset,cpu.getBigUint64(cfg.checkpoint.cpu.stackPointerOffset,true)+(unit.operation===B.OP.CALL?-8n:8n),true);
    assert.deepEqual(new Uint8Array(memory.buffer,tb+cfg.ctx,state.length),expected,'complete CPU preserved except RIP/RSP');
    ['lazyFlags','roundMode'].forEach((n,i)=>{const s=cfg.checkpoint[n];assert.deepEqual(new Uint8Array(memory.buffer,tb+s.offset,s.size),before[i+1],n+' preserved');});
   }
   if(status===1||status===2){assert.equal(done.rip,unit.rip);['cpu','lazyFlags','roundMode'].forEach((n,i)=>{const s=cfg.checkpoint[n];assert.deepEqual(new Uint8Array(memory.buffer,tb+s.offset,s.size),before[i],n+' rollback');});}
   return done;
  };
  f.close=()=>{broker.unregister(token);space.close();alias?.close();backing?.close();assert.equal(budget.stats().ownedPayloadBytes,0);};return f;
 }
 function gprs(f){return Array.from({length:16},(_,i)=>f.view.getBigUint64(f.g+i*8,true));}
 function preserved(f,before,rsp){before.forEach((value,i)=>assert.equal(f.view.getBigUint64(f.g+i*8,true),i===4?rsp:value,'GPR '+i));}
 for(const row of golden)for(const offset of [128n,129n,4099n])for(const kind of ['private','private-view']){
  const f=fixture({offset,kind}),u=modes[row.mode];try{
   f.view.setBigUint64(f.g,BigInt(row.a),true);f.view.setBigUint64(f.g+24,BigInt(row.b),true);await f.step(add);await f.step(syscall);
   assert.equal(f.view.getBigUint64(f.g+88,true)&0x8d5n,BigInt(row.flags));
   if(u.register!==undefined)f.view.setBigUint64(f.g+u.register*8,u.ret.rip,true);
   const before=gprs(f),rsp=before[4],bytes=f.space.read(rsp-16n,24);
   const done=await f.step(u.call);assert.equal(done.status,0);assert.equal(done.rip,u.ret.rip);preserved(f,before,rsp-8n);
   assert.deepEqual(f.space.read(rsp-8n,8),pack(u.call.nextRip));const expected=bytes.slice();expected.set(pack(u.call.nextRip),8);assert.deepEqual(f.space.read(rsp-16n,24),expected);
   await f.step(syscall);assert.equal(f.view.getBigUint64(f.g+88,true)&0x8d5n,BigInt(row.flags),'CALL flags including AF');
   const beforeRet=gprs(f),ret=await f.step(u.ret);assert.equal(ret.status,0);assert.equal(ret.rip,u.call.nextRip);preserved(f,beforeRet,rsp);
   assert.deepEqual(f.space.read(rsp-16n,24),expected);await f.step(syscall);assert.equal(f.view.getBigUint64(f.g+88,true)&0x8d5n,BigInt(row.flags),'RET flags including AF');
   if(f.alias)assert.deepEqual(f.alias.read(STACK,8192),new Uint8Array(8192),'CALL detaches only the private view');
   assert.equal(f.view.getUint32(f.tb+cfg.checkpoint.roundMode.offset,true),2);assert.equal(f.broker.stats().requests,2);
   records.push({mode:row.mode,kind,offset:String(offset),flags:row.flags,callRip:String(u.call.rip),target:String(u.ret.rip),returnRip:String(ret.rip)});
  }finally{f.close();}
 }
 const registerRecords=[];
 for(const rex of [undefined,...Array.from({length:16},(_,i)=>0x40+i)])for(let low=0;low<8;low++){
  const register=low+((rex??0)&1?8:0),bytes=[...(rex===undefined?[]:[rex]),0xff,0xd0+low],unit=await compile(CODE+320n,bytes);
  assert.equal(unit.sourceRegister,register);assert.equal(unit.continuationKind,6);assert.equal(unit.branchTarget,0n);assert.deepEqual(unit.continuations,[]);
  const destination=register===4?STACK+4096n:CODE+64n,ret=await compile(destination,[0xc3]);
  for(const row of golden.filter(r=>r.mode==='indirect'))for(const kind of ['private','private-view'])for(const offset of register===4?[4096n]:[128n,129n,4099n]){
   const f=fixture({kind,offset});try{
    f.view.setBigUint64(f.g,BigInt(row.a),true);f.view.setBigUint64(f.g+24,BigInt(row.b),true);await f.step(add);await f.step(syscall);
    if(register===4){f.space.write(destination,Uint8Array.of(0xc3));f.space.protect(destination,4096n,5);}
    f.view.setBigUint64(f.g+register*8,destination,true);
    const before=gprs(f),rsp=before[4],stack=f.space.read(STACK,8192),alias=f.alias?.read(STACK,8192),owned=f.budget.stats().ownedPayloadBytes;
    const result=await f.step(unit);assert.equal(result.status,0);assert.equal(result.rip,destination);preserved(f,before,rsp-8n);
    const expected=stack.slice();expected.set(pack(unit.nextRip),Number(rsp-8n-STACK));assert.deepEqual(f.space.read(STACK,8192),expected);
    const touched=Number(((rsp-1n)>>12n)-((rsp-8n)>>12n)+1n);
    assert.equal(f.budget.stats().ownedPayloadBytes,owned+(kind==='private-view'?touched*4096:0));
    if(alias)assert.deepEqual(f.alias.read(STACK,8192),alias);
    const after=await f.step(ret);assert.equal(after.status,0);assert.equal(after.rip,unit.nextRip);preserved(f,before,rsp);
    assert.deepEqual(f.space.read(STACK,8192),expected);await f.step(syscall);assert.equal(f.view.getBigUint64(f.g+88,true)&0x8d5n,BigInt(row.flags));
    registerRecords.push({register,rex:rex??null,kind,offset:String(offset),flags:row.flags,prestateTarget:String(destination),returned:true});
   }finally{f.close();}
  }
 }
 const U=modes.forward;
 for(const spec of [
  {name:'call-unmapped-stack',kind:'unmapped',status:1,reason:B.REASON.UNMAPPED},
  {name:'call-readonly-stack',stackProt:1,status:1,reason:B.REASON.PROTECTION},
  {name:'call-underflow',sp:4n,status:2,reason:B.REASON.ADDRESS_DOMAIN},
  {name:'return-overflow',ret:true,sp:(1n<<47n)-4n,status:2,reason:B.REASON.ADDRESS_DOMAIN},
  {name:'call-invalid-target-before-write',target:'rw',status:2,reason:B.REASON.CONTROL_TARGET},
  {name:'call-writable-executable-target',target:'rwx',status:2,reason:B.REASON.CONTROL_TARGET},
  {name:'call-unmapped-target',target:'unmapped',status:2,reason:B.REASON.CONTROL_TARGET},
  {name:'call-cow-allocation',kind:'private-view',budgetBytes:12288,status:1,reason:B.REASON.ALLOCATION},
  {name:'call-second-cow-allocation',kind:'private-view',offset:4099n,budgetBytes:16384,status:1,reason:B.REASON.ALLOCATION},
  {name:'call-forged-address',alter:f=>f.view.setBigUint64(f.tb+B.ABI.scratchOffset+B.FIELD.address,STACK+256n,true),status:2,reason:B.REASON.CHECKPOINT},
  {name:'call-forged-return-PC',alter:f=>f.view.setBigUint64(f.tb+B.ABI.scratchOffset+B.FIELD.operand0,1n,true),status:2,reason:B.REASON.CHECKPOINT},
  {name:'return-unmapped-stack',ret:true,kind:'unmapped',status:1,reason:B.REASON.UNMAPPED},
  {name:'return-noncanonical-PC',ret:true,returnPC:1n<<47n,status:2,reason:B.REASON.CONTROL_TARGET},
  {name:'return-unmapped-PC',ret:true,returnPC:CODE+8192n,status:2,reason:B.REASON.CONTROL_TARGET},
  {name:'return-cross-page-unmapped',ret:true,offset:8190n,status:1,reason:B.REASON.UNMAPPED},
  {name:'call-cross-page-unmapped',offset:4n,status:1,reason:B.REASON.UNMAPPED},
 ])for(const variant of spec.ret?['return']:['direct','register']){
  const f=fixture(spec);try{
   if(variant==='register')f.view.setBigUint64(f.g,modes.indirect.ret.rip,true);
   if(spec.returnPC!==undefined)f.space.write(f.view.getBigUint64(f.g+32,true),pack(spec.returnPC));
   const bytes=spec.kind==='unmapped'?null:f.space.read(STACK,8192),budget=f.budget.stats().ownedPayloadBytes;
   const frame=spec.kind==='unmapped'?null:[f.space.mappingInfo(STACK),f.space.mappingInfo(STACK+4096n)];
   const done=await f.step(spec.ret?U.ret:variant==='register'?modes.indirect.call:U.call,{alter:spec.alter});assert.equal(done.status,spec.status,spec.name);assert.equal(done.memory.reason,spec.reason,spec.name);
   if(bytes)assert.deepEqual(f.space.read(STACK,8192),bytes,spec.name+' stack unchanged');assert.equal(f.budget.stats().ownedPayloadBytes,budget);if(frame)assert.deepEqual([f.space.mappingInfo(STACK),f.space.mappingInfo(STACK+4096n)],frame);failures.push({name:spec.name,variant,status:done.status,reason:done.memory.reason,faultAddress:String(done.memory.faultAddress??0n)});
  }finally{f.close();}
 }
 const edgeCall=await compile(CODE+512n,call(CODE+512n,CODE+4095n)),edgeReturn=await compile(CODE+4095n,[0xc3]);
 const stackTargetCall=await compile(CODE+320n,[0xff,0xd4]);
 for(const kind of ['private','private-view']){
  const f=fixture({kind,offset:4100n});try{
   const target=STACK+4100n;f.space.write(target,Uint8Array.of(0xc3));f.space.protect(STACK+4096n,4096n,5);
   const before=f.space.read(STACK,8192),frames=[f.space.mappingInfo(STACK),f.space.mappingInfo(STACK+4096n)],owned=f.budget.stats().ownedPayloadBytes;
   const result=await f.step(stackTargetCall);assert.equal(result.status,1);assert.equal(result.memory.reason,B.REASON.PROTECTION);assert.equal(result.memory.faultAddress,STACK+4096n);
   assert.deepEqual(f.space.read(STACK,8192),before);assert.deepEqual([f.space.mappingInfo(STACK),f.space.mappingInfo(STACK+4096n)],frames);assert.equal(f.budget.stats().ownedPayloadBytes,owned);
   failures.push({name:'register-call-RSP-cross-page-protection',kind,status:result.status,faultAddress:String(result.memory.faultAddress)});
  }finally{f.close();}
 }
 {const f=fixture();try{assert.equal((await f.step(edgeCall)).rip,edgeReturn.rip);assert.equal((await f.step(edgeReturn)).rip,edgeCall.nextRip);}finally{f.close();}}
 const metadata=[];for(const [rip,disp,supported]of [[CODE,-2147483648,true],[CODE,2147483647,true],[0x7f000006a986n,-214219,true],[0n,-6,false],[(1n<<47n)-6n,1,false],[(1n<<47n)-5n,0,false],[(1n<<64n)-32n,0,false]]){
  const bytes=new Uint8Array(5);bytes[0]=0xe8;new DataView(bytes.buffer).setInt32(1,disp,true);const u=await request(rip,bytes);assert.equal(u.status,supported?0:2,'target '+rip+' '+disp);
  if(supported)assert.equal(u.branchTarget,rip+5n+BigInt(disp));else{assert.equal(u.code.length,0);assert.equal(u.nextRip,rip);}metadata.push({rip:String(rip),displacement:disp,status:u.status});
 }
 const negatives={pushWord:[0x66,0x50],popWord:[0x66,0x58],retImm:[0xc2,8,0],farRet:[0xcb],farRetImm:[0xca,8,0],iret:[0xcf],farCall:[0x9a,0,0,0,0,0,0],farIndirectCall:[0xff,0xd8],memoryCall:[0xff,0x10]};
 for(const prefix of [0x66,0x67,0x64,0x65,0xf0,0xf2,0xf3,0x48]){negatives['call-prefix-'+prefix]=[prefix,0xe8,0,0,0,0];negatives['return-prefix-'+prefix]=[prefix,0xc3];}
 for(let n=1;n<5;n++)negatives['truncated-call-'+n]=[0xe8,0,0,0,0].slice(0,n);
 const rejected=[];for(const [name,bytes]of Object.entries(negatives)){
  const u=await request(CODE,Uint8Array.from(bytes));assert.equal(u.status,2,name+': '+log());assert.equal(u.code.length,0);assert.equal(u.nextRip,CODE);rejected.push(name);
 }
 const report={evidence:'Actual sparse FEX/Wasm direct and all-register indirect CALL, pre-push RSP target, checked plain RET, native x86 flag/stack oracle, checked target/stack failures. No Wine command, WebKit or device claim.',nativeOracle,coverageVersion:cfg.coverageVersion,buildID:cfg.buildID,records,registerChecks:registerRecords.length,registerRecords,failures,rejected,metadata,native:await(await get('/xlat/stats')).json()};
 const text=JSON.stringify(report,null,2);if(process.argv[3])fs.writeFileSync(process.argv[3],text+'\n');console.log(text);
 });}
main().catch(error=>{console.error(error);process.exitCode=1;});
