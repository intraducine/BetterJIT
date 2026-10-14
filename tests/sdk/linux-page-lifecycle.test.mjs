// SPDX-License-Identifier: GPL-3.0-or-later
// Execute the actual page with browser/worker fixtures. No guest or OS-memory claims.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const base=new URL('../../Sources/BetterJITLinux/Resources/linux/',import.meta.url);
const read=name=>fs.readFileSync(new URL(name,base),'utf8');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function target() {
 const events=new Map();
 return {events,addEventListener(type,fn){if(!events.has(type))events.set(type,new Set());events.get(type).add(fn);},
  removeEventListener(type,fn){events.get(type)?.delete(fn);},
  emit(type){for(const fn of [...(events.get(type)??[])])fn({});},
  listenerCount(){return [...events.values()].reduce((sum,set)=>sum+set.size,0);}};
}
async function page({paused=false}={}) {
 const window=target(),canvas=target(),workers=[],timers=new Map(),frames=new Map(),caches=[];
 let next=0,continueConfig;
 const config=paused?new Promise(resolve=>{continueConfig=resolve;}):{profAddr:1};
 const schedule=fn=>{const id=++next;timers.set(id,fn);return id;};
 const out={textContent:''};
 Object.assign(canvas,{classList:{add(){}},getContext:()=>({createImageData:()=>({data:[]}),putImageData(){}})});
 const context=vm.createContext({...window,console,Map,Set,Promise,URLSearchParams,SharedArrayBuffer,Int32Array,
  Uint8Array,TextDecoder,performance,Atomics,AbortController,location:{origin:'http://fixture',search:'?chan=1&sample=1&display=4x4&timeout=10&clicks=1.1.500'},
  document:{getElementById:id=>id==='out'?out:canvas,body:{classList:{add(){}}}},
  setInterval:schedule,setTimeout:schedule,clearTimeout:id=>timers.delete(id),clearInterval:id=>timers.delete(id),
  requestAnimationFrame:fn=>{const id=++next;frames.set(id,fn);return id;},cancelAnimationFrame:id=>frames.delete(id),
  fetch:async url=>({ok:true,json:async()=>url.includes('/config')?config:{entries:[],uid:0,gid:0},arrayBuffer:async()=>new ArrayBuffer(0)}),
  Worker:class {constructor(name){this.name=name;this.messages=[];this.terminated=0;workers.push(this);}
   postMessage(message){assert.equal(this.terminated,0);this.messages.push(message);}
   terminate(){assert.equal(this.onmessage,null);assert.equal(this.onerror,null);this.terminated++;}},
  FexCompositor:{Compositor:class {constructor(){this.windows=new Map();this.z=[];}compose(){} }},
  FexLinuxThread:{UnitCache:()=>{const cache={stats:{},epoch:{buffer:new SharedArrayBuffer(4)},closed:0,close(){this.closed++;}};caches.push(cache);return cache;}}
 });
 context.self=context;context.window=context;
 vm.runInContext(read('web/owned_workers.js'),context);
 vm.runInContext(read('web/linux_main.js'),context);
 await tick();
 const kernel=workers.find(w=>w.name==='kworker_web.js');
 const assertClosed=()=>{
  assert.ok(workers.every(w=>w.terminated===1));assert.equal(timers.size,0);assert.equal(frames.size,0);
  assert.equal(window.listenerCount(),0);assert.equal(canvas.listenerCount(),0);
  assert.ok(caches.every(c=>c.closed===1));assert.equal(context.betterjitClose,undefined);
 };
 return {context,window,canvas,workers,kernel,out,frames,timers,assertClosed,continueConfig};
}
for(const reason of ['exit','error','pagehide','host-close'])test(`page ${reason} closes channels, guest workers, display callbacks and caches`,async()=>{
 const p=await page();
 assert.equal(p.workers.length,4);assert.equal(p.frames.size,1);
 p.kernel.onmessage({data:{op:'spawn',pid:100,tid:100,slot:0,ksab:new SharedArrayBuffer(4096)}});
 assert.equal(p.workers.length,5);
 if(reason==='exit')p.kernel.onmessage({data:{op:'exit',code:0}});
 if(reason==='error')p.kernel.onerror({message:'injected kernel failure'});
 if(reason==='pagehide')p.window.emit('pagehide');
 if(reason==='host-close')p.context.betterjitClose();
 p.assertClosed();p.window.emit('pagehide');p.assertClosed();
 if(reason==='exit')assert.match(p.out.textContent,/\[page\] exit 0/);
 if(reason==='error')assert.match(p.out.textContent,/\[page\] exit 126/);
});
test('closing during startup prevents a late configuration reply from spawning workers',async()=>{
 const p=await page({paused:true});p.window.emit('pagehide');p.continueConfig({profAddr:1});await tick();
 assert.equal(p.workers.length,0);p.assertClosed();
});
test('unit cache aborts requests and cannot compile or retain replies after closure',async()=>{
 let resolve,signal,compiles=0;
 const context=vm.createContext({Map,Int32Array,SharedArrayBuffer,AbortController,performance,Uint8Array,DataView,
  WebAssembly:{compile:async()=>{compiles++;return {};}}});
 vm.runInContext(read('thread_core.js'),context);
 const cache=context.FexLinuxThread.UnitCache('http://fixture',(_url,options)=>{signal=options.signal;return new Promise(r=>{resolve=r;});});
 const pending=cache.get(1,4096);
 cache.module('one',new Uint8Array([1]));cache.close();cache.close();assert.equal(signal.aborted,true);
 resolve({arrayBuffer:async()=>new ArrayBuffer(0)});
 await assert.rejects(pending,/closed/);
 await assert.rejects(cache.get(1,4096),/closed/);
 assert.throws(()=>cache.module('two',new Uint8Array([2])),/closed/);
 assert.equal(compiles,1);
});
