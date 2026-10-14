// SPDX-License-Identifier: GPL-3.0-or-later
// Page-side ownership only; no guest execution or memory quota is emulated.
(function(root) {
  'use strict';
  class GuestWorkers {
    constructor() { this.current=new Map();this.owned=new Map();this.closed=false; }
    add(tid,worker,release) {
      if(this.closed){worker.onmessage=null;worker.onerror=null;worker.terminate();release?.();return false;}
      const old=this.current.get(tid);if(old)this.dispose(old);
      this.current.set(tid,worker);this.owned.set(worker,{tid,release});
      return true;
    }
    has(worker) { return this.owned.has(worker); }
    reply(worker,message) {
      if(!this.owned.has(worker))return false;
      worker.postMessage(message);return true;
    }
    dispose(worker) {
      const entry=this.owned.get(worker);if(!entry)return false;
      this.owned.delete(worker);
      if(this.current.get(entry.tid)===worker)this.current.delete(entry.tid);
      // Remove callback captures before terminating the worker. Delayed
      // translation replies must not keep an obsolete worker's guest alive.
      worker.onmessage=null;worker.onerror=null;
      worker.terminate();entry.release?.();return true;
    }
    kill(tid) { const worker=this.current.get(tid);if(worker)this.dispose(worker); }
    close() {
      this.closed=true;
      for(const worker of [...this.owned.keys()])this.dispose(worker);
      this.current.clear();
    }
  }
  root.FexGuestWorkers=GuestWorkers;
  // Own page resources from startup through exit, error, cancellation or unload.
  // Releasing references is not a claim that the engine has collected them.
  class PageResources {
    constructor() { this.closed=false;this.disposers=new Set(); }
    defer(dispose) {
      if(this.closed){dispose();return ()=>{};}
      this.disposers.add(dispose);return ()=>this.disposers.delete(dispose);
    }
    worker(worker) {
      this.defer(()=>{worker.onmessage=null;worker.onerror=null;worker.terminate();});
      return worker;
    }
    on(target,type,callback,options) {
      if(this.closed)return;
      target.addEventListener(type,callback,options);
      this.defer(()=>target.removeEventListener(type,callback,options));
    }
    interval(callback,ms) {
      if(this.closed)return;
      const id=setInterval(()=>{if(!this.closed)callback();},ms);
      this.defer(()=>clearInterval(id));return id;
    }
    timeout(callback,ms) {
      if(this.closed)return;
      const id=setTimeout(()=>{forget();if(!this.closed)callback();},ms);
      const forget=this.defer(()=>clearTimeout(id));return id;
    }
    frame(callback) {
      if(this.closed)return;
      const id=requestAnimationFrame(time=>{forget();if(!this.closed)callback(time);});
      const forget=this.defer(()=>cancelAnimationFrame(id));return id;
    }
    close() {
      if(this.closed)return;this.closed=true;
      const owned=[...this.disposers];this.disposers.clear();
      for(const dispose of owned.reverse()) { try {dispose();} catch {} }
    }
  }
  root.FexPageResources=PageResources;
})(self);
