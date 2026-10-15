// SPDX-License-Identifier: GPL-3.0-or-later
const {workerData:d,parentPort}=require('worker_threads'),fs=require('fs'),path=require('path'),vm=require('vm'),assert=require('node:assert/strict'),F=require('./sparse-exec-fixture.cjs');
globalThis.self=globalThis;for(const n of ['guest_memory.js','guest_memory_broker.js','guest_image.js','web/linux-kernel.js'])vm.runInThisContext(fs.readFileSync(path.join(d.resources,'linux',n),'utf8'));
const M=BetterJITGuestMemory,I=BetterJITGuestImage,{Kernel}=LinuxBundle.require('./kernel.js'),budget=new M.BackingBudget(),space=new M.GuestAddressSpace(budget,{virtualLimit:1n<<47n}),births=[],commits=[],exits=[],outputs=[];let kernel,initial;
try{
 kernel=new Kernel({state:d.state,vfs:{},log:()=>{},sparseLifecycleVersion:4,sparseExecutables:new I.ExecutableStore([{path:'/bin/rot13',bytes:d.elf}]),
  spawnSparseThread:s=>parentPort.postMessage({op:'spawn',...s}),stopSparseThread:s=>parentPort.postMessage({op:'stop',...s}),dropSparseSpace:s=>parentPort.postMessage({op:'drop',...s}),
  writeSparseOutput:({pid,tid,fd,bytes})=>{assert(bytes.buffer instanceof ArrayBuffer);outputs.push({pid,tid,fd,bytes:[...bytes]});return bytes.length;},
  sparseCloneCreated:t=>{assert.deepEqual([...t.proc.fds].map(([fd,e])=>[fd,e.file.refs]),[[1,2],[2,2]]);births.push({pid:t.proc.pid,tid:t.tid});},
  sparseExecCommitted:(t,old)=>{assert.equal(old.sparse.retired,true);assert.deepEqual([...t.proc.fds].map(([fd,e])=>[fd,e.file.refs]),[[1,2],[2,2]]);commits.push({pid:t.proc.pid,tid:t.tid,...t.sparse.executedImage});},
  sparseExit:t=>{exits.push({pid:t.proc.pid,code:t.sparse.guestExitCode,status:t.sparse.terminalStatus,last:t.sparse.last});},
  sparseWorkerRetired:()=>{if(exits.length===2&&[...kernel.threads.values()].every(t=>t.sparse.retired))kernel.done=true;}
 },d.cfg);
 for(const n of ['request','attempt','reply','pendingFor','deliver','freezeRequest','syncShared'])kernel[n]=()=>{throw Error('unsafe '+n);};
 const b=F.bootstrap(),v=new DataView(b.data.buffer);b.data.fill(0,128,160);b.data.set(new TextEncoder().encode('/bin/rot13\0'),128);b.data.fill(0,256);if(d.argument!==null){b.data.set(new TextEncoder().encode(d.argument+'\0'),256);v.setBigUint64(72,F.DATA+256n,true);}else v.setBigUint64(72,0n,true);
 space.mapAnonymous(F.CODE,F.PAGE,3);space.write(F.CODE,b.image);space.protect(F.CODE,F.PAGE,5);space.mapAnonymous(F.DATA,F.PAGE,3);space.write(F.DATA,b.data);initial=kernel.createSparseProcess({space,entryRip:F.CODE,plans:d.plans,standardIO:true});initial.thread.sigmask=0x200n;
 parentPort.postMessage({op:'spawn',...initial.worker});kernel.run();assert.equal(births.length,1);assert.equal(commits.length,1);const child=kernel.procs.get(101);assert.equal(child.sparseReaped,true);assert.equal(child.fds.size,0);assert.equal(initial.proc.fds.size,0);assert.equal(exits.find(x=>x.pid===101).code,d.expected.exitCode);assert.equal(new DataView(space.read(F.DATA+8n,4).buffer).getUint32(0,true),d.expected.exitCode<<8);
 const stream=fd=>new TextDecoder().decode(Uint8Array.from(outputs.filter(x=>x.fd===fd).flatMap(x=>x.bytes)));assert.equal(stream(1),d.expected.stdout);assert.equal(stream(2),d.expected.stderr);
 const records=[...kernel.threads.values(),...(kernel.sparseRetiredContexts??[])].map(t=>({pid:t.proc.pid,tid:t.tid,steps:t.sparse.steps,syscalls:t.sparse.syscalls,code:t.sparse.guestExitCode,retired:t.sparse.retired,replaced:!!t.sparse.execStop}));kernel.closeSparseImage(initial.proc.mm);assert.equal(budget.stats().ownedPayloadBytes,0);
 parentPort.postMessage({op:'kernel-result',births,commits,exits,records,stdout:stream(1),stderr:stream(2),outputs,broker:kernel.sparseBroker.stats(),afterClose:budget.stats()});
}catch(error){parentPort.postMessage({op:'fatal',message:(error.stack||String(error))+' contexts='+JSON.stringify([...(kernel?.threads.values()??[])].map(t=>({pid:t.proc.pid,last:t.sparse.last,steps:t.sparse.steps})),(_k,x)=>typeof x==='bigint'?'0x'+x.toString(16):x)});}
