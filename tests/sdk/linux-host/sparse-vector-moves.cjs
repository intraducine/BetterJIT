// SPDX-License-Identifier: GPL-3.0-or-later
// Hardware oracle plus actual pinned FEX/Wasm; no memory-vector or device claim.
const fs=require('fs'),path=require('path'),os=require('os'),vm=require('vm'),assert=require('node:assert/strict'),{spawnSync}=require('child_process');
const {serve}=require('./native-step-contract.cjs'),D=require('./sparse-vector-moves-cases.json'),golden=require('./sparse-vector-moves-oracle.json');
for(const n of ['guest_memory','guest_memory_broker','thread_core'])vm.runInThisContext(fs.readFileSync(path.resolve(__dirname,'../../../Sources/BetterJITLinux/Resources/linux',n+'.js'),'utf8'));
const M=BetterJITGuestMemory,B=BetterJITGuestMemoryBroker,RIP=0x123400008000n,forms=D.forms.flatMap(f=>(f.width?[f.width]:[4,8]).map(width=>({...f,width}))),mask=0xffffffffn;
function expected(f,p){const [lo,hi,oldLo,oldHi,gpr]=p.map(BigInt),src=f.kind===1?gpr:lo,low=f.width===4?src&mask:src;
 return[f.kind===2?low:gpr,f.kind===2?oldLo:f.kind===5&&f.width===4?(oldLo&~mask)|low:low,f.kind===2||f.kind===5?oldHi:f.kind===3?hi:0n,lo,hi];}
