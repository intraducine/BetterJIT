// SPDX-License-Identifier: GPL-3.0-or-later
const fs=require('fs'),path=require('path'),vm=require('vm'),assert=require('node:assert/strict'),{Worker}=require('worker_threads');
const {serve}=require('./native-step-contract.cjs'),F=require('./sparse-sync-fixture.cjs'),resources=path.resolve(__dirname,'../../../Sources/BetterJITLinux/Resources');
for(const n of ['guest_memory','guest_memory_broker','thread_core'])vm.runInThisContext(fs.readFileSync(path.join(resources,'linux',n+'.js'),'utf8'));
async function execute(cfg,state,units) {
 const barrier=new SharedArrayBuffer(48),control=new Int32Array(barrier),workers=[],results=[];let kernel,timer,tick;
 try {
  const outcome=await new Promise((resolve,reject)=>{
   timer=setTimeout(()=>reject(Error('Native sparse atomic/futex fixture exceeded 30 seconds')),30000);
   tick=setInterval(()=>{if(control[0]===4){Atomics.store(control,1,1);Atomics.notify(control,1);}
    if(control[2]===4){Atomics.store(control,3,1);Atomics.notify(control,3);}},5);
   const plans=units.map(uu=>uu.map(({module,code,...metadata})=>metadata));
   kernel=new Worker(path.join(__dirname,'sparse-sync-kernel.cjs'),{workerData:{resources,cfg,state,plans,barrier}});
   kernel.on('error',reject);kernel.on('message',m=>{
    if(m.op==='fatal')return reject(Error(m.message));
    if(m.op==='spawn') {
     const w=new Worker(path.join(__dirname,'sparse-thread.cjs'),{workerData:{...m,resources,units:units[m.index],barrier}});workers.push(w);
     w.on('error',reject);w.on('message',r=>{if(r.op==='fatal')reject(Error(r.message));else if(r.op==='result'){w.result=r;results.push(r);finish();}});
     w.on('exit',code=>{Atomics.store(new Int32Array(m.ksab),((256+m.slot*128)>>2)+26,0);
      if(code!==0||!w.result)reject(Error('Atomic/futex worker exited unexpectedly: '+code));});
    } else if(m.op==='result'){kernel.result=m;finish();}
   });
   function finish(){if(kernel.result&&results.length===4)resolve(kernel.result);}
  });
  assert.equal(control[0],4);assert.equal(control[2],4);for(const r of results)assert.equal(r.status,0);
  assert.equal(new Set(results.map(r=>r.pid)).size,3);
  return {...outcome,workers:results,barriers:{initial:control[0],afterAtomicAdds:control[2],kind:'host test control; waits/wakes themselves are translated Linux futex syscalls'}};
 }finally{
  clearTimeout(timer);clearInterval(tick);const closed=await Promise.allSettled([...workers,kernel].filter(Boolean).map(w=>w.terminate()));
  for(const r of closed)if(r.status==='rejected')throw Error('Atomic/futex cleanup failed: '+r.reason);
 }
}
async function main() {
 await serve('guestmem=broker1',async(get,log)=>{
  const cfg=await(await get('/xlat/config')).json(),state=new Uint8Array(await(await get('/xlat/state')).arrayBuffer());
  await get('/xlat/code?addr='+F.CODE.toString(16),{method:'POST',body:F.image});
  const units=[];
  for(const p of F.programs) {
   const row=[];
   for(const e of p.entries) {
    const u=FexLinuxThread.parseBrokerStep(new Uint8Array(await(await get('/xlat/step?rip='+e.rip)).arrayBuffer()));
    if(u.status!==0){await new Promise(r=>setTimeout(r,10));throw Error(e.name+' rejected: '+log());}
    assert.equal(u.operation,e.operation);assert.equal(u.width,e.width);assert.equal(u.nextRip,e.nextRip);assert.deepEqual(u.instruction,e.code);
    u.module=await WebAssembly.compile(u.code);row.push(u);
   }
   units.push(row);
  }
  const actual=await execute(cfg,state,units),native=await(await get('/xlat/stats')).json(),count=F.programs.reduce((n,p)=>n+p.entries.length,0);
  assert.equal(native.units,count);assert.equal(native.guestInsts,count);assert.equal(native.failed,0);
  const result={evidence:'Actual FEX-generated Wasm atomic instructions and Linux futex syscalls through dedicated kernel routing: three host-created guest processes, four threads/workers. Includes same-mm aliases. No guest fork/exec/clone, Apple/device or RAM-saving claim.',
   cfg,native,compiledModules:count,executedSteps:actual.records.reduce((n,r)=>n+r.steps,0),...actual};
  const text=JSON.stringify(result,(_k,x)=>typeof x==='bigint'?(x<0n?x.toString():'0x'+x.toString(16)):x,2);
  if(process.argv[3])fs.writeFileSync(process.argv[3],text+'\n');console.log(text);
 });
}
main().catch(error=>{console.error(error);process.exitCode=1;});
