// SPDX-License-Identifier: GPL-3.0-or-later
// Explicit live native FEX -> Wasm diagnostics. No sparse guest/phone claim.
const fs=require('fs'),path=require('path'),net=require('net'),assert=require('node:assert/strict');
const {spawn,spawnSync}=require('child_process');
const translator=path.resolve(process.argv[2]??'.build/host-fex/fexserve');
const output=process.argv[3];
fs.accessSync(translator,fs.constants.X_OK);
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function serve(options,run) {
 const port=await new Promise((resolve,reject)=>{const s=net.createServer();s.on('error',reject);s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});
 const child=spawn(translator,['--linux',String(port),options],{stdio:['ignore','ignore','pipe']});
 const lifecycle={closeRequested:false,closed:false};
 const closed=new Promise(resolve=>child.once('close',()=>{lifecycle.closed=true;resolve();}));
 const readMemory=()=>{
  const result={source:'unavailable',rssBytes:null,peakRSSBytes:null};
  if(lifecycle.closed||!Number.isSafeInteger(child.pid))return result;
  try{
   if(process.platform==='linux'){
    const status=fs.readFileSync('/proc/'+child.pid+'/status','utf8'),rss=status.match(/^VmRSS:\s+(\d+) kB$/m),peak=status.match(/^VmHWM:\s+(\d+) kB$/m);
    if(rss){result.source='linux-proc-status';result.rssBytes=Number(rss[1])*1024;if(peak)result.peakRSSBytes=Number(peak[1])*1024;}
   }else if(process.platform==='darwin'){
    const sample=spawnSync('ps',['-o','rss=','-p',String(child.pid)],{encoding:'utf8',timeout:1000});
    if(sample.status===0&&/^\s*\d+\s*$/.test(sample.stdout)){result.source='darwin-ps-rss';result.rssBytes=Number(sample.stdout.trim())*1024;}
   }
  }catch{}
  return result;
 };
 let log='',spawnError;child.stderr.on('data',bytes=>log=(log+bytes).slice(-8192));child.on('error',error=>spawnError=error);
 const get=(route,init)=>fetch(`http://127.0.0.1:${port}`+route,{...init,signal:AbortSignal.timeout(5000)});
 try {
  let ready=false;
  for(let i=0;i<200;i++) {
   if(spawnError)throw spawnError;if(child.exitCode!==null)throw Error('Native server exited: '+log);
   try {if((await get('/xlat/totals')).ok){ready=true;break;}}catch{}
   await pause(25);
  }
  assert.ok(ready,'Native server starts within 5 seconds');return await run(get,()=>log,{readMemory,lifecycle});
 } finally {
  if(child.exitCode===null){lifecycle.closeRequested=true;child.kill();}
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
   parityRawOffset:16,auxiliaryRawOffset:20,nzcvOffset:cfg.nzcvAddr-cfg.ctx,xmmRegisters:{version:1,offset:cfg.xmmOff,stride:16,count:16,bytes:16}},
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
 await serve('guestmem=broker1',async get=>{
  const rip=0x123400008000n,space=7;await get('/xlat/config?space='+space);
  const map=code=>get('/xlat/code?space='+space+'&addr='+rip.toString(16),{method:'POST',body:Uint8Array.from(code)}),step=async()=>new Uint8Array(await(await get('/xlat/step?space='+space+'&rip='+rip)).arrayBuffer());
  await map([0x48,0xb8,1,2,3,4,5,6,7,8]);const first=await step(),second=await step();assert.equal(new DataView(first.buffer).getUint32(20,true),0);assert.deepEqual(second,first);await WebAssembly.compile(first.slice(96));
  let s=await(await get('/xlat/stats?space='+space)).json();assert.equal(s.units,2);assert.equal(s.irGenerations,2);assert.equal(s.irDiscards,2);assert.equal(s.irCacheHits,0);assert.equal(s.irCacheEntries,0);assert.equal(s.irOwnedEntries,0);assert.equal(s.irDataBytes,0);assert.equal(s.irListBytes,0);assert.equal(s.irBufferCapacityBytes,0);assert.equal(s.irCataloguePeakOwnedEntriesSum,1);assert(s.irCataloguePeakBufferCapacityBytesSum>0);
  await map([0x48,0xb8]);assert.equal(new DataView((await step()).buffer).getUint32(20,true),2);s=await(await get('/xlat/stats?space='+space)).json();assert.equal(s.irGenerations,3);assert.equal(s.irDiscards,3);assert.equal(s.irCacheEntries,0);assert.equal(s.irBufferCapacityBytes,0);
  await map([15,11]);assert.equal(new DataView((await step()).buffer).getUint32(20,true),2);s=await(await get('/xlat/stats?space='+space)).json();assert.equal(s.irGenerations,3);assert.equal(s.irDiscards,3);
  await get('/xlat/drop?space='+space);const totals=await(await get('/xlat/totals')).json();assert.equal(totals.irGenerations,3);assert.equal(totals.irDiscards,3);assert.equal(totals.irCacheEntries,0);assert.equal(totals.irBufferCapacityBytes,0);assert.equal(totals.irCataloguePeakOwnedEntriesSum,1);
  records.push({options:'guestmem=broker1',status:'passed',scope:'Sparse native IR discard after success/decode rejection, raw refusal, deterministic recompilation and current/dropped telemetry only',stats:s,totals});
 });
 await serve('',async get=>{
  const space=9;await get('/xlat/config?space='+space);await get('/xlat/code?space='+space+'&addr=400000',{method:'POST',body:Uint8Array.of(0xb8,0x78,0x56,0x34,0x12,0xc3)});const bytes=await(await get('/xlat/unit?space='+space+'&rip=4194304')).arrayBuffer();assert(bytes.byteLength>0);
  const before=await(await get('/xlat/stats?space='+space)).json();assert(before.irOwnedEntries>0);assert(before.irBufferCapacityBytes>0);assert.equal(before.irDiscards,0);await get('/xlat/drop?space='+space);const totals=await(await get('/xlat/totals')).json();assert.equal(totals.irOwnedEntries,0);assert.equal(totals.irDataBytes,0);assert.equal(totals.irListBytes,0);assert.equal(totals.irBufferCapacityBytes,0);assert.equal(totals.irCataloguePeakOwnedEntriesSum,before.irCataloguePeakOwnedEntriesSum);
  records.push({options:'dense Linux translator',status:'passed',scope:'Generic IR cache retains through Release; destroyed catalogues excluded from current gauges; catalogue-peak sums stay historical',before,totals});
 });
 const result={evidence:'Fresh native FEX IR and generated Wasm on host; direct and sparse IR lifecycle controls only, not device or guest native JIT evidence.',records};
 if(output)fs.writeFileSync(output,JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
}
module.exports={serve};
if(require.main===module)main().catch(error=>{console.error(error);process.exitCode=1;});
