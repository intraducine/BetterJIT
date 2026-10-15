// SPDX-License-Identifier: GPL-3.0-or-later
// One normal-exit worker. This profile never acknowledges Worker.terminate().
'use strict';
importScripts('../guest_memory.js','../guest_memory_broker.js','../thread_core.js');
let pending=new Map(),next=0,started=false;
onmessage=async({data:d})=>{
 if(d.op==='unit-reply'){const p=pending.get(d.id);if(p){pending.delete(d.id);d.error?p.reject(Error(d.error)):p.resolve(d.unit);}return;}
 if(d.op!=='start'||started)throw Error('Sparse worker starts once');started=true;
 try{const result=await FexLinuxThread.runThread({data:d.spec,stepBroker:(space,rip)=>new Promise((resolve,reject)=>{const id=++next;pending.set(id,{resolve,reject});postMessage({op:'unit-request',id,space,rip});})});
  onmessage=null;postMessage({op:'thread-result',result});
 }catch(error){onmessage=null;postMessage({op:'failure',message:String(error)});}
 // Internal memory remains retained until the owning session is torn down.
};
