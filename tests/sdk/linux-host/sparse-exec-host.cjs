// SPDX-License-Identifier: GPL-3.0-or-later
// Node reference host: exact worker/lease ownership and native request draining.
const {Worker}=require('worker_threads'),path=require('path'),assert=require('node:assert/strict');
class SparseHost {
 constructor({get,cfg,resources,units,scenario,onResult,onFailure}){Object.assign(this,{get,cfg,resources,units,scenario,onResult,onFailure});this.workers=new Map();this.history=[];this.drops=[];this.events=[];this.results=[];this.failures=[];}
 track(r,p){r.pending.add(p);p.finally(()=>{r.pending.delete(p);this.ack(r);}).catch(this.onFailure);return p;}
 notify(d){const k=new Int32Array(d.ksab);Atomics.add(k,0,1);Atomics.notify(k,0);}
 ack(r){if(r.acked||!r.absent||r.pending.size)return;r.acked=true;const d=r.spec,k=new Int32Array(d.ksab);this.events.push({kind:'ack',slot:d.slot,lease:d.lease,space:d.space,pending:0});Atomics.store(k,((256+d.slot*128)>>2)+26,0);this.notify(d);}
 spawn(d){assert(!this.workers.has(d.slot)||this.workers.get(d.slot).acked,'A live worker record cannot be overwritten');const r={spec:d,pending:new Set(),absent:true,stopping:false,acked:false};this.workers.set(d.slot,r);this.history.push(r);
  this.track(r,(async()=>{
   if(d.codes){const c=await(await this.get('/xlat/config?space='+d.space)).json();assert.deepEqual(c,this.cfg);
    for(const p of d.codes){if(r.stopping)break;assert((await this.get('/xlat/code?space='+d.space+'&addr='+p.address.toString(16),{method:'POST',body:p.bytes})).ok);}
   }
   if(r.stopping)return;
   const fail=!!d.codes&&this.scenario==='terminate-before-ready',w=new Worker(path.join(__dirname,'sparse-exec-thread.cjs'),{workerData:{...d,resources:this.resources,units:this.units,maximumSteps:200,startupHold:fail?new SharedArrayBuffer(4):undefined}});r.worker=w;r.absent=false;
   w.on('error',this.onFailure);w.on('message',m=>{
    if(m.op==='unit-request'){
     if(r.stopping)return;
     if(d.codes&&this.scenario==='terminate-during-translation'&&!r.injected){r.injected=true;queueMicrotask(()=>this.stop(d));}
     if(m.space!==d.space||typeof m.rip!=='bigint')return this.onFailure(Error('Foreign native catalogue request'));
     this.track(r,(async()=>{const b=new Uint8Array(await(await this.get('/xlat/step?space='+d.space+'&rip='+m.rip)).arrayBuffer()),u=FexLinuxThread.parseBrokerStep(b);if(u.status===0)u.module=await WebAssembly.compile(u.code);
      if(!r.stopping)w.postMessage({op:'unit-reply',id:m.id,unit:u});this.events.push({kind:'translated',slot:d.slot,space:d.space,rip:m.rip,discarded:r.stopping});
     })().catch(e=>{if(!r.stopping)w.postMessage({op:'unit-reply',id:m.id,error:String(e)});}));
    }else if(m.op==='thread-result'){this.results.push(m);this.onResult?.(m);}
    else if(m.op==='thread-failed'){this.failures.push(m);if(!d.codes||!['unsupported-entry','terminate-before-ready'].includes(this.scenario))this.onFailure(Error(m.message));}
   });
   w.on('exit',code=>{r.absent=true;this.events.push({kind:'worker-exit',slot:d.slot,lease:d.lease,code,pending:r.pending.size});this.ack(r);});
   if(fail){r.stopping=true;await w.terminate();}
  })().catch(error=>{if(d.startGate){Atomics.store(new Int32Array(d.startGate),0,4);this.notify(d);}else this.onFailure(error);}));
 }
 stop(d){const r=this.workers.get(d.slot);assert(r&&r.spec.lease===d.lease,'Stop requires exact owned lease');this.events.push({kind:'stop',slot:d.slot,lease:d.lease});r.stopping=true;r.worker?.terminate().catch(this.onFailure);this.ack(r);}
 drop(d){for(const r of this.history)if(r.spec.space===d.space)assert(r.acked,'Cannot drop a catalogue before native requests and workers drain');this.events.push({kind:'drop',space:d.space});this.drops.push(this.get('/xlat/drop?space='+d.space).then(r=>assert(r.ok)));}
 async close(){for(const r of this.history){r.stopping=true;await r.worker?.terminate();await Promise.allSettled([...r.pending]);}await Promise.all(this.drops);}
}
module.exports={SparseHost};
