// SPDX-License-Identifier: GPL-3.0-or-later
// Bounded sparse execution host. A receipt revokes guest access, never proves
// physical Worker termination. Occupancy and internal memories stay retained.
(function(root){'use strict';
 function translationBudget(value={maximumUnits:256,maximumBytes:2*1024*1024}){
  const reject=()=>{throw Error('Invalid bounded sparse translation budget');};
  if(!value||typeof value!=='object'||Array.isArray(value))reject();
  const keys=Reflect.ownKeys(value);if(keys.length!==2||!keys.includes('maximumUnits')||!keys.includes('maximumBytes'))reject();
  const units=Object.getOwnPropertyDescriptor(value,'maximumUnits'),bytes=Object.getOwnPropertyDescriptor(value,'maximumBytes');
  if(!units||!bytes||!Object.hasOwn(units,'value')||!Object.hasOwn(bytes,'value'))reject();
  const maximumUnits=units.value,maximumBytes=bytes.value;
  if(!Number.isSafeInteger(maximumUnits)||maximumUnits<1||maximumUnits>512||
     !Number.isSafeInteger(maximumBytes)||maximumBytes<1||maximumBytes>2*1024*1024)reject();
  return Object.freeze({maximumUnits,maximumBytes});
 }
 class SparseProcessHost {
  constructor({get,cfg,workerFactory=()=>new Worker('sparse_thread.js'),onResult=()=>{},onFailure=()=>{},maximumSteps=20000,translationBudget:limits,maximumResidentBytes:residentBytes}){
   Object.defineProperty(this,'translationBudget',{value:translationBudget(limits),enumerable:true});
   const resident=residentBytes===undefined?this.translationBudget.maximumBytes:residentBytes;
   if(!Number.isSafeInteger(resident)||resident<1||resident>this.translationBudget.maximumBytes)throw Error('Invalid bounded sparse resident translation budget');
   Object.defineProperty(this,'maximumResidentBytes',{value:resident,enumerable:true});
   Object.assign(this,{get,cfg,workerFactory,onResult,onFailure,maximumSteps});this.records=new Map();this.history=[];this.cache=new Map();this.cacheBytes=0;this.closed=false;this.drops=[];this.dropped=new Set();
   this.retainedBytes=0;this.pendingEntries=0;this.pinnedEntries=0;this.pinnedRequests=0;
   this.cacheCounters={hits:0,misses:0,fetches:0,compileAttempts:0,compiled:0,failures:0,evictions:0,failedRemovals:0,
    peakEntries:0,peakRetainedBytes:0,peakPendingEntries:0,peakPinnedEntries:0,peakPinnedRequests:0};
  }
  cacheStats(){return {...this.cacheCounters,entries:this.cache.size,retainedBytes:this.retainedBytes,receivedBytes:this.cacheBytes,
   pendingEntries:this.pendingEntries,pinnedEntries:this.pinnedEntries,pinnedRequests:this.pinnedRequests,
   maximumEntries:this.translationBudget.maximumUnits,maximumReceivedBytes:this.translationBudget.maximumBytes,maximumResidentBytes:this.maximumResidentBytes};}
  peaks(){const s=this.cacheCounters;s.peakEntries=Math.max(s.peakEntries,this.cache.size);s.peakRetainedBytes=Math.max(s.peakRetainedBytes,this.retainedBytes);
   s.peakPendingEntries=Math.max(s.peakPendingEntries,this.pendingEntries);s.peakPinnedEntries=Math.max(s.peakPinnedEntries,this.pinnedEntries);s.peakPinnedRequests=Math.max(s.peakPinnedRequests,this.pinnedRequests);}
  releaseBytes(e){this.retainedBytes-=e.bytes;e.bytes=0;}
  forget(e,reason){if(this.cache.get(e.key)!==e)return false;this.cache.delete(e.key);if(!e.pins)this.releaseBytes(e);
   if(reason==='eviction')this.cacheCounters.evictions++;if(reason==='failed')this.cacheCounters.failedRemovals++;return true;}
  touch(e){if(!this.closed&&this.cache.get(e.key)===e){this.cache.delete(e.key);this.cache.set(e.key,e);}}
  evict(){for(const e of this.cache.values())if(e.settled&&!e.pins){this.forget(e,'eviction');return true;}return false;}
  unpin(e){this.pinnedRequests--;if(!--e.pins){this.pinnedEntries--;if(e.failed)this.forget(e,'failed');if(this.cache.get(e.key)!==e)this.releaseBytes(e);}}
  translation(space,rip){
   if(this.closed||this.dropped.has(space))throw Error('Sparse translation namespace closed or retired');
   const key=space+':'+rip;let e=this.cache.get(key);
   if(e){this.cacheCounters.hits++;this.touch(e);}else{
    this.cacheCounters.misses++;
    while(this.cache.size>=this.translationBudget.maximumUnits)if(!this.evict())throw Error('Sparse process translation limit reached: all entries pending or pinned');
    e={key,pins:0,settled:false,failed:false,bytes:0,promise:null};this.cache.set(key,e);this.pendingEntries++;
   }
   if(!e.pins++)this.pinnedEntries++;this.pinnedRequests++;this.peaks();
   if(!e.promise){
    // Publish the shared promise before invoking an injected get(), which can
    // synchronously reenter translation(). Closing before this turn cancels it.
    e.promise=Promise.resolve().then(async()=>{try{
     if(this.closed||this.cache.get(key)!==e)return null;
     this.cacheCounters.fetches++;
     const bytes=new Uint8Array(await(await this.get('/xlat/step?space='+space+'&rip='+rip)).arrayBuffer());this.cacheBytes+=bytes.length;
     // A closed host must not compile or reinsert a late response. Pending
     // and pin counters still drain independently of Map membership.
     if(this.closed||this.cache.get(key)!==e)return null;
     if(this.cacheBytes>this.translationBudget.maximumBytes)throw Error('Sparse process translation byte limit reached');
     if(bytes.length>this.maximumResidentBytes)throw Error('Sparse process resident translation byte limit reached');
     while(this.retainedBytes+bytes.length>this.maximumResidentBytes)if(!this.evict())throw Error('Sparse process resident translation byte limit reached: all entries pending or pinned');
     e.bytes=bytes.length;this.retainedBytes+=e.bytes;this.peaks();
     const u=FexLinuxThread.parseBrokerStep(bytes);
     if(u.status===0){this.cacheCounters.compileAttempts++;u.module=await WebAssembly.compile(u.code);this.cacheCounters.compiled++;}
     if(this.closed||this.cache.get(key)!==e)return null;
     return u;
    }catch(error){e.failed=true;this.cacheCounters.failures++;throw error;}
    finally{e.settled=true;this.pendingEntries--;}});
   }
   return e;
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
       let entry;try{entry=this.translation(d.space,m.rip);const unit=await entry.promise;this.touch(entry);
        // postMessage completes structured cloning before returning. The worker
        // then owns its clone; eviction never revokes a running instance.
        if(!this.closed&&!r.stopping&&!r.finished)w.postMessage({op:'unit-reply',id:m.id,unit});
       }finally{if(entry)this.unpin(entry);r.requests.delete(m.id);}
      })());
     }else if(m.op==='thread-result'||m.op==='failure'){
      if(m.lease!==d.lease||m.slot!==d.slot||m.tid!==d.tid||m.pendingRequests!==0||r.requests.size)throw Error('Foreign sparse completion receipt');
      r.finished=m.op==='thread-result'?'normal':r.stopping?'stopped':'failed';
      if(m.op==='thread-result')this.onResult(m,r);
      else if(!r.stopping){
       // Before RUN, the authority can cancel this exact staged image and
       // return errno/UNSUPPORTED after its receipt. Never fabricate status.
       if(d.startGate&&Atomics.load(new Int32Array(d.startGate),0)!==2){Atomics.store(new Int32Array(d.startGate),0,4);this.notify(d);}
       else {r.uncertain=true;this.onFailure(Error(m.message));}
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
   for(const e of this.cache.values())if(e.key.startsWith(d.space+':'))this.forget(e,'drop');
   this.dropped.add(d.space);const p=this.get('/xlat/drop?space='+d.space);this.drops.push(p);p.catch(this.onFailure);
  }
  close(){if(this.closed)return;this.closed=true;for(const r of this.history){if(r.worker){r.worker.onmessage=null;r.worker.onerror=null;r.worker.terminate();}}for(const e of this.cache.values())this.forget(e,'close');}
 }
 root.BetterJITSparseProcessHost=SparseProcessHost;
})(globalThis);
