// SPDX-License-Identifier: GPL-3.0-or-later
const {workerData:d,parentPort}=require('worker_threads'),fs=require('fs'),path=require('path'),vm=require('vm');
for(const name of ['guest_memory','guest_memory_broker','thread_core'])
 vm.runInThisContext(fs.readFileSync(path.join(d.resources,'linux',name+'.js'),'utf8'));
const units=new Map(d.units.map(u=>[u.rip,u])),barrier=new Int32Array(d.barrier);
function rendezvous(count,release) {
 if(count!==undefined){Atomics.add(barrier,count,1);Atomics.notify(barrier,count);}
 const deadline=performance.now()+10000;
 while(Atomics.load(barrier,release)===0) {
  Atomics.wait(barrier,release,0,100);
  if(performance.now()>deadline)throw Error('Host-controlled fixture barrier exceeded 10 seconds');
 }
}
async function main() {
 rendezvous(0,1);
 const result=await FexLinuxThread.runThread({data:d,stepBroker:async(_space,rip)=>units.get(rip),
  onStep:step=>{for(const p of d.pauses??[{after:4,count:2,release:3}])
   if(step.executed===p.after)rendezvous(p.count,p.release);}});
 parentPort.postMessage({op:'result',pid:d.pid,...result});
}
main().catch(error=>parentPort.postMessage({op:'fatal',message:error.stack||String(error)}));
