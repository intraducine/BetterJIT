// SPDX-License-Identifier: GPL-3.0-or-later
// Ownership protocol tests only. Real FEX/browser execution is separate.
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';
vm.runInThisContext(fs.readFileSync(new URL('../../Sources/BetterJITLinux/Resources/linux/web/sparse_process_host.js',import.meta.url),'utf8'));
const tick=()=>new Promise(r=>setImmediate(r));
function spec(slot=0){const q=new SharedArrayBuffer(16);new Int32Array(q)[1]=1;new BigUint64Array(q)[1]=BigInt(slot+1);const ksab=new SharedArrayBuffer(4096);Atomics.store(new Int32Array(ksab),((256+slot*128)>>2)+26,1);return{pid:100,tid:100,slot,lease:BigInt(slot+1),space:1,ksab,quiescence:q,stopControl:new SharedArrayBuffer(4)};}
function fixture(get=async()=>({ok:true,json:async()=>({})}),options={}){const errors=[],workers=[];const host=new BetterJITSparseProcessHost({get,cfg:{},onFailure:e=>errors.push(e),workerFactory:()=>{const w={messages:[],terminated:0,postMessage:m=>w.messages.push(m),terminate:()=>w.terminated++};workers.push(w);return w;},...options});return{host,errors,workers};}
const result=(w,d,extra={})=>w.onmessage({data:{op:'thread-result',lease:d.lease,slot:d.slot,tid:d.tid,pendingRequests:0,result:{status:0},...extra}});
test('owned completion certifies guest quiescence without clearing occupancy or terminating its worker',async()=>{
 const f=fixture(),d=spec();f.host.spawn(d);await tick();result(f.workers[0],d);assert.equal(new Int32Array(d.quiescence)[0],1);assert.equal(Atomics.load(new Int32Array(d.ksab),((256+d.slot*128)>>2)+26),1);assert.equal(f.workers[0].terminated,0);assert.equal(f.errors.length,0);f.host.close();assert.equal(f.workers[0].terminated,1);
});
test('native mapping must settle before a no-worker cancellation receipt can publish',async()=>{
 let release;const held=new Promise(r=>{release=r;}),f=fixture(async route=>route.includes('/config')?{json:async()=>({})}:held),d={...spec(),codes:[{address:4096n,bytes:new Uint8Array([1])}]};f.host.spawn(d);await tick();f.host.stop(d);assert.equal(new Int32Array(d.quiescence)[0],0);assert.equal(f.workers.length,0);assert.throws(()=>f.host.drop({space:1}),/before guest\/native drain/);release({ok:true});await tick();assert.equal(new Int32Array(d.quiescence)[0],2);assert.equal(f.workers.length,0);f.host.close();
});
test('foreign receipts and pending guest requests cannot release an execution owner',async()=>{
 for(const extra of [{lease:99n},{slot:7},{tid:101},{pendingRequests:1}]){const f=fixture(),d=spec();f.host.spawn(d);await tick();result(f.workers[0],d,extra);assert.equal(new Int32Array(d.quiescence)[0],0);assert.equal(f.errors.length,1);assert.throws(()=>f.host.drop({space:1}),/before guest\/native drain/);f.host.close();}
});
test('a native request with uncertain failure is not an acknowledgement',async()=>{
 let reject;const held=new Promise((_r,j)=>{reject=j;}),f=fixture(async route=>route.includes('/config')?{json:async()=>({})}:held),d={...spec(),codes:[{address:4096n,bytes:new Uint8Array([1])}]};f.host.spawn(d);await tick();f.host.stop(d);reject(Error('uncertain native operation'));await tick();assert.equal(new Int32Array(d.quiescence)[0],0);assert.equal(f.errors.length,1);assert.throws(()=>f.host.drop({space:1}),/before guest\/native drain/);f.host.close();
});
test('an occupied record cannot be overwritten and closed ownership never publishes a late receipt',async()=>{
 const f=fixture(),d=spec();f.host.spawn(d);await tick();assert.throws(()=>f.host.spawn(d),/Invalid retained sparse worker/);const callback=f.workers[0].onmessage;f.host.close();callback({data:{op:'thread-result',lease:d.lease,slot:0,tid:100,pendingRequests:0,result:{status:0}}});assert.equal(new Int32Array(d.quiescence)[0],0);assert.throws(()=>f.host.spawn(spec(1)),/closed/);
});

