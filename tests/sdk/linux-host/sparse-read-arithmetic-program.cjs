// SPDX-License-Identifier: GPL-3.0-or-later
// Dynamic ELF/interpreter, self-checking ADD/SUB, stdout and normal Linux exit.
const fs=require('fs'),path=require('path'),vm=require('vm'),assert=require('node:assert/strict'),crypto=require('crypto'),
 {Worker,isMainThread,workerData:d,parentPort}=require('worker_threads'),F=require('./sparse-linux-image-fixture.cjs');
const resources=path.resolve(__dirname,'../../../Sources/BetterJITLinux/Resources'),sha=b=>crypto.createHash('sha256').update(b).digest('hex'),
 output='arithmetic-ok\n',DATA=F.BASE+0x3180n;
function load(){globalThis.self=globalThis;for(const n of ['guest_memory.js','guest_memory_broker.js','guest_image.js','guest_linux_image.js','thread_core.js','web/linux-kernel.js','web/sparse_process_host.js'])vm.runInThisContext(fs.readFileSync(path.join(resources,'linux',n),'utf8'));}
function fixture(readOnly,fault){
 const elf=F.image(),interpreter=F.image({interpreter:true}),code=[],branches=[],marks={},first=(0x7fffffffn<<32n)|16n;
 const emit=(...b)=>code.push(...b),word=n=>Array.from({length:8},(_,i)=>Number(BigInt.asUintN(64,n)>>BigInt(i*8)&255n)),
  mov=(r,n)=>emit(0x48,0xb8+r,...word(n)),check32=n=>{emit(0x83,0xf8,n,15,0x85,0,0,0,0);branches.push(code.length-4);},
  check64=(r,n)=>{mov(2,n);emit(0x48,0x39,0xd0|r,15,0x85,0,0,0,0);branches.push(code.length-4);};
 mov(6,DATA);mov(0,0xdeadbeef80000004n);marks.firstRead=code.length;
 emit(0x2b,0x46,4);check32(5);emit(3,0x46,8);check32(12);
 emit(0x48,0x2b,0x46,16);check64(0,0x800000000000000cn);
 emit(0x48,3,0x46,24);check32(12);
 emit(0x48,0x2b,0x36);check64(6,BigInt.asUintN(64,DATA-first));
 mov(1,3n);mov(2,DATA-12n);emit(0x2b,0x4c,0x8a,8,0x83,0xf9,0xfc,15,0x85,0,0,0,0);branches.push(code.length-4);
 // Exercise new group-1 logical steps through the real kernel/worker path.
 // Deliberately different guest addresses; the same OR EAX,1 encoding is generic.
 mov(0,0xdeadbeef80000000n);emit(0x83,0xc8,1);check64(0,0x80000001n);
 emit(0x48,0x83,0xf0,0xff);check64(0,0xffffffff7ffffffen);
 emit(0x48,0x81,0xe0,0,0,0,0x80);check64(0,0xffffffff00000000n);
 emit(0x49,0xb8,...word(0xdeadbeef00000000n),0x41,0x83,0xc8,0x80,0x41,0x81,0xf0,0xff,0xff,0xff,0xff,
  0x41,0x83,0xf8,0x7f,15,0x85,0,0,0,0);branches.push(code.length-4);
 mov(0,0n);emit(0x83,0xf8,1,0x48,0x81,0xc8,0,0,0,0x80,15,0x82,0,0,0,0);branches.push(code.length-4);
 check64(0,0xffffffff80000000n);
 emit(0xb8,1,0,0,0,0xbf,1,0,0,0);mov(6,DATA+64n);emit(0xba,Buffer.byteLength(output),0,0,0,15,5);check32(Buffer.byteLength(output));
 emit(0x31,0xff,0xb8,60,0,0,0,15,5);marks.failure=code.length;emit(0xbf,99,0,0,0,0xb8,60,0,0,0,15,5);
 for(const at of branches){const relative=marks.failure-(at+4);for(let i=0;i<4;i++)code[at+i]=relative>>(i*8)&255;}
 interpreter.fill(0,0x1000,0x2000);interpreter.set(code,0x1000);const v=new DataView(interpreter.buffer);
 v.setBigUint64(64+56+32,BigInt(code.length),true);v.setBigUint64(0x2180,first,true);
 v.setUint32(0x2188,7,true);v.setBigUint64(0x2190,0x8000000000000000n,true);v.setBigUint64(0x2198,0x8000000000000000n,true);
 interpreter.set(Buffer.from(output),0x21c0);
 if(readOnly)v.setUint32(64+2*56+4,4,true);
 return {elf,interpreter,readOnly,fault,firstRead:F.BASE+0x1000n+BigInt(marks.firstRead),identity:{elf:sha(elf),interpreter:sha(interpreter)}};
}
function kernel(){load();const M=BetterJITGuestMemory,I=BetterJITGuestImage,L=BetterJITGuestLinuxImage,B=BetterJITGuestMemoryBroker,{Kernel}=LinuxBundle.require('./kernel.js'),
 budget=new M.BackingBudget(),empty=new M.GuestAddressSpace(budget,{virtualLimit:1n<<47n}),enc=new TextEncoder();let k,image,initial,lastCheckpoint;const outputs=[],quiesced=[];
 try{image=L.prepare(empty,d.elf,{path:'/test/read-arithmetic',argv:[enc.encode('/test/read-arithmetic')],envp:[]},new Uint8Array(16),new I.ExecutableStore([{path:F.INTERP,bytes:d.interpreter}]));empty.close();
  const original=image.space.read(DATA,128),snapshot=t=>['cpu','lazyFlags','roundMode'].map(n=>{const p=d.cfg.checkpoint[n];return new Uint8Array(t.sparse.memory.buffer,t.tb+p.offset,p.size).slice();});
  if(d.fault)image.space.protect(DATA&~4095n,4096n,0);
  k=new Kernel({state:d.state,vfs:{},log:()=>{},sparseLifecycleVersion:5,sparseRetainInternalContexts:true,sparseAllowThreads:false,sparseAllowFutex:false,
   spawnSparseThread:spec=>parentPort.postMessage({op:'spawn',spec}),stopSparseThread:spec=>parentPort.postMessage({op:'stop',spec}),dropSparseSpace:spec=>parentPort.postMessage({op:'drop',spec}),
   writeSparseOutput:({fd,bytes})=>{outputs.push({fd,bytes:[...bytes]});return bytes.length;},
   sparseStep:(t,last)=>{if(last.status===B.STEP.FAULT){assert(d.fault);assert.equal(last.rip,d.firstRead);assert.deepEqual(snapshot(t),lastCheckpoint);}else lastCheckpoint=snapshot(t);},
   sparseExit:t=>{assert.equal(t.sparse.terminalStatus,d.fault?B.STEP.FAULT:B.STEP.OK);assert.equal(t.sparse.guestExitCode,d.fault?undefined:0);},
   sparseGuestQuiesced:(t,r)=>{assert.equal(r.failed,false);quiesced.push(r);k.done=true;}
  },d.cfg);
  initial=k.createSparseProcess({space:image.space,entryRip:image.entry,dynamic:true,standardIO:true});initial.proc.mm.catalog={id:initial.proc.space,refs:1};const t=initial.thread;
  t.sparse.view.setBigUint64(t.tb+d.cfg.ctx+d.cfg.gregsOff+32,image.stackPointer,true);
  parentPort.postMessage({op:'spawn',spec:{...initial.worker,codes:image.codes}});k.run();assert.equal(quiesced.length,1);assert(t.sparse.executionQuiesced&&!t.sparse.retired);
  const text=new TextDecoder().decode(Uint8Array.from(outputs.filter(x=>x.fd===1).flatMap(x=>x.bytes)));assert.equal(text,d.fault?'':output);
  if(d.fault)image.space.protect(DATA&~4095n,4096n,1);assert.deepEqual(image.space.read(DATA,128),original);
  const result={readOnly:d.readOnly,fault:d.fault,stdout:text,guestExitCode:t.sparse.guestExitCode??null,status:t.sparse.terminalStatus,steps:t.sparse.steps,broker:k.sparseBroker.stats(),checkpointUnchangedOnFault:!!d.fault,sourceBytesUnchanged:true,workerRetirementAcknowledged:!!t.sparse.retired};
  k.closeSparseImage(initial.proc.mm);assert.equal(budget.stats().ownedPayloadBytes,0);assert.equal(k.sparseBroker.stats().threads,0);parentPort.postMessage({op:'kernel-result',...result,afterClose:budget.stats()});
 }catch(error){parentPort.postMessage({op:'fatal',message:error.stack||String(error)});}
}
async function run(get,cfg,state,input){let k,host,timer,report;const workers=[],terminations=[];try{
 const result=await new Promise((resolve,reject)=>{timer=setTimeout(()=>reject(Error('Arithmetic dynamic ELF exceeded30seconds')),30000);
  host=new BetterJITSparseProcessHost({get,cfg,onFailure:reject,maximumSteps:200,workerFactory:()=>{const worker=new Worker(path.join(__dirname,'sparse-browser-thread.cjs'),{workerData:{resources}}),adapter={onmessage:null,onerror:null,postMessage:m=>worker.postMessage(m),terminate:()=>{terminations.push(worker.terminate());}};workers.push(worker);worker.on('message',data=>adapter.onmessage?.({data}));worker.on('error',e=>adapter.onerror?.({message:String(e)}));return adapter;}});
  k=new Worker(__filename,{workerData:{cfg,state,...input}});k.on('error',reject);k.on('message',m=>{try{if(m.op==='spawn')host.spawn(m.spec);else if(m.op==='stop')host.stop(m.spec);else if(m.op==='drop')host.drop(m.spec);else if(m.op==='fatal')reject(Error(m.message));else if(m.op==='kernel-result')resolve(m);}catch(e){reject(e);}});
 });await Promise.all(host.drops);assert(host.history.every(r=>r.acked&&!r.pending.size));report={...result,identity:input.identity,guestAccessQuiescenceAcknowledged:true};
 }finally{clearTimeout(timer);host?.close();await Promise.allSettled(terminations);await k?.terminate();}
 assert(workers.every(w=>w.threadId===-1));assert.equal(k.threadId,-1);
 return{...report,laterHostWorkersExited:true,kernelWorkerExited:true};
}
if(!isMainThread)kernel();else{load();require('./native-step-contract.cjs').serve('guestmem=broker1',async get=>{const cfg=await(await get('/xlat/config')).json(),state=new Uint8Array(await(await get('/xlat/state')).arrayBuffer()),cases=[];
 for(const [readOnly,fault]of [[false,false],[true,false],[true,true]])cases.push(await run(get,cfg,state,fixture(readOnly,fault)));
 const report={evidence:'Synthetic dynamic ELF and interpreter, self-checking ADD/SUB32/64, group-1 OR/AND/XOR immediate sign extension/zero extension and carry clearing, old-address aliasing, deterministic stdout/normal Linux exit or exact read-fault rollback through production SDK kernel/worker. No Wine completion or device claim.',cfg,cases,native:await(await get('/xlat/totals')).json()};if(process.argv[3])fs.writeFileSync(process.argv[3],JSON.stringify(report,(_k,v)=>typeof v==='bigint'?'0x'+v.toString(16):v,2)+'\n');console.log(JSON.stringify({...report,cfg:undefined}));
 }).catch(e=>{console.error(e);process.exitCode=1;});}
