// SPDX-License-Identifier: GPL-3.0-or-later
// Native x86 oracle, all conditions/flags, and actual sparse FEX/Wasm SETcc.
const fs=require('fs'),path=require('path'),os=require('os'),vm=require('vm'),assert=require('node:assert/strict'),{spawnSync}=require('child_process');
const {serve}=require('./native-step-contract.cjs'),golden=require('./sparse-setcc-oracle.json');
for(const n of ['guest_memory','guest_memory_broker','thread_core'])vm.runInThisContext(fs.readFileSync(path.resolve(__dirname,'../../../Sources/BetterJITLinux/Resources/linux',n+'.js'),'utf8'));
const M=BetterJITGuestMemory,B=BetterJITGuestMemoryBroker,CODE=0x123400008000n,SC=CODE+0x100n,MASK=0xcd5n,inputs=golden.inputs.map(BigInt);
function forms(){const out=[],add=(name,prefix,rm,register,shift=0,full=true)=>out.push({name,prefix,rm,register,shift,full});
 for(let rm=0;rm<8;rm++)add('legacy-'+rm,[],0xc0+rm,rm<4?rm:rm-4,rm<4?0:8);
 for(let r=0;r<16;r++)add('REX-'+r,[r<8?0x40:0x41],0xc0+(r&7),r);
 for(let rex=0x40;rex<=0x4f;rex++)add('66-REX-ignored-'+rex,[0x66,rex],0xfc,4+((rex&1)?8:0),0,false);
 for(let reg=0;reg<8;reg++){add('ignored-ModRM-'+reg,[],0xc4+(reg<<3),0,8,false);add('66-ignored-ModRM-'+reg,[0x66],0xc4+(reg<<3),0,8,false);}
 return out;
}
function oracle(){
 if(process.platform!=='linux'||process.arch!=='x64')return{supported:false,reason:'Retained native x86 oracle checked through actual FEX/Wasm; fresh oracle requires Linux x86-64'};
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'betterjit-setcc-'));
 try{const bin=path.join(dir,'oracle'),build=spawnSync(process.env.CC||'cc',['-std=gnu11','-O2','-mno-red-zone','-Wall','-Wextra','-Werror',path.join(__dirname,'sparse-setcc-oracle.c'),'-o',bin],{encoding:'utf8',timeout:15000});assert.equal(build.status,0,build.stderr);const run=spawnSync(bin,[],{encoding:'utf8',timeout:15000,maxBuffer:4*1024*1024});assert.equal(run.status,0,run.stderr);assert.deepEqual(JSON.parse(run.stdout),golden);return{supported:true,rows:golden.rows.length};}finally{fs.rmSync(dir,{recursive:true,force:true});}
}
async function main(){
 const nativeOracle=oracle(),rows=new Map(golden.rows.map(r=>[[r[0],r[1],r[2]].join(':'),r]));let nativeAliasChecks=0;
 assert.equal(golden.rows.length,16*128*7);assert.equal(rows.size,golden.rows.length);
 for(const row of golden.rows){assert.equal(row[3],row[1]);const normal=rows.get([row[0],row[1],row[2]===1||row[2]===6?1:0].join(':'));assert.deepEqual(row[4],normal[4]);nativeAliasChecks++;}
 await serve('guestmem=broker1',async(get,log)=>{
  const cfg=await(await get('/xlat/config')).json(),state=new Uint8Array(await(await get('/xlat/state')).arrayBuffer());assert.equal(cfg.coverageVersion,26);
  const budget=new M.BackingBudget(),space=new M.GuestAddressSpace(budget),memory=B.createInternalMemory(),broker=new B.GuestMemoryBroker(),token=broker.register(0,{space,memory,checkpointLayout:cfg.checkpoint}),v=new DataView(memory.buffer),tb=B.ABI.threadBase,g=tb+cfg.ctx+cfg.gregsOff,c=cfg.checkpoint.cpu;
  let executedWasmSteps=0,checkedSETccs=0,lazyChecks=0;const records=[];
  async function request(bytes,rip=CODE){await get('/xlat/code?addr='+rip.toString(16),{method:'POST',body:Uint8Array.from(bytes)});return FexLinuxThread.parseBrokerStep(new Uint8Array(await(await get('/xlat/step?rip='+rip)).arrayBuffer()));}
  async function compile(bytes,operation=6,rip=CODE){const u=await request(bytes,rip);assert.equal(u.status,0,Buffer.from(bytes).toString('hex')+': '+log());assert.equal(u.operation,operation);assert.equal(u.width,0);assert.deepEqual([...u.instruction],bytes);assert.equal(u.nextRip,rip+BigInt(bytes.length));const module=await WebAssembly.compile(u.code);assert(WebAssembly.Module.imports(module).every(i=>i.module==='e'&&['mem','tb'].includes(i.name)),'SETcc must have no guest RPC import');u.instance=await WebAssembly.instantiate(module,{e:{mem:memory,tb:new WebAssembly.Global({value:'i32'},tb)}});return u;}
  function step(u){v.setBigUint64(tb+cfg.ctx+cfg.ripOff,u.rip,true);const checkpoint=broker.beginInstruction(token,{...u});v.setBigUint64(tb+B.ABI.scratchOffset+B.FIELD.checkpoint,checkpoint,true);const status=u.instance.exports.run();executedWasmSteps++;const r=broker.finishInstruction(token,{status,nextRip:u.nextRip});assert.equal(r.status,u.operation===5?B.STEP.SYSCALL:0);return r;}
  const syscall=await compile([15,5],5,SC),spans=['cpu','lazyFlags','roundMode'];
  const snapshot=()=>spans.map(n=>{const p=cfg.checkpoint[n];return new Uint8Array(memory.buffer,tb+p.offset,p.size).slice();});
  function initialize(flags){
   new Uint8Array(memory.buffer,tb+cfg.ctx,state.length).set(state);new Uint8Array(memory.buffer,tb+cfg.checkpoint.lazyFlags.offset,24).fill(0);
   // Pinned FEX CPUState: NZCV at flags+24, DF raw at flags+10. DF is
   // encoded as +1/-1; PF and AF retain intentionally nonzero upper bits.
   v.setUint32(tb+c.offset+c.nzcvOffset,((flags&128)?0x80000000:0)|((flags&64)?0x40000000:0)|((flags&1)?0:0x20000000)|((flags&2048)?0x10000000:0),true);
   v.setUint32(tb+c.offset+c.parityRawOffset,0xa5a5fe00|((flags&4)?0:1),true);v.setUint32(tb+c.offset+c.auxiliaryRawOffset,0x12345600|((flags&16)?0x10:0),true);
   v.setUint8(tb+c.offset+c.nzcvOffset-24+10,(flags&1024)?255:1);v.setUint32(tb+cfg.checkpoint.roundMode.offset,2,true);
  }
  function check(u,form,input,expected,flags){
   for(let r=0;r<16;r++)v.setBigUint64(g+r*8,r===form.register?input:0x1122334455000000n+BigInt(r)*0x10101n,true);
   v.setBigUint64(tb+cfg.ctx+cfg.ripOff,u.rip,true);const before=snapshot(),cpu=before[0].slice(),cv=new DataView(cpu.buffer);cv.setBigUint64(c.ripOffset,u.nextRip,true);cv.setBigUint64(c.generalRegistersOffset+form.register*8,expected,true);
   step(u);checkedSETccs++;const after=snapshot();
   assert(after[0].every((x,i)=>(i>=c.nzcvOffset&&i<c.nzcvOffset+4)||x===cpu[i]),'exact byte write and PF/AF/DF/unrelated CPU preservation: '+form.name);
   assert.deepEqual(after[1].subarray(4),before[1].subarray(4),'lazy operand/padding preservation');assert.deepEqual(after[2],before[2]);
   if(u.instruction.at(-2)===0x9a||u.instruction.at(-2)===0x9b){assert.deepEqual(after[1],before[1]);assert.deepEqual(after[0].subarray(c.nzcvOffset,c.nzcvOffset+4),before[0].subarray(c.nzcvOffset,c.nzcvOffset+4));}
   step(syscall);assert.equal(v.getBigUint64(g+11*8,true)&MASK,BigInt(flags),'architectural CF/PF/AF/ZF/SF/DF/OF preservation: '+form.name);
  }
  try{
   const units=[];
   for(let cc=0;cc<16;cc++)for(const form of forms()){
    const u=await compile([...form.prefix,15,0x90+cc,form.rm]);if(form.name==='legacy-0')units[cc]=u;let checks=0;
    for(const row of golden.rows){if(row[0]!==cc||row[2]!==0||(!form.full&&(row[1]&(16|1024))))continue;
     const expected=rows.get([cc,row[1],form.shift?1:0].join(':'))[4];for(let i=0;i<(form.full?inputs.length:1);i++){initialize(row[1]);check(u,form,inputs[i],BigInt(expected[i]),row[1]);checks++;}
    }records.push({cc,form:form.name,register:form.register,shift:form.shift,instruction:[...u.instruction],checks});
   }
   // Real predecessor instructions carry lazy arithmetic flags across units.
   // Read them once for the expected condition, then rerun the producer to
   // restore its unmaterialized state before executing SETcc.
   const seeds=[['add64',[0x48,1,0xd8]],['sub64',[0x48,0x29,0xd8]],['and64',[0x48,0x21,0xd8]],['xor32',[0x31,0xd8]],['TEST-AH',[0xf6,0xc4,0x80]],['SHR64',[0x48,0xd1,0xe8]]];
   const operands=[[0n,1n],[0x7fffffffffffffffn,1n],[0x8000000000000000n,0xffffffffffffffffn],[0xffffffffffffffffn,0x8000000000000001n],[0x1234567800008000n,0xff00n]];
   for(const [name,bytes]of seeds){const seed=await compile(bytes,6,SC+0x40n);for(const [a,b]of operands)for(let cc=0;cc<16;cc++){
    const prepare=()=>{initialize(0xcd5);v.setBigUint64(g,a,true);v.setBigUint64(g+24,b,true);step(seed);};
    prepare();step(syscall);const flags=Number(v.getBigUint64(g+11*8,true)&MASK),row=rows.get([cc,flags,0].join(':'));assert(row,name+' flag-mask oracle');
    prepare();check(units[cc],{name:name+'→SETcc'+cc,register:0,shift:0},inputs[2],BigInt(row[4][2]),flags);lazyChecks++;
   }}
   const refused=[];
   for(let cc=0;cc<16;cc++)for(const bytes of [[15,0x90+cc,0],[15,0x90+cc,0x44,0x24,0x20],[15,0x90+cc,0x85,0,0,0,0],[15,0x90+cc],[0x66,15,0x90+cc],[0x41,15,0x90+cc]]){const before=new Uint8Array(memory.buffer).slice(),u=await request(bytes);assert.equal(u.status,2);assert.equal(u.code.length,0);assert.deepEqual(new Uint8Array(memory.buffer),before);refused.push(Buffer.from(bytes).toString('hex'));}
   for(const prefix of [[0xf0],[0xf2],[0xf3],[0x64],[0x65],[0x67],[0x2e],[0x66,0x66],[0x40,0x66],[0x41,0x66],[0x40,0x41]]){const bytes=[...prefix,15,0x94,0xc4],before=new Uint8Array(memory.buffer).slice(),u=await request(bytes);assert.equal(u.status,2);assert.equal(u.code.length,0);assert.deepEqual(new Uint8Array(memory.buffer),before);refused.push(Buffer.from(bytes).toString('hex'));}
   await get('/xlat/code?addr='+CODE.toString(16),{method:'POST',body:Uint8Array.of(15,0x94,0xc0)});const header=new Uint8Array(await(await get('/xlat/step?rip='+CODE)).arrayBuffer());new DataView(header.buffer).setUint32(16,17,true);assert.throws(()=>FexLinuxThread.parseBrokerStep(header),/ABI/);
   assert.equal(broker.stats().requests,0);const native=await(await get('/xlat/totals')).json(),report={evidence:'Actual sparse FEX/Wasm register SETcc all 16 conditions, all 32 condition-flag combinations, independently varied AF/DF, partial-byte preservation, lazy predecessors and native x86 oracle. No Wine, device or native guest JIT replacement claim.',cfg,nativeOracle,oracleRows:golden.rows.length,nativeAliasChecks,checkedSETccs,executedWasmSteps,lazyChecks,records,refused,native};if(process.argv[3])fs.writeFileSync(process.argv[3],JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({...report,cfg:undefined,records:records.length,refused:refused.length}));
  }finally{broker.unregister(token);space.close();assert.equal(budget.stats().ownedPayloadBytes,0);}
 });
}
main().catch(e=>{console.error(e);process.exitCode=1;});
