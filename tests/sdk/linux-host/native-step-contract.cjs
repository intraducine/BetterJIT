// SPDX-License-Identifier: GPL-3.0-or-later
// Explicit live native FEX -> Wasm diagnostics. No sparse guest/phone claim.
const fs=require('fs'),path=require('path'),net=require('net'),assert=require('node:assert/strict');
const {spawn}=require('child_process');
const translator=path.resolve(process.argv[2]??'.build/host-fex/fexserve');
const output=process.argv[3];
fs.accessSync(translator,fs.constants.X_OK);
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function serve(options,run) {
 const port=await new Promise((resolve,reject)=>{const s=net.createServer();s.on('error',reject);s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});
 const child=spawn(translator,['--linux',String(port),options],{stdio:['ignore','ignore','pipe']});
 const closed=new Promise(resolve=>child.once('close',resolve));
 let log='',spawnError;child.stderr.on('data',bytes=>log=(log+bytes).slice(-8192));child.on('error',error=>spawnError=error);
 const get=(route,init)=>fetch(`http://127.0.0.1:${port}`+route,{...init,signal:AbortSignal.timeout(5000)});
 try {
  let ready=false;
  for(let i=0;i<200;i++) {
   if(spawnError)throw spawnError;if(child.exitCode!==null)throw Error('Native server exited: '+log);
   try {if((await get('/xlat/totals')).ok){ready=true;break;}}catch{}
   await pause(25);
  }
  assert.ok(ready,'Native server starts within 5 seconds');return await run(get,()=>log);
 } finally {
  if(child.exitCode===null)child.kill();
  const killTimer=setTimeout(()=>child.kill('SIGKILL'),1000);killTimer.unref();
  await closed;clearTimeout(killTimer);
 }
}
async function main() {
 const records=[];
 for(const options of ['guestmem=broker1 shared=0','guestmem=typo','maxinst=2'])await serve(options,async get=>{
  assert.equal((await get('/xlat/config?space=0')).status,404);
  assert.deepEqual(await (await get('/xlat/totals')).json(),{});
  assert.equal((await get('/xlat/config?space=0')).status,404);
  records.push({options,status:'rejected',totals:'empty, server remains live'});
 });
 for(const options of ['', 'instmeta=1'])await serve(options,async get=>{
  const cfg=await (await get('/xlat/config?space=0')).json();
  assert.equal(cfg.guestMemory,'direct');assert.equal(cfg.maxInstructions,0);
  assert.equal(cfg.debugGuestInstructions,options==='instmeta=1');assert.equal(cfg.memoryTraceAddr,0);
  assert.equal(cfg.regArgs,8);assert.equal(cfg.callsViaDispatcher,true);
  records.push({options,config:cfg,status:'passed'});
 });
 await serve('maxinst=1 abi=win64 localflags=1 xflags=1 multiblock=1 hot=1',async get=>{
  const cfg=await (await get('/xlat/config?space=0')).json();
  assert.equal(cfg.maxInstructions,1);assert.equal(cfg.debugGuestInstructions,true);assert.equal(cfg.memoryTraceAddr,0);
  assert.equal(cfg.guestAbi,'none');assert.equal(cfg.regArgs,0);assert.equal(cfg.callsViaDispatcher,false);assert.equal(cfg.hotThreshold,0);
  assert.deepEqual(cfg.checkpoint,{version:1,cpu:{offset:cfg.ctx,size:cfg.stateSize,ripOffset:cfg.ripOff,stackPointerOffset:cfg.gregsOff+32,generalRegistersOffset:cfg.gregsOff,
   parityRawOffset:16,auxiliaryRawOffset:20,nzcvOffset:cfg.nzcvAddr-cfg.ctx},
   lazyFlags:{offset:cfg.flagSpillAddr,size:24},roundMode:{offset:0x70,size:4}});
  const state=new Uint8Array(await (await get('/xlat/state?space=0')).arrayBuffer());assert.equal(state.length,cfg.stateSize);
  // MOV RAX,42; ADD RAX,1; NOP; UD2. Each request must translate exactly one.
  const code=Uint8Array.from([0x48,0xc7,0xc0,42,0,0,0,0x48,0x83,0xc0,1,0x90,0x0f,0x0b]);
  assert.ok((await get('/xlat/code?space=0&addr=400000&abi=1',{method:'POST',body:code})).ok);
  // This legacy diagnostic still declares the default 65536-page maximum.
  // Do not describe this memory as the bounded broker's 33-page maximum.
  const memory=new WebAssembly.Memory({initial:33,maximum:cfg.memMaxPages,shared:true}),tb=0x10000;
  new Uint8Array(memory.buffer,tb+cfg.ctx,state.length).set(state);const view=new DataView(memory.buffer);
  async function step(rip) {
   const bytes=new Uint8Array(await (await get('/xlat/unit?space=0&rip='+rip)).arrayBuffer());
   assert.ok(bytes.length>24);const v=new DataView(bytes.buffer),head=24+4*v.getUint32(20,true);
   const module=await WebAssembly.compile(bytes.subarray(head));
   const imports=WebAssembly.Module.imports(module);assert.ok(imports.every(i=>i.module==='e'&&['mem','tb','d'].includes(i.name)),JSON.stringify(imports));
   const instance=await WebAssembly.instantiate(module,{e:{mem:memory,tb:new WebAssembly.Global({value:'i32'},tb),
    d:new WebAssembly.Global({value:'i64'},v.getBigInt64(12,true))}});
   return {next:instance.exports.run(),moduleBytes:bytes.length-head};
  }
  const first=await step(0x400000);assert.equal(first.next,0x400007);assert.equal(view.getBigUint64(tb+cfg.ctx+cfg.gregsOff,true),42n);
  let stats=await (await get('/xlat/stats?space=0')).json();assert.equal(stats.units,1);assert.equal(stats.guestInsts,1);
  const second=await step(0x400007);assert.equal(second.next,0x40000b);assert.equal(view.getBigUint64(tb+cfg.ctx+cfg.gregsOff,true),43n);
  stats=await (await get('/xlat/stats?space=0')).json();assert.equal(stats.units,2);assert.equal(stats.guestInsts,2);
  const region=await get('/xlat/region?space=0',{method:'POST',body:new Uint8Array(12)});assert.equal((await region.arrayBuffer()).byteLength,0);
  records.push({options:'maxinst=1 with conflicting optimization options and Win64 mapping',status:'passed',config:cfg,
   executed:[{rip:'0x400000',nextRip:'0x400007',rax:'42',moduleBytes:first.moduleBytes},
    {rip:'0x400007',nextRip:'0x40000b',rax:'43',moduleBytes:second.moduleBytes}],stats,regions:'rejected'});
 });
 const result={evidence:'Fresh native FEX IR and generated Wasm on host; diagnostic direct memory only, not sparse execution or device evidence.',records};
 if(output)fs.writeFileSync(output,JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
}
module.exports={serve};
if(require.main===module)main().catch(error=>{console.error(error);process.exitCode=1;});