test('cooperative stop waits for every owned translation promise after the worker stops requesting units',async()=>{
 globalThis.FexLinuxThread={parseBrokerStep:()=>({status:2,code:new Uint8Array(0)})};let release;const held=new Promise(r=>{release=r;}),f=fixture(async()=>({arrayBuffer:()=>held})),d=spec();f.host.spawn(d);await tick();const w=f.workers[0];w.onmessage({data:{op:'unit-request',id:1,space:1,rip:4096n}});await tick();f.host.stop(d);w.onmessage({data:{op:'failure',message:'cooperative stop',lease:d.lease,slot:d.slot,tid:d.tid,pendingRequests:0}});assert.equal(new Int32Array(d.quiescence)[0],0);assert.throws(()=>f.host.drop({space:1}),/before guest\/native drain/);release(new ArrayBuffer(0));await tick();assert.equal(new Int32Array(d.quiescence)[0],2);assert.equal(w.messages.filter(m=>m.op==='unit-reply').length,1);assert.equal(f.errors.length,0);f.host.close();
});
test('a certified pre-RUN worker failure is owned by kernel rollback, never a fake guest exit',async()=>{
 const f=fixture(),d={...spec(),startGate:new SharedArrayBuffer(16)};f.host.spawn(d);await tick();f.workers[0].onmessage({data:{op:'failure',message:'startup unavailable',lease:d.lease,slot:d.slot,tid:d.tid,pendingRequests:0}});assert.equal(new Int32Array(d.startGate)[0],4);assert.equal(new Int32Array(d.quiescence)[0],3);assert.equal(f.errors.length,0);f.host.close();
});
test('an unexpected post-RUN Wasm failure cannot publish quiescence or release its native catalogue',async()=>{
 const f=fixture(),d=spec();f.host.spawn(d);await tick();f.workers[0].onmessage({data:{op:'failure',message:'RuntimeError: integer divide by zero',lease:d.lease,slot:d.slot,tid:d.tid,pendingRequests:0}});
 assert.equal(f.errors.length,1);assert.equal(new Int32Array(d.quiescence)[0],0);assert.equal(f.host.history[0].uncertain,true);assert.equal(f.host.history[0].acked,false);assert.throws(()=>f.host.drop({space:1}),/before guest\/native drain/);f.host.close();
});
test('owned typed divide-error run-loop return can drain without becoming a guest exit code',async()=>{
 const results=[],f=fixture(undefined,{onResult:m=>results.push(m.result)}),d=spec();f.host.spawn(d);await tick();result(f.workers[0],d,{result:{status:5,executed:1,rip:4096n}});assert.equal(results[0].status,5);assert.equal(results[0].guestExitCode,undefined);assert.equal(new Int32Array(d.quiescence)[0],1);assert.equal(f.errors.length,0);f.host.drop({space:1});await Promise.all(f.host.drops);f.host.close();
});

test('rollback before spawn never sends a drop for an unowned namespace',()=>{let requests=0;const f=fixture(async()=>{requests++;return{ok:true};});f.host.drop({space:42});assert.equal(requests,0);f.host.close();});

