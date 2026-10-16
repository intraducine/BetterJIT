// SPDX-License-Identifier: GPL-3.0-or-later
// Actual sparse FEX/Wasm integer extensions, checked against native x86-64.
const fs=require('fs'),path=require('path'),vm=require('vm'),os=require('os');
const {spawnSync}=require('child_process'),assert=require('node:assert/strict');
const {serve}=require('./native-step-contract.cjs'),golden=require('./sparse-extend-oracle.json');
for(const name of ['guest_memory','guest_memory_broker','thread_core'])vm.runInThisContext(fs.readFileSync(path.resolve(__dirname,
  '../../../Sources/BetterJITLinux/Resources/linux',name+'.js'),'utf8'));
const M=BetterJITGuestMemory,B=BetterJITGuestMemoryBroker,CODE=0x123400008000n,DATA=0x223456780000n;
const OLD=0x1122334455667788n,OLDD=0xaabbccddeeff0123n,MASK=0x8d5n;
const seeds=[[0,0],[0x7f,1],[0xffffffff,1],[0x80000000,0x80000000],[0x7fffffff,1],[0x80000000,1]];
const forms=[
  ['cbw',[0x66,0x98]],['cwde',[0x98]],['cdqe',[0x48,0x98]],
  ['cwd',[0x66,0x99]],['cdq',[0x99]],['cqo',[0x48,0x99]],
  ['movsx8-16',[0x66,0x0f,0xbe,0xc3],1],['movsx8-32',[0x0f,0xbe,0xc3],1],
  ['movsx8-64',[0x48,0x0f,0xbe,0xc3],1],['movsx16-32',[0x0f,0xbf,0xc3],2],
  ['movsx16-64',[0x48,0x0f,0xbf,0xc3],2],['movsxd32-64',[0x48,0x63,0xc3],4],
  ['movzx8-16',[0x66,0x0f,0xb6,0xc3],1],['movzx8-32',[0x0f,0xb6,0xc3],1],
  ['movzx8-64',[0x48,0x0f,0xb6,0xc3],1],['movzx16-32',[0x0f,0xb7,0xc3],2],
  ['movzx16-64',[0x48,0x0f,0xb7,0xc3],2]
];
const pack=value=>{const bytes=new Uint8Array(8);new DataView(bytes.buffer).setBigUint64(0,value,true);return bytes;};
function oracle(){
  if(process.platform!=='linux'||process.arch!=='x64')return {supported:false,
    reason:'Native oracle requires Linux x86-64; fresh FEX/Wasm still checks retained native results'};
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'betterjit-extend-'));
  try{
    const binary=path.join(dir,'oracle'),build=spawnSync(process.env.CC||'cc',['-O2','-mno-red-zone','-Wall','-Wextra','-Werror',
      path.join(__dirname,'sparse-extend-oracle.c'),'-o',binary],{encoding:'utf8'});
    assert.equal(build.status,0,build.stderr);const run=spawnSync(binary,[],{encoding:'utf8'});assert.equal(run.status,0,run.stderr);
    assert.deepEqual(JSON.parse(run.stdout),golden);return {supported:true,rows:golden.length,executions:golden.length*seeds.length};
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
}
async function main(){
  const nativeOracle=oracle();await serve('guestmem=broker1',async(get,log)=>{
    const cfg=await(await get('/xlat/config')).json(),state=new Uint8Array(await(await get('/xlat/state')).arrayBuffer());
    const units=new Map(),records=[],failures=[],rejected=[];let executedWasmSteps=0;
    async function request(bytes){
      await get('/xlat/code?addr='+CODE.toString(16),{method:'POST',body:Uint8Array.from(bytes)});
      return FexLinuxThread.parseBrokerStep(new Uint8Array(await(await get('/xlat/step?rip='+CODE)).arrayBuffer()));
    }
    async function compile(bytes,operation=0,width=0){
      const key=bytes.join(',');if(units.has(key))return units.get(key);
      const u=await request(bytes);assert.equal(u.status,0,key+': '+log());assert.equal(u.operation,operation);assert.equal(u.width,width);
      assert.equal(u.nextRip,CODE+BigInt(bytes.length));assert.deepEqual([...u.instruction],bytes);
      u.module=await WebAssembly.compile(u.code);assert(WebAssembly.Module.imports(u.module).every(i=>i.module==='e'&&
        (operation?['mem','tb','memory']:['mem','tb']).includes(i.name)),'No direct guest memory or dispatcher imports');
      units.set(key,u);return u;
    }
    const canonical=[];for(const form of forms)canonical.push(await compile(form[1]));
    const add=await compile([1,0xd8],6),syscall=await compile([15,5],5);
    // Every admitted REX combination is architecturally ignored except W.
    // 66+REX.W must select 64 bits, including when R/X/B are also set.
    const variants=[];
    for(const word of [false,true])for(let rex=0x40;rex<=0x4f;rex++)for(const opcode of [0x98,0x99]){
      const op=(opcode===0x99?3:0)+(rex&8?2:word?0:1);
      const code=[...(word?[0x66]:[]),rex,opcode];
      if(code.join(',')!==forms[op][1].join(','))variants.push({op,unit:await compile(code)});
    }
    const budget=new M.BackingBudget(),space=new M.GuestAddressSpace(budget,{virtualLimit:1n<<47n});
    space.mapAnonymous(DATA,8192n,3);const memory=B.createInternalMemory(),broker=new B.GuestMemoryBroker();
    const token=broker.register(0,{space,memory,checkpointLayout:cfg.checkpoint}),v=new DataView(memory.buffer),tb=B.ABI.threadBase,g=tb+cfg.ctx+cfg.gregsOff;
    let sequence=0,activeAddress=DATA;
    const spans=['cpu','lazyFlags','roundMode'];
    const snapshot=()=>spans.map(n=>{const p=cfg.checkpoint[n];return new Uint8Array(memory.buffer,tb+p.offset,p.size).slice();});
    async function step(u,expectedStatus=0,alter){
      v.setBigUint64(tb+cfg.ctx+cfg.ripOff,u.rip,true);
      const checkpoint=broker.beginInstruction(token,{...u});v.setBigUint64(tb+B.ABI.scratchOffset+B.FIELD.checkpoint,checkpoint,true);
      const before=snapshot(),instance=await WebAssembly.instantiate(u.module,{e:{mem:memory,tb:new WebAssembly.Global({value:'i32'},tb),memory:()=>{
        v.setUint32(tb+B.ABI.scratchOffset+B.FIELD.sequence,++sequence,true);v.setBigUint64(tb+B.ABI.scratchOffset+B.FIELD.lease,token.generation,true);
        alter?.();return broker.dispatch(token,{lease:token.generation,sequence}).status;
      }}});
      const status=instance.exports.run(),done=broker.finishInstruction(token,{status,nextRip:u.nextRip});executedWasmSteps++;
      assert.equal(status,expectedStatus,[...u.instruction]+': '+log());
      if(status===1||status===2)snapshot().forEach((bytes,i)=>assert.deepEqual(bytes,before[i],spans[i]+' rollback'));
      return {done,before};
    }
    async function seed(row,index){
      new Uint8Array(memory.buffer,tb+cfg.ctx,state.length).set(state);
      v.setBigUint64(g,BigInt(seeds[index][0]),true);v.setBigUint64(g+24,BigInt(seeds[index][1]),true);await step(add);await step(syscall,3);
      assert.equal(v.getBigUint64(g+88,true)&MASK,BigInt(row.flags[index][0]));
      for(let reg=0;reg<16;reg++)v.setBigUint64(g+reg*8,0x1020304000000000n+BigInt(reg),true);
      v.setBigUint64(g,row.op<6?BigInt(row.input):OLD,true);v.setBigUint64(g+16,OLDD,true);v.setBigUint64(g+24,BigInt(row.input),true);
      v.setUint32(tb+cfg.checkpoint.roundMode.offset,2,true);
    }
    async function check(row,u,index,{destination=0,source=3,sourceValue=BigInt(row.input),memory=false}={}){
      await seed(row,index);
      if(destination!==0)v.setBigUint64(g+destination*8,OLD,true);
      if(source!==3)v.setBigUint64(g+source*8,sourceValue,true);
      let memoryBefore,backingBefore;
      if(memory){
        v.setBigUint64(g+56,activeAddress,true);space.write(activeAddress,pack(BigInt(row.input)));
        memoryBefore=space.read(activeAddress,8);space.protect(DATA,8192n,1);backingBefore=budget.stats().ownedPayloadBytes;
      }
      const requests=broker.stats().requests,{before}=await step(u),expected=before[0].slice(),cpu=new DataView(expected.buffer);
      cpu.setBigUint64(cfg.ripOff,u.nextRip,true);cpu.setBigUint64(cfg.gregsOff+destination*8,BigInt(row.rax),true);
      if(row.op>=3&&row.op<=5)cpu.setBigUint64(cfg.gregsOff+16,BigInt(row.rdx),true);
      const after=snapshot();assert.deepEqual(after[0],expected,forms[row.op][0]+' full CPU');
      assert.deepEqual(after[1],before[1],'lazy flags preserved');assert.deepEqual(after[2],before[2],'rounding preserved');
      assert.equal(broker.stats().requests-requests,memory?1:0,'exact checked memory effect count');
      if(memory){
        assert.equal(v.getBigUint64(tb+B.ABI.scratchOffset+B.FIELD.address,true),activeAddress);
        assert.equal(v.getUint32(tb+B.ABI.scratchOffset+B.FIELD.width,true),forms[row.op][2]);
        assert.deepEqual(space.read(activeAddress,8),memoryBefore,'read-only guest bytes unchanged');
        assert.equal(budget.stats().ownedPayloadBytes,backingBefore,'extension read does not allocate backing');space.protect(DATA,8192n,3);
      }
      await step(syscall,3);assert.equal(v.getBigUint64(g+88,true)&MASK,BigInt(row.flags[index][1]),'all arithmetic flags including AF');
      records.push({op:forms[row.op][0],instruction:[...u.instruction],input:row.input,flags:row.flags[index][1],memory,destination,source});
    }
    try{
      for(const row of golden)for(let index=0;index<seeds.length;index++)await check(row,canonical[row.op],index);
      for(const variant of variants)for(const row of golden.filter(r=>r.op===variant.op))for(let index=0;index<seeds.length;index++)await check(row,variant.unit,index);
      // Existing explicit extensions: high GPRs, partial SP writes, high-byte
      // sources without REX, and REX low-byte SPL instead of AH.
      for(let op=6;op<forms.length;op++){
        const bytes=forms[op][1],modrm=bytes.length-1,legacy=bytes.filter((_,i)=>i!==modrm);
        for(const [destination,source]of [[8,9],[4,3],[15,5]]){
          const code=legacy.slice(),rexAt=code.findIndex(b=>b>=0x40&&b<=0x4f),rex=(rexAt<0?0x40:code[rexAt])|(destination>=8?4:0)|(source>=8?1:0);
          if(rexAt>=0)code[rexAt]=rex;else code.splice(code[0]===0x66?1:0,0,rex);
          code.push(0xc0|((destination&7)<<3)|(source&7));const unit=await compile(code);
          for(const row of golden.filter(r=>r.op===op))await check(row,unit,0,{destination,source});
        }
        if([6,7,12,13].includes(op)){
          const code=bytes.slice();code[modrm]=0xd4;const unit=await compile(code); // DX/EDX <- AH, without REX
          for(const row of golden.filter(r=>r.op===op))await check(row,unit,2,{destination:2,source:0,sourceValue:BigInt(row.input)<<8n});
        }
        if(forms[op][2]===1){
          const code=bytes.slice();code[modrm]=0xd4;
          if(!code.some(b=>b>=0x40&&b<=0x4f))code.splice(code[0]===0x66?1:0,0,0x40);
          const unit=await compile(code); // DX/EDX/RDX <- SPL, with REX
          for(const row of golden.filter(r=>r.op===op))await check(row,unit,3,{destination:2,source:4});
        }
        const memoryCode=bytes.slice();memoryCode[modrm]=0x07;const unit=await compile(memoryCode,1,forms[op][2]);
        for(const offset of [128n,129n,4095n]){activeAddress=DATA+offset;for(const row of golden.filter(r=>r.op===op))for(let index=0;index<seeds.length;index++)await check(row,unit,index,{memory:true});}
        const row=golden.find(r=>r.op===op);
        for(const kind of ['unmapped','end-unmapped','protection','range','forged-width']){
          await seed(row,2);const address=kind==='unmapped'?DATA+8192n:kind==='end-unmapped'?DATA+8193n-BigInt(forms[op][2]):kind==='range'?0xffffffffffffffffn:DATA+128n;
          v.setBigUint64(g+56,address,true);if(kind==='protection')space.protect(DATA,4096n,2);
          const beforeBytes=space.read(DATA+4096n,4096),expected=kind==='forged-width'?2:1;
          const {done}=await step(unit,expected,kind==='forged-width'?()=>v.setUint32(tb+B.ABI.scratchOffset+B.FIELD.width,8,true):undefined);
          assert.equal(done.memory.reason,({unmapped:B.REASON.UNMAPPED,'end-unmapped':B.REASON.UNMAPPED,protection:B.REASON.PROTECTION,range:B.REASON.RANGE,'forged-width':B.REASON.CHECKPOINT})[kind]);
          if(kind==='protection')space.protect(DATA,4096n,3);
          assert.deepEqual(space.read(DATA+4096n,4096),beforeBytes);failures.push({op:forms[op][0],kind,status:done.status});
        }
      }
    }finally{broker.unregister(token);space.close();assert.equal(budget.stats().ownedPayloadBytes,0);}
    for(const opcode of [0x98,0x99]){
      for(const prefix of [[0xf0],[0xf2],[0xf3],[0x64],[0x65],[0x67],[0x66,0x66],[0x48,0x48],[0x48,0x66]]){
        const bytes=[...prefix,opcode],u=await request(bytes);assert.equal(u.status,2,bytes.toString());assert.equal(u.code.length,0);rejected.push(bytes);
      }
      for(const bytes of [[0x66],[0x48],[0x66,0x48]]){const u=await request(bytes);assert.equal(u.status,2);assert.equal(u.code.length,0);rejected.push(bytes);}
    }
    const result={evidence:'Actual sparse FEX/Wasm accumulator and explicit integer sign/zero extensions checked against independent native x86 results and flag preservation; not Wine, WebKit or device evidence.',
      nativeOracle,coverageVersion:cfg.coverageVersion,buildID:cfg.buildID,compiledModules:units.size,executedWasmSteps,records,failures,rejected,native:await(await get('/xlat/stats')).json()};
    const text=JSON.stringify(result,null,2);if(process.argv[3])fs.writeFileSync(process.argv[3],text+'\n');console.log(text);
  });
}
main().catch(e=>{console.error(e);process.exitCode=1;});
