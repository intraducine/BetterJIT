// SPDX-License-Identifier: GPL-3.0-or-later
const {workerData:d,parentPort}=require('worker_threads'),fs=require('fs'),path=require('path'),vm=require('vm');
for(const n of ['guest_memory','guest_memory_broker','thread_core'])vm.runInThisContext(fs.readFileSync(path.join(d.resources,'linux',n+'.js'),'utf8'));
let next=0;const pending=new Map(),units=new Map((d.units??[]).map(u=>[u.rip,u]));
parentPort.on('message',m=>{if(m.op!=='unit-reply')return;const p=pending.get(m.id);if(!p)return;pending.delete(m.id);m.error?p.reject(Error(m.error)):p.resolve(m.unit);});
if(d.startupHold)Atomics.wait(new Int32Array(d.startupHold),0,0);
FexLinuxThread.runThread({data:d,stepBroker:async(space,rip)=>{
 if(!d.admission)return units.get(rip);
 const id=++next;return new Promise((resolve,reject)=>{pending.set(id,{resolve,reject});parentPort.postMessage({op:'unit-request',id,space,rip});});
}}).then(result=>{parentPort.postMessage({op:'thread-result',pid:d.pid,tid:d.tid,slot:d.slot,...result});parentPort.close();},error=>{parentPort.postMessage({op:'thread-failed',pid:d.pid,tid:d.tid,slot:d.slot,message:String(error)});parentPort.close();});
