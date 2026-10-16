// SPDX-License-Identifier: GPL-3.0-or-later
// Register-destination memory-source ADD: native x86 oracle and sparse FEX/Wasm.
const fs=require('fs'),path=require('path'),os=require('os'),vm=require('vm'),assert=require('node:assert/strict'),{spawnSync}=require('child_process');
const {serve}=require('./native-step-contract.cjs'),golden=require('./sparse-read-add-oracle.json');
for(const n of ['guest_memory','guest_memory_broker','thread_core'])vm.runInThisContext(fs.readFileSync(path.resolve(__dirname,'../../../Sources/BetterJITLinux/Resources/linux',n+'.js'),'utf8'));
const M=BetterJITGuestMemory,B=BetterJITGuestMemoryBroker,CODE=0x123400008000n,SC=CODE+0x100n,DATA=0x123456780000n,MASK=0x8d5n;
const pack=n=>{const b=new Uint8Array(8);new DataView(b.buffer).setBigUint64(0,BigInt.asUintN(64,n),true);return b;};
const value=b=>new DataView(b.buffer,b.byteOffset,8).getBigUint64(0,true);
function oracle(){
 if(process.platform!=='linux'||process.arch!=='x64')return {supported:false,reason:'Retained Linux x86 oracle checked by FEX/Wasm; no native oracle execution on this host'};
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'betterjit-read-add-'));
 try{const binary=path.join(directory,'oracle'),build=spawnSync(process.env.CC||'cc',['-std=gnu11','-O2','-mno-red-zone','-Wall','-Wextra','-Werror',path.join(__dirname,'sparse-read-add-oracle.c'),'-o',binary],{encoding:'utf8',timeout:10000});assert.equal(build.status,0,build.stderr);
  const run=spawnSync(binary,[],{encoding:'utf8',timeout:10000});assert.equal(run.status,0,run.stderr);assert.deepEqual(JSON.parse(run.stdout),golden);return {supported:true,rows:golden.length};
 }finally{fs.rmSync(directory,{recursive:true,force:true});}
}
function forms(width){const rex=width===8?[0x48]:[],disp=pack(DATA-(CODE+BigInt(width===8?7:6))).slice(0,4);
 return [
  {name:'rax-rdx',code:[...rex,3,0x10],regs:{0:DATA},source:2},
  {name:'r8-r10',code:[width===8?0x4d:0x45,3,0x10],regs:{8:DATA},source:10},
  {name:'positive-disp8',code:[...rex,3,0x50,0x7f],regs:{0:DATA-127n},source:2},
  {name:'rex-sib-negative-disp8',code:[width===8?0x4f:0x47,3,0x54,0xac,0x80],regs:{12:DATA+116n,13:3n},source:10},
  {name:'base-index-scale1',code:[...rex,3,0x14,8],regs:{0:DATA-3n,1:3n},source:2},
  {name:'index-only-scale4',code:[...rex,3,0x14,0x8d,0,0,1,0],regs:{1:(DATA-65536n)/4n},source:2},
  {name:'rip-relative',code:[...rex,3,0x15,...disp],regs:{},source:2},
  {name:'rsp-source',code:[...rex,3,0x20],regs:{0:DATA},source:4},
  {name:'source-address-alias',code:[...rex,3,0],regs:{0:DATA},source:0,alias:true},
  {name:'destination-index-alias',code:[...rex,3,0x0c,0x88],regs:{},source:1,configure:(f,row)=>f.view.setBigUint64(f.g,BigInt.asUintN(64,DATA-BigInt(row.source)*4n),true)},
  {name:'destination-base-index-alias',code:[...rex,3,0x04,0x80],regs:{0:DATA},source:0,alias:true,address:DATA*5n},
  {name:'r12-index',code:[width===8?0x4a:0x42,3,0x14,0xa0],regs:{0:DATA-12n,12:3n},source:2},
  ...[2n,8n].map(scale=>({name:'SIB-scale-'+scale,code:[...rex,3,0x14,scale===2n?0x48:0xc8],regs:{0:DATA-3n*scale,1:3n},source:2})),
  {name:'negative-disp32',code:[...rex,3,0x90,0,0,0xff,0xff],regs:{0:DATA+65536n},source:2},
  {name:'rip-relative-rexB',code:[width===8?0x49:0x41,3,0x15,...pack(DATA-CODE-7n).slice(0,4)],regs:{},source:2},
  ...Array.from({length:16},(_,r)=>({name:'destination-register-'+r,code:[...(r>=8?[width===8?0x4c:0x44]:rex),3,(r&7)<<3],regs:{0:DATA},source:r,alias:r===0}))
 ];
}
async function main(){const nativeOracle=oracle();await serve('guestmem=broker1',async(get,log)=>{
 const cfg=await(await get('/xlat/config')).json(),state=new Uint8Array(await(await get('/xlat/state')).arrayBuffer());assert.equal(cfg.coverageVersion,16);
 async function compile(code,rip=CODE){await get('/xlat/code?addr='+rip.toString(16),{method:'POST',body:Uint8Array.from(code)});const u=FexLinuxThread.parseBrokerStep(new Uint8Array(await(await get('/xlat/step?rip='+rip)).arrayBuffer()));assert.equal(u.status,0,Buffer.from(code).toString('hex')+': '+log());u.module=await WebAssembly.compile(u.code);assert(WebAssembly.Module.imports(u.module).every(i=>i.module==='e'&&['mem','tb','memory'].includes(i.name)));return u;}
 const syscall=await compile([15,5],SC),seeds=[await compile([0x45,1,0xc9],SC+0x100n),await compile([0x49,0x83,0xe9,1],SC+0x120n)],units={};let executedWasmSteps=0,checkedADDs=0;
 function fixture({budget=new M.BackingBudget(),space=new M.GuestAddressSpace(budget,{virtualLimit:1n<<47n}),broker=new B.GuestMemoryBroker()}={}){
  const memory=B.createInternalMemory(),token=broker.register(0,{space,memory,checkpointLayout:cfg.checkpoint}),view=new DataView(memory.buffer),tb=B.ABI.threadBase,g=tb+cfg.ctx+cfg.gregsOff,scratch=new DataView(memory.buffer,tb+B.ABI.scratchOffset,128);let sequence=0;
  const spans=['cpu','lazyFlags','roundMode'],snapshot=()=>spans.map(n=>{const p=cfg.checkpoint[n];return new Uint8Array(memory.buffer,tb+p.offset,p.size).slice();});
  const f={budget,space,memory,broker,token,view,tb,g,scratch,snapshot,close(){broker.unregister(token);space.close();}};
  f.reset=(source,address=DATA,sourceReg=2)=>{new Uint8Array(memory.buffer).fill(0);new Uint8Array(memory.buffer,tb+cfg.ctx,state.length).set(state);scratch.setBigUint64(B.FIELD.lease,token.generation,true);for(let r=0;r<16;r++)view.setBigUint64(g+8*r,0xabcdef0000000000n+BigInt(r),true);view.setBigUint64(g,address,true);view.setBigUint64(g+8*sourceReg,source,true);};
  f.step=async(u,{finish=true,alter,afterRun}={})=>{view.setBigUint64(tb+cfg.ctx+cfg.ripOff,u.rip,true);const generation=broker.beginInstruction(token,{...u});scratch.setBigUint64(B.FIELD.checkpoint,generation,true);
   const before=snapshot(),requests=broker.stats().requests,instance=await WebAssembly.instantiate(u.module,{e:{mem:memory,tb:new WebAssembly.Global({value:'i32'},tb),memory:()=>{scratch.setUint32(B.FIELD.sequence,++sequence,true);alter?.(f);return broker.dispatch(token,{lease:token.generation,sequence}).status;}}});
   const status=instance.exports.run();executedWasmSteps++;afterRun?.(f);if(finish)broker.finishInstruction(token,{status,nextRip:u.nextRip});assert.equal(broker.stats().requests-requests,u.operation===B.OP.ADD_REGISTER_MEMORY?1:0);return {status,before};};return f;
 }
 const records=[];
 for(const width of [4,8])for(const form of forms(width)){
  const u=await compile(form.code);assert.equal(u.operation,B.OP.ADD_REGISTER_MEMORY);assert.equal(u.width,width);assert.deepEqual([...u.instruction],form.code);units[width]??=u;
  const f=fixture(),target=form.address??DATA;f.space.mapAnonymous(target,8192n,3);
  try{let rows=0;for(const row of golden.filter(r=>r.width===width&&(!form.alias||BigInt(r.source)===DATA))){
   f.space.write(target,pack(BigInt(row.initial)));f.reset(BigInt(row.source),DATA,form.source);for(const [r,n]of Object.entries(form.regs))f.view.setBigUint64(f.g+8*Number(r),n,true);form.configure?.(f,row);
   if(form.source!==9){f.view.setBigUint64(f.g+9*8,rows%2?0n:0x80000000n,true);assert.equal((await f.step(seeds[rows%2])).status,0);}
   const registers=Array.from({length:16},(_,r)=>f.view.getBigUint64(f.g+8*r,true)),round=f.snapshot()[2];
   assert.equal((await f.step(u)).status,0);checkedADDs++;assert.equal(value(f.space.read(target,8)),BigInt(row.initial));registers[form.source]=BigInt(row.result);
   assert.deepEqual(Array.from({length:16},(_,r)=>f.view.getBigUint64(f.g+8*r,true)),registers,'ADD changes only the selected destination GPR');assert.deepEqual(f.snapshot()[2],round);
   assert.equal((await f.step(syscall)).status,B.STEP.SYSCALL);assert.equal(f.view.getBigUint64(f.g+11*8,true)&MASK,BigInt(row.flags));rows++;
  }records.push({width,form:form.name,rows,oneRPCPerADD:true,unrelatedGPRsPreserved:true});}finally{f.close();assert.equal(f.budget.stats().ownedPayloadBytes,0);}
 }
 const edges=[];
 for(const width of [4,8])for(const kind of ['unaligned','cross-page','read-only','second-read-only','shared-cross-page','private-view-budget-full','second-unmapped','second-protected','second-write-only','end-of-mapping','virtual-edge','range']){
  const address=kind==='range'?(1n<<64n)-3n:kind==='virtual-edge'?(1n<<47n)-4n:DATA+(kind==='unaligned'?1n:kind==='end-of-mapping'?8188n:4093n),budget=new M.BackingBudget({limitBytes:kind==='private-view-budget-full'?8192:32768}),f=fixture({budget});let backing,alias;
  if(kind==='shared-cross-page'||kind==='private-view-budget-full'){backing=new M.SharedBacking(budget,8192n);alias=new M.GuestAddressSpace(budget,{virtualLimit:1n<<47n});alias.mapShared(DATA,8192n,backing);alias.write(DATA+4093n,pack(0x7fffffffffffffffn));f.space.mapShared(DATA,8192n,backing,0n,{privateView:kind==='private-view-budget-full'});}
  else{f.space.mapAnonymous(DATA,8192n,3);f.space.write(DATA+1n,pack(7n));f.space.write(DATA+4093n,pack(0x7fffffffffffffffn));}
  if(kind==='virtual-edge')f.space.mapAnonymous(address&~4095n,4096n,3);if(kind==='virtual-edge'||kind==='end-of-mapping')f.space.write(address,pack(0x7fffffffn).slice(0,4));
  const original=f.space.read(DATA,8192),frames=[f.space.mappingInfo(DATA).frameId,f.space.mappingInfo(DATA+4096n).frameId];
  if(kind==='read-only')f.space.protect(DATA,8192n,1);if(kind==='second-read-only')f.space.protect(DATA+4096n,4096n,1);
  if(kind==='second-unmapped')f.space.unmap(DATA+4096n,4096n);if(kind==='second-protected'||kind==='second-write-only')f.space.protect(DATA+4096n,4096n,kind==='second-write-only'?2:0);
  f.reset(0xffffffff00000001n,address);const owned=budget.stats().ownedPayloadBytes,success=!['second-unmapped','second-protected','second-write-only','range'].includes(kind)&&(!['end-of-mapping','virtual-edge'].includes(kind)||width===4);
  try{const done=await f.step(units[width]);checkedADDs++;assert.equal(done.status,success?0:1,kind);
   if(success){const initial=kind==='unaligned'?7n:['end-of-mapping','virtual-edge'].includes(kind)?0x7fffffffn:0x7fffffffffffffffn;assert.equal(f.view.getBigUint64(f.g+16,true),BigInt.asUintN(width*8,0xffffffff00000001n+BigInt.asUintN(width*8,initial)));assert.deepEqual(f.space.read(DATA,8192),original);assert.deepEqual([f.space.mappingInfo(DATA).frameId,f.space.mappingInfo(DATA+4096n).frameId],frames);}
   else{f.snapshot().forEach((b,i)=>assert.deepEqual(b,done.before[i]));assert.equal(f.scratch.getUint32(B.FIELD.reason,true),['range','virtual-edge'].includes(kind)?B.REASON.RANGE:['second-unmapped','end-of-mapping'].includes(kind)?B.REASON.UNMAPPED:B.REASON.PROTECTION);}
   assert.equal(budget.stats().ownedPayloadBytes,owned);if(alias)assert.deepEqual(alias.read(DATA,8192),original);edges.push({width,kind,status:done.status,bytesAndAccountingPreserved:true});
  }finally{f.close();alias?.close();backing?.close();assert.equal(budget.stats().ownedPayloadBytes,0);}
 }
 const forged=[];
 for(const width of [4,8])for(const kind of ['address','write','checkpoint','result','unrelated-register','round']){const f=fixture();f.space.mapAnonymous(DATA,8192n,3);f.space.write(DATA,pack(7n));f.reset(5n);
  try{const done=()=>f.step(units[width],{alter:x=>{if(kind==='address')x.scratch.setBigUint64(B.FIELD.address,DATA+8n,true);if(kind==='write'){x.scratch.setUint32(B.FIELD.operation,2,true);x.scratch.setUint32(B.FIELD.access,2,true);}if(kind==='checkpoint')x.scratch.setBigUint64(B.FIELD.checkpoint,99n,true);},afterRun:x=>{if(kind==='result')x.view.setBigUint64(x.g+16,99n,true);if(kind==='unrelated-register')x.view.setBigUint64(x.g+8,99n,true);if(kind==='round')x.view.setUint32(x.tb+cfg.checkpoint.roundMode.offset,3,true);}});
   if(['result','unrelated-register','round'].includes(kind))await assert.rejects(done(),/changed/);else assert.equal((await done()).status,2);assert.equal(value(f.space.read(DATA,8)),7n);forged.push({width,kind});
  }finally{f.close();}
 }
 const refused=[];
 for(const code of [[0xf0,0x48,3,0x10],[0x66,3,0x10],[0x66,0x48,3,0x10],[0x67,0x48,3,0x10],[0x64,0x48,3,0x10],[0x65,0x48,3,0x10],[0xf3,0x48,3,0x10],[2,0x10],[0x48,0x2b,0x10],[0x48,0x13,0x10],[0x48,3],[0x48,3,0x54],[0x48,3,0x54,0x8c],[0x49,3,4,0x25,0,0,1,0],[0x41,3,4,0x25,0,0,1,0],[0x40,0x48,3,0x10]]){
  await get('/xlat/code?addr='+CODE.toString(16),{method:'POST',body:Uint8Array.from(code)});const u=FexLinuxThread.parseBrokerStep(new Uint8Array(await(await get('/xlat/step?rip='+CODE)).arrayBuffer()));assert.equal(u.status,2,Buffer.from(code).toString('hex'));assert.equal(u.code.length,0);refused.push(Buffer.from(code).toString('hex'));
 }
 const report={evidence:'Native Linux x86 arithmetic oracle and actual FEX/Wasm ADD r32,r/m32 or r64,r/m64 with checked reads, all six arithmetic flags and destination-only GPR changes. No Wine completion, device or JIT replacement evidence.',cfg,nativeOracle,oracleRows:golden.length,checkedADDs,executedWasmSteps,records,edges,forged,refused,native:await(await get('/xlat/totals')).json()};if(process.argv[3])fs.writeFileSync(process.argv[3],JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({...report,cfg:undefined,records:records.length,edges:edges.length,forged:forged.length,refused:refused.length}));
 });}
main().catch(e=>{console.error(e);process.exitCode=1;});
