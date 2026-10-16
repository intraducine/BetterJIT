// SPDX-License-Identifier: GPL-3.0-or-later
// Actual FEX/Wasm NOPs: native-verified encodings, full checkpoint preservation,
// no operand access, and bounded refusals. This is host evidence, not Wine.
const fs=require('fs'),path=require('path'),vm=require('vm'),os=require('os'),crypto=require('crypto');
const {spawnSync}=require('child_process'),assert=require('node:assert/strict');
const {serve}=require('./native-step-contract.cjs'),{cases}=require('./sparse-nop-cases.cjs');
const golden=require('./sparse-nop-oracle.json'),forms=cases(),hex=bytes=>Buffer.from(bytes).toString('hex');
const instructionSHA256=crypto.createHash('sha256').update(forms.map(hex).join('\n')+'\n').digest('hex');
assert.equal(instructionSHA256,golden.instructionSHA256,'Retained native receipt must match every tested encoding');
for(const name of ['guest_memory','guest_memory_broker','thread_core'])vm.runInThisContext(fs.readFileSync(path.resolve(__dirname,
  '../../../Sources/BetterJITLinux/Resources/linux',name+'.js'),'utf8'));
const M=BetterJITGuestMemory,B=BetterJITGuestMemoryBroker,CODE=0x123400008000n,MASK=0x8d5n;
const seeds=[[0,0],[0x7f,1],[0xffffffff,1],[0x80000000,0x80000000],[0x7fffffff,1],[0x80000000,1]];
function oracle() {
  if(process.platform!=='linux'||process.arch!=='x64')return {supported:false,
    reason:'Native assembly oracle requires Linux x86-64; FEX/Wasm still checks the retained native encoding and flag receipt'};
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'betterjit-nop-'));
  try {
    const binary=path.join(dir,'oracle'),build=spawnSync(process.env.CC||'cc',['-O2','-mno-red-zone','-Wall','-Wextra','-Werror',
      path.join(__dirname,'sparse-nop-oracle.c'),path.join(__dirname,'sparse-nop-oracle.S'),'-o',binary],{encoding:'utf8'});
    assert.equal(build.status,0,build.stderr);
    const run=spawnSync(binary,forms.map(hex),{encoding:'utf8'});assert.equal(run.status,0,run.stderr+' '+run.signal);
    assert.deepEqual({...JSON.parse(run.stdout),instructionSHA256},golden);
    return {supported:true,...golden};
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
}
async function main() {
  const nativeOracle=oracle();await serve('guestmem=broker1',async(get,log)=>{
    const cfg=await(await get('/xlat/config')).json(),state=new Uint8Array(await(await get('/xlat/state')).arrayBuffer());
    const units=[],rejected=new Set();let executedWasmSteps=0,checkedNOPSteps=0;
    async function request(bytes) {
      assert((await get('/xlat/code?addr='+CODE.toString(16),{method:'POST',body:Uint8Array.from(bytes)})).ok);
      return FexLinuxThread.parseBrokerStep(new Uint8Array(await(await get('/xlat/step?rip='+CODE)).arrayBuffer()));
    }
    async function compile(bytes,operation=0,expected=bytes) {
      const u=await request(bytes);assert.equal(u.status,0,hex(bytes)+': '+log());assert.equal(u.operation,operation);assert.equal(u.width,0);
      assert.equal(u.nextRip,CODE+BigInt(expected.length));assert.deepEqual([...u.instruction],expected);
      u.module=await WebAssembly.compile(u.code);
      assert(WebAssembly.Module.imports(u.module).every(i=>i.module==='e'&&['mem','tb'].includes(i.name)),
        'A NOP cannot import guest memory RPC, dispatcher or syscall services');
      units.push(u);return u;
    }
    for(const bytes of forms)await compile(bytes);
    // Trailing bytes are a separate instruction, including after a legal
    // fifteen-byte NOP. Length is supplied independently by admission and FEX.
    const trailing=[];
    for(const bytes of [forms[0],forms.find(b=>b.length===15),[0x66,0x66,0x2e,0x0f,0x1f,0x84,0,0,0,0,0]])
      trailing.push(await compile([...bytes,0x0f,0x0b],0,bytes));
    const add=await compile([1,0xd8],6),syscall=await compile([15,5],5);
    const budget=new M.BackingBudget(),space=new M.GuestAddressSpace(budget,{virtualLimit:1n<<47n});
    // No guest mappings at all: every ModRM address is permitted for a NOP,
    // without looking up protection, canonicality or guest operand bytes.
    const memory=B.createInternalMemory(),broker=new B.GuestMemoryBroker();
    const token=broker.register(0,{space,memory,checkpointLayout:cfg.checkpoint}),v=new DataView(memory.buffer),tb=B.ABI.threadBase,g=tb+cfg.ctx+cfg.gregsOff;
    const spans=['cpu','lazyFlags','roundMode'];
    const snapshot=()=>spans.map(n=>{const p=cfg.checkpoint[n];return new Uint8Array(memory.buffer,tb+p.offset,p.size).slice();});
    const restore=checkpoint=>spans.forEach((n,i)=>new Uint8Array(memory.buffer,tb+cfg.checkpoint[n].offset,checkpoint[i].length).set(checkpoint[i]));
    async function step(u,status=0) {
      v.setBigUint64(tb+cfg.ctx+cfg.ripOff,u.rip,true);
      const checkpoint=broker.beginInstruction(token,{...u});v.setBigUint64(tb+B.ABI.scratchOffset+B.FIELD.checkpoint,checkpoint,true);
      const before=snapshot(),requests=broker.stats().requests;
      const instance=await WebAssembly.instantiate(u.module,{e:{mem:memory,tb:new WebAssembly.Global({value:'i32'},tb)}});
      assert.equal(instance.exports.run(),status,hex(u.instruction)+': '+log());
      broker.finishInstruction(token,{status,nextRip:u.nextRip});executedWasmSteps++;
      assert.equal(broker.stats().requests,requests,'No memory RPC for register instructions or NOP operands');
      return before;
    }
    try {
      const seeded=[];
      for(let index=0;index<seeds.length;index++) {
        new Uint8Array(memory.buffer,tb+cfg.ctx,state.length).set(state);
        v.setBigUint64(g,BigInt(seeds[index][0]),true);v.setBigUint64(g+24,BigInt(seeds[index][1]),true);
        await step(add);await step(syscall,3);assert.equal(v.getBigUint64(g+88,true)&MASK,BigInt(golden.flags[index]));
        v.setUint32(tb+cfg.checkpoint.roundMode.offset,2,true);seeded.push(snapshot());
      }
      for(const u of units.slice(0,forms.length).concat(trailing))for(const addressText of golden.addresses)for(let seed=0;seed<seeds.length;seed++) {
        restore(seeded[seed]);const address=BigInt(addressText);
        for(let reg=0;reg<16;reg++)v.setBigUint64(g+reg*8,BigInt.asUintN(64,address+BigInt(reg*8)),true);
        const before=await step(u),expected=before[0].slice();new DataView(expected.buffer).setBigUint64(cfg.ripOff,u.nextRip,true);
        const after=snapshot();assert.deepEqual(after[0],expected,'All CPU bytes except RIP remain unchanged: '+hex(u.instruction));
        assert.deepEqual(after[1],before[1],'Lazy flag bytes unchanged');assert.deepEqual(after[2],before[2],'Rounding state unchanged');
        assert.equal(budget.stats().ownedPayloadBytes,0,'No guest backing allocated');checkedNOPSteps++;
        await step(syscall,3);assert.equal(v.getBigUint64(g+88,true)&MASK,BigInt(golden.flags[seed]),'Native arithmetic flags including AF preserved');
      }
      assert.equal(broker.stats().requests,0);assert.equal(broker.stats().faults,0);
    } finally {broker.unregister(token);space.close();assert.equal(budget.stats().ownedPayloadBytes,0);}
    async function reject(bytes) {
      const key=hex(bytes);if(rejected.has(key))return;
      const u=await request(bytes);assert.equal(u.status,2,'Must refuse '+key+': '+log());assert.equal(u.code.length,0);rejected.add(key);
    }
    // Every truncation of every accepted encoding; no zero-filled code-map
    // padding may complete a ModRM, SIB or displacement on the guest's behalf.
    for(const bytes of forms)for(let length=1;length<bytes.length;length++)await reject(bytes.slice(0,length));
    for(const prefix of [[],[0x66],[0x67],[0x64],[0x65]]) {
      for(let rex=0x41;rex<=0x4f;rex+=2)await reject([...prefix,rex,0x90]);
      for(let op=0x91;op<=0x97;op++)await reject([...prefix,op]);
      for(const bad of [[0xf0,0x90],[0xf2,0x90],[0xf3,0x90],[0xf0,0x0f,0x1f,0],
        [0xf2,0x0f,0x1f,0],[0xf3,0x0f,0x1f,0],[0x48,0x66,0x90],[0x48,0x48,0x90]])await reject([...prefix,...bad]);
    }
    for(let extension=1;extension<8;extension++)for(const mod of [0,3])await reject([0x0f,0x1f,(mod<<6)|(extension<<3)]);
    for(let op=0x19;op<0x1f;op++)await reject([0x0f,op,0]);
    for(const bytes of [[...Array(15).fill(0x66),0x90],[...Array(13).fill(0x66),0x0f,0x1f,0],
      [...Array(8).fill(0x66),0x0f,0x1f,0x84,0,0,0,0,0],[...Array(14).fill(0x66),0x48,0x90]])await reject(bytes);
    const result={evidence:'Actual FEX/Wasm NOP family with complete CPU/lazy/round preservation and zero guest operand RPCs, checked against native x86-64. Not Wine, WebKit or physical-device evidence.',
      nativeOracle,retainedNative:golden,coverageVersion:cfg.coverageVersion,buildID:cfg.buildID,compiledModules:units.length,
      checkedNOPSteps,executedWasmSteps,guestMappings:0,memoryRPCs:0,guestBackingBytes:0,rejected:[...rejected],native:await(await get('/xlat/stats')).json()};
    const text=JSON.stringify(result,null,2);if(process.argv[3])fs.writeFileSync(process.argv[3],text+'\n');console.log(text);
  });
}
main().catch(error=>{console.error(error);process.exitCode=1;});