test('retired numeric namespaces cannot restart native work or reuse a cached unit through aliases',async()=>{
 let requests=0;const old=globalThis.FexLinuxThread;globalThis.FexLinuxThread={parseBrokerStep:()=>({status:2,code:new Uint8Array(0)})};
 const f=fixture(async()=>{requests++;return{ok:true,arrayBuffer:async()=>new ArrayBuffer(0)};}),d=spec();try{
  f.host.spawn(d);await tick();f.workers[0].onmessage({data:{op:'unit-request',id:1,space:1,rip:4096n}});await tick();
  assert.equal(f.host.cache.size,1);result(f.workers[0],d);f.host.drop({space:1});await Promise.all(f.host.drops);assert.equal(f.host.cache.size,0);
  const before=requests;for(const space of [1,'1',1n,0,-1,1.5,0x100000000,NaN])assert.throws(()=>f.host.spawn({...spec(1),space,codes:[{address:4096n,bytes:Uint8Array.of(0xff,0xe0)}]}),/namespace/);
  assert.equal(requests,before);assert.equal(f.host.history.length,1);assert.equal(f.workers.length,1);assert.equal(f.errors.length,0);
 }finally{f.host.close();globalThis.FexLinuxThread=old;}
});

test('translation budgets preserve defaults and reject malformed or excessive configuration',()=>{
 const f=fixture();assert.deepEqual(f.host.translationBudget,{maximumUnits:256,maximumBytes:2097152});f.host.close();
 assert.equal(f.host.maximumResidentBytes,2097152);assert.throws(()=>{f.host.maximumResidentBytes=1;},TypeError);
 const valid={maximumUnits:512,maximumBytes:2097152},g=fixture(undefined,{translationBudget:valid});valid.maximumUnits=1;
 assert.equal(g.host.translationBudget.maximumUnits,512);assert(Object.isFrozen(g.host.translationBudget));
 assert.throws(()=>{g.host.translationBudget.maximumUnits=513;},TypeError);assert.throws(()=>{g.host.translationBudget=valid;},TypeError);g.host.close();
 for(const value of [null,[],{}, {maximumUnits:512}, {maximumBytes:1}, {maximumUnits:1,maximumBytes:1,extra:1},
  ...[0,-1,513,NaN,Infinity,1.5,'512'].map(maximumUnits=>({maximumUnits,maximumBytes:2097152})),
  ...[0,-1,2097153,NaN,Infinity,1.5,'2097152'].map(maximumBytes=>({maximumUnits:512,maximumBytes}))])
  assert.throws(()=>fixture(undefined,{translationBudget:value}),/bounded sparse translation budget/);
 let reads=0;const getters={get maximumUnits(){return++reads<4?512:999999;},maximumBytes:2097152};assert.throws(()=>fixture(undefined,{translationBudget:getters}),/bounded sparse translation budget/);assert.equal(reads,0);
 for(const key of [Symbol('extra'),'hidden']){const value={maximumUnits:512,maximumBytes:2097152};Object.defineProperty(value,key,{value:1});assert.throws(()=>fixture(undefined,{translationBudget:value}),/bounded sparse translation budget/);}
});

test('default and explicit entry caps reject before fetching, count pending promises, and permit cached hits',async()=>{
 const old=globalThis.FexLinuxThread;globalThis.FexLinuxThread={parseBrokerStep:()=>({status:2,code:new Uint8Array(0)})};
 try{for(const maximumUnits of [256,512]){
  let requests=0,release;const held=new Promise(resolve=>{release=resolve;});
  const f=fixture(async()=>{requests++;return{arrayBuffer:()=>held};},maximumUnits===256?{}:{translationBudget:{maximumUnits,maximumBytes:2097152}}),d=spec();f.host.spawn(d);await tick();const w=f.workers[0];
  for(let i=0;i<maximumUnits;i++)w.onmessage({data:{op:'unit-request',id:i+1,space:1,rip:4096n+BigInt(i)}});await tick();
  assert.equal(f.host.cache.size,maximumUnits);assert.equal(requests,maximumUnits);
  // A hit at the cap shares its pending promise; it must not consume a slot.
  w.onmessage({data:{op:'unit-request',id:maximumUnits+1,space:1,rip:4096n}});assert.equal(requests,maximumUnits);
  w.onmessage({data:{op:'unit-request',id:maximumUnits+2,space:1,rip:8192n}});await tick();assert.equal(requests,maximumUnits);assert.match(f.errors[0].message,/translation limit reached/);
  release(new ArrayBuffer(96));await tick();assert.equal(f.host.cacheBytes,maximumUnits*96);assert.equal(w.messages.filter(m=>m.op==='unit-reply').length,maximumUnits+1);
  assert.equal(f.host.history[0].acked,false);assert.throws(()=>f.host.drop({space:1}),/before guest\/native drain/);f.host.close();assert.equal(f.host.cache.size,0);assert.equal(w.terminated,1);
 }}finally{globalThis.FexLinuxThread=old;}
});

