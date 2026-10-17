// SPDX-License-Identifier: GPL-3.0-or-later
// Non-LOCK OR memory: native x86 arithmetic oracle and actual sparse FEX/Wasm.
const fs=require('fs'),path=require('path'),os=require('os'),vm=require('vm'),assert=require('node:assert/strict'),{spawnSync}=require('child_process');
const {serve}=require('./native-step-contract.cjs'),golden=require('./sparse-memory-or-oracle.json');
for(const n of ['guest_memory','guest_memory_broker','thread_core'])vm.runInThisContext(fs.readFileSync(path.resolve(__dirname,'../../../Sources/BetterJITLinux/Resources/linux',n+'.js'),'utf8'));
const M=BetterJITGuestMemory,B=BetterJITGuestMemoryBroker,CODE=0x123400008000n,SC=CODE+0x100n,DATA=0x123456780000n,MASK=0x8c5n;
const pack=n=>{const b=new Uint8Array(8);new DataView(b.buffer).setBigUint64(0,BigInt.asUintN(64,n),true);return b;};
const value=b=>new DataView(b.buffer,b.byteOffset,8).getBigUint64(0,true);
function oracle(){
 if(process.platform!=='linux'||process.arch!=='x64')return {supported:false,reason:'Retained Linux x86 oracle checked by FEX/Wasm; no native oracle execution on this host'};
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'betterjit-memory-or-'));
 try{const binary=path.join(directory,'oracle'),build=spawnSync(process.env.CC||'cc',['-std=gnu11','-O2','-mno-red-zone','-Wall','-Wextra','-Werror',path.join(__dirname,'sparse-memory-or-oracle.c'),'-o',binary],{encoding:'utf8',timeout:10000});assert.equal(build.status,0,build.stderr);
  const run=spawnSync(binary,[],{encoding:'utf8',timeout:10000});assert.equal(run.status,0,run.stderr);assert.deepEqual(JSON.parse(run.stdout),golden);return {supported:true,rows:golden.length};
 }finally{fs.rmSync(directory,{recursive:true,force:true});}
}
function forms(width){const rex=width===8?[0x48]:[],disp=pack(DATA-(CODE+BigInt(width===8?7:6))).slice(0,4);
 return [
  {name:'rax-rdx',code:[...rex,9,0x10],regs:{0:DATA},source:2},
  {name:'r8-r10',code:[width===8?0x4d:0x45,9,0x10],regs:{8:DATA},source:10},
  {name:'positive-disp8',code:[...rex,9,0x50,0x7f],regs:{0:DATA-127n},source:2},
  {name:'rex-sib-negative-disp8',code:[width===8?0x4f:0x47,9,0x54,0xac,0x80],regs:{12:DATA+116n,13:3n},source:10},
  {name:'base-index-scale1',code:[...rex,9,0x14,8],regs:{0:DATA-3n,1:3n},source:2},
  {name:'index-only-scale4',code:[...rex,9,0x14,0x8d,0,0,1,0],regs:{1:(DATA-65536n)/4n},source:2},
  {name:'rip-relative',code:[...rex,9,0x15,...disp],regs:{},source:2},
  {name:'wine-rsp-negative-disp8',code:[...rex,9,0x74,0x24,0x88],regs:{4:DATA+120n},source:6},
  {name:'rsp-source',code:[...rex,9,0x20],regs:{0:DATA},source:4},
  {name:'source-address-alias',code:[...rex,9,0],regs:{0:DATA},source:0,alias:true},
  {name:'source-index-alias',code:[...rex,9,0x0c,0x88],regs:{},source:1,configure:(f,row)=>f.view.setBigUint64(f.g,BigInt.asUintN(64,DATA-BigInt(row.source)*4n),true)},
  {name:'source-base-index-alias',code:[...rex,9,0x04,0x80],regs:{0:DATA},source:0,alias:true,address:DATA*5n},
  {name:'r12-index',code:[width===8?0x4a:0x42,9,0x14,0xa0],regs:{0:DATA-12n,12:3n},source:2},
  ...[2n,8n].map(scale=>({name:'SIB-scale-'+scale,code:[...rex,9,0x14,scale===2n?0x48:0xc8],regs:{0:DATA-3n*scale,1:3n},source:2})),
  {name:'negative-disp32',code:[...rex,9,0x90,0,0,0xff,0xff],regs:{0:DATA+65536n},source:2},
  {name:'rip-relative-rexB',code:[width===8?0x49:0x41,9,0x15,...pack(DATA-CODE-7n).slice(0,4)],regs:{},source:2},
  ...Array.from({length:16},(_,r)=>({name:'source-register-'+r,code:[...(r>=8?[width===8?0x4c:0x44]:rex),9,(r&7)<<3],regs:{0:DATA},source:r,alias:r===0}))
 ];
}
async function main(){const nativeOracle=oracle();await serve('guestmem=broker1',async(get,log)=>{
 const cfg=await(await get('/xlat/config')).json(),state=new Uint8Array(await(await get('/xlat/state')).arrayBuffer());assert.equal(cfg.coverageVersion,24);
 async function compile(code,rip=CODE){await get('/xlat/code?addr='+rip.toString(16),{method:'POST',body:Uint8Array.from(code)});const u=FexLinuxThread.parseBrokerStep(new Uint8Array(await(await get('/xlat/step?rip='+rip)).arrayBuffer()));assert.equal(u.status,0,Buffer.from(code).toString('hex')+': '+log());u.module=await WebAssembly.compile(u.code);assert(WebAssembly.Module.imports(u.module).every(i=>i.module==='e'&&['mem','tb','memory'].includes(i.name)));return u;}
 const branchUnits=[];for(const op of [0x72,0x73,0x74,0x75,0x78,0x79])branchUnits.push(await compile([op,2],SC+0x200n+BigInt(op)*8n));
 const syscall=await compile([15,5],SC),seeds=[await compile([0x45,1,0xc9],SC+0x100n),await compile([0x49,0x83,0xe9,1],SC+0x120n)],units={};let executedWasmSteps=0,checkedORs=0,branchChecks=0;
 function fixture({budget=new M.BackingBudget(),space=new M.GuestAddressSpace(budget,{virtualLimit:1n<<47n}),broker=new B.GuestMemoryBroker()}={}){
  const memory=B.createInternalMemory(),token=broker.register(0,{space,memory,checkpointLayout:cfg.checkpoint}),view=new DataView(memory.buffer),tb=B.ABI.threadBase,g=tb+cfg.ctx+cfg.gregsOff,scratch=new DataView(memory.buffer,tb+B.ABI.scratchOffset,128);let sequence=0;
  const spans=['cpu','lazyFlags','roundMode'],snapshot=()=>spans.map(n=>{const p=cfg.checkpoint[n];return new Uint8Array(memory.buffer,tb+p.offset,p.size).slice();});
  const f={budget,space,memory,broker,token,view,tb,g,scratch,snapshot,close(){broker.unregister(token);space.close();}};
  f.reset=(source,address=DATA,sourceReg=2)=>{new Uint8Array(memory.buffer).fill(0);new Uint8Array(memory.buffer,tb+cfg.ctx,state.length).set(state);scratch.setBigUint64(B.FIELD.lease,token.generation,true);for(let r=0;r<16;r++)view.setBigUint64(g+8*r,0xabcdef0000000000n+BigInt(r),true);view.setBigUint64(g,address,true);view.setBigUint64(g+8*sourceReg,source,true);};
  f.step=async(u,{finish=true,alter,afterRun}={})=>{view.setBigUint64(tb+cfg.ctx+cfg.ripOff,u.rip,true);const generation=broker.beginInstruction(token,{...u});scratch.setBigUint64(B.FIELD.checkpoint,generation,true);
   const before=snapshot(),requests=broker.stats().requests,instance=await WebAssembly.instantiate(u.module,{e:{mem:memory,tb:new WebAssembly.Global({value:'i32'},tb),memory:()=>{scratch.setUint32(B.FIELD.sequence,++sequence,true);alter?.(f);return broker.dispatch(token,{lease:token.generation,sequence}).status;}}});
   const status=instance.exports.run();executedWasmSteps++;afterRun?.(f);if(finish)broker.finishInstruction(token,{status,nextRip:u.nextRip});assert.equal(broker.stats().requests-requests,u.operation===B.OP.OR_MEMORY?1:0);return {status,before};};return f;
 }
 const records=[];
 for(const width of [4,8])for(const form of forms(width)){
  const u=await compile(form.code);assert.equal(u.operation,B.OP.OR_MEMORY);assert.equal(u.width,width);assert.deepEqual([...u.instruction],form.code);units[width]??=u;
  const f=fixture(),target=form.address??DATA;f.space.mapAnonymous(target,8192n,3);
  try{let rows=0;for(const row of golden.filter(r=>r.width===width&&(!form.alias||BigInt(r.source)===DATA))){
   f.space.write(target,pack(BigInt(row.initial)));f.reset(BigInt(row.source),DATA,form.source);for(const [r,n]of Object.entries(form.regs))f.view.setBigUint64(f.g+8*Number(r),n,true);form.configure?.(f,row);
   if(form.source!==9){f.view.setBigUint64(f.g+9*8,rows%2?0n:0x80000000n,true);assert.equal((await f.step(seeds[rows%2])).status,0);}
   const registers=Array.from({length:16},(_,r)=>f.view.getBigUint64(f.g+8*r,true)),round=f.snapshot()[2];
   assert.equal((await f.step(u)).status,0);checkedORs++;assert.equal(value(f.space.read(target,8)),BigInt(row.memory));
   assert.deepEqual(Array.from({length:16},(_,r)=>f.view.getBigUint64(f.g+8*r,true)),registers,'OR memory preserves all GPRs');assert.deepEqual(f.snapshot()[2],round);
   if(form.name==='rax-rdx')for(let i=0;i<branchUnits.length;i++){const branch=branchUnits[i],flags=BigInt(row.flags),taken=[(flags&1n)!==0n,(flags&1n)===0n,(flags&64n)!==0n,(flags&64n)===0n,(flags&128n)!==0n,(flags&128n)===0n][i];assert.equal((await f.step(branch)).status,0);assert.equal(f.view.getBigUint64(f.tb+cfg.ctx+cfg.ripOff,true),taken?branch.branchTarget:branch.nextRip);branchChecks++;}
   assert.equal((await f.step(syscall)).status,B.STEP.SYSCALL);assert.equal(f.view.getBigUint64(f.g+11*8,true)&MASK,BigInt(row.flags));rows++;
  }records.push({width,form:form.name,rows,oneRPCPerOR:true,allGPRsPreserved:true});}finally{f.close();assert.equal(f.budget.stats().ownedPayloadBytes,0);}
 }
 const edges=[];
 for(const width of [4,8])for(const kind of ['unaligned','cross-page','shared-cross-page','cow-cross-page','read-only','write-only','second-unmapped','second-read-only','second-write-only','allocation-first','allocation-second','range']){
  const cross=!['unaligned','read-only','write-only','range'].includes(kind),address=kind==='range'?(1n<<64n)-4n:DATA+(cross?4093n:1n),cow=kind.includes('cow')||kind.startsWith('allocation'),shared=cow||kind==='shared-cross-page',budget=new M.BackingBudget({limitBytes:kind==='allocation-first'?8192:kind==='allocation-second'?12288:32768}),f=fixture({budget});let object,alias;
  if(shared){object=new M.SharedBacking(budget,8192n);alias=new M.GuestAddressSpace(budget,{virtualLimit:1n<<47n});alias.mapShared(DATA,8192n,object);alias.write(DATA+4093n,pack(0x0123456789abcdefn));f.space.mapShared(DATA,8192n,object,0n,{privateView:cow});}
  else{f.space.mapAnonymous(DATA,8192n,3);f.space.write(DATA+1n,pack(7n));f.space.write(DATA+4093n,pack(0x0123456789abcdefn));}
  if(kind==='read-only')f.space.protect(DATA,8192n,1);if(kind==='write-only')f.space.protect(DATA,8192n,2);
  if(kind==='second-unmapped')f.space.unmap(DATA+4096n,4096n);if(kind==='second-read-only')f.space.protect(DATA+4096n,4096n,1);if(kind==='second-write-only')f.space.protect(DATA+4096n,4096n,2);
  const beforeBytes=kind==='write-only'||kind==='second-write-only'?null:f.space.read(DATA,kind==='second-unmapped'?4096:8192),beforeBudget=budget.stats().ownedPayloadBytes;
  const source=0x8040201008040201n;f.reset(kind==='read-only'?0n:source,address);const success=['unaligned','cross-page','shared-cross-page','cow-cross-page'].includes(kind),u=units[width];
  try{const done=await f.step(u);assert.equal(done.status,success?0:1,kind);checkedORs++;
   if(success){const initial=cross?0x0123456789abcdefn:7n,mask=(1n<<BigInt(width*8))-1n;assert.equal(value(f.space.read(address,8)),(initial&~mask)|((initial|source)&mask));if(alias)assert.equal(value(alias.read(address,8)),cow?initial:((initial&~mask)|((initial|source)&mask)));}
   else{f.snapshot().forEach((bytes,i)=>assert.deepEqual(bytes,done.before[i],kind+' full checkpoint rollback'));assert.equal(budget.stats().ownedPayloadBytes,beforeBudget,kind+' COW rollback');if(beforeBytes)assert.deepEqual(f.space.read(DATA,beforeBytes.length),beforeBytes);const reason=f.scratch.getUint32(B.FIELD.reason,true);assert.equal(reason,kind.startsWith('allocation')?B.REASON.ALLOCATION:kind==='range'?B.REASON.RANGE:kind==='second-unmapped'?B.REASON.UNMAPPED:B.REASON.PROTECTION);if(kind.startsWith('second-'))assert.equal(f.scratch.getBigUint64(B.FIELD.faultAddress,true),DATA+4096n);}
   edges.push({width,kind,status:done.status,oneRPC:true,checkpointRestored:!success});
  }finally{f.close();alias?.close();object?.close();assert.equal(budget.stats().ownedPayloadBytes,0);}
 }
 for(const width of [4,8])for(const kind of ['end-of-mapping','virtual-edge']){
  const address=kind==='virtual-edge'?(1n<<47n)-4n:DATA+8188n,f=fixture(),start=kind==='virtual-edge'?address&~4095n:DATA;
  f.space.mapAnonymous(start,kind==='virtual-edge'?4096n:8192n,3);f.space.write(address,pack(4n).slice(0,4));f.reset(0x80000000n,address);const owned=f.budget.stats().ownedPayloadBytes;
  try{const done=await f.step(units[width]);checkedORs++;assert.equal(done.status,width===4?0:1);if(width===4)assert.deepEqual(f.space.read(address,4),pack(0x80000004n).slice(0,4));else{done.before.forEach((v,i)=>assert.deepEqual(f.snapshot()[i],v));assert.deepEqual(f.space.read(address,4),pack(4n).slice(0,4));assert.equal(f.scratch.getUint32(B.FIELD.reason,true),kind==='virtual-edge'?B.REASON.RANGE:B.REASON.UNMAPPED);}assert.equal(f.budget.stats().ownedPayloadBytes,owned);edges.push({width,kind,status:done.status,completeWidthChecked:true});}finally{f.close();}
 }
 const callbackCases=[];
 for(const kind of ['retired-owner','reused-slot','alias-revision']){
  let armed=false,callback=()=>{},fresh;const budget=new M.BackingBudget({allocatePage:n=>{if(armed){armed=false;callback();}return new Uint8Array(n);}}),object=new M.SharedBacking(budget,8192n),f=fixture({budget}),alias=new M.GuestAddressSpace(budget,{virtualLimit:1n<<47n});
  alias.mapShared(DATA,8192n,object);alias.write(DATA+4093n,pack(7n));f.space.mapShared(DATA,8192n,object,0n,{privateView:true});f.reset(8n,DATA+4093n);f.view.setBigUint64(f.tb+cfg.ctx+cfg.ripOff,CODE,true);
  const before=f.snapshot(),mapping=[f.space.mappingInfo(DATA).frameId,f.space.mappingInfo(DATA+4096n).frameId],owned=budget.stats().ownedPayloadBytes;
  callback=()=>{if(kind==='alias-revision')alias.write(DATA+4093n,pack(11n));else{f.broker.unregister(f.token);if(kind==='reused-slot')fresh=fixture({budget,space:f.space,broker:f.broker});}};armed=true;
  try{await assert.rejects(f.step(units[8]),kind==='alias-revision'?/Prepared backing changed/:/owner changed/);f.snapshot().forEach((bytes,i)=>assert.deepEqual(bytes,before[i]));
   assert.equal(value(f.space.read(DATA+4093n,8)),kind==='alias-revision'?11n:7n);assert.equal(budget.stats().ownedPayloadBytes,owned);assert.deepEqual([f.space.mappingInfo(DATA).frameId,f.space.mappingInfo(DATA+4096n).frameId],mapping);
   if(fresh){assert.notEqual(fresh.token.generation,f.token.generation);fresh.reset(16n,DATA+4093n);assert.equal((await fresh.step(units[8])).status,0);assert.equal(value(f.space.read(DATA+4093n,8)),23n);assert.equal(value(alias.read(DATA+4093n,8)),7n);}
   callbackCases.push({kind,noORCommit:true,fullCheckpointPreserved:true,stagedPagesReleased:true,freshOwnerUnaffected:!!fresh});
  }finally{armed=false;fresh?.close();f.close();alias.close();object.close();assert.equal(budget.stats().ownedPayloadBytes,0);}
 }
 const forged=[];
 for(const width of [4,8])for(const kind of ['address','source','write','atomic','width','checkpoint','rip','access']){
  const f=fixture();f.space.mapAnonymous(DATA,8192n,3);f.space.write(DATA,pack(7n));f.reset(8n);const before=f.snapshot(),bytes=f.space.read(DATA,8192);
  try{const done=await f.step(units[width],{alter:x=>{const q=x.scratch,F=B.FIELD;
   if(kind==='address')q.setBigUint64(F.address,DATA+8n,true);if(kind==='source')q.setBigUint64(F.operand0,9n,true);
   if(kind==='write'||kind==='atomic')q.setUint32(F.operation,kind==='write'?2:4,true);if(kind==='width')q.setUint32(F.width,width===4?8:4,true);
   if(kind==='checkpoint')q.setBigUint64(F.checkpoint,99n,true);if(kind==='rip')q.setBigUint64(F.rip,CODE+1n,true);if(kind==='access')q.setUint32(F.access,2,true);
  }});assert.equal(done.status,2);done.before.forEach((v,i)=>assert.deepEqual(f.snapshot()[i],v));assert.deepEqual(f.space.read(DATA,8192),bytes);forged.push({width,kind,noMemoryCommit:true,fullCheckpointRestored:true});}finally{f.close();}
 }
 const refused=[];for(const code of [[0xf0,0x48,9,0x10],[0x66,9,0x10],[0x66,0x48,9,0x10],[0x67,0x48,9,0x10],[0x64,0x48,9,0x10],[0x65,0x48,9,0x10],[0xf3,0x48,9,0x10],[0xf2,0x48,9,0x10],[8,0x10],[0x48,0x11,0x10],[0x48,0x29,0x10],[0x48,0x83,8,1],[0x48,0x81,8,1,0,0,0],[0x48,9],[0x48,9,0x54],[0x48,9,0x54,0x8c],[0x49,9,4,0x25,0,0,1,0],[0x41,9,4,0x25,0,0,1,0],[0x40,0x48,9,0x10]]){
  await get('/xlat/code?addr='+CODE.toString(16),{method:'POST',body:Uint8Array.from(code)});const bytes=new Uint8Array(await(await get('/xlat/step?rip='+CODE)).arrayBuffer()),u=FexLinuxThread.parseBrokerStep(bytes);assert.equal(u.status,2,Buffer.from(code).toString('hex'));assert.equal(u.code.length,0);refused.push(Buffer.from(code).toString('hex'));
 }

 const result={evidence:'Actual FEX/Wasm non-LOCK OR r/m32,r32 and r/m64,r64 against independently executed native x86 result/CF/PF/ZF/SF/OF (AF undefined) rows. Synthetic memory, not Wine, device or guest LOCK atomicity evidence.',cfg,nativeOracle,oracleRows:golden.length,checkedORs,executedWasmSteps,branchChecks,records,edges,callbackCases,forged,refused,native:await(await get('/xlat/totals')).json()};
 const text=JSON.stringify(result,null,2)+'\n';if(process.argv[3])fs.writeFileSync(process.argv[3],text);console.log(JSON.stringify({...result,cfg:undefined,records:records.length,edges:edges.length,callbackCases:callbackCases.length,forged:forged.length,refused:refused.length}));
 });}
main().catch(error=>{console.error(error);process.exitCode=1;});
