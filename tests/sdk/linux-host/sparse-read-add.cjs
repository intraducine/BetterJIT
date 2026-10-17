// SPDX-License-Identifier: GPL-3.0-or-later
// Register-destination memory-source ADD/SUB: native x86 oracle and sparse FEX/Wasm.
const fs=require('fs'),path=require('path'),os=require('os'),vm=require('vm'),assert=require('node:assert/strict'),{spawnSync}=require('child_process');
const {serve}=require('./native-step-contract.cjs');
let golden,arithmetic='ADD';
for(const n of ['guest_memory','guest_memory_broker','thread_core'])vm.runInThisContext(fs.readFileSync(path.resolve(__dirname,'../../../Sources/BetterJITLinux/Resources/linux',n+'.js'),'utf8'));
const M=BetterJITGuestMemory,B=BetterJITGuestMemoryBroker,CODE=0x123400008000n,SC=CODE+0x100n,DATA=0x123456780000n,MASK=0x8d5n;
const pack=n=>{const b=new Uint8Array(8);new DataView(b.buffer).setBigUint64(0,BigInt.asUintN(64,n),true);return b;};
const value=b=>new DataView(b.buffer,b.byteOffset,8).getBigUint64(0,true);
function oracle(){
 if(process.platform!=='linux'||process.arch!=='x64')return {supported:false,reason:'Retained Linux x86 oracle checked by FEX/Wasm; no native oracle execution on this host'};
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'betterjit-read-add-'));
 try{const binary=path.join(directory,'oracle'),build=spawnSync(process.env.CC||'cc',['-std=gnu11','-O2','-mno-red-zone','-Wall','-Wextra','-Werror',path.join(__dirname,arithmetic==='ADD'?'sparse-read-add-oracle.c':'sparse-read-sub-oracle.c'),'-o',binary],{encoding:'utf8',timeout:10000});assert.equal(build.status,0,build.stderr);
  const run=spawnSync(binary,[],{encoding:'utf8',timeout:10000});assert.equal(run.status,0,run.stderr);assert.deepEqual(JSON.parse(run.stdout),golden);return {supported:true,rows:golden.length};
 }finally{fs.rmSync(directory,{recursive:true,force:true});}
}
function forms(width,opcode=3){const rex=width===8?[0x48]:[],disp=pack(DATA-(CODE+BigInt(width===8?7:6))).slice(0,4);
 return [
  {name:'rax-rdx',code:[...rex,opcode,0x10],regs:{0:DATA},source:2},
  {name:'r8-r10',code:[width===8?0x4d:0x45,opcode,0x10],regs:{8:DATA},source:10},
  {name:'positive-disp8',code:[...rex,opcode,0x50,0x7f],regs:{0:DATA-127n},source:2},
  {name:'rex-sib-negative-disp8',code:[width===8?0x4f:0x47,opcode,0x54,0xac,0x80],regs:{12:DATA+116n,13:3n},source:10},
  {name:'base-index-scale1',code:[...rex,opcode,0x14,8],regs:{0:DATA-3n,1:3n},source:2},
  {name:'index-only-scale4',code:[...rex,opcode,0x14,0x8d,0,0,1,0],regs:{1:(DATA-65536n)/4n},source:2},
  {name:'rip-relative',code:[...rex,opcode,0x15,...disp],regs:{},source:2},
  {name:'rsp-source',code:[...rex,opcode,0x20],regs:{0:DATA},source:4},
  {name:'source-address-alias',code:[...rex,opcode,0],regs:{0:DATA},source:0,alias:true},
  {name:'destination-index-alias',code:[...rex,opcode,0x0c,0x88],regs:{},source:1,configure:(f,row)=>f.view.setBigUint64(f.g,BigInt.asUintN(64,DATA-BigInt(row.source)*4n),true)},
  {name:'destination-base-index-alias',code:[...rex,opcode,0x04,0x80],regs:{0:DATA},source:0,alias:true,address:DATA*5n},
  {name:'r12-index',code:[width===8?0x4a:0x42,opcode,0x14,0xa0],regs:{0:DATA-12n,12:3n},source:2},
  ...[2n,8n].map(scale=>({name:'SIB-scale-'+scale,code:[...rex,opcode,0x14,scale===2n?0x48:0xc8],regs:{0:DATA-3n*scale,1:3n},source:2})),
  {name:'negative-disp32',code:[...rex,opcode,0x90,0,0,0xff,0xff],regs:{0:DATA+65536n},source:2},
  {name:'rip-relative-rexB',code:[width===8?0x49:0x41,opcode,0x15,...pack(DATA-CODE-7n).slice(0,4)],regs:{},source:2},
  {name:'wrapped-address',code:[...rex,opcode,0x14,8],regs:{0:(1n<<64n)-16n,1:DATA+16n},source:2},
  {name:'absolute-no-base-SIB',code:[...rex,opcode,0x14,0x25,0,0,1,0],regs:{},source:2,address:65536n},
  {name:'minimum-disp32',code:[...rex,opcode,0x90,0,0,0,0x80],regs:{0:DATA+0x80000000n},source:2},
  ...Array.from({length:16},(_,r)=>{const low=r&7,prefix=(width===8?0x48:0x40)|(r>=8?1:0),mod=low===5?0x40:0;
    return {name:'address-base-register-'+r,code:[...(prefix===0x40?[]:[prefix]),opcode,mod|0x10|low,...(low===4?[0x24]:low===5?[0]:[])],regs:{[r]:DATA},source:2,alias:r===2};}),
  ...Array.from({length:16},(_,r)=>({name:'destination-register-'+r,code:[...(r>=8?[width===8?0x4c:0x44]:rex),opcode,(r&7)<<3],regs:{0:DATA},source:r,alias:r===0}))
 ];
}
async function main(operation='ADD'){assert(['ADD','SUB'].includes(operation));arithmetic=operation;golden=require(operation==='ADD'?'./sparse-read-add-oracle.json':'./sparse-read-sub-oracle.json');const expectedOperation=operation==='ADD'?B.OP.ADD_REGISTER_MEMORY:B.OP.SUB_REGISTER_MEMORY,opcode=operation==='ADD'?3:0x2b,nativeOracle=oracle();await serve('guestmem=broker1',async(get,log)=>{
 const cfg=await(await get('/xlat/config')).json(),state=new Uint8Array(await(await get('/xlat/state')).arrayBuffer());assert.equal(cfg.coverageVersion,25);
 async function compile(code,rip=CODE){await get('/xlat/code?addr='+rip.toString(16),{method:'POST',body:Uint8Array.from(code)});const u=FexLinuxThread.parseBrokerStep(new Uint8Array(await(await get('/xlat/step?rip='+rip)).arrayBuffer()));assert.equal(u.status,0,Buffer.from(code).toString('hex')+': '+log());u.module=await WebAssembly.compile(u.code);assert(WebAssembly.Module.imports(u.module).every(i=>i.module==='e'&&['mem','tb','memory'].includes(i.name)));return u;}
 const syscall=await compile([15,5],SC),seeds=[await compile([0x45,1,0xc9],SC+0x100n),await compile([0x49,0x83,0xe9,1],SC+0x120n)],units={};let executedWasmSteps=0,checkedArithmetic=0,flagConsumerChecks=0;
 const sets=[],branches=[];for(const [cc,bit]of [[0x92,0],[0x9a,2],[0x94,6],[0x98,7],[0x90,11]])sets.push({u:await compile([0x41,15,cc,0xc0],SC+0x200n+BigInt(bit*16)),bit});
 for(const [cc,bit]of [[0x72,0],[0x74,6],[0x78,7]])branches.push({u:await compile([cc,1],SC+0x400n+BigInt(bit*16)),bit});
 function fixture({budget=new M.BackingBudget(),space=new M.GuestAddressSpace(budget,{virtualLimit:1n<<47n}),broker=new B.GuestMemoryBroker()}={}){
  const memory=B.createInternalMemory(),token=broker.register(0,{space,memory,checkpointLayout:cfg.checkpoint}),view=new DataView(memory.buffer),tb=B.ABI.threadBase,g=tb+cfg.ctx+cfg.gregsOff,scratch=new DataView(memory.buffer,tb+B.ABI.scratchOffset,128);let sequence=0;
  const spans=['cpu','lazyFlags','roundMode'],snapshot=()=>spans.map(n=>{const p=cfg.checkpoint[n];return new Uint8Array(memory.buffer,tb+p.offset,p.size).slice();});
  const f={budget,space,memory,broker,token,view,tb,g,scratch,snapshot,close(){broker.unregister(token);space.close();}};
  f.reset=(source,address=DATA,sourceReg=2)=>{new Uint8Array(memory.buffer).fill(0);new Uint8Array(memory.buffer,tb+cfg.ctx,state.length).set(state);scratch.setBigUint64(B.FIELD.lease,token.generation,true);for(let r=0;r<16;r++)view.setBigUint64(g+8*r,0xabcdef0000000000n+BigInt(r),true);view.setBigUint64(g,address,true);view.setBigUint64(g+8*sourceReg,source,true);};
  f.step=async(u,{finish=true,alter,afterDispatch,afterRun}={})=>{view.setBigUint64(tb+cfg.ctx+cfg.ripOff,u.rip,true);const generation=broker.beginInstruction(token,{...u});scratch.setBigUint64(B.FIELD.checkpoint,generation,true);
   const before=snapshot(),requests=broker.stats().requests,instance=await WebAssembly.instantiate(u.module,{e:{mem:memory,tb:new WebAssembly.Global({value:'i32'},tb),memory:()=>{scratch.setUint32(B.FIELD.sequence,++sequence,true);alter?.(f);const reply=broker.dispatch(token,{lease:token.generation,sequence});afterDispatch?.(f);return reply.status;}}});
   const status=instance.exports.run();executedWasmSteps++;afterRun?.(f);if(finish)broker.finishInstruction(token,{status,nextRip:u.nextRip});assert.equal(broker.stats().requests-requests,u.operation===expectedOperation?1:0);return {status,before};};return f;
 }
 const records=[];
 for(const width of [4,8])for(const form of forms(width,opcode)){
  const u=await compile(form.code);assert.equal(u.operation,expectedOperation);assert.equal(u.width,width);assert.deepEqual([...u.instruction],form.code);units[width]??=u;
  const f=fixture(),target=form.address??DATA;f.space.mapAnonymous(target,8192n,3);
  try{let rows=0;for(const row of golden.filter(r=>r.width===width&&(!form.alias||BigInt(r.source)===DATA))){
   f.space.write(target,pack(BigInt(row.initial)));f.reset(BigInt(row.source),DATA,form.source);for(const [r,n]of Object.entries(form.regs))f.view.setBigUint64(f.g+8*Number(r),n,true);form.configure?.(f,row);
   if(form.source!==9&&!(9 in form.regs)){f.view.setBigUint64(f.g+9*8,rows%2?0n:0x80000000n,true);assert.equal((await f.step(seeds[rows%2])).status,0);}
   const registers=Array.from({length:16},(_,r)=>f.view.getBigUint64(f.g+8*r,true)),round=f.snapshot()[2];
   assert.equal((await f.step(u)).status,0,operation+' width'+width+' '+form.name+' '+JSON.stringify(row));checkedArithmetic++;assert.equal(value(f.space.read(target,8)),BigInt(row.initial));registers[form.source]=BigInt(row.result);
   assert.deepEqual(Array.from({length:16},(_,r)=>f.view.getBigUint64(f.g+8*r,true)),registers,'Arithmetic changes only the selected destination GPR');assert.deepEqual(f.snapshot()[2],round);
   if(form.name==='rax-rdx'){for(const {u,bit}of sets){assert.equal((await f.step(u)).status,0);assert.equal(Number(f.view.getBigUint64(f.g+64,true)&255n),(row.flags>>bit)&1);flagConsumerChecks++;}
    for(const {u,bit}of branches){assert.equal((await f.step(u)).status,0);assert.equal(f.view.getBigUint64(f.tb+cfg.ctx+cfg.ripOff,true),(row.flags>>bit)&1?u.branchTarget:u.nextRip);flagConsumerChecks++;}}
   assert.equal((await f.step(syscall)).status,B.STEP.SYSCALL);assert.equal(f.view.getBigUint64(f.g+11*8,true)&MASK,BigInt(row.flags));rows++;
  }records.push({width,form:form.name,rows,oneRPCPerInstruction:true,unrelatedGPRsPreserved:true});}finally{f.close();assert.equal(f.budget.stats().ownedPayloadBytes,0);}
 }
 const edges=[],preservationNegativeControls=[];
 for(const width of [4,8])for(const kind of ['unaligned','cross-page','read-only','second-read-only','shared-cross-page','private-view-budget-full','second-unmapped','second-protected','second-write-only','end-of-mapping','virtual-edge','range']){
  const address=kind==='range'?(1n<<64n)-3n:kind==='virtual-edge'?(1n<<47n)-4n:DATA+(kind==='unaligned'?1n:kind==='end-of-mapping'?8188n:4093n),budget=new M.BackingBudget({limitBytes:kind==='private-view-budget-full'?8192:32768}),f=fixture({budget});let backing,alias;
  if(kind==='shared-cross-page'||kind==='private-view-budget-full'){backing=new M.SharedBacking(budget,8192n);alias=new M.GuestAddressSpace(budget,{virtualLimit:1n<<47n});alias.mapShared(DATA,8192n,backing);alias.write(DATA+4093n,pack(0x7fffffffffffffffn));f.space.mapShared(DATA,8192n,backing,0n,{privateView:kind==='private-view-budget-full'});}
  else{f.space.mapAnonymous(DATA,8192n,3);f.space.write(DATA+1n,pack(7n));f.space.write(DATA+4093n,pack(0x7fffffffffffffffn));}
  if(kind==='virtual-edge')f.space.mapAnonymous(address&~4095n,4096n,3);if(kind==='virtual-edge'||kind==='end-of-mapping')f.space.write(address,pack(0x7fffffffn).slice(0,4));
  const original=f.space.read(DATA,8192);
  if(kind==='read-only')f.space.protect(DATA,8192n,1);if(kind==='second-read-only')f.space.protect(DATA+4096n,4096n,1);
  if(kind==='second-unmapped')f.space.unmap(DATA+4096n,4096n);if(kind==='second-protected'||kind==='second-write-only')f.space.protect(DATA+4096n,4096n,kind==='second-write-only'?2:0);
  // Observe after deliberate unmap/protection setup. Temporarily granting READ
  // lets the trusted test inspect protected bytes; restore permissions and
  // verify that observation itself changes no frame or backing accounting.
  const pages=[{at:DATA,prot:kind==='read-only'?1:3},
   {at:DATA+4096n,prot:kind==='second-unmapped'?null:kind==='second-protected'?0:kind==='second-write-only'?2:['read-only','second-read-only'].includes(kind)?1:3},
   ...(kind==='virtual-edge'?[{at:address&~4095n,prot:3}]:[])];
  function snapshotMappedPages(){const owned=budget.stats().ownedPayloadBytes;
   const observed=pages.map(({at,prot})=>{
    if(prot===null){assert.throws(()=>f.space.mappingInfo(at),e=>e instanceof M.MemoryFault&&e.reason==='unmapped'&&e.faultAddress===at);return{at,mapped:false};}
    const identity=f.space.mappingInfo(at),readable=!!(prot&1),writable=!!(prot&2);
    const permissions=()=>{if(readable)f.space.read(at,1);else assert.throws(()=>f.space.read(at,1),e=>e instanceof M.MemoryFault&&e.reason==='protection');
     if(writable)assert.equal(f.space.validateWrite(at,1),true);else assert.throws(()=>f.space.validateWrite(at,1),e=>e instanceof M.MemoryFault&&e.reason==='protection');
     assert.throws(()=>f.space.executableSnapshot(at,1),e=>e instanceof M.MemoryFault&&e.reason==='protection');};
    permissions();let bytes;if(!readable)f.space.protect(at,4096n,prot|1);
    try{bytes=f.space.read(at,4096);}finally{if(!readable)f.space.protect(at,4096n,prot);}
    permissions();assert.deepEqual(f.space.mappingInfo(at),identity);return{at,mapped:true,identity,readable,writable,executable:false,bytes};
   });assert.equal(budget.stats().ownedPayloadBytes,owned);return observed;
  }
  f.reset(0xffffffff00000001n,address);const beforePages=snapshotMappedPages(),owned=budget.stats().ownedPayloadBytes,success=!['second-unmapped','second-protected','second-write-only','range'].includes(kind)&&(!['end-of-mapping','virtual-edge'].includes(kind)||width===4);
  try{const done=await f.step(units[width]);checkedArithmetic++;assert.equal(done.status,success?0:1,kind);
   if(success){const initial=kind==='unaligned'?7n:['end-of-mapping','virtual-edge'].includes(kind)?0x7fffffffn:0x7fffffffffffffffn;assert.equal(f.view.getBigUint64(f.g+16,true),BigInt.asUintN(width*8,operation==='ADD'?0xffffffff00000001n+BigInt.asUintN(width*8,initial):0xffffffff00000001n-BigInt.asUintN(width*8,initial)));assert.equal(f.scratch.getBigUint64(B.FIELD.faultAddress,true),0n);}
   else{f.snapshot().forEach((b,i)=>assert.deepEqual(b,done.before[i]));assert.equal(f.scratch.getUint32(B.FIELD.reason,true),['range','virtual-edge'].includes(kind)?B.REASON.RANGE:['second-unmapped','end-of-mapping'].includes(kind)?B.REASON.UNMAPPED:B.REASON.PROTECTION);
    const expectedFault=kind==='range'?address:kind==='virtual-edge'?1n<<47n:kind==='end-of-mapping'?DATA+8192n:DATA+4096n;
    assert.equal(f.scratch.getBigUint64(B.FIELD.faultAddress,true),expectedFault,kind+' exact faultAddress');}
   assert.deepEqual(snapshotMappedPages(),beforePages,kind+' mapped bytes, frame identities, permissions and unmapped absence');
   assert.equal(budget.stats().ownedPayloadBytes,owned);if(alias)assert.deepEqual(alias.read(DATA,8192),original);
   edges.push({width,kind,status:done.status,mappedBytesAndFramesPreserved:true,permissionsAndAccountingPreserved:true,
    observedMappedBytes:beforePages.filter(p=>p.mapped).length*4096,unmappedPagesChecked:beforePages.filter(p=>!p.mapped).length,
    scope:'All still-mapped initialized pages; deliberately unmapped pages checked for absence only',faultAddressChecked:!success,faultAddress:'0x'+f.scratch.getBigUint64(B.FIELD.faultAddress,true).toString(16)});
   if(width===8&&kind==='second-protected'){
    // Deliberate post-validation corruption proves these evidence assertions
    // detect byte, frame and fault-address drift. None is a guest effect.
    const saved=beforePages[0].bytes,changed=saved.slice();changed[0]^=1;f.space.write(DATA,changed);
    assert.throws(()=>assert.deepEqual(snapshotMappedPages(),beforePages),assert.AssertionError);f.space.write(DATA,saved);
    const exact=f.scratch.getBigUint64(B.FIELD.faultAddress,true);f.scratch.setBigUint64(B.FIELD.faultAddress,exact+1n,true);
    assert.throws(()=>assert.equal(f.scratch.getBigUint64(B.FIELD.faultAddress,true),DATA+4096n),assert.AssertionError);f.scratch.setBigUint64(B.FIELD.faultAddress,exact,true);
    assert.deepEqual(snapshotMappedPages(),beforePages);
    f.space.mapAnonymous(DATA,4096n,3,{replace:true});f.space.write(DATA,saved);const replaced=snapshotMappedPages();
    assert.deepEqual(replaced[0].bytes,saved);assert.notEqual(replaced[0].identity.frameId,beforePages[0].identity.frameId);
    assert.throws(()=>assert.deepEqual(replaced,beforePages),assert.AssertionError);
    preservationNegativeControls.push({width,kind,testInjected:true,changedByteDetected:true,replacedFrameDetected:true,wrongFaultAddressDetected:true});
   }
  }finally{f.close();alias?.close();backing?.close();assert.equal(budget.stats().ownedPayloadBytes,0);}
 }
 const forged=[];
 for(const width of [4,8])for(const kind of ['address','write','checkpoint','result','unrelated-register','round','nzcv','kind','fa','fb','padding','read-result']){const f=fixture();f.space.mapAnonymous(DATA,8192n,3);f.space.write(DATA,pack(7n));f.reset(5n);
  try{const done=()=>f.step(units[width],{alter:x=>{if(kind==='address')x.scratch.setBigUint64(B.FIELD.address,DATA+8n,true);if(kind==='write'){x.scratch.setUint32(B.FIELD.operation,2,true);x.scratch.setUint32(B.FIELD.access,2,true);}if(kind==='checkpoint')x.scratch.setBigUint64(B.FIELD.checkpoint,99n,true);},afterDispatch:x=>{if(kind==='read-result')x.scratch.setBigUint64(B.FIELD.result0,x.scratch.getBigUint64(B.FIELD.result0,true)^1n,true);},afterRun:x=>{if(kind==='result')x.view.setBigUint64(x.g+16,99n,true);if(kind==='unrelated-register')x.view.setBigUint64(x.g+8,99n,true);if(kind==='round')x.view.setUint32(x.tb+cfg.checkpoint.roundMode.offset,3,true);if(kind==='nzcv')x.view.setUint32(x.tb+cfg.nzcvAddr,x.view.getUint32(x.tb+cfg.nzcvAddr,true)^1,true);if(kind==='kind')x.view.setUint32(x.tb+cfg.flagSpillAddr,31,true);if(kind==='fa'||kind==='fb'){const at=x.tb+cfg.flagSpillAddr+(kind==='fa'?8:16);x.view.setBigUint64(at,x.view.getBigUint64(at,true)^1n,true);}if(kind==='padding')x.view.setUint8(x.tb+cfg.flagSpillAddr+4,1);}});
   if(['result','unrelated-register','round','nzcv','kind','fa','fb','padding','read-result'].includes(kind))await assert.rejects(done(),/changed/);else assert.equal((await done()).status,2);assert.equal(value(f.space.read(DATA,8)),7n);forged.push({width,kind});
  }finally{f.close();}
 }
 const refused=[];
 for(const code of [[0xf0,0x48,opcode,0x10],[0x66,opcode,0x10],[0x66,0x48,opcode,0x10],[0x67,0x48,opcode,0x10],[0x64,0x48,opcode,0x10],[0x65,0x48,opcode,0x10],[0xf3,0x48,opcode,0x10],[2,0x10],[0x48,0x29,0x10],[0x48,0x13,0x10],[0x48,opcode],[0x48,opcode,0x54],[0x48,opcode,0x54,0x8c],[0x49,opcode,4,0x25,0,0,1,0],[0x41,opcode,4,0x25,0,0,1,0],[0x40,0x48,opcode,0x10]]){
  await get('/xlat/code?addr='+CODE.toString(16),{method:'POST',body:Uint8Array.from(code)});const u=FexLinuxThread.parseBrokerStep(new Uint8Array(await(await get('/xlat/step?rip='+CODE)).arrayBuffer()));assert.equal(u.status,2,Buffer.from(code).toString('hex'));assert.equal(u.code.length,0);refused.push(Buffer.from(code).toString('hex'));
 }
 const goldenExecutions=records.reduce((n,r)=>n+r.rows,0),successfulEdges=edges.filter(e=>e.status===0).length,typedFaults=edges.filter(e=>e.status===1).length;
 assert.equal(checkedArithmetic,goldenExecutions+successfulEdges+typedFaults);
 const report={operation,evidence:'Native Linux x86 arithmetic oracle and actual FEX/Wasm register-destination memory-source ADD/SUB32/64 with checked reads, all six arithmetic flags and destination-only GPR changes. Attempts include typed faults; see arithmeticCounts. No Wine completion, device or JIT replacement evidence.',cfg,nativeOracle,oracleRows:golden.length,checkedArithmetic,
  arithmeticCounts:{attempts:checkedArithmetic,goldenExecutions,successfulEdges,typedFaults,successfulExecutions:goldenExecutions+successfulEdges},flagConsumerChecks,executedWasmSteps,records,edges,preservationNegativeControls,forged,refused,native:await(await get('/xlat/totals')).json()};if(process.argv[3])fs.writeFileSync(process.argv[3],JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({...report,cfg:undefined,records:records.length,edges:edges.length,forged:forged.length,refused:refused.length}));
 });}
if(require.main===module)main(process.argv[4]??'ADD').catch(e=>{console.error(e);process.exitCode=1;});
module.exports={forms};