test('both count profiles enforce the same cumulative byte boundary before parse and compile',async()=>{
 const old=globalThis.FexLinuxThread;let parses=0;globalThis.FexLinuxThread={parseBrokerStep:()=>{parses++;return{status:2,code:new Uint8Array(0)};}};
 try{for(const maximumUnits of [256,512])for(const lengths of [[2097151],[2097152],[2097153],[1048576,1048576,96]]){
  let requests=0;parses=0;const f=fixture(async()=>({arrayBuffer:async()=>new ArrayBuffer(lengths[requests++])}),{translationBudget:{maximumUnits,maximumBytes:2097152}}),d=spec();f.host.spawn(d);await tick();const w=f.workers[0];
  for(let i=0;i<lengths.length;i++){w.onmessage({data:{op:'unit-request',id:i+1,space:1,rip:4096n+BigInt(i)}});await tick();}
  const over=lengths.reduce((n,x)=>n+x,0)>2097152;assert.equal(f.errors.length,over?1:0);if(over)assert.match(f.errors[0].message,/translation byte limit reached/);
  assert.equal(parses,lengths.length-(over?1:0));assert.equal(f.host.cacheBytes,lengths.reduce((n,x)=>n+x,0));
  assert.equal(f.host.history[0].acked,false);f.host.close();assert.equal(f.host.cache.size,0);assert.equal(w.terminated,1);
 }}finally{globalThis.FexLinuxThread=old;}
});

test('settled LRU entries evict across multiple capacities; hits refresh order and live clones survive',async()=>{
 const old=globalThis.FexLinuxThread,wasm=Uint8Array.of(0,97,115,109,1,0,0,0);let fetches=0;
 globalThis.FexLinuxThread={parseBrokerStep:bytes=>({status:0,header:bytes.slice(0,96),code:wasm.slice()})};
 const f=fixture(async()=>{fetches++;return{arrayBuffer:async()=>new Uint8Array(104).fill(7).buffer};},{translationBudget:{maximumUnits:2,maximumBytes:2097152}}),d=spec();
 try{f.host.spawn(d);await tick();const w=f.workers[0];w.postMessage=m=>w.messages.push(structuredClone(m));let id=0;
  const ask=async rip=>{const request=++id;w.onmessage({data:{op:'unit-request',id:request,space:1,rip}});for(let n=0;n<100&&!w.messages.some(m=>m.id===request);n++)await tick();assert.equal(f.errors.length,0);return w.messages.find(m=>m.id===request).unit;};
  const first=await ask(4096n),entry=f.host.cache.get('1:4096');await ask(4097n);await ask(4096n);await ask(4098n);
  assert(f.host.cache.has('1:4096'));assert(!f.host.cache.has('1:4097'));assert.equal(fetches,3);
  for(let i=0;i<12;i++){await ask(8192n+BigInt(i));assert.equal(f.host.cache.size,2);assert.equal(f.host.retainedBytes,208);}
  const original=await entry.promise;original.header.fill(0);original.code.fill(0);assert.equal(first.header[0],7);assert.equal(first.code[0],0);assert.equal(first.code[1],97);assert(first.module instanceof WebAssembly.Module);assert.deepEqual(WebAssembly.Module.exports(first.module),[]);
  const again=await ask(4096n);assert.notEqual(again.module,first.module);assert.deepEqual(again.header,new Uint8Array(104).fill(7).slice(0,96));
  const s=f.host.cacheStats();assert.equal(s.hits,1);assert.equal(s.fetches,16);assert.equal(s.compiled,16);assert.equal(s.evictions,14);assert.equal(s.peakEntries,2);assert.equal(s.peakRetainedBytes,208);assert.equal(s.pendingEntries,0);assert.equal(s.pinnedRequests,0);
  result(w,d);f.host.drop({space:1});await Promise.all(f.host.drops);assert.equal(f.host.retainedBytes,0);
 }finally{f.host.close();globalThis.FexLinuxThread=old;}
});

