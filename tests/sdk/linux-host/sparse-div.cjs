// SPDX-License-Identifier: GPL-3.0-or-later
// Real sparse FEX/Wasm DIV and native x86 #DE; no signal delivery/device claim.
const fs=require('fs'),path=require('path'),os=require('os'),vm=require('vm'),assert=require('node:assert/strict'),{spawnSync}=require('child_process'),{Worker}=require('worker_threads');
const {serve}=require('./native-step-contract.cjs'),golden=require('./sparse-div-oracle.json');
globalThis.self=globalThis;
for(const n of ['guest_memory','guest_memory_broker','thread_core','web/linux-kernel'])vm.runInThisContext(fs.readFileSync(path.resolve(__dirname,'../../../Sources/BetterJITLinux/Resources/linux',n+'.js'),'utf8'));
const M=BetterJITGuestMemory,B=BetterJITGuestMemoryBroker,RIP=0x123400008000n;
async function workerCheck(cfg,state,u,{low,high,divisor}){
 const {Kernel}=LinuxBundle.require('./kernel.js'),budget=new M.BackingBudget(),space=new M.GuestAddressSpace(budget,{virtualLimit:1n<<47n});space.mapAnonymous(u.rip,4096n,3);space.write(u.rip,u.instruction);space.protect(u.rip,4096n,5);
 const k=new Kernel({state,vfs:{},log:()=>{}},cfg),{thread,worker:d}=k.createSparseProcess({space,entryRip:u.rip,plans:[u]}),g=d.tb+cfg.ctx+cfg.gregsOff,v=thread.sparse.view;
 v.setBigUint64(g,low,true);v.setBigUint64(g+16,high,true);v.setBigUint64(g+8,divisor,true);const before=['cpu','lazyFlags','roundMode'].map(n=>{const p=cfg.checkpoint[n];return new Uint8Array(d.mem.buffer,d.tb+p.offset,p.size).slice();});
 const worker=new Worker(`const {parentPort,workerData:d}=require('worker_threads'),fs=require('fs'),vm=require('vm');globalThis.self=globalThis;for(const n of ['guest_memory','guest_memory_broker','thread_core'])vm.runInThisContext(fs.readFileSync(d.root+'/'+n+'.js','utf8'));FexLinuxThread.runThread({data:d,stepBroker:async(_space,rip)=>({...d.unit,rip})}).then(result=>parentPort.postMessage({result}),e=>parentPort.postMessage({error:String(e)}));`,{eval:true,workerData:{...d,unit:{...u,instance:undefined,module:await WebAssembly.compile(u.code)},root:path.resolve(__dirname,'../../../Sources/BetterJITLinux/Resources/linux'),maximumSteps:1,requestTimeoutMs:5000}});
 let timer,deadline;try{const result=await new Promise((resolve,reject)=>{worker.once('error',reject);worker.once('message',m=>m.error?reject(Error(m.error)):resolve(m.result));deadline=setTimeout(()=>reject(Error('Actual DIV worker deadline')),10000);timer=setInterval(()=>{try{k.serviceRequests();}catch(e){reject(e);}},1);});assert.equal(result.status,5);assert.equal(result.executed,1);assert.equal(result.guestExitCode,undefined);assert.equal(thread.sparse.exception.kind,'divide-error');assert.equal(thread.sparse.exception.rip,u.rip);assert.equal(k.sparseBroker.stats().threads,0);assert.equal(k.sparseBroker.stats().requests,0);for(let i=0;i<3;i++){const p=cfg.checkpoint[['cpu','lazyFlags','roundMode'][i]];assert.deepEqual(new Uint8Array(d.mem.buffer,d.tb+p.offset,p.size),before[i]);}return{status:result.status,executed:result.executed,exception:thread.sparse.exception.reason,guestExitCode:null,checkpointUnchanged:true};}
 finally{clearInterval(timer);clearTimeout(deadline);await worker.terminate();k.sparseBroker.unregister(thread.sparse.token);space.close();assert.equal(budget.stats().ownedPayloadBytes,0);}
}
function oracle(){
 if(process.platform!=='linux'||process.arch!=='x64')return{supported:false,reason:'Retained x86 oracle used; fresh SIGFPE oracle requires Linux x86-64'};
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'betterjit-div-'));
 try{const bin=path.join(dir,'oracle'),built=spawnSync(process.env.CC||'cc',['-std=gnu11','-O2','-mno-red-zone','-Wall','-Wextra','-Werror',path.join(__dirname,'sparse-div-oracle.c'),'-o',bin],{encoding:'utf8',timeout:15000});assert.equal(built.status,0,built.stderr);
  for(const [width,alias,low,high,d,expected]of golden){const run=spawnSync(bin,[String(width),String(alias),low.slice(2),high.slice(2),d.slice(2),'cd5'],{encoding:'utf8',timeout:1000});assert.equal(run.status,0,run.stderr);const actual=JSON.parse(run.stdout);for(const k of ['fault','a','d','c'])assert.equal(actual[k],expected[k]);if(actual.fault){for(const k of ['signalCode','trap','error','faultRIPExact'])assert.equal(actual[k],expected[k]);assert.equal(BigInt(actual.flags)&0xcd5n,0xcd5n);}else assert.equal(BigInt(actual.flags)&0x400n,0x400n);}
  return{supported:true,rows:golden.length};
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
}
async function main(){const nativeOracle=oracle();await serve('guestmem=broker1',async(get,log)=>{
 const cfg=await(await get('/xlat/config')).json(),state=new Uint8Array(await(await get('/xlat/state')).arrayBuffer());assert.equal(cfg.stepABI,4);assert.equal(cfg.coverageVersion,27);
 const budget=new M.BackingBudget(),space=new M.GuestAddressSpace(budget),memory=B.createInternalMemory(),broker=new B.GuestMemoryBroker(),token=broker.register(0,{space,memory,checkpointLayout:cfg.checkpoint}),view=new DataView(memory.buffer),tb=B.ABI.threadBase,g=tb+cfg.ctx+cfg.gregsOff,ripAt=tb+cfg.ctx+cfg.ripOff,units=new Map();
 let checks=0,divideErrors=0,wide64=0,nativeChecks=0;const refused=[],records=[];
 async function request(code,rip=RIP){await get('/xlat/code?addr='+rip.toString(16),{method:'POST',body:Uint8Array.from(code)});return FexLinuxThread.parseBrokerStep(new Uint8Array(await(await get('/xlat/step?rip='+rip)).arrayBuffer()));}
 async function unit(code){const key=code.join(',');if(units.has(key))return units.get(key);const u=await request(code);assert.equal(u.status,0,key+': '+log());assert.equal(u.operation,17);assert.equal(u.width,code[0]&8&&code.length===3?8:4);assert.deepEqual([...u.instruction],code);const module=await WebAssembly.compile(u.code);assert(WebAssembly.Module.imports(module).every(i=>i.module==='e'&&['mem','tb'].includes(i.name)));u.instance=await WebAssembly.instantiate(module,{e:{mem:memory,tb:new WebAssembly.Global({value:'i32'},tb)}});units.set(key,u);return u;}
 function check(u,low,high,divisor,native){
  new Uint8Array(memory.buffer,tb+cfg.ctx,state.length).set(state);for(const name of ['lazyFlags','roundMode']){const p=cfg.checkpoint[name];for(let i=0;i<p.size;i++)view.setUint8(tb+p.offset+i,(i*17+3)&255);}
  for(let r=0;r<16;r++)view.setBigUint64(g+r*8,0x1122334455000000n+BigInt(r),true);view.setBigUint64(g,low,true);view.setBigUint64(g+16,high,true);const source=u.divisionOperand.register;if(source!==0&&source!==2)view.setBigUint64(g+source*8,divisor,true);view.setBigUint64(ripAt,u.rip,true);
  const bits=u.width*8,l=BigInt.asUintN(bits,low),h=BigInt.asUintN(bits,high),d=BigInt.asUintN(bits,source===0?low:source===2?high:divisor),fault=d===0n||h>=d;
  const before=['cpu','lazyFlags','roundMode'].map(n=>{const p=cfg.checkpoint[n];return new Uint8Array(memory.buffer,tb+p.offset,p.size).slice();});
  broker.beginInstruction(token,{...u});const allBefore=fault?new Uint8Array(memory.buffer).slice():null,status=u.instance.exports.run();checks++;assert.equal(status,fault?5:0);
  if(fault){divideErrors++;assert.deepEqual(new Uint8Array(memory.buffer),allBefore,'typed DIVIDE_ERROR must precede every memory/state write');}
  const result=broker.finishInstruction(token,{status,nextRip:u.nextRip});assert.equal(result.memory,null);assert.equal(result.rip,fault?u.rip:u.nextRip);
  if(fault){assert.deepEqual(result.exception,{kind:'divide-error',vector:0,reason:d===0n?'zero-divisor':'quotient-overflow',rip:u.rip});assert(Object.isFrozen(result.exception));}
  else{const numerator=(h<<BigInt(bits))|l,c=new DataView(before[0].buffer);c.setBigUint64(cfg.ripOff,u.nextRip,true);c.setBigUint64(cfg.gregsOff,numerator/d,true);c.setBigUint64(cfg.gregsOff+16,numerator%d,true);if(u.width===8&&h!==0n)wide64++;}
  for(let i=0;i<3;i++){const p=cfg.checkpoint[['cpu','lazyFlags','roundMode'][i]];assert.deepEqual(new Uint8Array(memory.buffer,tb+p.offset,p.size),before[i],'full CPU/lazy/round checkpoint');}
  if(native){nativeChecks++;assert.equal(native.fault,fault);if(!fault){assert.equal(view.getBigUint64(g,true),BigInt(native.a));assert.equal(view.getBigUint64(g+16,true),BigInt(native.d));}}
 }
 try{
  assert.equal(golden.length,288);for(const [width,alias,low,high,d,native]of golden){const source=[1,0,2][alias],code=[...(width===8?[0x48]:[]),0xf7,0xf0+source];check(await unit(code),BigInt(low),BigInt(high),BigInt(d),native);}
  for(const rex of [0,...Array.from({length:16},(_,i)=>0x40+i)])for(let rm=0;rm<8;rm++){
   const code=[...(rex?[rex]:[]),0xf7,0xf0+rm],u=await unit(code),mask=(1n<<BigInt(u.width*8))-1n;
   for(const [low,high,d]of [[0n,0n,1n],[mask,0n,1n],[mask,1n,3n],[mask,mask-1n,mask],[0n,mask,mask],[7n,0n,0n],[mask,1n,1n],[1n,0n,mask]]){
    check(u,low,high,d);if(u.width===4)check(u,low|0xaabbccdd00000000n,high|0x1234567800000000n,d|0xdeadbeef00000000n);
   }records.push({instruction:code,width:u.width,source:u.divisionOperand.register});
  }
  const bad=[];for(const prefix of [[],[0x48],[0x41],[0x4f]]){for(let m=0;m<0xc0;m++)bad.push([...prefix,0xf7,m]);for(const group of [1,4,5,7])bad.push([...prefix,0xf7,0xc0+(group<<3)]);for(const n of [0,1])bad.push([...prefix,0xf7,0xf1].slice(0,prefix.length+n));}
  for(const prefix of [[0x66],[0x67],[0x64],[0x65],[0xf0],[0xf2],[0xf3],[0x2e],[0x66,0x48],[0x40,0x41],[0x40,0x66]])bad.push([...prefix,0xf7,0xf1]);bad.push([0xf6,0xf1]);
  for(const code of bad){const u=await request(code);assert.equal(u.status,2,Buffer.from(code).toString('hex'));assert.equal(u.code.length,0);refused.push(code);}
  for(const code of [[0xf7,0xf1],[0x48,0xf7,0xf1]])for(const valid of [true,false]){const u=await request(code,(1n<<47n)-BigInt(code.length)-(valid?1n:0n));assert.equal(u.status,valid?0:2);}
  const workerEvidence=[];for(const [code,values]of [[[0xf7,0xf1],{low:7n,high:0n,divisor:0n}],[[0x48,0xf7,0xf1],{low:1n,high:3n,divisor:3n}]])workerEvidence.push(await workerCheck(cfg,state,await unit(code),values));
  assert.equal(broker.stats().requests,0);assert(wide64>0);const report={evidence:'Actual sparse DIV32/64 and write-free typed DIVIDE_ERROR with native x86 oracle; successful arithmetic flags undefined in x86, stronger pinned preservation checked separately. No Linux SIGFPE delivery, Wine completion or device/JIT replacement claim.',cfg,nativeOracle,nativeChecks,checks,divideErrors,wide64,workerEvidence,units:units.size,records,refused,native:await(await get('/xlat/totals')).json()};if(process.argv[3])fs.writeFileSync(process.argv[3],JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({...report,cfg:undefined,records:records.length,refused:refused.length}));
 }finally{broker.unregister(token);space.close();assert.equal(budget.stats().ownedPayloadBytes,0);}
});}
main().catch(error=>{console.error(error);process.exitCode=1;});
