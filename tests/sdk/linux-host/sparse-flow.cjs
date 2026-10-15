// SPDX-License-Identifier: GPL-3.0-or-later
// Actual FEX/Wasm flags/finite continuations plus guest-controlled clone paths.
const fs=require('fs'),path=require('path'),os=require('os'),vm=require('vm'),assert=require('node:assert/strict'),{spawnSync}=require('child_process');
const {serve}=require('./native-step-contract.cjs'),{execute}=require('./sparse-clone.cjs'),F=require('./sparse-flow-fixture.cjs');
const golden=require('./sparse-flow-oracle.json'),M=BetterJITGuestMemory,B=BetterJITGuestMemoryBroker,CODE=0x123400008000n,BRANCH=CODE+0x100n,SC=CODE+0x200n;
function oracle(){
 if(process.platform!=='linux'||process.arch!=='x64')return {supported:false,reason:'Native oracle requires Linux x86-64; checked-in native oracle results still checked against actual FEX/Wasm'};
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'betterjit-flow-oracle-'));
 try{const binary=path.join(directory,'oracle'),build=spawnSync(process.env.CC||'cc',['-std=gnu11','-O2','-mno-red-zone','-Wall','-Wextra','-Werror',path.join(__dirname,'sparse-flow-oracle.c'),'-o',binary],{encoding:'utf8',timeout:10000});assert.equal(build.status,0,build.stderr);
  const run=spawnSync(binary,[],{encoding:'utf8',timeout:10000});assert.equal(run.status,0,run.stderr);assert.deepEqual(JSON.parse(run.stdout),golden);return {supported:true,records:golden.length};
 }finally{fs.rmSync(directory,{recursive:true,force:true});}
}
async function main(){const nativeOracle=oracle();await serve('guestmem=broker1',async(get,log)=>{
 const cfg=await(await get('/xlat/config')).json(),state=new Uint8Array(await(await get('/xlat/state')).arrayBuffer());assert.equal(cfg.stepHeaderBytes,96);
 async function compile(rip,code){await get('/xlat/code?addr='+rip.toString(16),{method:'POST',body:Uint8Array.from(code)});const u=FexLinuxThread.parseBrokerStep(new Uint8Array(await(await get('/xlat/step?rip='+rip)).arrayBuffer()));if(u.status!==0)await new Promise(r=>setTimeout(r,20));assert.equal(u.status,0,JSON.stringify(code)+': '+log());u.module=await WebAssembly.compile(u.code);return u;}
 const syscall=await compile(SC,[15,5]),records=[];
 const branches=[[0x74,0x40],[0x75,0xc0],[15,0x84,0x40,0,0,0],[15,0x85,0xc0,0xff,0xff,0xff]];
 for(const row of golden){
  const flag=await compile(CODE,[...(row.width===8?[0x48]:[]),row.test?0x85:0x39,0xd8]);
  const space=new M.GuestAddressSpace(new M.BackingBudget()),memory=B.createInternalMemory(),broker=new B.GuestMemoryBroker(),token=broker.register(0,{space,memory,checkpointLayout:cfg.checkpoint});
  const v=new DataView(memory.buffer),tb=B.ABI.threadBase,g=tb+cfg.ctx+cfg.gregsOff;new Uint8Array(memory.buffer,tb+cfg.ctx,state.length).set(state);v.setBigUint64(g,BigInt(row.a),true);v.setBigUint64(g+24,BigInt(row.b),true);
  async function step(u){v.setBigUint64(tb+cfg.ctx+cfg.ripOff,u.rip,true);broker.beginInstruction(token,{rip:u.rip,operation:u.operation,width:u.width,continuations:u.continuations});const instance=await WebAssembly.instantiate(u.module,{e:{mem:memory,tb:new WebAssembly.Global({value:'i32'},tb),memory:()=>{throw Error('Flags/branch touched guest memory');}}});const status=instance.exports.run();return broker.finishInstruction(token,{status,nextRip:u.nextRip});}
  for(const code of branches){await step(flag);const branch=await compile(BRANCH,code);const result=await step(branch),zero=!!(row.flags&64),taken=(code[0]===0x74||code[1]===0x84)?zero:!zero;assert.equal(result.rip,taken?branch.branchTarget:branch.nextRip);assert.equal(v.getBigUint64(g,true),BigInt(row.a));assert.equal(v.getBigUint64(g+24,true),BigInt(row.b));await step(syscall);assert.equal(v.getBigUint64(g+11*8,true)&BigInt(row.mask),BigInt(row.flags));records.push({test:row.test,width:row.width,a:row.a,b:row.b,branch:code,taken,nextRip:result.rip});}
  broker.unregister(token);space.close();
 }
 const direct=[];for(const code of [[0xeb,0x40],[0xe9,0xc0,0xff,0xff,0xff]]){const u=await compile(BRANCH,code);assert.equal(u.continuationKind,1);
  const space=new M.GuestAddressSpace(new M.BackingBudget()),memory=B.createInternalMemory(),broker=new B.GuestMemoryBroker(),token=broker.register(0,{space,memory,checkpointLayout:cfg.checkpoint}),v=new DataView(memory.buffer),tb=B.ABI.threadBase;
  new Uint8Array(memory.buffer,tb+cfg.ctx,state.length).set(state);v.setBigUint64(tb+cfg.ctx+cfg.ripOff,u.rip,true);broker.beginInstruction(token,{rip:u.rip,operation:u.operation,width:0,continuations:u.continuations});
  const instance=await WebAssembly.instantiate(u.module,{e:{mem:memory,tb:new WebAssembly.Global({value:'i32'},tb),memory:()=>{throw Error('Jump touched memory');}}});const status=instance.exports.run(),done=broker.finishInstruction(token,{status,nextRip:u.nextRip});assert.equal(done.rip,u.branchTarget);direct.push({code,target:done.rip});broker.unregister(token);space.close();}
 await get('/xlat/code?addr='+F.CODE.toString(16),{method:'POST',body:F.image});const units=[];for(const e of F.program){const u=FexLinuxThread.parseBrokerStep(new Uint8Array(await(await get('/xlat/step?rip='+e.rip)).arrayBuffer()));assert.equal(u.status,0,e.name+': '+log());assert.equal(u.operation,e.operation);u.module=await WebAssembly.compile(u.code);units.push(u);}
 const cases=[];for(const scenario of ['success','missing-continuation','terminate-before-ready'])cases.push(await execute(cfg,state,units,scenario,path.join(__dirname,'sparse-flow-fixture.cjs')));
 const result={evidence:'Actual FEX/Wasm TEST/CMP and direct finite branches, checked against independent native x86 flag results; guest clone return value chooses parent/child exit paths. No fork/exec/ELF/device or RAM claim.',cfg,native:await(await get('/xlat/stats')).json(),nativeOracle,records,direct,cases};
 const text=JSON.stringify(result,(_k,x)=>typeof x==='bigint'?'0x'+x.toString(16):x,2);if(process.argv[3])fs.writeFileSync(process.argv[3],text+'\n');console.log(text);
});}
main().catch(e=>{console.error(e);process.exitCode=1;});
