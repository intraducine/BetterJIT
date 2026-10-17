// SPDX-License-Identifier: GPL-3.0-or-later
// Production page transport with browser/worker fixtures, not guest execution.
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';
const source=fs.readFileSync(new URL('../../Sources/BetterJITLinux/Resources/linux/web/sparse_main.js',import.meta.url),'utf8');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function page({paused=false}={}) {
 const workers=[],events=[],listeners=new Map(),views={};let release;
 const configuration=paused?new Promise(resolve=>{release=resolve;}):Promise.resolve();
 for(const id of ['out','stdout','stderr'])views[id]={nodes:[],replacements:0,removedCharacters:0,
  get textContent(){return this.nodes.join('');},
  set textContent(value){this.replacements++;this.removedCharacters+=this.nodes.join('').length;this.nodes=[value];},
  appendChild(node){this.nodes.push(node.textContent);}};
 const abi={version:1,stepVersion:4,coverageVersion:23};
 const context=vm.createContext({URLSearchParams,AbortController,WebAssembly,Uint8Array,TextDecoder,TextEncoder,Map,Promise,
  SharedArrayBuffer,crossOriginIsolated:true,location:{origin:'http://fixture',search:'?argv=%5B%22%2Ftest%2Fcat%22%5D&stdin=1'},
  BetterJITGuestMemoryBroker:{ABI:abi,STEP:{DIVIDE_ERROR:5}},FexLinuxThread:{},
  document:{getElementById:id=>views[id],createTextNode:textContent=>({textContent})},
  addEventListener:(name,fn)=>listeners.set(name,fn),removeEventListener:(name,fn)=>{if(listeners.get(name)===fn)listeners.delete(name);},
  fetch:async(url,options={})=>{
   if(url.endsWith('/events')){events.push(JSON.parse(options.body));return {ok:true};}
   return {ok:true,json:async()=>{await configuration;return {guestMemory:'broker1',memoryABI:1,stepABI:4,coverageVersion:23};},arrayBuffer:async()=>new ArrayBuffer(0)};
  },Worker:class {constructor(name){this.name=name;this.messages=[];this.terminated=0;workers.push(this);}postMessage(m){this.messages.push(m);}terminate(){this.terminated++;}}
 });vm.runInContext(source,context);await tick();
 const stop=context.betterjitClose;
 async function spawn(){const kernel=workers[0];await kernel.onmessage({data:{op:'spawn',spec:{space:1},codes:[]}});await tick();return workers[1];}
 function write(fd,bytes){workers[0].onmessage({data:{op:'output',fd,bytes:Uint8Array.from(bytes)}});}
 async function finish({terminal={status:0,guestExitCode:0},result={status:0,guestExitCode:0}}={}){await spawn();workers[0].onmessage({data:{op:'kernel-result',terminal,steps:1,internalBytes:33*65536,broker:{threads:0},backing:{},stdin:{providedBytes:0,consumedBytes:0,positiveReads:0},workerRetirementAcknowledged:false,retainedUntilSessionTeardown:true}});workers[1].onmessage({data:{op:'thread-result',result}});await tick();await tick();}
 return {context,workers,events,views,listeners,release,stop,write,finish,text:kind=>events.flatMap(x=>x.events).filter(x=>x.kind===kind).map(x=>x.text).join('')};
}
test('sparse page preserves BOM scalars at stream start, write boundaries and split UTF-8',async()=>{
 const p=await page();try{p.write(1,[0xef]);p.write(1,[0xbb,0xbf,65]);p.write(1,new TextEncoder().encode('\ufeffB'));p.write(2,[0xef,0xbb]);p.write(2,[0xbf,0xff,0xe2]);await p.finish();assert.equal(p.text('stdout'),'\ufeffA\ufeffB');assert.equal(p.text('stderr'),'\ufeff\ufffd\ufffd');assert.equal(p.views.stdout.textContent,p.text('stdout'));assert.equal(p.events.at(-1).events.at(-1).kind,'exit');}finally{p.stop();}
});
test('sparse output appends bounded DOM text without replacing every accumulated prefix',async()=>{
 const p=await page();try{for(let i=0;i<64;i++)p.write(1,new TextEncoder().encode('x'.repeat(4096)));await p.finish();assert.equal(p.text('stdout').length,256*1024);assert.equal(p.views.stdout.textContent,p.text('stdout'));assert.equal(p.views.stdout.replacements,0);assert.equal(p.views.stdout.removedCharacters,0);}finally{p.stop();}
});
test('sparse capture keeps a valid four-MiB scalar prefix, reports truncation and preserves exit ordering',async()=>{
 const p=await page();try{for(let i=0;i<64;i++)p.write(1,new TextEncoder().encode('x'.repeat(65536)));p.write(2,new TextEncoder().encode('€'));await p.finish();assert.equal(Buffer.byteLength(p.text('stdout')),4*1024*1024);assert.equal(p.text('stderr'),'');const events=p.events.flatMap(x=>x.events);assert.equal(events.filter(e=>e.kind==='truncated').length,1);assert.equal(events.at(-1).kind,'exit');assert.deepEqual(p.events.map(x=>x.sequence),p.events.map((_,i)=>i));}finally{p.stop();}
});
test('close rejects late startup replies before creating a sparse worker',async()=>{
 const p=await page({paused:true});p.stop();p.release();await tick();await tick();assert.equal(p.workers.length,0);
});
test('sparse close clears callbacks and page ownership once without inventing retirement acknowledgement',async()=>{
 const p=await page();await p.finish();assert.equal(p.workers[0].terminated,0);assert.equal(p.workers[1].terminated,0);p.stop();p.stop();assert(p.workers.every(w=>w.terminated===1&&w.onmessage===null&&w.onerror===null));assert.equal(p.listeners.size,0);assert.equal(p.context.betterjitClose,undefined);
});
test('typed divide-error page completion reports the owned exception without a normal exit event',async()=>{
 for(const forged of [false,true]){const p=await page();try{await p.finish({terminal:{status:5,guestExitCode:null,exception:{kind:'divide-error',vector:0,reason:'zero-divisor',rip:4096n}},result:{status:5,rip:forged?4097n:4096n}});const events=p.events.flatMap(x=>x.events);assert(!events.some(e=>e.kind==='exit'||e.kind==='unsupported'));assert.match(events.at(-1).text,forged?/Incomplete sparse divide-error/:/Guest divide error.*zero-divisor/);assert.equal(p.workers[1].terminated,0);}finally{p.stop();}}
});
