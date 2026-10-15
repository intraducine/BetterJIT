// SPDX-License-Identifier: GPL-3.0-or-later
// Ownership protocol tests only. Real FEX/browser execution is separate.
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';
vm.runInThisContext(fs.readFileSync(new URL('../../Sources/BetterJITLinux/Resources/linux/web/sparse_process_host.js',import.meta.url),'utf8'));
const tick=()=>new Promise(r=>setImmediate(r));
function spec(slot=0){const q=new SharedArrayBuffer(16);new Int32Array(q)[1]=1;new BigUint64Array(q)[1]=BigInt(slot+1);const ksab=new SharedArrayBuffer(4096);Atomics.store(new Int32Array(ksab),((256+slot*128)>>2)+26,1);return{pid:100,tid:100,slot,lease:BigInt(slot+1),space:1,ksab,quiescence:q,stopControl:new SharedArrayBuffer(4)};}
function fixture(get=async()=>({ok:true,json:async()=>({})})){const errors=[],workers=[];const host=new BetterJITSparseProcessHost({get,cfg:{},onFailure:e=>errors.push(e),workerFactory:()=>{const w={messages:[],terminated:0,postMessage:m=>w.messages.push(m),terminate:()=>w.terminated++};workers.push(w);return w;}});return{host,errors,workers};}
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