test('shared pending entries remain pinned through synchronous delivery and count pressure never evicts them',async()=>{
 const old=globalThis.FexLinuxThread;globalThis.FexLinuxThread={parseBrokerStep:()=>({status:2,code:new Uint8Array(0)})};let release,fetches=0;const held=new Promise(r=>{release=r;});
 const f=fixture(async()=>{fetches++;return{arrayBuffer:()=>held};},{translationBudget:{maximumUnits:1,maximumBytes:2097152}}),a=spec(),b=spec(1);
 try{f.host.spawn(a);f.host.spawn(b);await tick();for(let n=0;n<2;n++)f.workers[n].onmessage({data:{op:'unit-request',id:1,space:1,rip:4096n}});await tick();
  assert.equal(fetches,1);assert.equal(f.host.cacheStats().pinnedRequests,2);assert.equal(f.host.cacheStats().pinnedEntries,1);assert.equal(f.host.cacheStats().pendingEntries,1);
  f.workers[0].onmessage({data:{op:'unit-request',id:2,space:1,rip:4097n}});await tick();assert.equal(fetches,1);assert.equal(f.host.cacheStats().evictions,0);assert.match(f.errors[0].message,/all entries pending or pinned/);
  let pins=[];for(const w of f.workers)w.postMessage=m=>{if(m.op==='unit-reply')pins.push(f.host.cacheStats().pinnedRequests);w.messages.push(m);};release(new ArrayBuffer(96));await tick();assert.deepEqual(pins,[2,1]);assert.equal(f.host.cacheStats().pinnedRequests,0);assert.equal(f.host.cacheStats().pendingEntries,0);assert.equal(f.host.retainedBytes,96);
 }finally{f.host.close();globalThis.FexLinuxThread=old;}
});

test('resident byte eviction is independent from the unchanged cumulative receive gate',async()=>{
 const old=globalThis.FexLinuxThread;let parses=0;globalThis.FexLinuxThread={parseBrokerStep:()=>{parses++;return{status:2,code:new Uint8Array(0)};}};
 const f=fixture(async()=>({arrayBuffer:async()=>new ArrayBuffer(96)}),{translationBudget:{maximumUnits:3,maximumBytes:288},maximumResidentBytes:96}),d=spec();
 try{f.host.spawn(d);await tick();const w=f.workers[0];for(let n=0;n<4;n++){w.onmessage({data:{op:'unit-request',id:n+1,space:1,rip:4096n+BigInt(n)}});await tick();}
  assert.equal(parses,3);assert.equal(f.host.cacheBytes,384);assert.equal(f.host.retainedBytes,96);assert.equal(f.host.cacheStats().evictions,2);assert.equal(f.host.cacheStats().failedRemovals,1);assert.equal(f.host.cacheStats().peakRetainedBytes,96);assert.equal(f.errors.length,1);assert.match(f.errors[0].message,/translation byte limit reached/);
 }finally{f.host.close();globalThis.FexLinuxThread=old;}
 for(const resident of [null,0,-1,289,NaN,Infinity,1.5,'96'])assert.throws(()=>fixture(undefined,{translationBudget:{maximumUnits:3,maximumBytes:288},maximumResidentBytes:resident}),/resident translation budget/);
});

