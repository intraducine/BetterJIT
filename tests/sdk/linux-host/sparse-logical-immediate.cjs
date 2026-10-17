// SPDX-License-Identifier: GPL-3.0-or-later
// Actual FEX/Wasm group-1 logical immediates. Native x86 is the flag oracle.
const fs=require('fs'),path=require('path'),os=require('os'),vm=require('vm');
const {spawnSync}=require('child_process'),assert=require('node:assert/strict');
const {serve}=require('./native-step-contract.cjs'),golden=require('./sparse-logical-immediate-oracle.json');
for(const name of ['guest_memory','guest_memory_broker','thread_core'])vm.runInThisContext(fs.readFileSync(path.resolve(__dirname,'../../../Sources/BetterJITLinux/Resources/linux',name+'.js'),'utf8'));
const M=BetterJITGuestMemory,B=BetterJITGuestMemoryBroker,RIP=0x123400008000n;
const inputs=[0n,1n,0x7fn,0x80n,0xffffffffn,0xffffffffffffffffn,0x8000000080000080n,0x123456789abcdefn];
const definitions=[];
for(const group of [1,4,6])for(const width of [4,8])for(const [opcode,masks]of [[0x81,[0,1,0x7fffffff,0x80000000,0xffffffff,0x5555aaaa,0x8000,0xffffff80]],[0x83,[0,1,0x7f,0x80,0xff,0x55,0xaa,0xfe]]])for(const mask of masks)for(const alias of [0,4,6])definitions.push({group,width,opcode,mask,alias});
function encoding(d,register=0,alias=d.alias,forceREX=false){const rex=(d.width===8?8:0)|(register>=8?1:0)|alias;return [...(rex||forceREX?[0x40|rex]:[]),d.opcode,0xc0|(d.group<<3)|(register&7),...Array.from({length:d.opcode===0x83?1:4},(_,i)=>Number(BigInt(d.mask)>>BigInt(i*8)&255n))];}
const rows=new Map(golden.map(row=>[row.slice(0,3).join(':'),row]));
function nativeOracle(){
 if(process.platform!=='linux'||process.arch!=='x64')return{supported:false,reason:'Retained native x86 rows used; fresh oracle requires Linux x86-64'};
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'betterjit-logical-'));
 try{const binary=path.join(temp,'oracle'),build=spawnSync(process.env.CC||'cc',['-O2','-mno-red-zone','-Wall','-Wextra','-Werror',path.join(__dirname,'sparse-logical-immediate-oracle.c'),'-o',binary],{encoding:'utf8'});assert.equal(build.status,0,build.stderr);const run=spawnSync(binary,[],{encoding:'utf8',maxBuffer:4*1024*1024});assert.equal(run.status,0,run.stderr);assert.deepEqual(JSON.parse(run.stdout),golden);return{supported:true,rows:golden.length};}finally{fs.rmSync(temp,{recursive:true,force:true});}
}
function independent(d,input,seed){
 const bits=d.width*8,x=BigInt.asUintN(bits,input),raw=BigInt.asIntN(d.opcode===0x83?8:32,BigInt(d.mask)),mask=BigInt.asUintN(bits,raw),result=d.group===1?x|mask:d.group===4?x&mask:x^mask;
 const parity=[...Number(result&255n).toString(2)].filter(c=>c==='1').length%2===0;
 return{result,flags:(parity?4:0)|(result===0n?64:0)|(result>>(BigInt(bits)-1n)?128:0)|(seed?0x400:0)};
}
async function main(){
 const oracle=nativeOracle();assert.equal(golden.length,4608);assert.equal(rows.size,golden.length);
 for(const [id,seed,input,result,flags]of golden){const expected=independent(definitions[id],inputs[input],seed);assert.equal(BigInt(result),expected.result);assert.equal(flags,expected.flags);const canonical=rows.get([id-id%3,seed,input].join(':'));assert.equal(result,canonical[3]);assert.equal(flags,canonical[4]);}
 let report;
 await serve('guestmem=broker1',async(get,log)=>{
  const cfg=await(await get('/xlat/config')).json(),state=new Uint8Array(await(await get('/xlat/state')).arrayBuffer());assert.equal(cfg.coverageVersion,29);
  const memory=B.createInternalMemory(),view=new DataView(memory.buffer),tb=B.ABI.threadBase,cpu=cfg.checkpoint.cpu,g=tb+cfg.ctx+cfg.gregsOff;
  const budget=new M.BackingBudget(),space=new M.GuestAddressSpace(budget),broker=new B.GuestMemoryBroker(),token=broker.register(0,{space,memory,checkpointLayout:cfg.checkpoint});
  const spans=['cpu','lazyFlags','roundMode'],snapshot=()=>spans.map(n=>{const p=cfg.checkpoint[n];return new Uint8Array(memory.buffer,tb+p.offset,p.size).slice();});
  async function request(code,rip=RIP){await get('/xlat/code?addr='+rip.toString(16),{method:'POST',body:Uint8Array.from(code)});return FexLinuxThread.parseBrokerStep(new Uint8Array(await(await get('/xlat/step?rip='+rip)).arrayBuffer()));}
  let compiled=0,checks=0,consumerChecks=0,rollbackChecks=0,steps=0;
  async function compile(code,operation=6){const unit=await request(code);assert.equal(unit.status,0,code+': '+log());assert.equal(unit.operation,operation);assert.equal(unit.width,0);assert.deepEqual([...unit.instruction],code);assert.equal(unit.nextRip,RIP+BigInt(code.length));const module=await WebAssembly.compile(unit.code);assert(WebAssembly.Module.imports(module).every(i=>i.module==='e'&&['mem','tb'].includes(i.name)));unit.instance=await WebAssembly.instantiate(module,{e:{mem:memory,tb:new WebAssembly.Global({value:'i32'},tb)}});compiled++;return unit;}
  function begin(unit){view.setBigUint64(tb+cfg.ctx+cfg.ripOff,unit.rip,true);const checkpoint=broker.beginInstruction(token,{rip:unit.rip,operation:unit.operation,width:unit.width,continuations:unit.continuations});view.setBigUint64(tb+B.ABI.scratchOffset+B.FIELD.checkpoint,checkpoint,true);}
  function step(unit){begin(unit);const result=broker.finishInstruction(token,{status:unit.instance.exports.run(),nextRip:unit.nextRip});assert.equal(result.status,unit.operation===5?B.STEP.SYSCALL:B.STEP.OK);steps++;return result;}
  const add=await compile([1,0xd8]),sub=await compile([0x29,0xd8]),syscall=await compile([15,5],5),setcc=[];
  for(let cc=0;cc<16;cc++)setcc.push(await compile([0x41,15,0x90+cc,0xc6]));
  const branch=[];for(let cc=0x72;cc<=0x79;cc++)branch.push(await compile([cc,0x40],7));
  function prepare(unit,register,input,seed){
   new Uint8Array(memory.buffer,tb+cfg.ctx,state.length).set(state);
   const bytes=new Uint8Array(memory.buffer,tb+cpu.offset,cpu.size);
   const flags=cpu.nzcvOffset-24;
   for(let i=0;i<bytes.length;i++)if((i<flags||i>=flags+48)&&(i<cfg.mxcsrOff||i>=cfg.mxcsrOff+4))bytes[i]=(0x5b+i*37+seed*89)&255;
   new Uint8Array(memory.buffer,tb+cfg.checkpoint.lazyFlags.offset+4,4).set([0xa5,0x3c,0x81,seed?0xff:0x11]);
   view.setBigUint64(g,seed?0x80000000n:0n,true);view.setBigUint64(g+24,seed?0x80000000n:1n,true);step(seed?add:sub);
   // Independently seed DF and undefined AF, preserving all unrelated flags.
   view.setInt8(tb+cpu.offset+cpu.nzcvOffset-24+10,seed?-1:1);
   view.setUint32(tb+cpu.offset+cpu.auxiliaryRawOffset,seed?0xffffffff:0,true);
   for(let r=0;r<16;r++)view.setBigUint64(g+r*8,r===register?input:0x1122334400000000n+BigInt(r)*0x10101n,true);
   view.setUint32(tb+cfg.checkpoint.roundMode.offset,seed?3:1,true);view.setBigUint64(tb+cfg.ctx+cfg.ripOff,unit.rip,true);
  }
  const condition=(cc,f)=>{const cf=!!(f&1),pf=!!(f&4),zf=!!(f&64),sf=!!(f&128),of=!!(f&2048);return[of,!of,cf,!cf,zf,!zf,cf||zf,!cf&&!zf,sf,!sf,pf,!pf,sf!==of,sf===of,zf||sf!==of,!zf&&sf===of][cc];};
  for(let id=0;id<definitions.length;id+=3){const d=definitions[id];
   for(let register=0;register<16;register++){
    const aliases=d.mask===(d.opcode===0x83?0x80:0x80000000)?[0,2,4,6]:[0];
    for(const alias of aliases){const unit=await compile(encoding(d,register,alias));
     for(let seed=0;seed<2;seed++)for(let input=0;input<inputs.length;input++){
      const row=rows.get([id,seed,input].join(':'));prepare(unit,register,inputs[input],seed);const before=snapshot();step(unit);checks++;
      const expected=before[0].slice(),ev=new DataView(expected.buffer);ev.setBigUint64(cpu.generalRegistersOffset+register*8,BigInt(row[3]),true);ev.setBigUint64(cpu.ripOffset,unit.nextRip,true);const after=snapshot();
      assert(after[0].every((v,i)=>(i>=cpu.nzcvOffset&&i<cpu.nzcvOffset+4)||(i>=cpu.parityRawOffset&&i<cpu.parityRawOffset+4)||v===expected[i]),'exact CPU/destination/AF preservation');assert.equal(view.getUint32(tb+cpu.offset+cpu.parityRawOffset,true),Number(BigInt(row[3])&0xffffffffn));assert.deepEqual(after[1].subarray(4,8),before[1].subarray(4,8));assert.deepEqual(after[2],before[2]);
      if(register===0&&alias===0&&input<2){for(let cc=0;cc<16;cc++){step(setcc[cc]);assert.equal(view.getBigUint64(g+14*8,true)&255n,condition(cc,row[4])?1n:0n);consumerChecks++;}for(let i=0;i<branch.length;i++){const b=branch[i],taken=condition(i+2,row[4]);assert.equal(step(b).rip,taken?b.branchTarget:b.nextRip);consumerChecks++;}}
      step(syscall);assert.equal(view.getBigUint64(g+11*8,true)&0xcc5n,BigInt(row[4]),'native defined flags and unchanged DF');
     }
     if(alias===0){prepare(unit,register,inputs[6],1);const before=snapshot();begin(unit);assert.equal(unit.instance.exports.run(),B.STEP.OK);steps++;const result=broker.finishInstruction(token,{status:B.STEP.UNSUPPORTED,nextRip:unit.nextRip});assert.equal(result.rip,unit.rip);assert.deepEqual(snapshot(),before,'injected unsupported completion restores full CPU/lazy/round checkpoint');rollbackChecks++;}
    }
   }
  }
  const refused=[];
  for(const d of definitions.filter(x=>x.alias===0)){
   const code=encoding(d);
   for(let n=0;n<code.length;n++)refused.push(code.slice(0,n));
   for(const prefix of [[0x66,0x66],[0x67],[0x64],[0x65],[0xf0],[0xf2],[0xf3],[0x2e],[0x40,0x41],[0x40,0x66]])refused.push([...prefix,...code]);
   refused.push([...(d.width===8?[0x48]:[]),d.opcode,d.group<<3,...code.slice(-1*(d.opcode===0x83?1:4))]);
  }
  for(const group of [1,4,6])for(const opcode of [0x80,0x82])refused.push([opcode,0xc0|(group<<3),1]);
  for(const group of [2,3])refused.push([0x83,0xc0|(group<<3),1]);
  for(const code of refused){const before=new Uint8Array(memory.buffer).slice(),unit=await request(code);assert.equal(unit.status,2,code+': '+log());assert.equal(unit.code.length,0);assert.equal(unit.nextRip,RIP);assert.deepEqual(new Uint8Array(memory.buffer),before);}
  const boundaries=[];
  for(const group of [1,4,6])for(const width of [4,8])for(const opcode of [0x81,0x83]){const code=encoding({group,width,opcode,mask:1,alias:0});for(const supported of [true,false]){const rip=(1n<<47n)-BigInt(code.length)-(supported?1n:0n),unit=await request(code,rip);assert.equal(unit.status,supported?0:2);boundaries.push({group,width,opcode,rip:'0x'+rip.toString(16),supported});}}
  broker.unregister(token);space.close();assert.equal(budget.stats().ownedPayloadBytes,0);const native=await(await get('/xlat/stats')).json();
  for(const field of ['irCacheEntries','irOwnedEntries','irDataBytes','irListBytes','irBufferCapacityBytes'])assert.equal(native[field],0,field);
  assert.equal(native.irGenerations,native.irDiscards);
  const result={evidence:'Native x86 oracle and actual FEX-generated sparse Wasm for group-1 OR/AND/XOR register32/64, signed 81/83 immediates, all GPRs, ignored REX.R/X aliases, defined flags/DF, exact unrelated CPU/AF/round preservation, and injected unsupported rollback. AF undefined. No Wine completion or device claim.',nativeOracle:oracle,coverageVersion:cfg.coverageVersion,buildID:cfg.buildID,compiled,arithmeticChecks:checks,consumerChecks,rollbackChecks,executedWasmSteps:steps,refused:refused.length,boundaries,native,backingBytesAfterClose:budget.stats().ownedPayloadBytes};
  report=result;
 });
 report.nativeChildClosed=true;
 if(process.argv[3])fs.writeFileSync(process.argv[3],JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
}
main().catch(e=>{console.error(e);process.exitCode=1;});
