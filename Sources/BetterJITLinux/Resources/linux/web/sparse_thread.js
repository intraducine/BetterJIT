// SPDX-License-Identifier: GPL-3.0-or-later
// One controlled run-loop return, including owned terminal CPU exceptions.
// This profile never acknowledges Worker.terminate().
'use strict';
importScripts('../guest_memory.js','../guest_memory_broker.js','../thread_core.js');
let pending=new Map(),next=0,started=false;
onmessage=async({data:d})=>{
 if(d.op==='unit-reply'){const p=pending.get(d.id);if(p){pending.delete(d.id);d.error?p.reject(Error(d.error)):p.resolve(d.unit);}return;}
 if(d.op!=='start'||started)throw Error('Sparse worker starts once');started=true;
 try{const result=await FexLinuxThread.runThread({data:d.spec,stepBroker:(space,rip)=>new Promise((resolve,reject)=>{const id=++next;pending.set(id,{resolve,reject});postMessage({op:'unit-request',id,space,rip});})});
  if(pending.size)throw Error('Sparse execution completed with pending requests');
  onmessage=null;postMessage({op:'thread-result',result,lease:d.spec.lease,slot:d.spec.slot,tid:d.spec.tid,pendingRequests:0});
 }catch(error){onmessage=null;if(!pending.size)postMessage({op:'failure',message:String(error),lease:d.spec.lease,slot:d.spec.slot,tid:d.spec.tid,pendingRequests:0});else postMessage({op:'failure',message:'Sparse failure retained pending requests',lease:d.spec.lease,slot:d.spec.slot,tid:d.spec.tid,pendingRequests:pending.size});}
 // Internal memory remains retained until the owning session is torn down.
};
