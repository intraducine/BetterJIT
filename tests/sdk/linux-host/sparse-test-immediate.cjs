// SPDX-License-Identifier: GPL-3.0-or-later
// Immediate TEST registers: native x86 oracle and actual sparse FEX/Wasm.
const fs=require('fs'),path=require('path'),os=require('os'),vm=require('vm'),assert=require('node:assert/strict'),{spawnSync}=require('child_process');
const {serve}=require('./native-step-contract.cjs'),golden=require('./sparse-test-immediate-oracle.json');
for(const n of ['guest_memory','guest_memory_broker','thread_core'])vm.runInThisContext(fs.readFileSync(path.resolve(__dirname,'../../../Sources/BetterJITLinux/Resources/linux',n+'.js'),'utf8'));
const M=BetterJITGuestMemory,B=BetterJITGuestMemoryBroker,CODE=0x123400008000n,SC=CODE+0x100n,MASK=0x8c5n;
const masks={1:[0,1,0x7f,0x80,0xff,0x55,0xaa,0xfe],2:[0,1,0x7fff,0x8000,0xffff,0x55aa,0x80,0xff00],4:[0,1,0x7fffffff,0x80000000,0xffffffff,0x55aa55aa,0x80,0xffff0000],8:[0,1,0x7fffffff,0x80000000,0xffffffff,0x55aa55aa,0x80,0xffff0000]};
function forms(width){const result=[],add=(name,bytes,register,shift=0)=>result.push({name,bytes,register,shift});
 if(width===1){
  for(let r=0;r<4;r++){add('legacy-low-'+r,[0xf6,0xc0+r],r);add('legacy-high-'+r,[0xf6,0xc4+r],r,8);}
  for(let r=0;r<16;r++)add('REX-low-'+r,[r<8?0x40:0x41,0xf6,0xc0+(r&7)],r);
  add('66-AH',[0x66,0xf6,0xc4],0,8);add('66-SPL',[0x66,0x40,0xf6,0xc4],4);add('66-R12B',[0x66,0x41,0xf6,0xc4],12);
  for(const [rex,low,reg]of [[0x48,0,0],[0x48,4,4],[0x49,4,12],[0x44,4,4],[0x42,1,1],[0x4f,4,12]])add('ignored-REX-bits-'+rex+'-'+low,[rex,0xf6,0xc0+low],reg);
  for(const prefix of [[],[0x40],[0x41],[0x48],[0x49],[0x4f],[0x66],[0x66,0x4f]])add('accumulator-'+prefix.join('-'),[...prefix,0xa8],0);
 }else{
  for(let r=0;r<16;r++)add('group-register-'+r,[...(width===2?[0x66]:[]),...(width===8?[r<8?0x48:0x49]:r>=8?[0x41]:[]),0xf7,0xc0+(r&7)],r);
  const extra=width===2?[[[0x66,0x40],4,4],[[0x66,0x46],5,5],[[0x66,0x47],5,13]]:width===4?[[[0x40],4,4],[[0x44],5,5],[[0x42],2,2],[[0x47],5,13]]:[[[0x4c],5,5],[[0x4a],2,2],[[0x4f],5,13],[[0x66,0x48],4,4],[[0x66,0x49],4,12]];
  for(const [prefix,low,reg]of extra)add('prefix-'+prefix.join('-'),[...prefix,0xf7,0xc0+low],reg);
  const prefixes=width===2?[[0x66],[0x66,0x41],[0x66,0x44],[0x66,0x47]]:width===4?[[],[0x40],[0x41],[0x44],[0x47]]:[[0x48],[0x49],[0x4c],[0x4f],[0x66,0x48],[0x66,0x4f]];
  for(const prefix of prefixes)add('accumulator-'+prefix.join('-'),[...prefix,0xa9],0);
 }return result;
}
function code(form,width,mask){const n=Math.min(width,4),bytes=[];for(let i=0;i<n;i++)bytes.push(Number(BigInt(mask)>>BigInt(i*8)&255n));return[...form.bytes,...bytes];}
function oracle(){
 if(process.platform!=='linux'||process.arch!=='x64')return{supported:false,reason:'Retained x86 oracle checked through FEX/Wasm; no fresh native oracle on this host'};
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'betterjit-test-immediate-'));
 try{const binary=path.join(directory,'oracle'),build=spawnSync(process.env.CC||'cc',['-std=gnu11','-O2','-mno-red-zone','-Wall','-Wextra','-Werror',path.join(__dirname,'sparse-test-immediate-oracle.c'),'-o',binary],{encoding:'utf8',timeout:15000});assert.equal(build.status,0,build.stderr);const run=spawnSync(binary,[],{encoding:'utf8',timeout:15000});assert.equal(run.status,0,run.stderr);assert.deepEqual(JSON.parse(run.stdout),golden);return{supported:true,rows:golden.length};}finally{fs.rmSync(directory,{recursive:true,force:true});}
}
async function main(){const nativeOracle=oracle();
 // Direct native SPL/R12B and implicit-accumulator REX.B rows must agree with
 // the ordinary low-register oracle, while preserving the complete operand.
 const rows=new Map(golden.map(r=>[[r[0],r[1],r[2],r[3],r[4]].join(':'),r]));let nativePrefixRows=0;
 for(const r of golden){assert.equal(r[5],r[4]);if(r[2]>=2){const normal=rows.get([r[0],r[1],0,r[3],r[4]].join(':'));assert.equal(r[6],normal[6]);nativePrefixRows++;}}
 await serve('guestmem=broker1',async(get,log)=>{
  const cfg=await(await get('/xlat/config')).json(),state=new Uint8Array(await(await get('/xlat/state')).arrayBuffer());assert.equal(cfg.coverageVersion,20);
  async function request(bytes,rip=CODE){await get('/xlat/code?addr='+rip.toString(16),{method:'POST',body:Uint8Array.from(bytes)});return FexLinuxThread.parseBrokerStep(new Uint8Array(await(await get('/xlat/step?rip='+rip)).arrayBuffer()));}
  async function compile(bytes,operation=6,rip=CODE){const u=await request(bytes,rip);assert.equal(u.status,0,Buffer.from(bytes).toString('hex')+': '+log());assert.equal(u.operation,operation);assert.equal(u.width,0);assert.deepEqual([...u.instruction],bytes);assert.equal(u.nextRip,rip+BigInt(bytes.length));u.module=await WebAssembly.compile(u.code);assert(WebAssembly.Module.imports(u.module).every(i=>i.module==='e'&&['mem','tb'].includes(i.name)),'TEST must have no guest-memory import');return u;}
  const seedUnits=[await compile([0x45,1,0xc9],6,SC),await compile([0x49,0x83,0xe9,1],6,SC+0x20n)],syscall=await compile([15,5],5,SC+0x40n),branches=[];
  for(let op=0x72;op<=0x79;op++)branches.push(await compile([op,0x40],7,SC+0x100n+BigInt(op)*8n));
  for(const op of [0x88,0x89])branches.push(await compile([15,op,0x40,0,0,0],7,SC+0x1000n+BigInt(op)*8n));
  const budget=new M.BackingBudget(),space=new M.GuestAddressSpace(budget),memory=B.createInternalMemory(),broker=new B.GuestMemoryBroker(),token=broker.register(0,{space,memory,checkpointLayout:cfg.checkpoint}),v=new DataView(memory.buffer),tb=B.ABI.threadBase,g=tb+cfg.ctx+cfg.gregsOff,spans=['cpu','lazyFlags','roundMode'];let executedWasmSteps=0,checkedTESTs=0,branchChecks=0;
  const snapshot=()=>spans.map(n=>{const p=cfg.checkpoint[n];return new Uint8Array(memory.buffer,tb+p.offset,p.size).slice();});
  async function step(u){v.setBigUint64(tb+cfg.ctx+cfg.ripOff,u.rip,true);const checkpoint=broker.beginInstruction(token,{...u});v.setBigUint64(tb+B.ABI.scratchOffset+B.FIELD.checkpoint,checkpoint,true);const instance=await WebAssembly.instantiate(u.module,{e:{mem:memory,tb:new WebAssembly.Global({value:'i32'},tb)}});const status=instance.exports.run();executedWasmSteps++;const result=broker.finishInstruction(token,{status,nextRip:u.nextRip});assert.equal(result.status,u.operation===5?B.STEP.SYSCALL:0);return result;}
  const records=[];
  try{for(const width of [1,2,4,8])for(const form of forms(width))for(let mask=0;mask<8;mask++){
   const bytes=code(form,width,masks[width][mask]),u=await compile(bytes),chosen=golden.filter(r=>r[0]===width&&r[1]===mask&&r[2]===(form.shift?1:0)),maskValue=width===8?BigInt.asUintN(64,BigInt.asIntN(32,BigInt(masks[width][mask]))):BigInt(masks[width][mask]),widthMask=(1n<<BigInt(width*8))-1n;
   for(const row of chosen){const input=BigInt(row[4]);new Uint8Array(memory.buffer,tb+cfg.ctx,state.length).set(state);v.setBigUint64(g+9*8,row[3]===0?0x80000000n:0n,true);await step(seedUnits[row[3]]);
    for(let r=0;r<16;r++)v.setBigUint64(g+r*8,r===form.register?input:0x1122334400000000n+BigInt(r),true);v.setUint32(tb+cfg.checkpoint.roundMode.offset,2,true);v.setBigUint64(tb+cfg.ctx+cfg.ripOff,u.rip,true);const before=snapshot();
    await step(u);checkedTESTs++;
    const operand=form.shift?BigInt.asUintN(32,input)>>8n:input,result=operand&maskValue&widthMask,pf=maskValue===widthMask&&width<4?operand:result,expected=before[0].slice(),cpu=new DataView(expected.buffer),c=cfg.checkpoint.cpu;
    cpu.setBigUint64(c.ripOffset,u.nextRip,true);cpu.setUint32(c.parityRawOffset,Number(BigInt.asUintN(32,pf)),true);const after=snapshot();
    assert(after[0].every((x,i)=>(i>=c.nzcvOffset&&i<c.nzcvOffset+4)||x===expected[i]),'TEST preserves all GPR bits, AF raw and unrelated CPU bytes: '+Buffer.from(bytes).toString('hex'));
    assert.deepEqual(after[1].subarray(4,8),before[1].subarray(4,8));assert.deepEqual(after[2],before[2]);
    if(form.name===(width===1?'legacy-low-0':'group-register-0'))for(const branch of branches){const op=branch.instruction[0]===15?branch.instruction[1]-16:branch.instruction[0],flags=row[6],cf=!!(flags&1),zf=!!(flags&64),sf=!!(flags&128),taken=[cf,!cf,zf,!zf,cf||zf,!cf&&!zf,sf,!sf][op-0x72];assert.equal((await step(branch)).rip,taken?branch.branchTarget:branch.nextRip);branchChecks++;}
    await step(syscall);assert.equal(v.getBigUint64(g+11*8,true)&MASK,BigInt(row[6]),'native defined flags: '+Buffer.from(bytes).toString('hex')+' input '+row[4]);
   }records.push({width,form:form.name,register:form.register,shift:form.shift,mask:masks[width][mask],instruction:bytes,checks:chosen.length,allGPRBitsPreserved:true,noGuestRPC:true});
  }
  const refused=[];for(const bytes of [[0xf6,0xc8,0x80],[0xf7,0xc8,1,0,0,0],[0x66,0xf7,0xc8,1,0],[0x48,0xf7,0xc8,1,0,0,0],[0xf6,0,0x80],[0x66,0xf7,0,1,0],[0xf7,0,1,0,0,0],[0x48,0xf7,0,1,0,0,0],[0xf6,0xc4],[0xf7,0xc0,1,0,0],[0x66,0xf7,0xc0,1],[0x48,0xf7,0xc0,1,0,0],[0xa8],[0xa9,1,0,0],[0x66,0xa9,1],[0x48,0xa9,1,0,0],[0xf0,0xf6,0xc4,0x80],[0xf2,0xf6,0xc4,0x80],[0xf3,0xf6,0xc4,0x80],[0x64,0xf6,0xc4,0x80],[0x65,0xf6,0xc4,0x80],[0x67,0xf6,0xc4,0x80],[0x66,0x66,0xf7,0xc0,1,0],[0x40,0x66,0xf7,0xc0,1,0],[0x40,0x48,0xf6,0xc4,0x80],[0xf6,0xd4,0x80],[0xf7,0xf8,1,0,0,0]]){const before=new Uint8Array(memory.buffer).slice(),u=await request(bytes);assert.equal(u.status,2,Buffer.from(bytes).toString('hex'));assert.equal(u.code.length,0);assert.deepEqual(new Uint8Array(memory.buffer),before);refused.push(Buffer.from(bytes).toString('hex'));}
  await get('/xlat/code?addr='+CODE.toString(16),{method:'POST',body:Uint8Array.from([0xf6,0xc4,0x80])});const oldHeader=new Uint8Array(await(await get('/xlat/step?rip='+CODE)).arrayBuffer());new DataView(oldHeader.buffer).setUint32(16,16,true);assert.throws(()=>FexLinuxThread.parseBrokerStep(oldHeader),/ABI/);
  assert.equal(broker.stats().requests,0);const native=await(await get('/xlat/totals')).json(),report={evidence:'Actual FEX/Wasm register-only immediate TEST8/16/32/64 with native x86 defined logical flags, all GPR bits preserved, AF undefined. No Wine, device or JIT replacement claim.',cfg,nativeOracle,oracleRows:golden.length,nativePrefixRows,checkedTESTs,executedWasmSteps,branchChecks,records,refused,native};if(process.argv[3])fs.writeFileSync(process.argv[3],JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({...report,cfg:undefined,records:records.length,refused:refused.length}));
  }finally{broker.unregister(token);space.close();assert.equal(budget.stats().ownedPayloadBytes,0);}
 });
}
main().catch(e=>{console.error(e);process.exitCode=1;});
