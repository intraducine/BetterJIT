// SPDX-License-Identifier: GPL-3.0-or-later
// Real FEX-generated scalar Wasm in three host-created kernel guest processes.
// Host barriers are test control, not an implementation of guest futexes.
const fs=require('fs'),path=require('path'),vm=require('vm'),assert=require('node:assert/strict'),{Worker}=require('worker_threads');
const {serve}=require('./native-step-contract.cjs'),F=require('./sparse-fixture.cjs');
const resources=path.resolve(__dirname,'../../../Sources/BetterJITLinux/Resources');
for(const name of ['guest_memory','guest_memory_broker','thread_core'])
 vm.runInThisContext(fs.readFileSync(path.join(resources,'linux',name+'.js'),'utf8'));
const B=BetterJITGuestMemoryBroker;
const stringify=v=>JSON.stringify(v,(_k,x)=>typeof x==='bigint'?'0x'+x.toString(16):x,2);
async function execute(cfg,state,units) {
 const barrier=new SharedArrayBuffer(16),control=new Int32Array(barrier),workers=[],results=[];
 const plans=units.map(({module,code,...metadata})=>metadata);
 let kernel,timer,tick;
 try {
  const outcome=await new Promise((resolve,reject)=>{
   timer=setTimeout(()=>reject(Error('Sparse live fixture exceeded 30 seconds')),30000);
   tick=setInterval(()=>{
    if(Atomics.load(control,0)===3){Atomics.store(control,1,1);Atomics.notify(control,1);}
    if(Atomics.load(control,2)===3){Atomics.store(control,3,1);Atomics.notify(control,3);}
   },5);
   kernel=new Worker(path.join(__dirname,'sparse-kernel.cjs'),{workerData:{resources,cfg,state,plans}});
   kernel.on('error',reject);kernel.on('message',message=>{
    if(message.op==='fatal')return reject(Error(message.message));
    if(message.op==='spawn') {
     const worker=new Worker(path.join(__dirname,'sparse-thread.cjs'),{workerData:{...message,resources,units,barrier}});
     workers.push(worker);worker.on('error',reject);worker.on('message',r=>{
      if(r.op==='fatal')reject(Error(r.message));else if(r.op==='result'){worker.result=r;results.push(r);finish();}
     });
     worker.on('exit',code=>{
      Atomics.store(new Int32Array(message.ksab),((256+message.slot*128)>>2)+26,0);
      if(code!==0||!worker.result)reject(Error('Sparse worker exited without a passing result: '+code));
     });
    } else if(message.op==='result'){kernel.result=message;finish();}
   });
   function finish(){if(kernel.result&&results.length===3)resolve(kernel.result);}
  });
  assert.equal(Atomics.load(control,0),3);assert.equal(Atomics.load(control,2),3);
  for(const r of results){assert.equal(r.status,1);assert.equal(r.executed,13);assert.equal(r.memoryRequests,12);assert.equal(r.internalBytes,33*65536);}
  return {...outcome,workerResults:results,barriers:{initialLiveWorkers:control[0],afterSharedWrites:control[2],kind:'host test control; no guest futex claim'}};
 } finally {
  clearTimeout(timer);clearInterval(tick);
  const cleanup=await Promise.allSettled([...workers,kernel].filter(Boolean).map(w=>w.terminate()));
  for(const r of cleanup)if(r.status==='rejected')throw Error('Sparse fixture worker cleanup failed: '+r.reason);
 }
}
async function main() {
 await serve('guestmem=broker1',async(get,log)=>{
  const cfg=await(await get('/xlat/config')).json(),state=new Uint8Array(await(await get('/xlat/state')).arrayBuffer());
  assert.equal(cfg.memPages,33);assert.equal(cfg.memMaxPages,33);assert.equal(cfg.guestMemory,'broker1');
  assert.equal(cfg.regArgs,0);assert.equal(cfg.callsViaDispatcher,false);assert.equal(cfg.maxInstructions,1);
  assert.ok((await get('/xlat/code?addr='+F.CODE.toString(16),{method:'POST',body:F.code})).ok);
  const units=[];
  for(const expected of F.program) {
   const unit=FexLinuxThread.parseBrokerStep(new Uint8Array(await(await get('/xlat/step?rip='+expected.rip)).arrayBuffer()));
   assert.equal(unit.status,0,expected.name+' was rejected: '+log());assert.equal(unit.rip,expected.rip);assert.equal(unit.nextRip,expected.nextRip);
   assert.equal(unit.operation,expected.operation);assert.equal(unit.width,expected.width);assert.deepEqual(unit.instruction,expected.code);
   unit.module=await WebAssembly.compile(unit.code);units.push(unit);
  }
  const imported={tb:new WebAssembly.Global({value:'i32'},B.ABI.threadBase),memory:()=>0};
  await assert.rejects(WebAssembly.instantiate(units[0].module,{e:{...imported,mem:new WebAssembly.Memory({initial:33,maximum:34,shared:true})}}),WebAssembly.LinkError);
  await assert.rejects(WebAssembly.instantiate(units[0].module,{e:{...imported,mem:new WebAssembly.Memory({initial:32,maximum:33,shared:true})}}),WebAssembly.LinkError);
  assert.equal((await(await get('/xlat/unit?rip='+Number(F.CODE&0xffffffffn))).arrayBuffer()).byteLength,0);
  assert.equal((await(await get('/xlat/dispatcher')).arrayBuffer()).byteLength,0);
  const rejected=[];
  const negatives={push:[0x50],pop:[0x58],call:[0xe8,0,0,0,0],ret:[0xc3],atomic:[0xf0,0x48,0x0f,0xc1,0x03],
   rep:[0xf3,0xa4],simd:[0x0f,0x10,0x03],syscall:[0x0f,0x05],branch:[0xeb,0],addressSize:[0x67,0x48,0x8b,0x03],truncated:[0x48,0x8b,0x83]};
  for(const [i,[name,bytes]]of Object.entries(negatives).entries()) {
   const rip=F.CODE+0x1000n+BigInt(i)*0x100n;
   await get('/xlat/code?addr='+rip.toString(16),{method:'POST',body:Uint8Array.from(bytes)});
   const unit=FexLinuxThread.parseBrokerStep(new Uint8Array(await(await get('/xlat/step?rip='+rip)).arrayBuffer()));
   assert.equal(unit.status,2,name);assert.equal(unit.code.length,0);rejected.push(name);
  }
  const actual=await execute(cfg,state,units),native=await(await get('/xlat/stats')).json();
  assert.equal(native.units,13);assert.equal(native.guestInsts,13);assert.equal(native.failed,rejected.length);
  const result={evidence:'Fresh FEX-generated scalar Wasm, three separate workers and host-created kernel Process/Thread records. No ELF/fork/exec, atomics/futex, Apple/device or RAM-saving claim.',
   cfg,native,compiledModules:units.length,executedWasmSteps:39,rejected,...actual};
  if(process.argv[3])fs.writeFileSync(process.argv[3],stringify(result)+'\n');console.log(stringify(result));
 });
}
main().catch(error=>{console.error(error);process.exitCode=1;});
