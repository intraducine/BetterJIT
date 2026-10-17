// SPDX-License-Identifier: GPL-3.0-or-later
// Native x86 word-CMP flags and real FEX/Wasm checked reads. No Wine fixture edits.
const fs=require('fs'),path=require('path'),os=require('os'),vm=require('vm'),assert=require('node:assert/strict'),{spawnSync}=require('child_process');
const {serve}=require('./native-step-contract.cjs'),golden=require('./sparse-word-compare-oracle.json');
for(const n of ['guest_memory','guest_memory_broker','thread_core'])vm.runInThisContext(fs.readFileSync(path.resolve(__dirname,'../../../Sources/BetterJITLinux/Resources/linux',n+'.js'),'utf8'));
const M=BetterJITGuestMemory,B=BetterJITGuestMemoryBroker,CODE=0x123400008000n,DATA=0x123456780000n,SC=CODE+0x1000n;
const values=[0,1,15,16,0x7f,0x80,0xff,0x100,0x7ffe,0x7fff,0x8000,0x8001,0xff7f,0xff80,0xfffe,0xffff],definitions=[];
for(const [opcode,masks]of [[0x81,[0,1,15,16,0x7f,0x80,0xff,0x100,0x7fff,0x8000,0xff80,0xffff]],[0x83,[0,1,15,16,0x7f,0x80,0xfe,0xff]]])for(const mask of masks)for(const rex of [0,0x44,0x46])definitions.push({opcode,mask,rex});
const rows=new Map(golden.map(row=>[row.slice(0,3).join(':'),row]));
function immediate(d){return d.opcode===0x83?(d.mask&128?d.mask|0xff00:d.mask):d.mask;}
function independentFlags(a,b,seed){const difference=(a-b)&65535,signed=n=>n&0x8000?n-65536:n,total=signed(a)-signed(b),parity=[...(difference&255).toString(2)].filter(c=>c==='1').length%2===0;return(a<b?1:0)|(parity?4:0)|((a&15)<(b&15)?16:0)|(difference===0?64:0)|(difference&0x8000?128:0)|(total< -32768||total>32767?2048:0)|(seed?1024:0);}
function oracle(){if(process.platform!=='linux'||process.arch!=='x64')return{supported:false,reason:'Retained native Linux x86 flags used; this host cannot run the fresh native oracle'};const temp=fs.mkdtempSync(path.join(os.tmpdir(),'betterjit-word-cmp-'));try{const binary=path.join(temp,'oracle'),build=spawnSync(process.env.CC||'cc',['-O2','-mno-red-zone','-Wall','-Wextra','-Werror',path.join(__dirname,'sparse-word-compare-oracle.c'),'-o',binary],{encoding:'utf8'});assert.equal(build.status,0,build.stderr);const run=spawnSync(binary,[],{encoding:'utf8',maxBuffer:4*1024*1024});assert.equal(run.status,0,run.stderr);assert.deepEqual(JSON.parse(run.stdout),golden);return{supported:true,rows:golden.length};}finally{fs.rmSync(temp,{recursive:true,force:true});}}
const immBytes=d=>Array.from({length:d.opcode===0x83?1:2},(_,i)=>d.mask>>(i*8)&255),disp32=n=>Array.from({length:4},(_,i)=>Number(BigInt.asUintN(32,n)>>BigInt(i*8)&255n));
function forms(d){
 const prefix=rex=>[0x66,...(rex?[0x40|rex]:[]),d.opcode],tail=immBytes(d),list=[];
 const add=(name,rex,body,regs,target=DATA)=>list.push({name,code:[...prefix(rex),...body,...tail],regs,target});
 add('rax-disp6',0,[0x78,6],{0:DATA-6n});add('negative-disp8',0,[0x78,0x80],{0:DATA+128n});
 add('negative-disp32',0,[0xb8,...disp32(-65536n)],{0:DATA+65536n});
 add('minimum-disp32',0,[0xb8,...disp32(-0x80000000n)],{0:DATA+0x80000000n});
 add('maximum-disp32',0,[0xb8,...disp32(0x7fffffffn)],{0:DATA-0x7fffffffn});
 for(let r=0;r<16;r++){const low=r&7,body=[0x38|low|(low===5?0x40:0),...(low===4?[0x24]:low===5?[0]:[])];add('base-register-'+r,r>=8?1:0,body,{[r]:DATA});}
 for(const r of [0,1,2,3,5,6,7,8,9,10,11,12,13,14,15]){const base=r===15?14:15,scale=[1,2,4,8][r%4],bits=Math.log2(scale),rex=(base>=8?1:0)|(r>=8?2:0),body=[0x3c,(bits<<6)|((r&7)<<3)|(base&7)];add('index-register-'+r+'-scale'+scale,rex,body,{[base]:DATA-3n*BigInt(scale),[r]:3n});}
 add('base-index-alias',0,[0x3c,0x80],{0:DATA},DATA*5n);
 add('wrapped-address',0,[0x3c,8],{0:(1n<<64n)-16n,1:DATA+16n});
 add('absolute-no-base-SIB',0,[0x3c,0x25,...disp32(65536n)],{},65536n);
 add('index-only-SIB',0,[0x3c,0x8d,...disp32(65536n)],{1:(DATA-65536n)/4n});
 add('r12-index-only-SIB',2,[0x3c,0xa5,...disp32(65536n)],{12:(DATA-65536n)/4n});
 for(const rex of [0,1,2,4,6,7]){const length=prefix(rex).length+1+4+tail.length;add('RIP-relative-REX'+rex,rex,[0x3d,...disp32(DATA-CODE-BigInt(length))],{});}
 for(const rex of [2,4,6])add('ignored-REX-RX'+rex,rex,[0x78,6],{0:DATA-6n});
 return list;
}
async function main(){
 const nativeOracle=oracle();assert.equal(golden.length,1920);assert.equal(rows.size,1920);
 for(const [id,seed,input,flags]of golden){assert.equal(flags,independentFlags(values[input],immediate(definitions[id]),seed));assert.equal(flags,rows.get([id-id%3,seed,input].join(':'))[3]);}
 let report;
 await serve('guestmem=broker1',async(get,log)=>{
  const cfg=await(await get('/xlat/config')).json(),state=new Uint8Array(await(await get('/xlat/state')).arrayBuffer());assert.equal(cfg.coverageVersion,28);
  async function request(code,rip=CODE){await get('/xlat/code?addr='+rip.toString(16),{method:'POST',body:Uint8Array.from(code)});return FexLinuxThread.parseBrokerStep(new Uint8Array(await(await get('/xlat/step?rip='+rip)).arrayBuffer()));}
  async function compile(code,rip=CODE){const u=await request(code,rip);assert.equal(u.status,0,Buffer.from(code).toString('hex')+': '+log());u.module=await WebAssembly.compile(u.code);assert(WebAssembly.Module.imports(u.module).every(i=>i.module==='e'&&['mem','tb','memory'].includes(i.name)));return u;}
  const syscall=await compile([15,5],SC),seeds=[await compile([0x45,1,0xd2],SC+32n),await compile([0x49,0x83,0xea,1],SC+64n)],sets=[],branches=[];
  for(let cc=0;cc<16;cc++)sets.push(await compile([0x41,15,0x90+cc,0xc1],SC+128n+BigInt(cc*8)));
  for(let cc=0x72;cc<=0x79;cc++)branches.push(await compile([cc,1],SC+512n+BigInt(cc*8)));
  let checks=0,consumerChecks=0,executedWasmSteps=0,successfulEdges=0,typedFaults=0;
  function fixture({budget=new M.BackingBudget(),space=new M.GuestAddressSpace(budget,{virtualLimit:1n<<47n})}={}){
   const memory=B.createInternalMemory(),broker=new B.GuestMemoryBroker(),token=broker.register(0,{space,memory,checkpointLayout:cfg.checkpoint}),view=new DataView(memory.buffer),tb=B.ABI.threadBase,g=tb+cfg.ctx+cfg.gregsOff,q=new DataView(memory.buffer,tb+B.ABI.scratchOffset,128);let sequence=0;
   const snapshot=()=>['cpu','lazyFlags','roundMode'].map(n=>{const p=cfg.checkpoint[n];return new Uint8Array(memory.buffer,tb+p.offset,p.size).slice();});
   const f={budget,space,memory,broker,token,view,tb,g,q,snapshot,close(){broker.unregister(token);space.close();}};
   f.step=async(u,{alter,afterRun,finish=true}={})=>{view.setBigUint64(tb+cfg.ctx+cfg.ripOff,u.rip,true);const generation=broker.beginInstruction(token,u);q.setBigUint64(B.FIELD.checkpoint,generation,true);const before=snapshot(),requests=broker.stats().requests;
    const instance=await WebAssembly.instantiate(u.module,{e:{mem:memory,tb:new WebAssembly.Global({value:'i32'},tb),memory:()=>{q.setUint32(B.FIELD.sequence,++sequence,true);q.setBigUint64(B.FIELD.lease,token.generation,true);alter?.(f);return broker.dispatch(token,{lease:token.generation,sequence}).status;}}});
    const status=instance.exports.run();executedWasmSteps++;afterRun?.(f);const done=finish?broker.finishInstruction(token,{status,nextRip:u.nextRip}):undefined;assert.equal(broker.stats().requests-requests,u.operation===8?1:0);return{status,before,done};};
   f.reset=async(seed,regs={})=>{new Uint8Array(memory.buffer).fill(0);new Uint8Array(memory.buffer,tb+cfg.ctx,state.length).set(state);view.setBigUint64(g+80,seed?0n:0x80000000n,true);await f.step(seeds[seed]);
    const cpu=cfg.checkpoint.cpu,bytes=new Uint8Array(memory.buffer,tb+cpu.offset,cpu.size),flags=cpu.nzcvOffset-24;
    for(let i=0;i<bytes.length;i++)if((i<flags||i>=flags+48)&&(i<cfg.mxcsrOff||i>=cfg.mxcsrOff+4)&&!(i>=cpu.parityRawOffset&&i<cpu.parityRawOffset+4)&&!(i>=cpu.auxiliaryRawOffset&&i<cpu.auxiliaryRawOffset+4))bytes[i]=(0x5b+i*37+seed*89)&255;
    view.setInt8(tb+cpu.offset+flags+10,seed?-1:1);new Uint8Array(memory.buffer,tb+cfg.checkpoint.lazyFlags.offset+4,4).set([0xa5,0x3c,0x81,0xff]);
    for(let r=0;r<16;r++)view.setBigUint64(g+r*8,0xabcdef0000000000n+BigInt(r),true);for(const[r,n]of Object.entries(regs))view.setBigUint64(g+Number(r)*8,n,true);view.setUint32(tb+cfg.checkpoint.roundMode.offset,seed?3:1,true);
   };return f;
  }
  const condition=(cc,flags)=>{const c=!!(flags&1),p=!!(flags&4),z=!!(flags&64),s=!!(flags&128),o=!!(flags&2048);return[o,!o,c,!c,z,!z,c||z,!c&&!z,s,!s,p,!p,s!==o,s===o,z||s!==o,!z&&s===o][cc];};
  const records=[];
  for(let id=0;id<definitions.length;id+=3){const d=definitions[id];for(const form of forms(d)){
   const u=await compile(form.code);assert.equal(u.operation,8);assert.equal(u.width,2);assert.equal(u.nextRip,CODE+BigInt(form.code.length));assert.equal(u.wordCompareOperand.immediate,immediate(d));
   const f=fixture();f.space.mapAnonymous(form.target,8192n,3);let count=0;
   try{for(let seed=0;seed<2;seed++)for(let input=0;input<values.length;input++){
    const value=values[input],row=rows.get([id,seed,input].join(':')),canary=Uint8Array.from({length:18},(_,i)=>i*13+7);canary[0]=value&255;canary[1]=value>>8;f.space.write(form.target,canary);await f.reset(seed,form.regs);
    const memoryBefore=f.space.read(form.target,32),cpuBefore=f.snapshot()[0].slice(),done=await f.step(u);assert.equal(done.status,0,form.name);checks++;count++;
    assert.deepEqual(f.space.read(form.target,32),memoryBefore);const after=f.snapshot(),expected=cpuBefore,v=new DataView(expected.buffer),cpu=cfg.checkpoint.cpu;v.setBigUint64(cpu.ripOffset,u.nextRip,true);v.setUint32(cpu.parityRawOffset,(value-immediate(d))>>>0,true);v.setUint32(cpu.auxiliaryRawOffset,immediate(d)&16?(~value)>>>0:value,true);assert.deepEqual(after[0],expected,'Only exact RIP/PF/AF change; NZCV and all GPRs unchanged');
    if(form.name==='rax-disp6'){for(let cc=0;cc<16;cc++){assert.equal((await f.step(sets[cc])).status,0);assert.equal(f.view.getBigUint64(f.g+72,true)&255n,condition(cc,row[3])?1n:0n);consumerChecks++;}for(let i=0;i<branches.length;i++){const b=branches[i],r=await f.step(b);assert.equal(r.done.rip,condition(i+2,row[3])?b.branchTarget:b.nextRip);consumerChecks++;}}
    await f.step(syscall);assert.equal(f.view.getBigUint64(f.g+88,true)&0xcd5n,BigInt(row[3]),'All six native CMP flags and unchanged DF');
   }records.push({opcode:d.opcode,immediate:d.mask,form:form.name,rows:count});}finally{f.close();assert.equal(f.budget.stats().ownedPayloadBytes,0);}
  }}
  const unit=await compile([0x66,0x83,0x38,0x80]),edges=[],negativeControls=[];
  for(const kind of ['unaligned','cross-page','read-only','second-read-only','shared-cross-page','private-view-budget-full','second-unmapped','second-protected','second-write-only','end-of-mapping','virtual-edge','u64-wrap']){
   const address=kind==='u64-wrap'?(1n<<64n)-1n:kind==='virtual-edge'?(1n<<47n)-1n:DATA+(kind==='unaligned'?1n:kind==='end-of-mapping'?8191n:4095n),budget=new M.BackingBudget({limitBytes:kind==='private-view-budget-full'?8192:32768}),f=fixture({budget});let backing,alias;
   const shared=['shared-cross-page','private-view-budget-full'].includes(kind);
   if(shared){backing=new M.SharedBacking(budget,8192n);f.space.mapShared(DATA,8192n,backing,0n,{prot:3,privateView:kind==='private-view-budget-full'});alias=new M.GuestAddressSpace(budget,{virtualLimit:1n<<47n});alias.mapShared(DATA,8192n,backing);}
   else f.space.mapAnonymous(DATA,8192n,3);
   const original=Uint8Array.from({length:8192},(_,i)=>i*17+31);if(kind!=='private-view-budget-full')f.space.write(DATA,original);
   const source=shared&&kind==='private-view-budget-full'?0:0x7f80;if(!['u64-wrap','virtual-edge','end-of-mapping'].includes(kind)&&kind!=='private-view-budget-full')f.space.write(address,Uint8Array.of(source&255,source>>8));
   if(kind==='second-unmapped')f.space.unmap(DATA+4096n,4096n);if(kind==='second-protected')f.space.protect(DATA+4096n,4096n,0);if(kind==='second-write-only')f.space.protect(DATA+4096n,4096n,2);if(kind==='read-only')f.space.protect(DATA,8192n,1);if(kind==='second-read-only')f.space.protect(DATA+4096n,4096n,1);
   if(kind==='virtual-edge'){f.space.mapAnonymous(address&~4095n,4096n,3);f.space.write(address,Uint8Array.of(0x80));}
   const pages=[{at:DATA,prot:kind==='read-only'?1:3},{at:DATA+4096n,prot:kind==='second-unmapped'?null:kind==='second-protected'?0:kind==='second-write-only'?2:['read-only','second-read-only'].includes(kind)?1:3},...(kind==='virtual-edge'?[{at:address&~4095n,prot:3}]:[])];
   function mappedSnapshot(){const owned=budget.stats().ownedPayloadBytes,result=pages.map(({at,prot})=>{if(prot===null){assert.throws(()=>f.space.mappingInfo(at),e=>e instanceof M.MemoryFault&&e.reason==='unmapped'&&e.faultAddress===at);return{at,mapped:false};}const identity=f.space.mappingInfo(at),readable=!!(prot&1),writable=!!(prot&2),permissions=()=>{if(readable)f.space.read(at,1);else assert.throws(()=>f.space.read(at,1),e=>e.reason==='protection');if(writable)assert(f.space.validateWrite(at,1));else assert.throws(()=>f.space.validateWrite(at,1),e=>e.reason==='protection');assert.throws(()=>f.space.executableSnapshot(at,1),e=>e.reason==='protection');};permissions();if(!readable)f.space.protect(at,4096n,prot|1);let bytes;try{bytes=f.space.read(at,4096);}finally{if(!readable)f.space.protect(at,4096n,prot);}permissions();assert.deepEqual(f.space.mappingInfo(at),identity);return{at,mapped:true,identity,readable,writable,executable:false,bytes};});assert.equal(budget.stats().ownedPayloadBytes,owned);return result;}
   await f.reset(1,{0:address});const before=mappedSnapshot(),aliasBefore=alias?.read(DATA,8192),owned=budget.stats().ownedPayloadBytes,success=!['second-unmapped','second-protected','second-write-only','end-of-mapping','virtual-edge','u64-wrap'].includes(kind);
   try{const r=await f.step(unit);assert.equal(r.status,success?0:1,kind);if(success)successfulEdges++;else{typedFaults++;assert.deepEqual(f.snapshot(),r.before);const expected=kind==='u64-wrap'?address:kind==='virtual-edge'?1n<<47n:kind==='end-of-mapping'?DATA+8192n:DATA+4096n;assert.equal(f.q.getBigUint64(B.FIELD.faultAddress,true),expected);assert.equal(f.q.getUint32(B.FIELD.reason,true),['u64-wrap','virtual-edge'].includes(kind)?B.REASON.RANGE:['second-unmapped','end-of-mapping'].includes(kind)?B.REASON.UNMAPPED:B.REASON.PROTECTION);}
    assert.deepEqual(mappedSnapshot(),before);if(alias)assert.deepEqual(alias.read(DATA,8192),aliasBefore);assert.equal(budget.stats().ownedPayloadBytes,owned);edges.push({kind,status:r.status,mappedBytesAndFramesPreserved:true,permissionsAndAccountingPreserved:true,observedMappedBytes:before.filter(p=>p.mapped).length*4096,unmappedPagesChecked:before.filter(p=>!p.mapped).length,faultAddress:'0x'+f.q.getBigUint64(B.FIELD.faultAddress,true).toString(16)});
    if(kind==='second-protected'){const saved=before[0].bytes,changed=saved.slice();changed[0]^=1;f.space.write(DATA,changed);assert.throws(()=>assert.deepEqual(mappedSnapshot(),before),assert.AssertionError);f.space.write(DATA,saved);const fault=f.q.getBigUint64(B.FIELD.faultAddress,true);f.q.setBigUint64(B.FIELD.faultAddress,fault+1n,true);assert.throws(()=>assert.equal(f.q.getBigUint64(B.FIELD.faultAddress,true),DATA+4096n),assert.AssertionError);f.q.setBigUint64(B.FIELD.faultAddress,fault,true);f.space.mapAnonymous(DATA,4096n,3,{replace:true});f.space.write(DATA,saved);assert.throws(()=>assert.deepEqual(mappedSnapshot(),before),assert.AssertionError);negativeControls.push({kind,changedByteDetected:true,replacedFrameDetected:true,wrongFaultAddressDetected:true});}
   }finally{f.close();alias?.close();backing?.close();assert.equal(budget.stats().ownedPayloadBytes,0);}
  }
  const forged=[];
  for(const[field,value]of [['address',DATA+1n],['width',4],['operation',2],['access',2],['rip',CODE+1n],['checkpoint',999n]]){const f=fixture();f.space.mapAnonymous(DATA,4096n,3);try{await f.reset(0,{0:DATA});const memory=f.space.read(DATA,4096),r=await f.step(unit,{alter:f=>typeof value==='bigint'?f.q.setBigUint64(B.FIELD[field],value,true):f.q.setUint32(B.FIELD[field],value,true)});assert.equal(r.status,2);assert.deepEqual(f.snapshot(),r.before);assert.deepEqual(f.space.read(DATA,4096),memory);forged.push(field);}finally{f.close();}}
  for(const name of ['kind','FA','FB','PF','AF','NZCV','padding','round','GPR']){const f=fixture();f.space.mapAnonymous(DATA,4096n,3);try{await f.reset(1,{0:DATA});const r=await f.step(unit,{finish:false});const cpu=cfg.checkpoint.cpu,lazy=cfg.checkpoint.lazyFlags.offset,at={kind:lazy,FA:lazy+8,FB:lazy+16,PF:cpu.offset+cpu.parityRawOffset,AF:cpu.offset+cpu.auxiliaryRawOffset,NZCV:cpu.offset+cpu.nzcvOffset,padding:lazy+4,round:cfg.checkpoint.roundMode.offset,GPR:cpu.offset+cpu.generalRegistersOffset+8}[name];f.view.setUint8(f.tb+at,f.view.getUint8(f.tb+at)^1);assert.throws(()=>f.broker.finishInstruction(f.token,{status:r.status,nextRip:unit.nextRip}),B.BrokerInvariantError);forged.push('FINISH-'+name);}finally{f.close();}}
  const refused=[];
  for(const code of [[0x66,0x80,0x38,0],[0x66,0x82,0x38,0],[0x66,0x48,0x83,0x38,0],[0x66,0x41,0x83,0x3c,0x25,0,0,1,0,0],...[0xf0,0xf2,0xf3,0x64,0x65,0x67,0x2e,0x66].map(p=>[p,0x66,0x83,0x38,0]),...[0,1,2,3,4,5,6].map(g=>[0x66,0x83,g<<3,0])]){const u=await request(code);assert.equal(u.status,2,Buffer.from(code).toString('hex'));assert.equal(u.code.length,0);refused.push(code);}
  for(const d of definitions.filter(x=>x.rex===0)){const code=forms(d)[0].code;for(let n=0;n<code.length;n++){assert.equal((await request(code.slice(0,n))).status,2);refused.push(code.slice(0,n));}}
  const native=await(await get('/xlat/totals')).json();for(const field of ['irCacheEntries','irOwnedEntries','irDataBytes','irListBytes','irBufferCapacityBytes'])assert.equal(native[field],0);assert.equal(native.irGenerations,native.irDiscards);
  report={evidence:'Fresh/retained native x86 word-CMP flag oracle and actual sparse FEX/Wasm memory81/83 /7 at16 bits, checked addresses, exact owned flags and one read, all GPRs preserved, precise faults and rollback. Synthetic data; no Wine completion or device claim.',nativeOracle,coverageVersion:cfg.coverageVersion,buildID:cfg.buildID,comparisonCounts:{attempts:checks+successfulEdges+typedFaults,successfulExecutions:checks+successfulEdges,goldenExecutions:checks,successfulEdges,typedFaults},consumerChecks,executedWasmSteps,records,edges,negativeControls,forged,refused:refused.length,native};
 });
 report.nativeChildClosed=true;if(process.argv[3])fs.writeFileSync(process.argv[3],JSON.stringify(report,(_k,v)=>typeof v==='bigint'?'0x'+v.toString(16):v,2)+'\n');console.log(JSON.stringify({...report,records:report.records.length}));
}
main().catch(error=>{console.error(error);process.exitCode=1;});
