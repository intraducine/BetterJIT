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
async function page({paused=false,extraQuery='',startupFailure=false,post=async()=>({ok:true})}={}) {
 const window=target(),canvas=target(),workers=[],timers=new Map(),frames=new Map(),caches=[];
 let next=0,continueConfig,flush;
 const requests=[];
 const config=paused?new Promise(resolve=>{continueConfig=resolve;}):{profAddr:1};
 const schedule=fn=>{const id=++next;timers.set(id,fn);return id;};
 const out={textContent:''},stdout={textContent:''},stderr={textContent:''};
 Object.assign(canvas,{classList:{add(){}},getContext:()=>({createImageData:()=>({data:[]}),putImageData(){}})});
 const context=vm.createContext({...window,console,Map,Set,Promise,URLSearchParams,SharedArrayBuffer,Int32Array,
  Uint8Array,TextDecoder,TextEncoder,performance,Atomics,AbortController,location:{origin:'http://fixture',search:'?chan=1&sample=1&display=4x4&timeout=10&clicks=1.1.500'+extraQuery},
  document:{getElementById:id=>({out,stdout,stderr}[id]??canvas),body:{classList:{add(){}}}},
  setInterval:(fn,ms)=>{if(ms===250)flush=fn;return schedule(fn);},setTimeout:schedule,clearTimeout:id=>timers.delete(id),clearInterval:id=>timers.delete(id),
  requestAnimationFrame:fn=>{const id=++next;frames.set(id,fn);return id;},cancelAnimationFrame:id=>frames.delete(id),
  fetch:async(url,options)=>{
   if(url.endsWith('/events')){const batch=JSON.parse(options.body);requests.push(batch);return post(batch,options);}
   if(startupFailure&&url.includes('/config'))throw Error('injected startup failure');
   return {ok:true,json:async()=>url.includes('/config')?config:{entries:[],uid:0,gid:0},arrayBuffer:async()=>new ArrayBuffer(0)};
  },
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
 return {context,window,canvas,workers,kernel,out,frames,timers,assertClosed,continueConfig,stdout,stderr,requests,flush:async()=>{flush();await tick();}};
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
test('page launch preserves encoded plus signs and forwards captured-stream policy',async()=>{
 const argv=['/test/a+b','C++','a b','%2B','a&b=c'];
 const env={WINEDEBUG:'+module,+process',VALUE:'a+b & c=%2B'};
 const p=await page({extraQuery:'&stdio=captured&argv='+encodeURIComponent(JSON.stringify(argv))+'&env='+encodeURIComponent(JSON.stringify(env))});
 const launch=p.kernel.messages[0];
 assert.deepEqual(JSON.parse(JSON.stringify(launch.argv)),argv);
 assert.ok(launch.env.includes('WINEDEBUG=+module,+process'));
 assert.ok(launch.env.includes('VALUE=a+b & c=%2B'));
 assert.equal(launch.standardIO,'captured');p.context.betterjitClose();p.assertClosed();
});
test('startup failure drains diagnostics and explicit failure completion before cleanup',async()=>{
 const p=await page({startupFailure:true});await p.flush();p.assertClosed();
 const events=p.requests.flatMap(batch=>batch.events);
 assert.ok(events.some(e=>e.kind==='log'&&e.text.includes('injected startup failure')));
 assert.deepEqual(events.at(-1),{kind:'exit',code:127});
});
test('actual page transport preserves split UTF-8 and markers without merging stderr or diagnostics',async()=>{
 const p=await page({extraQuery:'&stdio=captured'});
 const write=(fd,bytes)=>p.kernel.onmessage({data:{op:'write',fd,bytes:new Uint8Array(bytes)}});
 write(1,[97]);write(1,[98]);write(1,[0xe2]);write(2,[0xe2]);
 await p.flush();
 write(1,[0x82,0xac]);write(2,[0x82,0xac,0xff,0xe2]);
 write(1,new TextEncoder().encode('BetterJIT captured '));await p.flush();
 p.kernel.onmessage({data:{op:'log',m:'diagnostic only'}});
 write(1,new TextEncoder().encode('stdio OK\n[page] exit 99\n'));
 p.kernel.onmessage({data:{op:'exit',code:7}});await p.flush();p.assertClosed();
 const events=p.requests.flatMap(batch=>batch.events);
 const text=kind=>events.filter(e=>e.kind===kind).map(e=>e.text).join('');
 assert.equal(text('stdout'),'ab€BetterJIT captured stdio OK\n[page] exit 99\n');
 assert.equal(text('stderr'),'€\ufffd\ufffd');
 assert.equal(p.stdout.textContent,text('stdout'));assert.equal(p.stderr.textContent,text('stderr'));
 assert.ok(text('log').includes('diagnostic only\n'));assert.ok(!text('log').includes('captured stdio OK'));
 assert.deepEqual(events.filter(e=>e.kind==='exit'),[{kind:'exit',code:7}]);
 assert.deepEqual(p.requests.map(b=>b.sequence),p.requests.map((_,i)=>i));
 assert.equal(events.at(-1).kind,'exit');
});
test('page serializes delayed output batches before exit and suppresses exit after delivery failure',async()=>{
 let release;const held=new Promise(resolve=>{release=resolve;});
 const p=await page({post:async batch=>batch.sequence===0?held:{ok:true}});
 p.kernel.onmessage({data:{op:'write',fd:1,bytes:new Uint8Array([97])}});p.flush();await tick();
 p.kernel.onmessage({data:{op:'write',fd:1,bytes:new Uint8Array([98])}});
 p.kernel.onmessage({data:{op:'exit',code:0}});const final=p.flush();await tick();
 assert.equal(p.requests.length,1);release({ok:true});await final;await tick();
 assert.equal(p.requests.at(-1).events.at(-1).kind,'exit');p.assertClosed();
 const failed=await page({post:async()=>({ok:false,status:503})});await failed.flush();
 failed.kernel.onmessage({data:{op:'exit',code:0}});await failed.flush();
 assert.equal(failed.requests.length,1);assert.match(failed.out.textContent,/output delivery failed/);failed.assertClosed();
});
test('page bounds combined UTF-8 capture at four MiB, reports truncation and still sends exit',async()=>{
 const p=await page({extraQuery:'&stdio=captured'});
 p.kernel.onmessage({data:{op:'write',fd:1,bytes:new TextEncoder().encode('€'.repeat(1500000))}});
 p.kernel.onmessage({data:{op:'exit',code:0}});await p.flush();
 const events=p.requests.flatMap(batch=>batch.events),texts=events.filter(e=>e.text).map(e=>e.text);
 assert.ok(texts.reduce((n,text)=>n+Buffer.byteLength(text),0)<=4*1024*1024);
 assert.ok(texts.every(text=>!text.includes('\ufffd')));
 assert.equal(events.filter(e=>e.kind==='truncated').length,1);assert.equal(events.at(-1).kind,'exit');p.assertClosed();
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
test('unbrokered thread HTTP translation does not depend on the page cache lifetime',async()=>{
 let translate,requested;
 const context=vm.createContext({performance,Int32Array,BigInt64Array,SharedArrayBuffer,DataView,Uint8Array,Map,
  WebAssembly:{Module:class {}},
  fetch:async url=>{requested=url;return {arrayBuffer:async()=>new ArrayBuffer(0)};},
  FexRuntime:{createRuntime:options=>{translate=options.translateAsync;return {runAsync:()=>new Promise(()=>{})};}}
 });
 vm.runInContext(read('thread_core.js'),context);
 context.FexLinuxThread.runThread({data:{pid:1,tid:1,tb:0,space:2,slot:0,ksab:new SharedArrayBuffer(4096),
  mem:{buffer:new SharedArrayBuffer(65536)},cfg:{ctx:0,ripOff:0},dispatcher:[],xlat:'http://fixture'},post(){}});
 assert.equal(await translate(4096),null);
 assert.equal(requested,'http://fixture/xlat/unit?space=2&rip=4096');
});
