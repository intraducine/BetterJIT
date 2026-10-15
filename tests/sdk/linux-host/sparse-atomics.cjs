// SPDX-License-Identifier: GPL-3.0-or-later
// Fresh FEX/Wasm atomics against a separately compiled native x86 oracle.
const fs=require('fs'),path=require('path'),vm=require('vm'),os=require('os'),assert=require('node:assert/strict'),{spawnSync}=require('child_process');
const {serve}=require('./native-step-contract.cjs');
for(const name of ['guest_memory','guest_memory_broker','thread_core'])vm.runInThisContext(fs.readFileSync(
 path.resolve(__dirname,'../../../Sources/BetterJITLinux/Resources/linux',name+'.js'),'utf8'));
const M=BetterJITGuestMemory,B=BetterJITGuestMemoryBroker,CODE=0x12340000c000n,SC=CODE+0x80n,DATA=0x123456780000n,MASK=0x8d5n;
const pack=(value,width=8)=>{const b=new Uint8Array(width);let x=BigInt.asUintN(64,value);for(let i=0;i<width;i++){b[i]=Number(x&255n);x>>=8n;}return b;};
const number=bytes=>bytes.reduceRight((value,x)=>value<<8n|BigInt(x),0n);
function nativeOracle() {
 if(process.platform!=='linux'||process.arch!=='x64')throw Error('Independent oracle requires a Linux x86-64 host');
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'betterjit-atomic-oracle-'));
 try {
  const binary=path.join(directory,'oracle'),build=spawnSync(process.env.CC||'cc',['-std=gnu11','-O2','-Wall','-Wextra','-Werror',
   path.join(__dirname,'sparse-atomic-oracle.c'),'-o',binary],{encoding:'utf8',timeout:10000});
  assert.equal(build.status,0,build.stderr||String(build.error));
  const run=spawnSync(binary,[],{encoding:'utf8',timeout:10000});assert.equal(run.status,0,run.stderr||String(run.error));
  const result=JSON.parse(run.stdout);assert.equal(result.failedCompareReadOnlyFault,true);return result;
 } finally {fs.rmSync(directory,{recursive:true,force:true});}
}
async function main() {
 const oracle=nativeOracle();
 await serve('guestmem=broker1',async(get,log)=>{
  const cfg=await(await get('/xlat/config')).json(),state=new Uint8Array(await(await get('/xlat/state')).arrayBuffer()),records=[];
  async function compile(rip,code) {
   await get('/xlat/code?addr='+rip.toString(16),{method:'POST',body:Uint8Array.from(code)});
   const u=FexLinuxThread.parseBrokerStep(new Uint8Array(await(await get('/xlat/step?rip='+rip)).arrayBuffer()));
   if(u.status!==0){await new Promise(r=>setTimeout(r,10));throw Error('Atomic/flags unit rejected: '+log());}
   u.module=await WebAssembly.compile(u.code);return u;
  }
  const syscall=await compile(SC,[0x0f,0x05]);
  for(const row of oracle.records) {
   const code=[0xf0,...(row.width===8?[0x48]:[]),0x0f,row.operation===3?0xb1:0xc1,row.operation===3?0x13:0x03],
    unit=await compile(CODE,code),space=new M.GuestAddressSpace(new M.BackingBudget(),{virtualLimit:1n<<47n}),
    memory=B.createInternalMemory(),broker=new B.GuestMemoryBroker(),token=broker.register(0,{space,memory,checkpointLayout:cfg.checkpoint}),
    v=new DataView(memory.buffer),tb=B.ABI.threadBase,g=tb+cfg.ctx+cfg.gregsOff,scratch=new DataView(memory.buffer,tb+B.ABI.scratchOffset,128);
   space.mapAnonymous(DATA,4096n,3);space.write(DATA,pack(BigInt(row.initial),row.width));new Uint8Array(memory.buffer,tb+cfg.ctx,state.length).set(state);
   v.setBigUint64(g,BigInt(row.operand),true);v.setBigUint64(g+16,BigInt(row.desired),true);v.setBigUint64(g+24,DATA,true);
   let sequence=0;
   async function step(u) {
    v.setBigUint64(tb+cfg.ctx+cfg.ripOff,u.rip,true);
    const generation=broker.beginInstruction(token,{rip:u.rip,operation:u.operation,width:u.width});scratch.setBigUint64(B.FIELD.checkpoint,generation,true);
    const instance=await WebAssembly.instantiate(u.module,{e:{mem:memory,tb:new WebAssembly.Global({value:'i32'},tb),memory:()=>{
     scratch.setUint32(B.FIELD.sequence,++sequence,true);return broker.dispatch(token,{lease:token.generation,sequence}).status;
    }}});
    const status=instance.exports.run();broker.finishInstruction(token,{status,nextRip:u.nextRip});return status;
   }
   assert.equal(await step(unit),0,row.name);assert.equal(v.getBigUint64(g,true),BigInt(row.register),row.name+' register');
   assert.equal(number(space.read(DATA,row.width)),BigInt(row.memory),row.name+' memory');
   // The generated SYSCALL unit only spills/returns STEP_SYSCALL here; no host
   // syscall is dispatched. Its R11 is the actual FEX-packed arithmetic flags.
   assert.equal(await step(syscall),B.STEP.SYSCALL);const flags=v.getBigUint64(g+11*8,true);
   assert.equal(flags&MASK,BigInt(row.flags)&MASK,row.name+' defined arithmetic flags');
   assert.equal(v.getBigUint64(g+8,true),SC+2n,'full RCX return pointer');
   records.push({name:row.name,operation:row.operation,width:row.width,register:row.register,memory:row.memory,
    flags:'0x'+(flags&MASK).toString(16),nativeFlags:'0x'+(BigInt(row.flags)&MASK).toString(16)});
   broker.unregister(token);space.close();
  }
  const edgeCases=[];
  for(const kind of ['readonly-mismatch','unaligned','allocation-failure']) {
   const operation=kind==='readonly-mismatch'?3:4,unit=await compile(CODE,
    [0xf0,0x48,0x0f,operation===3?0xb1:0xc1,operation===3?0x13:0x03]),
    budget=new M.BackingBudget({limitBytes:kind==='allocation-failure'?4096:16384}),
    space=new M.GuestAddressSpace(budget,{virtualLimit:1n<<47n}),memory=B.createInternalMemory(),broker=new B.GuestMemoryBroker();
   let object;const address=kind==='unaligned'?DATA+1n:DATA;
   if(kind==='allocation-failure'){object=new M.SharedBacking(budget,4096n);space.mapShared(DATA,4096n,object,0n,{privateView:true});}
   else {space.mapAnonymous(DATA,4096n,3);space.write(address,pack(7n));if(kind==='readonly-mismatch')space.protect(DATA,4096n,1);}
   const token=broker.register(0,{space,memory,checkpointLayout:cfg.checkpoint}),v=new DataView(memory.buffer),tb=B.ABI.threadBase,
    g=tb+cfg.ctx+cfg.gregsOff,scratch=new DataView(memory.buffer,tb+B.ABI.scratchOffset,128);
   new Uint8Array(memory.buffer,tb+cfg.ctx,state.length).set(state);v.setBigUint64(tb+cfg.ctx+cfg.ripOff,CODE,true);
   v.setBigUint64(g,operation===3?0n:1n,true);v.setBigUint64(g+16,9n,true);v.setBigUint64(g+24,address,true);
   const pre=['cpu','lazyFlags','roundMode'].map(n=>{const p=cfg.checkpoint[n];return new Uint8Array(memory.buffer,tb+p.offset,p.size).slice();});
   const generation=broker.beginInstruction(token,{rip:CODE,operation,width:8});scratch.setBigUint64(B.FIELD.checkpoint,generation,true);
   const instance=await WebAssembly.instantiate(unit.module,{e:{mem:memory,tb:new WebAssembly.Global({value:'i32'},tb),memory:()=>{
    scratch.setUint32(B.FIELD.sequence,1,true);return broker.dispatch(token,{lease:token.generation,sequence:1}).status;
   }}});
   const status=instance.exports.run(),expected=kind==='unaligned'?2:1;assert.equal(status,expected,kind);
   broker.finishInstruction(token,{status,nextRip:unit.nextRip});
   ['cpu','lazyFlags','roundMode'].forEach((n,i)=>{const p=cfg.checkpoint[n];assert.deepEqual(new Uint8Array(memory.buffer,tb+p.offset,p.size),pre[i]);});
   assert.equal(number(space.read(address,8)),kind==='allocation-failure'?0n:7n);
   const reason=scratch.getUint32(B.FIELD.reason,true);assert.equal(reason,kind==='unaligned'?B.REASON.ALIGNMENT:
    kind==='readonly-mismatch'?B.REASON.PROTECTION:B.REASON.ALLOCATION);
   edgeCases.push({kind,status,reason,fullCheckpointRestored:true,noMemoryEffect:true});
   broker.unregister(token);space.close();object?.close();assert.equal(budget.stats().ownedPayloadBytes,0);
  }
  const result={evidence:'Independent native x86-64 register/memory/flag oracle versus actual FEX-generated Wasm. Spilled SYSCALL is a flags probe; kernel futex routing is tested separately.',
   nativeOracle:oracle,records,edgeCases,native:await(await get('/xlat/stats')).json(),stepABI:cfg.stepABI,coverageVersion:cfg.coverageVersion};
  const text=JSON.stringify(result,null,2);if(process.argv[3])fs.writeFileSync(process.argv[3],text+'\n');console.log(text);
 });
}
main().catch(error=>{console.error(error);process.exitCode=1;});
