import test from 'node:test';
import assert from 'node:assert/strict';
import {Engine, encodeBytes, decodeBytes, capabilities, validateMemoryOwnership} from '../../Sources/BetterJITWebKit/Resources/engine.mjs';
import {moduleBytes, limits} from './fixtures.mjs';
async function start(opts={}, extra={}) {const e=new Engine(opts);await e.command('configure',{limits:{...limits,...extra},services:['host.1','fex']});return e;}
async function load(e, bytes, module='test') {return e.command('load',{module,bytes:encodeBytes(bytes)});}
const call = (e, args=[{type:'i32',value:'20'},{type:'i32',value:'22'}], results=['i32']) => e.command('invoke',{module:'test',export:'run',arguments:args,results});
test('real Wasm compile, invoke, unloading and session isolation', async()=>{
 const a=await start(),b=await start();await load(a,moduleBytes());assert.deepEqual(await call(a),[{type:'i32',value:'42'}]);
 await assert.rejects(()=>call(b),{code:'unknownExport'});
 await assert.rejects(()=>load(a,moduleBytes()),{code:'duplicateModule'});
 await a.command('unload',{module:'test'});await assert.rejects(()=>call(a),{code:'unknownExport'});a.close();b.close();
 await assert.rejects(()=>load(a,moduleBytes()),{code:'closed'});
});
test('i64 values are exact beyond JavaScript numeric precision',async()=>{
 const e=await start();await load(e,moduleBytes({params:[0x7e],results:[0x7e],code:[0x20,0]}));
 for(const value of ['9223372036854775807','-9223372036854775808','9007199254740993']) assert.deepEqual(await call(e,[{type:'i64',value}],['i64']),[{type:'i64',value}]);
 for(const value of ['9223372036854775808','01','+2']) await assert.rejects(()=>call(e,[{type:'i64',value}],['i64']),{code:'invalidValue'});e.close();
});
test('shared session memory is bounded and write/read roundtrips',async()=>{
 const e=await start();await load(e,moduleBytes({params:[0x7f],results:[0x7f],code:[0x20,0,0x28,2,0],memory:true}));
 await e.command('write',{offset:16,bytes:encodeBytes(new Uint8Array([42,0,0,0]))});
 assert.deepEqual(await call(e,[{type:'i32',value:'16'}]),[{type:'i32',value:'42'}]);
 assert.equal(await e.command('read',{offset:16,count:4}),'KgAAAA==');
 for(const [offset,count] of [[-1,1],[0xffffffff,2],[e.memory.buffer.byteLength,1],[0,limits.maximumTransferBytes+1]]) await assert.rejects(()=>e.command('read',{offset,count}),{code:'bounds'});e.close();
});
test('private memories and unknown imports are rejected',async()=>{
 const e=await start();await assert.rejects(()=>load(e,moduleBytes({privateMemory:true})),{code:'memoryOwnership'});
 await assert.rejects(()=>load(e,moduleBytes({call:true,badImport:true})),{code:'importDenied'});e.close();
});
test('malformed sections, oversized messages and module counts fail closed',async()=>{
 assert.throws(()=>validateMemoryOwnership(new Uint8Array([0,97,115,109,1,0,0,0,1,255,255,255,255,255])),{code:'invalidModule'});
 for(const value of ['!','AQI=garbage','A===']) assert.throws(()=>decodeBytes(value,100));
 const e=await start({}, {maximumModules:1});await load(e,moduleBytes());await assert.rejects(()=>load(e,moduleBytes(),'two'),{code:'moduleLimit'});e.close();
});
test('maximum transfer payload handles base64 and typed bytes without argument or regex stack overflow',()=>{
 const data=new Uint8Array(1024*1024).fill(127);
 assert.deepEqual(decodeBytes(encodeBytes(data),data.length),data);
 assert.equal(decodeBytes(data,data.length),data);
});
test('unknown commands, duplicate configure and invalid config reject',async()=>{
 const e=await start();await assert.rejects(()=>e.command('shell'),{code:'unknownOperation'});
 await assert.rejects(()=>e.command('configure',{limits,services:[]}),{code:'invalidState'});e.close();
 for(const l of [{maximumMemoryPages:65537},{timeoutSeconds:NaN},{maximumModuleBytes:-1}]) await assert.rejects(()=>start({},l),{code:'invalidConfiguration'});
});
test('native byte service uses JSPI or explicitly reports unsupported',async()=>{
 const e=await start({hostCall:async(name,data)=>{assert.equal(name,'host.1');assert.equal(data,'AQID');return 'BAUG';}});
 const bytes=moduleBytes({params:[],results:[0x7f],memory:true,call:true,code:[0x41,1,0x41,0,0x41,3,0x41,8,0x41,4,0x10,0]});
 if(!capabilities().jspi) {await assert.rejects(()=>load(e,bytes),{code:'unsupported'});e.close();return;}
 await load(e,bytes);await e.command('write',{offset:0,bytes:'AQID'});assert.deepEqual(await call(e,[]),[{type:'i32',value:'3'}]);assert.equal(await e.command('read',{offset:8,count:3}),'BAUG');e.close();
});
test('guest cannot access native services not in its allowlist',async(t)=>{
 if(!capabilities().jspi){t.skip('This Node build has no current JSPI API; covered by browser-sdk.py');return;}
 const e=new Engine({hostCall:async()=>{assert.fail('denied service entered native code');}});await e.command('configure',{limits,services:[]});
 await load(e,moduleBytes({params:[],results:[0x7f],memory:true,call:true,code:[0x41,1,0x41,0,0x41,0,0x41,0,0x41,0,0x10,0]}));
 await assert.rejects(()=>call(e,[]),{code:'serviceDenied'});e.close();
});
