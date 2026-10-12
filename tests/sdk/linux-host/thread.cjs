// SPDX-License-Identifier: GPL-3.0-or-later
const {workerData:d,parentPort}=require('worker_threads');
const fs=require('fs'),path=require('path'),vm=require('vm');
for(const file of ['runtime.js','linux/thread_core.js'])vm.runInThisContext(fs.readFileSync(path.join(d.resources,file),'utf8'));
let nextID=1;const pending=new Map();
parentPort.on('message',message=>{
  if(message.op!=='unit')return;
  const resolve=pending.get(message.id);pending.delete(message.id);
  resolve?.(message.module?message:null);
});
FexLinuxThread.runThread({data:d,post:message=>parentPort.postMessage(message),
  unitBroker:(space,rip)=>new Promise(resolve=>{
    const id=nextID++;pending.set(id,resolve);parentPort.postMessage({op:'unit',id,space,rip});})
}).catch(error=>parentPort.postMessage({op:'fatal',message:error.stack||String(error)}));
