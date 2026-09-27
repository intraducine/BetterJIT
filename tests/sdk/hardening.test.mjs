// SPDX-License-Identifier: GPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine, encodeBytes, decodeBytes, validateLimits } from '../../Sources/BetterJITWebKit/Resources/engine.mjs';
import { inspectModule, Fault } from '../../Sources/BetterJITWebKit/Resources/wasm-module.mjs';
import { moduleBytes, limits, leb } from './fixtures.mjs';
const val = (n,type='i32') => ({type,value:String(n)});
const call = (n=20,m=22) => ({module:'m',export:'run',arguments:[val(n),val(m)],results:['i32']});
async function start(extra={}) { const e = new Engine(); await e.command('configure',{limits:{...limits,...extra},services:[]}); return e; }
async function load(e,b=moduleBytes(),module='m') { return e.command('load',{module,bytes:encodeBytes(b)}); }
const header = [0,97,115,109,1,0,0,0];
const table = (maximum, bounded=true) => new Uint8Array([...header,4,...leb(bounded?5:4),1,0x70,bounded?1:0,0,...(bounded?[maximum]:[])]);
test('typed signature mismatch is rejected before guest side effects', async()=>{
 const e=await start(); await load(e,moduleBytes({params:[0x7f],code:[0x41,0,0x20,0,0x36,2,0,0x20,0],memory:true}));
 await assert.rejects(()=>e.command('invoke',{...call(),arguments:[val(99,'f64')]}),{code:'signature'});
 assert.equal(await e.command('read',{offset:0,count:4}),'AAAAAA=='); e.close();
});
test('result signature mismatch is rejected before execution', async()=>{
 const e=await start(); await load(e,moduleBytes({params:[0x7f],code:[0x41,0,0x20,0,0x36,2,0,0x20,0],memory:true}));
 await assert.rejects(()=>e.command('invoke',{...call(),arguments:[val(99)],results:['f64']}),{code:'signature'});
 assert.equal(await e.command('read',{offset:0,count:4}),'AAAAAA=='); e.close();
});
test('batches validate every call first and execute in order', async()=>{
 const e=await start(); await load(e);
 assert.deepEqual(await e.command('invokeBatch',{calls:[call(1,2),call(3,4)]}),[[val(3)],[val(7)]]);
 const count=(await e.command('statistics')).invocations;
 await assert.rejects(()=>e.command('invokeBatch',{calls:[call(),{...call(),export:'missing'}]}),{code:'unknownExport'});
 assert.equal((await e.command('statistics')).invocations,count); e.close();
});
test('batch size and empty batches are bounded',async()=>{
 const e=await start({maximumBatchOperations:1}); await load(e);
 for(const calls of [[],[call(),call()]]) await assert.rejects(()=>e.command('invokeBatch',{calls}),{code:'invalidCall'});e.close();
});
test('unload returns live budget but does not reset lifetime compilation budget',async()=>{
 const b=moduleBytes(),n=b.length,e=await start({maximumModuleBytes:n,maximumResidentModuleBytes:2*n,maximumCumulativeModuleBytes:3*n});
 await load(e,b,'a');await load(e,b,'b');await assert.rejects(()=>load(e,b,'c'),{code:'codeBudget'});
 await e.command('unload',{module:'a'});await load(e,b,'c');await e.command('unload',{module:'b'});
 await assert.rejects(()=>load(e,b,'d'),{code:'codeBudget'});
 const s=await e.command('statistics');assert.equal(s.residentModuleBytes,n);assert.equal(s.cumulativeModuleBytes,3*n);e.close();
});
test('unbounded and aggregate tables are rejected before allocation',async()=>{
 const e=await start({maximumTableElements:6});
 await assert.rejects(()=>load(e,table(0,false)),{code:'tableLimit'});
 await load(e,table(4),'a');await assert.rejects(()=>load(e,table(4),'b'),{code:'tableLimit'});
 await e.command('unload',{module:'a'});await load(e,table(4),'b');e.close();
});
test('start sections are rejected before instantiation',()=>{
 assert.throws(()=>inspectModule(new Uint8Array([...header,8,1,0])),{code:'startDenied'});
});
test('sections cannot consume bytes from the following section',()=>{
 assert.throws(()=>inspectModule(new Uint8Array([...header,1,1,1,0x60,0,0])),{code:'invalidModule'});
 assert.throws(()=>inspectModule(new Uint8Array([...header,5,1,0x80,0])),{code:'invalidModule'});
});
test('canonical base64 and float boundaries agree across hosts',async()=>{
 for(const text of ['AB==','AAF=','A===','AQI=\n']) assert.throws(()=>decodeBytes(text,16));
 const e=await start();await load(e,moduleBytes({params:[0x7c],results:[0x7c],code:[0x20,0]}));
 for(const value of ['0x10',' 1','1\n','01','1e999']) await assert.rejects(()=>e.command('invoke',{module:'m',export:'run',arguments:[{type:'f64',value}],results:['f64']}),{code:'invalidValue'});
 const out=await e.command('invoke',{module:'m',export:'run',arguments:[{type:'f64',value:'-0.0'}],results:['f64']});
 assert.equal(out[0].value,'-0.0');e.close();
});
test('direct engine calls serialize and a queue slot is free when its promise resolves',async()=>{
 const e=await start({maximumPendingRequests:1});const first=load(e);
 await assert.rejects(()=>load(e,moduleBytes(),'second'),{code:'backpressure'});await first;
 assert.deepEqual(await e.command('invoke',call()),[val(42)]);e.close();
});
test('guest trap terminates session rather than reusing uncertain state',async()=>{
 const e=await start();await load(e,moduleBytes({params:[],results:[],code:[0]}));
 await assert.rejects(()=>e.command('invoke',{module:'m',export:'run',arguments:[],results:[]}),{code:'wasmTrap'});
 await assert.rejects(()=>e.command('statistics'),{code:'closed'});
});
test('decoded added resource limits validate without fallback',()=>{
 for(const bad of [{maximumPendingBytes:0},{maximumCumulativeModuleBytes:1},{maximumTableElements:NaN},{maximumBatchOperations:129}])
  assert.throws(()=>validateLimits({...limits,...bad}),{code:'invalidConfiguration'});
});
test('seeded malformed-module preflight corpus is bounded and produces typed failures',()=>{
 let seed=0x13579;
 for(let i=0;i<3000;i++) {
  const b=moduleBytes();
  seed=(Math.imul(seed,1664525)+1013904223)>>>0; const p=8+(seed%(b.length-8));
  b[p]=(seed>>>8)&255;
  try{inspectModule(b);}catch(error){assert.ok(error instanceof Fault,`${i}: ${error}`);}
 }
});

test('service names cannot contain a trailing newline', async () => {
  const e = new Engine();
  await assert.rejects(() => e.command('configure', {limits, services: ['host.1\n']}), {code:'invalidConfiguration'});
  e.close();
});
