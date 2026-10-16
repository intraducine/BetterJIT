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
  for(let i=0;i<maximumUnits;i++)w.onmessage({data:{op:'unit-request',id:i+1,space:1,rip:4096n+BigInt(i)}});
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
