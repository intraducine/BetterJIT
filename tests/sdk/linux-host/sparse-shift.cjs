// SPDX-License-Identifier: GPL-3.0-or-later
// Register SHL/SHR/SAR through production sparse FEX/Wasm, native defined flags.
const fs=require('fs'),path=require('path'),os=require('os'),vm=require('vm'),assert=require('node:assert/strict'),{spawnSync}=require('child_process');
const {serve}=require('./native-step-contract.cjs'),golden=require('./sparse-shift-oracle.json');
for(const n of ['guest_memory','guest_memory_broker','thread_core'])vm.runInThisContext(fs.readFileSync(path.resolve(__dirname,'../../../Sources/BetterJITLinux/Resources/linux',n+'.js'),'utf8'));
const M=BetterJITGuestMemory,B=BetterJITGuestMemoryBroker,CODE=0x123400008000n,groups=[4,5,7],counts=[0,1,2,7,8,15,16,31,32,33,63,64,65,127,128,129,255];
function oracle(){
 if(process.platform!=='linux'||process.arch!=='x64')return {supported:false,reason:'Retained Linux x86 oracle checked by fresh FEX/Wasm; no native x86 oracle execution on this host'};
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'betterjit-shift-'));
 try{const binary=path.join(dir,'oracle'),build=spawnSync(process.env.CC||'cc',['-std=gnu11','-O2','-mno-red-zone','-Wall','-Wextra','-Werror',path.join(__dirname,'sparse-shift-oracle.c'),'-o',binary],{encoding:'utf8',timeout:10000});assert.equal(build.status,0,build.stderr);
  const run=spawnSync(binary,[],{encoding:'utf8',timeout:10000,maxBuffer:4*1024*1024});assert.equal(run.status,0,run.stderr);assert.deepEqual(JSON.parse(run.stdout),golden);return {supported:true,rows:golden.length};
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
}
function encoding(kind,width,form,count,dest){const rex=(width===8?0x48:0x40)|(dest>=8?1:0),opcode=form===0||form===3?0xd3:form===1?0xc1:0xd1;
 return [...(rex===0x40?[]:[rex]),opcode,0xc0|(groups[kind]<<3)|(dest&7),...(form===1?[count]:[])];}
