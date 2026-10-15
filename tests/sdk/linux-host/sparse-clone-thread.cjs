// SPDX-License-Identifier: GPL-3.0-or-later
const {workerData:d,parentPort}=require('worker_threads'),fs=require('fs'),path=require('path'),vm=require('vm');
for(const n of ['guest_memory','guest_memory_broker','thread_core'])vm.runInThisContext(fs.readFileSync(path.join(d.resources,'linux',n+'.js'),'utf8'));
const units=new Map(d.units.map(u=>[u.rip,u]));
FexLinuxThread.runThread({data:d,stepBroker:async(_space,rip)=>units.get(rip)}).then(
 result=>parentPort.postMessage({op:'thread-result',pid:d.pid,tid:d.tid,...result}),
 error=>parentPort.postMessage({op:'thread-failed',tid:d.tid,message:String(error)}));
