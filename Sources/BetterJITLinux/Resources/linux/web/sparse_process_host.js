// SPDX-License-Identifier: GPL-3.0-or-later
// Bounded sparse execution host. A receipt revokes guest access, never proves
// physical Worker termination. Occupancy and internal memories stay retained.
(function(root){'use strict';
 class SparseProcessHost {
  constructor({get,cfg,workerFactory=()=>new Worker('sparse_thread.js'),onResult=()=>{},onFailure=()=>{},maximumSteps=20000}){
   Object.assign(this,{get,cfg,workerFactory,onResult,onFailure,maximumSteps});this.records=new Map();this.history=[];this.cache=new Map();this.cacheBytes=0;this.closed=false;this.drops=[];this.dropped=new Set();
  }
  notify(d){const k=new Int32Array(d.ksab);Atomics.add(k,0,1);Atomics.notify(k,0);}
  track(r,p){r.pending.add(p);p.then(()=>{r.pending.delete(p);try{this.ack(r);}catch(error){r.uncertain=true;this.onFailure(error);}},error=>{r.pending.delete(p);r.uncertain=true;this.onFailure(error);});return p;}
  ack(r){
   if(this.closed||r.acked||!r.finished||r.pending.size||r.uncertain)return;
   const d=r.spec,q=d.quiescence,c=new Int32Array(q);
   if(c[1]!==1||new BigUint64Array(q)[1]!==d.lease||Atomics.load(c,0)!==0)throw Error('Invalid owned quiescence receipt');
   r.acked=true;Atomics.store(c,0,r.finished==='normal'?1:r.finished==='stopped'?2:3);this.notify(d);
  }
  spawn(d){
   if(this.closed)throw Error('Sparse process host closed');
   if(!Number.isSafeInteger(d.space)||d.space<1||d.space>0xffffffff||this.dropped.has(d.space))throw Error('Invalid or retired sparse namespace');
   if(this.records.has(d.slot)||this.history.length>=8||typeof d.lease!=='bigint'||!(d.quiescence instanceof SharedArrayBuffer)||d.quiescence.byteLength!==16||!(d.stopControl instanceof SharedArrayBuffer)||d.stopControl.byteLength!==4)throw Error('Invalid retained sparse worker');
   const r={spec:d,pending:new Set(),requests:new Set(),stopping:false,finished:null,acked:false,worker:null};this.records.set(d.slot,r);this.history.push(r);
   this.track(r,(async()=>{
    if(d.codes){const cfg=await(await this.get('/xlat/config?space='+d.space)).json();if(JSON.stringify(cfg)!==JSON.stringify(this.cfg))throw Error('Foreign sparse catalogue configuration');
     for(const code of d.codes){if(r.stopping)break;await this.get('/xlat/code?space='+d.space+'&addr='+code.address.toString(16),{method:'POST',body:code.bytes});}
    }
    if(r.stopping){r.finished='stopped';return;}
    const w=this.workerFactory();r.worker=w;w.onerror=e=>{r.uncertain=true;this.onFailure(Error(e.message||'Sparse worker error without quiescence'));};
    w.onmessage=({data:m})=>{if(this.closed||r.acked)return;try{
     if(m.op==='unit-request'){
      if(m.space!==d.space||typeof m.rip!=='bigint'||!Number.isSafeInteger(m.id)||r.finished)throw Error('Foreign sparse translation request');
      if(r.stopping){w.postMessage({op:'unit-reply',id:m.id,error:'Sparse execution stopped'});return;}
      r.requests.add(m.id);
      this.track(r,(async()=>{
       const key=d.space+':'+m.rip;let p=this.cache.get(key);
       if(!p){if(this.cache.size>=256)throw Error('Sparse process translation limit reached');p=(async()=>{const bytes=new Uint8Array(await(await this.get('/xlat/step?space='+d.space+'&rip='+m.rip)).arrayBuffer());this.cacheBytes+=bytes.length;if(this.cacheBytes>2*1024*1024)throw Error('Sparse process translation byte limit reached');const u=FexLinuxThread.parseBrokerStep(bytes);if(u.status===0)u.module=await WebAssembly.compile(u.code);return u;})();this.cache.set(key,p);}
       const unit=await p;if(!this.closed&&!r.stopping&&!r.finished)w.postMessage({op:'unit-reply',id:m.id,unit});r.requests.delete(m.id);
      })());
     }else if(m.op==='thread-result'||m.op==='failure'){
      if(m.lease!==d.lease||m.slot!==d.slot||m.tid!==d.tid||m.pendingRequests!==0||r.requests.size)throw Error('Foreign sparse completion receipt');
      r.finished=m.op==='thread-result'?'normal':r.stopping?'stopped':'failed';
      if(m.op==='thread-result')this.onResult(m,r);
      else if(!r.stopping){
       // Before RUN, the authority can cancel this exact staged image and
       // return errno/UNSUPPORTED after its receipt. Never fabricate status.
       if(d.startGate&&Atomics.load(new Int32Array(d.startGate),0)!==2){Atomics.store(new Int32Array(d.startGate),0,4);this.notify(d);}
       else this.onFailure(Error(m.message));
      }
      this.ack(r);
     }
    }catch(error){r.uncertain=true;this.onFailure(error);}};
    // The worker cannot publish its own authority-side receipt. It can only
    // return from the one admitted run loop, then report that completion.
    w.postMessage({op:'start',spec:{...d,quiescence:undefined,maximumSteps:this.maximumSteps}});
   })());
  }
  stop(d){
   const r=this.records.get(d.slot);if(!r||r.spec.lease!==d.lease)throw Error('Stop requires exact sparse owner');
   r.stopping=true;Atomics.store(new Int32Array(r.spec.stopControl),0,1);
   for(const id of r.requests)r.worker?.postMessage({op:'unit-reply',id,error:'Sparse execution stopped'});r.requests.clear();
   const k=new Int32Array(r.spec.ksab);Atomics.notify(k,(256+d.slot*128)>>2);if(r.spec.startGate)Atomics.notify(new Int32Array(r.spec.startGate),0);this.ack(r);
  }
  drop(d){
   // Preparation can roll back before spawn starts any native operation.
   // Do not send a drop for a namespace this host never owned.
   if(!this.history.some(r=>r.spec.space===d.space))return;
   if(this.dropped.has(d.space))throw Error('Duplicate sparse catalogue drop');
   if(this.history.some(r=>r.spec.space===d.space&&(!r.acked||r.pending.size)))throw Error('Catalogue drop before guest/native drain');
   for(const key of this.cache.keys())if(key.startsWith(d.space+':'))this.cache.delete(key);
   this.dropped.add(d.space);const p=this.get('/xlat/drop?space='+d.space);this.drops.push(p);p.catch(this.onFailure);
  }
  close(){if(this.closed)return;this.closed=true;for(const r of this.history){if(r.worker){r.worker.onmessage=null;r.worker.onerror=null;r.worker.terminate();}}this.cache.clear();}
 }
 root.BetterJITSparseProcessHost=SparseProcessHost;
})(globalThis);
