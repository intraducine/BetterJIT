// SPDX-License-Identifier: GPL-3.0-or-later
const fs=require('fs'),path=require('path'),os=require('os'),vm=require('vm'),assert=require('node:assert/strict'),{Worker}=require('worker_threads'),{spawnSync}=require('child_process');
const {serve}=require('./native-step-contract.cjs'),F=require('./sparse-clone-fixture.cjs'),resources=path.resolve(__dirname,'../../../Sources/BetterJITLinux/Resources');
for(const n of ['guest_memory','guest_memory_broker','thread_core'])vm.runInThisContext(fs.readFileSync(path.join(resources,'linux',n+'.js'),'utf8'));
function nativeOracle() {
 if(process.platform!=='linux'||process.arch!=='x64')return {supported:false,reason:'Independent clone oracle requires Linux x86-64; actual FEX/Wasm fixture still runs'};
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'betterjit-clone-oracle-'));
 try {
  const binary=path.join(directory,'oracle'),build=spawnSync(process.env.CC||'cc',['-std=gnu11','-O2','-Wall','-Wextra','-Werror',path.join(__dirname,'sparse-clone-oracle.c'),'-o',binary],{encoding:'utf8',timeout:10000});
  assert.equal(build.status,0,build.stderr||String(build.error));const run=spawnSync(binary,[],{encoding:'utf8',timeout:10000});
  assert.equal(run.status,0,run.stderr||String(run.error));return JSON.parse(run.stdout);
 }finally{fs.rmSync(directory,{recursive:true,force:true});}
}
async function execute(cfg,state,units,scenario,fixtureFile) {
 const workers=new Map(),results=[],startupFailures=[],workerExits=[];let kernel,timer;
 try{return await new Promise((resolve,reject)=>{
  timer=setTimeout(()=>reject(Error('Actual guest clone fixture exceeded 30 seconds')),30000);
  kernel=new Worker(path.join(__dirname,'sparse-clone-kernel.cjs'),{workerData:{cfg,state,resources,scenario,fixtureFile,plans:units.map(({code,module,...p})=>p)}});
  kernel.on('error',reject);kernel.on('message',m=>{
   if(m.op==='fatal')return reject(Error(m.message));
   if(m.op==='spawn') {
    const expectedFailure=!!m.startGate&&scenario!=='success';
    const w=new Worker(path.join(__dirname,'sparse-clone-thread.cjs'),{workerData:{...m,resources,units:expectedFailure&&scenario==='missing-continuation'?[]:units,maximumSteps:100,
      startupHold:expectedFailure&&scenario==='terminate-before-ready'?new SharedArrayBuffer(4):undefined}});workers.set(m.slot,{worker:w,spec:m});
    w.on('error',reject);w.on('message',r=>{if(r.op==='thread-failed'){if(expectedFailure)startupFailures.push(r);else reject(Error(r.message));}else if(r.op==='thread-result')results.push(r);});
    w.on('exit',code=>{workerExits.push({pid:m.pid,tid:m.tid,slot:m.slot,lease:m.lease,code,expectedStartupFailure:expectedFailure});const k=new Int32Array(m.ksab);Atomics.store(k,((256+m.slot*128)>>2)+26,0);Atomics.add(k,0,1);Atomics.notify(k,0);if(code!==0&&!expectedFailure)reject(Error('Clone worker exited '+code));});
    if(expectedFailure&&scenario==='terminate-before-ready')w.terminate();
   }else if(m.op==='stop') {const owned=workers.get(m.slot);if(owned?.spec.lease===m.lease){
    // A rejected continuation already unwound. Let its diagnostic and natural
    // exit drain before the existing exact-worker exit acknowledgement. Killing
    // it here can race the rejection handler's thread-failed postMessage.
    if(!(scenario==='missing-continuation'&&owned.spec.startGate))owned.worker.terminate();
   }}
   else if(m.op==='kernel-result') {assert.equal(results.length,scenario==='success'?2:1);for(const r of results)assert.equal(r.status,0);if(scenario==='missing-continuation')assert.equal(startupFailures.length,1);resolve({...m,scenario,startupFailures,workerExits,workers:results});}
  });
 });}finally{clearTimeout(timer);await Promise.allSettled([...workers.values()].map(x=>x.worker.terminate()).concat(kernel?[kernel.terminate()]:[]));}
}
async function main(){const oracle=nativeOracle();await serve('guestmem=broker1',async(get,log)=>{
 const cfg=await(await get('/xlat/config')).json(),state=new Uint8Array(await(await get('/xlat/state')).arrayBuffer());
 await get('/xlat/code?addr='+F.CODE.toString(16),{method:'POST',body:F.image});const units=[];
 for(const e of F.program){const u=FexLinuxThread.parseBrokerStep(new Uint8Array(await(await get('/xlat/step?rip='+e.rip)).arrayBuffer()));
  assert.equal(u.status,0,e.name+': '+log());assert.equal(u.operation,e.operation);assert.equal(u.width,e.width);assert.equal(u.nextRip,e.nextRip);assert.deepEqual(u.instruction,e.code);u.module=await WebAssembly.compile(u.code);units.push(u);}
 const cases=[];for(const scenario of ['success','missing-continuation','terminate-before-ready'])cases.push(await execute(cfg,state,units,scenario));
 const native=await(await get('/xlat/stats')).json();assert.equal(native.units,units.length);
 const result={evidence:'Actual guest-initiated Linux x86-64 clone(0x10f00, guest high stack) and thread exits through FEX-generated Wasm, plus two real-worker startup failures returning EAGAIN without a published child. Only initial process is host-created; child executes the same guest continuation. No fork/exec, ELF loader, stock Wine, device or RAM-saving claim.',cfg,native,oracle,cases};
 const text=JSON.stringify(result,(_k,x)=>typeof x==='bigint'?'0x'+x.toString(16):x,2);if(process.argv[3])fs.writeFileSync(process.argv[3],text+'\n');console.log(text);
});}
module.exports={execute};
if(require.main===module)main().catch(error=>{console.error(error);process.exitCode=1;});
