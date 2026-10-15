// SPDX-License-Identifier: GPL-3.0-or-later
const {workerData:d,parentPort}=require('worker_threads'),fs=require('fs'),path=require('path'),vm=require('vm');
for(const n of ['guest_memory','guest_memory_broker','thread_core'])vm.runInThisContext(fs.readFileSync(path.join(d.resources,'linux',n+'.js'),'utf8'));
const units=new Map(d.units.map(u=>[u.rip,u]));
if(d.startupHold)Atomics.wait(new Int32Array(d.startupHold),0,0);
FexLinuxThread.runThread({data:d,stepBroker:async(_space,rip)=>units.get(rip),onStep:step=>{
 if(d.pauseAtRip===step.rip)while(!Atomics.load(new Int32Array(d.barrier),0))Atomics.wait(new Int32Array(d.barrier),0,0);
}}).then(
 result=>parentPort.postMessage({op:'thread-result',pid:d.pid,tid:d.tid,...result}),
 error=>parentPort.postMessage({op:'thread-failed',tid:d.tid,message:String(error)}));