async function main(){const nativeOracle=oracle();await serve('guestmem=broker1',async(get,log)=>{
 const cfg=await(await get('/xlat/config')).json(),state=new Uint8Array(await(await get('/xlat/state')).arrayBuffer());assert.equal(cfg.coverageVersion,27);
 const units=new Map();async function request(code,rip=CODE){await get('/xlat/code?addr='+rip.toString(16),{method:'POST',body:Uint8Array.from(code)});return FexLinuxThread.parseBrokerStep(new Uint8Array(await(await get('/xlat/step?rip='+rip)).arrayBuffer()));}
 async function compile(code,operation=6){const key=code.join(',');if(units.has(key))return units.get(key);const u=await request(code);assert.equal(u.status,0,key+': '+log());assert.equal(u.operation,operation);assert.equal(u.width,0);assert.deepEqual([...u.instruction],code);assert.equal(u.nextRip,CODE+BigInt(code.length));u.module=await WebAssembly.compile(u.code);assert(WebAssembly.Module.imports(u.module).every(i=>i.module==='e'&&['mem','tb'].includes(i.name)),'No guest memory or syscall import');units.set(key,u);return u;}
 const seeds=[await compile([0x45,1,0xc9]),await compile([0x49,0x83,0xe9,1]),await compile([0x45,1,0xc9])],syscall=await compile([15,5],5),branches=[];
 for(let op=0x72;op<=0x79;op++)branches.push(await compile([op,0x40],7));
 const space=new M.GuestAddressSpace(new M.BackingBudget()),memory=B.createInternalMemory(),broker=new B.GuestMemoryBroker(),token=broker.register(0,{space,memory,checkpointLayout:cfg.checkpoint});
 const view=new DataView(memory.buffer),tb=B.ABI.threadBase,g=tb+cfg.ctx+cfg.gregsOff;let executedWasmSteps=0,checkedShifts=0,zeroCountCases=0,branchChecks=0;
 const read=p=>new Uint8Array(memory.buffer,tb+p.offset,p.size).slice();
 async function step(u){view.setBigUint64(tb+cfg.ctx+cfg.ripOff,u.rip,true);broker.beginInstruction(token,{...u});const instance=u.instance??=await WebAssembly.instantiate(u.module,{e:{mem:memory,tb:new WebAssembly.Global({value:'i32'},tb)}});const status=instance.exports.run();executedWasmSteps++;return broker.finishInstruction(token,{status,nextRip:u.nextRip});}
 const destinations=[0,4,8],summary={};
 async function check(row,dest){const [kind,width,form,count,seed,input,expected,beforeFlags,flags,mask]=row,u=await compile(encoding(kind,width,form,count,dest)),effective=count&(width===8?63:31);
  assert.equal(mask,effective===0?0x8d5:effective===1?0x8c5:0xc5,'Native mask only defined flags after x86 count masking');
  new Uint8Array(memory.buffer,tb+cfg.ctx,state.length).set(state);view.setBigUint64(g+9*8,seed===0?0x80000000n:seed===1?0n:1n,true);assert.equal((await step(seeds[seed])).status,0);
  const regs=Array.from({length:16},(_,r)=>0xabcdef0123456700n+BigInt(r));regs[1]=form===3?BigInt(input):0x1122334455667700n|BigInt(count);regs[dest]=BigInt(input);regs.forEach((v,r)=>view.setBigUint64(g+8*r,v,true));
  view.setUint32(tb+cfg.checkpoint.roundMode.offset,2,true);view.setBigUint64(tb+cfg.ctx+cfg.ripOff,u.rip,true);
  const cpu=read(cfg.checkpoint.cpu),lazy=read(cfg.checkpoint.lazyFlags),round=read(cfg.checkpoint.roundMode);
  assert.equal((await step(u)).status,0);checkedShifts++;
  regs.forEach((v,r)=>assert.equal(view.getBigUint64(g+8*r,true),r===dest?BigInt(expected):v,`${kind}/${width}/${form}/${count}/${seed} GPR${r}`));assert.deepEqual(read(cfg.checkpoint.roundMode),round);
  if(effective===0){zeroCountCases++;const expectedCPU=new DataView(cpu.buffer);expectedCPU.setBigUint64(cfg.gregsOff+8*dest,BigInt(expected),true);expectedCPU.setBigUint64(cfg.ripOff,u.nextRip,true);assert.deepEqual(read(cfg.checkpoint.cpu),cpu,'Zero-count CPU flags/PF/AF/NZCV unchanged');assert.deepEqual(read(cfg.checkpoint.lazyFlags),lazy,'Zero-count lazy kind and operands unchanged');assert.equal(flags,beforeFlags);}
  // Consume live flags through real finite branches before a syscall materializes them.
  if(checkedShifts%17===0){const i=branchChecks++%8,cf=!!(flags&1),zf=!!(flags&64),sf=!!(flags&128),taken=[cf,!cf,zf,!zf,cf||zf,!cf&&!zf,sf,!sf][i],branch=branches[i];assert.equal((await step(branch)).rip,taken?branch.branchTarget:branch.nextRip);}
  assert.equal((await step(syscall)).status,B.STEP.SYSCALL);assert.equal(view.getBigUint64(g+11*8,true)&BigInt(mask),BigInt(flags),`${kind}/${width}/${form}/${count}/${seed} defined flags`);
  const key=kind+':'+width+':'+form;summary[key]=(summary[key]||0)+1;
 }
 try{for(const row of golden.filter(r=>r[1]>=4))for(const dest of row[2]===3?[1]:destinations)await check(row,dest);
  // Include every destination, while separately checking all16 registers on every row.
  for(const dest of Array.from({length:16},(_,i)=>i))for(const row of golden.filter(r=>r[1]>=4&&r[2]===1&&[0,1,32,64,255].includes(r[3])&&r[4]===0&&r[5]==='0xfedcba9887654321'))await check(row,dest);
  const smallRows=golden.filter(r=>r[1]<4),smallSummary={},prefixRecords=[];let smallChecked=0,smallZero=0,smallBranchChecks=0,prefixChecked=0;
  assert.equal(smallRows.length,18144);const cpu=cfg.checkpoint.cpu,smallCounts=Array.from({length:32},(_,i)=>i).concat([32,33,63,64,65,127,128,129,255]);
  function byteForms(){const out=[];for(let rm=0;rm<8;rm++)out.push({name:'legacy-'+rm,width:1,prefix:[],rm,root:rm<4?rm:rm-4,shift:rm<4?0:8});for(let root=0;root<16;root++)out.push({name:'REX-'+root,width:1,prefix:[root<8?0x40:0x41],rm:root&7,root,shift:0});return out;}
  function wordForms(){return Array.from({length:16},(_,root)=>({name:'word-'+root,width:2,prefix:root<8?[0x66]:[0x66,0x41],rm:root&7,root,shift:0}));}
  function nativeForm(form,wire){return wire===0?(form.root===1?(form.shift?7:3):(form.shift?4:0)):wire===1?(form.shift?5:1):(form.shift?6:2);}
  function codeFor(form,kind,wire,count){const opcode=form.width===1?[0xd2,0xc0,0xd0][wire]:[0xd3,0xc1,0xd1][wire];return[...form.prefix,opcode,0xc0|(groups[kind]<<3)|form.rm,...(wire===1?[count]:[])];}
  async function smallCheck(row,form,wire,extra=false){const [kind,width,nf,count,seed,input,expected,beforeFlags,flags,mask]=row,u=await compile(codeFor(form,kind,wire,count)),effective=count&31,expectedMask=effective===0?0x8d5:effective===1?0x8c5:0xc4|((kind===2||effective<width*8)?1:0);assert.equal(mask,expectedMask);
   new Uint8Array(memory.buffer,tb+cfg.ctx,state.length).set(state);view.setBigUint64(g+9*8,seed===0?0x80000000n:seed===1?0n:1n,true);assert.equal((await step(seeds[seed])).status,0);
   const regs=Array.from({length:16},(_,r)=>0xabcdef0123456700n+BigInt(r));regs[1]=nf===3||nf===7?BigInt(input):0x1122334455667700n|BigInt(count);regs[form.root]=BigInt(input);regs.forEach((v,r)=>view.setBigUint64(g+8*r,v,true));
   view.setUint8(tb+cpu.offset+cpu.nzcvOffset-24+10,seed===1?255:1);view.setUint32(tb+cfg.checkpoint.roundMode.offset,2,true);view.setBigUint64(tb+cfg.ctx+cfg.ripOff,u.rip,true);
   const before=read(cpu),lazy=read(cfg.checkpoint.lazyFlags),round=read(cfg.checkpoint.roundMode),expectedCPU=before.slice(),ev=new DataView(expectedCPU.buffer);ev.setBigUint64(cpu.generalRegistersOffset+8*form.root,BigInt(expected),true);ev.setBigUint64(cpu.ripOffset,u.nextRip,true);
   assert.equal((await step(u)).status,0);smallChecked++;if(extra)prefixChecked++;
   const after=read(cpu);assert.deepEqual(read(cfg.checkpoint.roundMode),round);
   if(effective===0){smallZero++;assert.deepEqual(after,expectedCPU,'Masked-zero preserves fullCPU inclAH/PF/AF/NZCV/DF');assert.deepEqual(read(cfg.checkpoint.lazyFlags),lazy,'Masked-zero preserves lazy kind/operands');assert.equal(flags,beforeFlags);}
   else{const flagField=i=>(i>=cpu.nzcvOffset&&i<cpu.nzcvOffset+4)||(i>=cpu.parityRawOffset&&i<cpu.parityRawOffset+4)||(i>=cpu.auxiliaryRawOffset&&i<cpu.auxiliaryRawOffset+4);assert(after.every((x,i)=>flagField(i)||x===expectedCPU[i]),'Small shift exact partial register/otherCPU/DF preservation');assert.deepEqual(read(cfg.checkpoint.lazyFlags).subarray(4,8),lazy.subarray(4,8));}
   if(smallChecked%17===0){const choices=mask&1?[0,1,2,3,4,5,6,7]:[2,3,6,7],i=choices[smallBranchChecks++%choices.length],cf=!!(flags&1),zf=!!(flags&64),sf=!!(flags&128),taken=[cf,!cf,zf,!zf,cf||zf,!cf&&!zf,sf,!sf][i],branch=branches[i];assert.equal((await step(branch)).rip,taken?branch.branchTarget:branch.nextRip);}
   assert.equal((await step(syscall)).status,B.STEP.SYSCALL);assert.equal(view.getBigUint64(g+11*8,true)&BigInt(mask),BigInt(flags),kind+'/'+width+'/'+wire+'/'+form.name+'/'+count+' definedflags');assert.equal(view.getBigUint64(g+11*8,true)&0x400n,seed===1?0x400n:0n,'DF preserved');
   const key=[kind,width,wire,form.shift,form.root===1].join(':');smallSummary[key]=(smallSummary[key]||0)+1;
  }
  for(const form of [...byteForms(),...wordForms()])for(let wire=0;wire<3;wire++){const nf=nativeForm(form,wire);for(const row of smallRows.filter(r=>r[1]===form.width&&r[2]===nf))await smallCheck(row,form,wire);}
  // Cover the complete bounded prefix grammar, including66+REX.W precedence,
  // ignored REX.R/X bits and every register selector, with representative rows.
  const prefixes=[[],[0x66],...Array.from({length:16},(_,i)=>[0x40+i]),...Array.from({length:16},(_,i)=>[0x66,0x40+i])];
  for(const prefix of prefixes)for(const byte of [true,false])for(let rm=0;rm<8;rm++){
   const rex=prefix.find(x=>x>=0x40&&x<=0x4f)||0,width=byte?1:(rex&8)?8:prefix.includes(0x66)?2:4,root=byte&&!rex&&rm>=4?rm-4:rm+((rex&1)?8:0),shift=byte&&!rex&&rm>=4?8:0,form={name:'prefix-'+prefix.join('-')+'-'+rm,width,prefix,rm,root,shift};
   for(let wire=0;wire<3;wire++){const nf=width<4?nativeForm(form,wire):wire===0&&root===1?3:wire===0?0:wire===1?1:2,rows=golden.filter(r=>r[1]===width&&r[2]===nf&&r[4]===1&&r[5]==='0xfedcba9887654321'&&[0,1,2,7,8,15,16,31,32,33,63,64,65,127,128,129,255].includes(r[3]));let checks=0;
    for(const row of rows){if(width<4)await smallCheck(row,form,wire,true);else{const u=await compile(codeFor(form,row[0],wire,row[3]));new Uint8Array(memory.buffer,tb+cfg.ctx,state.length).set(state);view.setBigUint64(g+9*8,0n,true);await step(seeds[1]);const regs=Array.from({length:16},(_,r)=>0xabcdef0123456700n+BigInt(r));regs[1]=nf===3?BigInt(row[5]):0x1122334455667700n|BigInt(row[3]);regs[root]=BigInt(row[5]);regs.forEach((v,r)=>view.setBigUint64(g+8*r,v,true));const lazy=read(cfg.checkpoint.lazyFlags),before=read(cpu);view.setBigUint64(tb+cfg.ctx+cfg.ripOff,u.rip,true);assert.equal((await step(u)).status,0);for(let r=0;r<16;r++)assert.equal(view.getBigUint64(g+r*8,true),r===root?BigInt(row[6]):regs[r]);if((row[3]&(width===8?63:31))===0){const ev=new DataView(before.buffer);ev.setBigUint64(cpu.generalRegistersOffset+root*8,BigInt(row[6]),true);ev.setBigUint64(cpu.ripOffset,u.nextRip,true);assert.deepEqual(read(cpu),before);assert.deepEqual(read(cfg.checkpoint.lazyFlags),lazy);}await step(syscall);assert.equal(view.getBigUint64(g+11*8,true)&BigInt(row[9]),BigInt(row[8]));prefixChecked++;}checks++;}
    assert(checks>0);prefixRecords.push({prefix,width,rm,root,shift,wire,checks});
   }
  }
  const negatives={};for(const width of [4,8])for(let kind=0;kind<3;kind++)for(const form of [0,1,2]){const code=encoding(kind,width,form,0,0);code[width===8?2:1]&=0x3f;negatives[`memory-${width}-${kind}-${form}`]=code;}
  for(const prefix of [0x67,0x64,0x65,0xf0,0xf2,0xf3])for(const opcode of [0xd1,0xd3,0xc1])negatives[`prefix-${prefix}-${opcode}`]=[prefix,0x48,opcode,0xe8,...(opcode===0xc1?[0]:[])];
  for(const opcode of [0xd1,0xd3,0xc1])for(const group of [0,1,2,3,6])negatives[`other-group-${opcode}-${group}`]=[0x48,opcode,0xc0|(group<<3),...(opcode===0xc1?[1]:[])];
  Object.assign(negatives,{doubleLeft:[0x48,15,0xa4,0xd8,1],doubleRight:[0x48,15,0xac,0xd8,1],truncatedOpcode:[0x48,0xd1],truncatedImmediate:[0x48,0xc1,0xe8],duplicateREX:[0x48,0x48,0xd1,0xe8]});
  for(const prefix of prefixes)for(const byte of [true,false])for(const opcode of byte?[0xd0,0xd2,0xc0]:[0xd1,0xd3,0xc1]){
   const count=opcode===0xc0||opcode===0xc1?[1]:[];for(const group of [4,5,7])negatives['memory-small-'+prefix+'-'+opcode+'-'+group]=[...prefix,opcode,group<<3,...count];for(const group of [0,1,2,3,6])negatives['group-small-'+prefix+'-'+opcode+'-'+group]=[...prefix,opcode,0xc0|(group<<3),...count];negatives['short-opcode-'+prefix+'-'+opcode]=[...prefix,opcode];if(count.length)negatives['short-imm-'+prefix+'-'+opcode]=[...prefix,opcode,0xe8];
  }
  for(const prefix of [[0x66,0x66],[0x40,0x66],[0x41,0x66],[0x40,0x41],[0x66,0x40,0x41]])for(const opcode of [0xd0,0xd2,0xc0,0xd1,0xd3,0xc1])negatives['bad-order-'+prefix+'-'+opcode]=[...prefix,opcode,0xe8,...(opcode===0xc0||opcode===0xc1?[1]:[])];
  const refused=[];for(const [name,code]of Object.entries(negatives)){const before=new Uint8Array(memory.buffer).slice(),u=await request(code);assert.equal(u.status,2,name+': '+log());assert.equal(u.code.length,0);assert.equal(u.nextRip,CODE);assert.deepEqual(new Uint8Array(memory.buffer),before);refused.push(name);}
  const addressCases=[];
  for(const form of [{name:'AH',width:1,prefix:[],rm:4,root:0,shift:8},{name:'SPL',width:1,prefix:[0x40],rm:4,root:4,shift:0},{name:'BP',width:2,prefix:[0x66],rm:5,root:5,shift:0}])for(let kind=0;kind<3;kind++)for(let wire=0;wire<3;wire++)for(const supported of [true,false]){
   const code=codeFor(form,kind,wire,0),rip=(1n<<47n)-BigInt(code.length)-(supported?1n:0n),before=new Uint8Array(memory.buffer).slice(),u=await request(code,rip);assert.equal(u.status,supported?0:2);if(supported){assert.equal(u.nextRip,(1n<<47n)-1n);assert(WebAssembly.validate(u.code));}else{assert.equal(u.nextRip,rip);assert.equal(u.code.length,0);}assert.deepEqual(new Uint8Array(memory.buffer),before);addressCases.push({form:form.name,kind,wire,rip:'0x'+rip.toString(16),supported});
  }
  assert.equal(broker.stats().requests,0,'Register shifts never issue guest memory requests');
  const result={evidence:'Actual register-only FEX/Wasm SHL/SHR/SAR8/16/32/64 with count1/imm8/CL, highbytes/REX, partial writes, all small masked counts, defined flags and oldCL aliases. No memory shifts, new Wine boundary or device claim.',cfg,nativeOracle,oracleRows:golden.length,rawCounts:counts,checkedShifts,zeroCountCases,branchChecks,executedWasmSteps,summary,smallCounts,smallChecked,smallZero,smallBranchChecks,prefixChecked,prefixRecords,addressCases,smallSummary,refused,native:await(await get('/xlat/totals')).json()};const text=JSON.stringify(result,null,2)+'\n';if(process.argv[3])fs.writeFileSync(process.argv[3],text);console.log(text);
 }finally{broker.unregister(token);space.close();}
 });}
main().catch(error=>{console.error(error);process.exitCode=1;});