function code(f,rex,m){return[...(f.prefix?[f.prefix]:[]),...(rex===undefined?[]:[rex]),15,f.opcode,0xc0|m];}
function hardware(){assert.equal(spawnSync('python3',[path.resolve(__dirname,'../../../scripts/generate-sparse-vector-moves-tests.py'),'--check'],{encoding:'utf8'}).status,0);
 assert.equal(golden.length,forms.length*D.patterns.length*D.flagSeeds.length);for(const [id,p,si,...r]of golden){assert.deepEqual(r.slice(0,5).map(BigInt),expected(forms[id],D.patterns[p]));assert.equal(r[5],D.flagSeeds[si]);}
 if(process.platform!=='linux'||process.arch!=='x64')return{supported:false,reason:'Retained x86 rows checked; fresh hardware oracle requires Linux x86-64'};
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'betterjit-vector-'));try{const bin=path.join(dir,'oracle'),build=spawnSync(process.env.CC||'cc',['-O2','-mno-red-zone','-Wall','-Wextra','-Werror',path.join(__dirname,'sparse-vector-moves-oracle.c'),'-o',bin],{encoding:'utf8'});assert.equal(build.status,0,build.stderr);const run=spawnSync(bin,[],{encoding:'utf8',maxBuffer:1024*1024});assert.equal(run.status,0,run.stderr);assert.deepEqual(JSON.parse(run.stdout),golden);return{supported:true,rows:golden.length};}finally{fs.rmSync(dir,{recursive:true,force:true});}}
async function main(){const nativeOracle=hardware();let report;await serve('guestmem=broker1',async(get,log)=>{
 const cfg=await(await get('/xlat/config')).json();assert.equal(cfg.coverageVersion,29);const memory=B.createInternalMemory(),v=new DataView(memory.buffer),tb=B.ABI.threadBase,cpu=cfg.checkpoint.cpu,g=tb+cpu.offset+cpu.generalRegistersOffset,x=tb+cpu.offset+cpu.xmmRegisters.offset;
 assert.deepEqual(cpu.xmmRegisters,{version:1,offset:cfg.xmmOff,stride:16,count:16,bytes:16});const budget=new M.BackingBudget(),space=new M.GuestAddressSpace(budget),broker=new B.GuestMemoryBroker(),token=broker.register(0,{space,memory,checkpointLayout:cfg.checkpoint});let steps=0,aliases=0,oracleChecks=0,rollback=0;
 async function request(c,rip=RIP){await get('/xlat/code?addr='+rip.toString(16),{method:'POST',body:Uint8Array.from(c)});return FexLinuxThread.parseBrokerStep(new Uint8Array(await(await get('/xlat/step?rip='+rip)).arrayBuffer()));}
 async function compile(c){const u=await request(c);assert.equal(u.status,0,Buffer.from(c).toString('hex')+': '+log());const m=await WebAssembly.compile(u.code);assert(WebAssembly.Module.imports(m).every(i=>i.module==='e'&&['mem','tb'].includes(i.name)));u.instance=await WebAssembly.instantiate(m,{e:{mem:memory,tb:new WebAssembly.Global({value:'i32'},tb)}});return u;}
 function seed(u,p,flags){for(const n of ['cpu','lazyFlags','roundMode']){const s=cfg.checkpoint[n],bytes=new Uint8Array(memory.buffer,tb+s.offset,s.size);for(let i=0;i<bytes.length;i++)bytes[i]=(i*37+flags+19)&255;}
  const a=u.vectorMoveOperand,[lo,hi,oldLo,oldHi,gpr]=p.map(BigInt);for(let r=0;r<16;r++){v.setBigUint64(g+r*8,0xfedcba9876540000n+BigInt(r)*0x101n,true);v.setBigUint64(x+r*16,lo^BigInt(r),true);v.setBigUint64(x+r*16+8,hi^BigInt(r),true);}
  v.setBigUint64(g,gpr,true);v.setBigUint64(x,oldLo,true);v.setBigUint64(x+8,oldHi,true);v.setBigUint64(x+16,lo,true);v.setBigUint64(x+24,hi,true);
  if(a.kind===2)v.setBigUint64(g+a.register*8,gpr,true);else{v.setBigUint64(x+a.register*16,oldLo,true);v.setBigUint64(x+a.register*16+8,oldHi,true);}
  if(a.kind===1)v.setBigUint64(g+a.source*8,gpr,true);else{v.setBigUint64(x+a.source*16,lo,true);v.setBigUint64(x+a.source*16+8,hi,true);}
  v.setUint32(tb+cfg.checkpoint.lazyFlags.offset,flags?0xfedcba98:9,true);v.setUint32(tb+cfg.checkpoint.roundMode.offset,flags?3:0,true);v.setBigUint64(tb+cpu.offset+cpu.ripOffset,RIP,true);
 }
 const snapshot=()=>['cpu','lazyFlags','roundMode'].map(n=>{const p=cfg.checkpoint[n];return new Uint8Array(memory.buffer,tb+p.offset,p.size).slice();});
 function run(u,status){const a=u.vectorMoveOperand;broker.beginInstruction(token,u);const before=snapshot(),expected=before.map(b=>b.slice()),c=new DataView(before[0].buffer),out=new DataView(expected[0].buffer),dest=a.kind===2?cpu.generalRegistersOffset+a.register*8:cpu.xmmRegisters.offset+a.register*16,src=a.kind===1?cpu.generalRegistersOffset+a.source*8:cpu.xmmRegisters.offset+a.source*16;
  out.setBigUint64(cpu.ripOffset,u.nextRip,true);if(a.kind!==5)expected[0].fill(0,dest,dest+(a.kind===2?8:16));expected[0].set(before[0].subarray(src,src+a.width),dest);
  const actual=u.instance.exports.run();assert.equal(actual,0);steps++;const done=broker.finishInstruction(token,{status:status??actual,nextRip:u.nextRip});assert.deepEqual(snapshot(),status===2?before:expected);return done;
 }
 try{
  for(const [id,p,si,...row]of golden){const f=forms[id],u=await compile(code(f,!D.forms.find(d=>d.name===f.name).width&&f.width===8?0x48:undefined,f.kind===1?0:f.reverse?8:1));seed(u,D.patterns[p],D.flagSeeds[si]);run(u);assert.deepEqual([v.getBigUint64(g,true),v.getBigUint64(x,true),v.getBigUint64(x+8,true),v.getBigUint64(x+16,true),v.getBigUint64(x+24,true)],row.slice(0,5).map(BigInt));oracleChecks++;}
  for(const f of D.forms)for(const rex of [undefined,...Array.from({length:16},(_,i)=>0x40+i)])for(let m=0;m<64;m++){
   const u=await compile(code(f,rex,m)),r=(m>>3)+((rex&4)?8:0),rm=(m&7)+((rex&1)?8:0),a={kind:f.kind,width:f.width||(rex&8?8:4),register:f.reverse?rm:r,source:f.reverse?r:rm,length:u.length};assert.deepEqual(u.vectorMoveOperand,a);aliases++;
   for(const p of D.patterns.slice(0,4))for(const flags of [0,0xcd5]){seed(u,p,flags);run(u);}
   if((m===0||m===63)&&(rex===undefined||rex===0x4f)){seed(u,D.patterns[3],0xcd5);assert.equal(run(u,2).rip,RIP);rollback++;}
  }
  const refused=[];for(const f of D.forms)for(const c of [[...(f.prefix?[f.prefix]:[]),15,f.opcode,0],[0x67,...code(f,undefined,1)],[0xf0,...code(f,undefined,1)],[0x40,0x66,...code(f,undefined,1)],[0x66,...code({...f,prefix:0x66},undefined,1)]]){if(c.join(',')===code(f,0x40,1).join(','))continue;assert.equal((await request(c)).status,2,c.join(','));refused.push(c);}
  for(const c of [[0x0f,0x6e,0xc0],[0x0f,0x7e,0xc0],[0xc5,0xf9,0x6e,0xc0],[0x66,0x0f,0xfc,0xc0],[0xf2,0x0f,0x6f,0xc0],[0x66,0x0f],[0x66,0x48,0x0f,0x6e]]){assert.equal((await request(c)).status,2);refused.push(c);}
  const boundaries=[];for(const f of D.forms)for(const valid of [true,false]){const c=code(f,0x4f,1),rip=(1n<<47n)-BigInt(c.length)-(valid?1n:0n);assert.equal((await request(c,rip)).status,valid?0:2);boundaries.push({name:f.name,valid});}
  const native=await(await get('/xlat/totals')).json();for(const key of ['irCacheEntries','irOwnedEntries','irDataBytes','irListBytes','irBufferCapacityBytes'])assert.equal(native[key],0);assert.equal(native.irDiscards,native.irGenerations);assert.equal(broker.stats().requests,0);
  report={evidence:'Native x86 results/flag preservation, actual pinned FEX/Wasm aliases, full CPU/lazy/round preservation including separate AVX upper halves and padding. No vector memory/arithmetic, Wine completion or device claim.',nativeOracle,oracleChecks,aliases,rollback,steps,refused,boundaries,native,coverageVersion:cfg.coverageVersion,buildID:cfg.buildID};
 }finally{broker.unregister(token);space.close();assert.equal(budget.stats().ownedPayloadBytes,0);}
 });report.nativeChildClosed=true;if(process.argv[3])fs.writeFileSync(process.argv[3],JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));}
main().catch(e=>{console.error(e);process.exitCode=1;});