test('an individually oversized resident response fails before parse and releases its reservation',async()=>{
 const old=globalThis.FexLinuxThread;let parses=0;globalThis.FexLinuxThread={parseBrokerStep:()=>{parses++;throw Error('must not parse');}};
 const f=fixture(async()=>({arrayBuffer:async()=>new ArrayBuffer(97)}),{maximumResidentBytes:96}),d=spec();try{f.host.spawn(d);await tick();f.workers[0].onmessage({data:{op:'unit-request',id:1,space:1,rip:4096n}});await tick();assert.equal(parses,0);assert.equal(f.host.cache.size,0);assert.equal(f.host.retainedBytes,0);assert.equal(f.host.cacheStats().pendingEntries,0);assert.equal(f.host.cacheStats().pinnedRequests,0);assert.match(f.errors[0].message,/resident translation byte limit/);}finally{f.host.close();globalThis.FexLinuxThread=old;}
});

test('shared failed fetches release the entry only after every waiter and cannot acknowledge uncertain ownership',async()=>{
 const old=globalThis.FexLinuxThread;globalThis.FexLinuxThread={parseBrokerStep:()=>({status:2,code:new Uint8Array(0)})};let reject,fetches=0;const held=new Promise((_r,j)=>{reject=j;});
 const f=fixture(async()=>{fetches++;return{arrayBuffer:()=>held};}),a=spec(),b=spec(1);try{f.host.spawn(a);f.host.spawn(b);await tick();for(const w of f.workers)w.onmessage({data:{op:'unit-request',id:1,space:1,rip:4096n}});await tick();assert.equal(fetches,1);reject(Error('fetch failed'));await tick();assert.equal(f.errors.length,2);assert.equal(f.host.cache.size,0);assert.equal(f.host.retainedBytes,0);assert.equal(f.host.cacheStats().failedRemovals,1);assert.equal(f.host.cacheStats().failures,1);assert.equal(f.host.cacheStats().pendingEntries,0);assert.equal(f.host.cacheStats().pinnedRequests,0);for(const r of f.host.history){assert.equal(r.requests.size,0);assert.equal(r.acked,false);}assert.throws(()=>f.host.drop({space:1}),/before guest\/native drain/);}finally{f.host.close();globalThis.FexLinuxThread=old;}
});

test('parse and compile failures remove charged entries and retain the cumulative byte debit',async()=>{
 const old=globalThis.FexLinuxThread;try{for(const mode of ['parse','compile']){globalThis.FexLinuxThread={parseBrokerStep:()=>{if(mode==='parse')throw Error('parse failed');return{status:0,code:Uint8Array.of(255)};}};const f=fixture(async()=>({arrayBuffer:async()=>new ArrayBuffer(96)})),d=spec();try{f.host.spawn(d);await tick();f.workers[0].onmessage({data:{op:'unit-request',id:1,space:1,rip:4096n}});for(let n=0;n<100&&!f.errors.length;n++)await tick();assert.equal(f.errors.length,1);assert.equal(f.host.cache.size,0);assert.equal(f.host.retainedBytes,0);assert.equal(f.host.cacheBytes,96);assert.equal(f.host.cacheStats().pendingEntries,0);assert.equal(f.host.cacheStats().pinnedRequests,0);assert.equal(f.host.cacheStats().failedRemovals,1);}finally{f.host.close();}}}finally{globalThis.FexLinuxThread=old;}
});

test('close leaves pending/pinned accounting visible and late fetches never parse, compile or reinsert',async()=>{
 const old=globalThis.FexLinuxThread;let parses=0,release;globalThis.FexLinuxThread={parseBrokerStep:()=>{parses++;throw Error('late parse');}};const held=new Promise(r=>{release=r;}),f=fixture(async()=>({arrayBuffer:()=>held})),d=spec();
 try{f.host.spawn(d);await tick();f.workers[0].onmessage({data:{op:'unit-request',id:1,space:1,rip:4096n}});await tick();f.host.close();assert.equal(f.host.cache.size,0);assert.equal(f.host.cacheStats().pendingEntries,1);assert.equal(f.host.cacheStats().pinnedRequests,1);release(new ArrayBuffer(96));await tick();assert.equal(parses,0);assert.equal(f.host.cache.size,0);assert.equal(f.host.cacheStats().pendingEntries,0);assert.equal(f.host.cacheStats().pinnedRequests,0);assert.equal(f.host.cacheBytes,96);assert.equal(f.errors.length,0);assert.equal(f.workers[0].messages.filter(m=>m.op==='unit-reply').length,0);}finally{f.host.close();globalThis.FexLinuxThread=old;}
});

