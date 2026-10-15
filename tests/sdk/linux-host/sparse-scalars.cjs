// SPDX-License-Identifier: GPL-3.0-or-later
// Actual FEX/Wasm emitter matrix. The multi-worker routing fixture is separate.
const fs=require('fs'),path=require('path'),vm=require('vm'),assert=require('node:assert/strict');
const {serve}=require('./native-step-contract.cjs');
for(const name of ['guest_memory','guest_memory_broker','thread_core'])vm.runInThisContext(fs.readFileSync(
 path.resolve(__dirname,'../../../Sources/BetterJITLinux/Resources/linux',name+'.js'),'utf8'));
const M=BetterJITGuestMemory,B=BetterJITGuestMemoryBroker,CODE=0x123400008000n,DATA=0x123456780000n;
const OLD=0x1122334455667788n,RAW=0x8786858483828180n,FS=0x100000000n;
const cases=[
 ['load64',[0x48,0x8b,0x03],1,8,RAW],['load32',[0x8b,0x03],1,4,0x83828180n],
 ['load16',[0x66,0x8b,0x03],1,2,0x1122334455668180n],['load8',[0x8a,0x03],1,1,0x1122334455667780n],
 ['load-high-byte',[0x8a,0x23],1,1,0x1122334455668088n],
 ['zero-extend8',[0x0f,0xb6,0x03],1,1,0x80n],['zero-extend16',[0x0f,0xb7,0x03],1,2,0x8180n],
 ['sign-extend8',[0x48,0x0f,0xbe,0x03],1,1,0xffffffffffffff80n],
 ['sign-extend16',[0x48,0x0f,0xbf,0x03],1,2,0xffffffffffff8180n],
 ['sign-extend32',[0x48,0x63,0x03],1,4,0xffffffff83828180n],
 ['store64',[0x48,0x89,0x03],2,8],['store32',[0x89,0x03],2,4],
 ['store16',[0x66,0x89,0x03],2,2],['store8',[0x88,0x03],2,1],
 ['store-immediate8',[0xc6,0x03,0x7f],2,1,undefined,0x7fn],
 ['store-immediate32',[0xc7,0x03,0xff,0xff,0xff,0xff],2,4,undefined,0xffffffffn],
 ['store-sign-extended-immediate',[0x48,0xc7,0x03,0xff,0xff,0xff,0xff],2,8,undefined,0xffffffffffffffffn],
 ['register-move',[0x48,0x89,0xd8],0,0,DATA],['register-immediate',[0x48,0xb8,1,2,3,4,5,6,7,8],0,0,0x0807060504030201n],
 ['nop',[0x90],0,0,OLD],['negative-displacement',[0x48,0x8b,0x43,0xf8],1,8,RAW],
 ['fs-negative-displacement',[0x64,0x48,0x8b,0x43,0xf8],1,8,RAW],
 ['zero64',[0x48,0x8b,0x03],1,8,0n],['all-one64',[0x48,0x8b,0x03],1,8,0xffffffffffffffffn],
 ['unmapped64',[0x48,0x8b,0x03],1,8],['range64',[0x48,0x8b,0x03],1,8],
 ['limit-crossing',[0x48,0x8b,0x03],1,8],
 ['allocation-failure',[0x48,0x89,0x03],2,8],
];
const pack=value=>{const bytes=new Uint8Array(8);new DataView(bytes.buffer).setBigUint64(0,value,true);return bytes;};
async function main() {
 await serve('guestmem=broker1',async(get,log)=>{
  const cfg=await(await get('/xlat/config')).json(),state=new Uint8Array(await(await get('/xlat/state')).arrayBuffer()),records=[];
  for(const [name,code,operation,width,expected,store=OLD]of cases) {
   await get('/xlat/code?addr='+CODE.toString(16),{method:'POST',body:Uint8Array.from(code)});
   const unit=FexLinuxThread.parseBrokerStep(new Uint8Array(await(await get('/xlat/step?rip='+CODE)).arrayBuffer()));
   assert.equal(unit.status,0,name+': '+log());assert.equal(unit.operation,operation);assert.equal(unit.width,width);
   const budget=new M.BackingBudget({limitBytes:name==='allocation-failure'?4096:65536}),
    space=new M.GuestAddressSpace(budget,{virtualLimit:name==='limit-crossing'?DATA+4096n:1n<<48n}),memory=B.createInternalMemory(),broker=new B.GuestMemoryBroker();
   let backing,address=name.includes('negative-displacement')?DATA-8n:DATA;
   if(name.startsWith('fs-'))address+=FS;
   if(name==='limit-crossing')address=DATA+4092n;
   if(name==='allocation-failure') {
    backing=new M.SharedBacking(budget,4096n);space.mapShared(DATA,4096n,backing,0n,{privateView:true});
   } else if(name==='range64')address=0xffffffffffffffffn;
   else if(name==='limit-crossing') {
    space.mapAnonymous(DATA,4096n,3);space.write(address,pack(RAW).subarray(0,4));
   } else if(name!=='unmapped64') {
    space.mapAnonymous(address-address%4096n,4096n,3);
    space.write(address,pack(name==='zero64'?0n:name==='all-one64'?0xffffffffffffffffn:RAW));
   }
   const token=broker.register(0,{space,memory,checkpointLayout:cfg.checkpoint}),v=new DataView(memory.buffer),tb=B.ABI.threadBase;
   new Uint8Array(memory.buffer,tb+cfg.ctx,state.length).set(state);
   v.setBigUint64(tb+cfg.ctx+cfg.ripOff,CODE,true);v.setBigUint64(tb+cfg.ctx+cfg.gregsOff,OLD,true);
   v.setBigUint64(tb+cfg.ctx+cfg.gregsOff+24,['range64','limit-crossing'].includes(name)?address:DATA,true);
   if(name.startsWith('fs-'))v.setBigUint64(tb+cfg.ctx+cfg.fsOff,FS,true);
   const scratch=new DataView(memory.buffer,tb+B.ABI.scratchOffset,128),checkpoint=broker.beginInstruction(token,{rip:CODE,operation,width});
   scratch.setBigUint64(B.FIELD.checkpoint,checkpoint,true);
   const pre=['cpu','lazyFlags','roundMode'].map(n=>{const s=cfg.checkpoint[n];return new Uint8Array(memory.buffer,tb+s.offset,s.size).slice();});
   const module=await WebAssembly.compile(unit.code),instance=await WebAssembly.instantiate(module,{e:{mem:memory,
    tb:new WebAssembly.Global({value:'i32'},tb),memory:()=>{
     scratch.setUint32(B.FIELD.sequence,1,true);return broker.dispatch(token,{lease:token.generation,sequence:1}).status;
    }}});
   const status=instance.exports.run(),finished=broker.finishInstruction(token,{status,nextRip:unit.nextRip});
   if(['unmapped64','range64','limit-crossing','allocation-failure'].includes(name)) {
    assert.equal(status,1,name);const reason={unmapped64:B.REASON.UNMAPPED,range64:B.REASON.RANGE,'limit-crossing':B.REASON.RANGE,'allocation-failure':B.REASON.ALLOCATION}[name];
    assert.equal(finished.memory.reason,reason);assert.equal(finished.memory.faultAddress,name==='limit-crossing'?DATA+4096n:address);
    ['cpu','lazyFlags','roundMode'].forEach((n,i)=>{const s=cfg.checkpoint[n];assert.deepEqual(new Uint8Array(memory.buffer,tb+s.offset,s.size),pre[i]);});
   } else {
    assert.equal(status,0,name);assert.equal(v.getBigUint64(tb+cfg.ctx+cfg.ripOff,true),unit.nextRip);
    if(expected!==undefined)assert.equal(v.getBigUint64(tb+cfg.ctx+cfg.gregsOff,true),expected,name);
    if(operation===2) {const bytes=pack(RAW);bytes.set(pack(store).subarray(0,width));assert.deepEqual(space.read(address,8),bytes,name);}
   }
   if(operation)assert.equal(scratch.getBigUint64(B.FIELD.address,true),address,name+' effective address');
   records.push({name,status,operation,width,rip:CODE,nextRip:finished.rip,effectiveAddress:operation?address:undefined});
   broker.unregister(token);space.close();backing?.close();assert.equal(budget.stats().ownedPayloadBytes,0);
  }
  const native=await(await get('/xlat/stats')).json();assert.equal(native.units,cases.length);assert.equal(native.guestInsts,cases.length);
  const result={evidence:'Fresh FEX-generated scalar Wasm emitter/storage contract matrix in one host process. No kernel routing, guest process creation or device claim.',native,records};
  const text=JSON.stringify(result,(_k,x)=>typeof x==='bigint'?'0x'+x.toString(16):x,2);
  if(process.argv[3])fs.writeFileSync(process.argv[3],text+'\n');console.log(text);
 });
}
main().catch(error=>{console.error(error);process.exitCode=1;});
