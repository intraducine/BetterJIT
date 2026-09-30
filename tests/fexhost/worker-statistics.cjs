// SPDX-License-Identifier: GPL-3.0-or-later
// Real worker routing with a fixture engine; not a native-FEX execution test.
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const code=fs.readFileSync('Sources/BetterJITWebKit/Resources/worker.mjs','utf8').replace(/^import .*?;\n/gm,'');
class Fault extends Error {constructor(code,message){super(message);this.code=code;}}
const replies=[],caps=()=>({protocolVersion:1,extensions:['statistics']});
let backend;
class Engine {
 constructor(){backend=this;this.fex=null;this.limits={maximumPendingRequests:16,maximumPendingBytes:65536,timeoutSeconds:1};}
 async command(op){if(op==='configure')return caps();if(op==='statistics')return {loadedModules:0};throw new Fault('test','expected failure');}
 close(){}
}
const context=vm.createContext({Engine,Fault,capabilities:caps,TextEncoder,setTimeout,clearTimeout,postMessage:m=>replies.push(JSON.parse(JSON.stringify(m))),self:{}});
vm.runInContext(code,context);
const send=async(id,op)=>{context.self.onmessage({data:{v:1,session:'fixture',id,kind:'request',operation:op}});await new Promise(r=>setImmediate(r));return replies.find(m=>m.id===id);};
(async()=>{
 const config=await send('1','configure');assert(config.payload.extensions.includes('fex.runtimeStatistics'));
 const plain=await send('2','statistics');assert(!('fex' in plain.payload));
 backend.fex={runtime:{stats:{units:1,regions:0,regionUnits:0,flushes:0}}};
 const before=await send('3','statistics');assert.deepEqual(before.payload.fex,{schema:1,units:1,regions:0,regionUnits:0,flushes:0});
 backend.fex.runtime.stats.regions=1;backend.fex.runtime.stats.regionUnits=1;
 const after=await send('4','statistics');assert.equal(after.payload.fex.regions,1);assert.equal(after.payload.fex.regionUnits,1);
 assert.equal(before.payload.fex.regions,0); // previous report remains an immutable snapshot
 const failure=await send('5','unknown');assert.equal(failure.error.code,'test');
 console.log('PASS: worker statistics negotiation, ordinary-module isolation, before/after snapshots and error routing. Engine is a test fixture.');
})().catch(e=>{console.error(e);process.exitCode=1;});