test('synchronous get reentry shares the published promise and charges one response',async()=>{
 const old=globalThis.FexLinuxThread;globalThis.FexLinuxThread={parseBrokerStep:()=>({status:2,code:new Uint8Array(0)})};let f,second,fetches=0;
 f=fixture(()=>{fetches++;const shared=f.host.translation(1,4096n);assert(shared.promise instanceof Promise);assert.equal(f.host.cacheStats().pendingEntries,1);second=shared.promise.finally(()=>f.host.unpin(shared));return Promise.resolve({arrayBuffer:async()=>new ArrayBuffer(96)});});
 try{const entry=f.host.translation(1,4096n);await entry.promise;f.host.unpin(entry);await second;const s=f.host.cacheStats();assert.equal(fetches,1);assert.equal(s.fetches,1);assert.equal(s.hits,1);assert.equal(s.pendingEntries,0);assert.equal(s.pinnedEntries,0);assert.equal(s.pinnedRequests,0);assert.equal(s.receivedBytes,96);assert.equal(s.retainedBytes,96);f.host.close();assert.equal(f.host.retainedBytes,0);}finally{f.host.close();globalThis.FexLinuxThread=old;}
});

test('closing before the fetch microtask cancels work and drains reservations without a response',async()=>{
 let fetches=0;const f=fixture(()=>{fetches++;throw Error('must not fetch');}),d=spec();f.host.spawn(d);await tick();f.workers[0].onmessage({data:{op:'unit-request',id:1,space:1,rip:4096n}});f.host.close();assert.equal(f.host.cacheStats().pendingEntries,1);await tick();const s=f.host.cacheStats();assert.equal(fetches,0);assert.equal(s.fetches,0);assert.equal(s.receivedBytes,0);assert.equal(s.retainedBytes,0);assert.equal(s.pendingEntries,0);assert.equal(s.pinnedRequests,0);assert.equal(f.errors.length,0);
});

test('close during compile retains charged pinned bytes until the waiter drains',async()=>{
 const old=globalThis.FexLinuxThread,compile=WebAssembly.compile;let release;const held=new Promise(r=>{release=r;});globalThis.FexLinuxThread={parseBrokerStep:()=>({status:0,code:new Uint8Array(8)})};WebAssembly.compile=()=>held;
 const f=fixture(async()=>({arrayBuffer:async()=>new ArrayBuffer(104)})),d=spec();try{f.host.spawn(d);await tick();f.workers[0].onmessage({data:{op:'unit-request',id:1,space:1,rip:4096n}});await tick();assert.equal(f.host.retainedBytes,104);f.host.close();assert.equal(f.host.cache.size,0);assert.equal(f.host.retainedBytes,104);assert.equal(f.host.cacheStats().pendingEntries,1);assert.equal(f.host.cacheStats().pinnedRequests,1);release({compiled:true});await tick();assert.equal(f.host.retainedBytes,0);assert.equal(f.host.cacheStats().pendingEntries,0);assert.equal(f.host.cacheStats().pinnedRequests,0);assert.equal(f.host.cacheStats().compiled,1);assert.equal(f.errors.length,0);}finally{f.host.close();WebAssembly.compile=compile;globalThis.FexLinuxThread=old;}
});

test('delivery failure still unpins without fabricating a completion receipt',async()=>{
 const old=globalThis.FexLinuxThread;globalThis.FexLinuxThread={parseBrokerStep:()=>({status:2,code:new Uint8Array(0)})};const f=fixture(async()=>({arrayBuffer:async()=>new ArrayBuffer(96)})),d=spec();try{f.host.spawn(d);await tick();f.workers[0].postMessage=()=>{throw Error('clone failed');};f.workers[0].onmessage({data:{op:'unit-request',id:1,space:1,rip:4096n}});await tick();assert.equal(f.host.cacheStats().pinnedRequests,0);assert.equal(f.host.cacheStats().pendingEntries,0);assert.equal(f.host.history[0].requests.size,0);assert.equal(f.host.history[0].acked,false);assert.match(f.errors[0].message,/clone failed/);}finally{f.host.close();globalThis.FexLinuxThread=old;}
});

test('namespace retirement frees only its own settled payload and cannot refetch retired keys',async()=>{
 const old=globalThis.FexLinuxThread;globalThis.FexLinuxThread={parseBrokerStep:()=>({status:2,code:new Uint8Array(0)})};let fetches=0;const f=fixture(async()=>{fetches++;return{ok:true,arrayBuffer:async()=>new ArrayBuffer(96)};}),a=spec(),b={...spec(1),space:2};try{f.host.spawn(a);f.host.spawn(b);await tick();for(let n=0;n<2;n++){f.workers[n].onmessage({data:{op:'unit-request',id:1,space:n+1,rip:4096n}});await tick();}assert.equal(f.host.retainedBytes,192);result(f.workers[0],a);f.host.drop({space:1});await Promise.all(f.host.drops);assert.equal(f.host.retainedBytes,96);assert(f.host.cache.has('2:4096'));const before=fetches;assert.throws(()=>f.host.translation(1,4096n),/retired/);assert.equal(fetches,before);result(f.workers[1],b);f.host.drop({space:2});await Promise.all(f.host.drops);assert.equal(f.host.retainedBytes,0);}finally{f.host.close();globalThis.FexLinuxThread=old;}
});

test('resident pressure refuses to evict a pinned compile and failed old promises cannot erase replacement entries',async()=>{
 const old=globalThis.FexLinuxThread,compile=WebAssembly.compile;let release;const held=new Promise(r=>{release=r;});globalThis.FexLinuxThread={parseBrokerStep:()=>({status:0,code:new Uint8Array(8)})};WebAssembly.compile=()=>held;
 const f=fixture(async()=>({arrayBuffer:async()=>new ArrayBuffer(96)}),{maximumResidentBytes:96}),d=spec();try{f.host.spawn(d);await tick();const w=f.workers[0];w.onmessage({data:{op:'unit-request',id:1,space:1,rip:4096n}});await tick();w.onmessage({data:{op:'unit-request',id:2,space:1,rip:4097n}});await tick();assert.match(f.errors[0].message,/resident translation byte limit.*pending or pinned/);assert.equal(f.host.cacheStats().evictions,0);assert.equal(f.host.retainedBytes,96);assert(f.host.cache.has('1:4096'));release({compiled:true});await tick();assert.equal(f.host.cacheStats().pinnedRequests,0);assert.equal(f.host.cacheStats().pendingEntries,0);}finally{f.host.close();WebAssembly.compile=compile;globalThis.FexLinuxThread=old;}
 const previous=globalThis.FexLinuxThread;let reject,requests=0;const failure=new Promise((_r,j)=>{reject=j;});globalThis.FexLinuxThread={parseBrokerStep:()=>({status:2,code:new Uint8Array(0)})};const g=fixture(async()=>({arrayBuffer:()=>++requests===1?failure:Promise.resolve(new ArrayBuffer(96))}));try{
  const first=g.host.translation(1,4096n),observed=first.promise.catch(e=>e);await tick();g.host.forget(first,'close');const second=g.host.translation(1,4096n);await second.promise;g.host.unpin(second);reject(Error('old failed'));await observed;g.host.unpin(first);assert.equal(g.host.cache.get('1:4096'),second);assert.equal(g.host.cache.size,1);assert.equal(g.host.retainedBytes,96);assert.equal(g.host.cacheStats().pendingEntries,0);assert.equal(g.host.cacheStats().pinnedRequests,0);
 }finally{g.host.close();globalThis.FexLinuxThread=previous;}
});
