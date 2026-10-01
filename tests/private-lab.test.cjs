'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const source = fs.readFileSync('addon/iridium/Web/lab.js', 'utf8');
function fixture(options = {}) {
  const records = [], requests = [];
  const kernels = [{name:'one',entry:1,n:100,chk:42},{name:'two',entry:2,n:200,chk:99}];
  const box = {textContent:''};
  const context = vm.createContext({URL, AbortController, setTimeout, clearTimeout, Uint8Array, performance,
    location: { href: 'http://127.0.0.1:1234/secret/index.html', origin:'http://127.0.0.1:1234'},
    document: {getElementById() {return box;}}, isSecureContext: true, crossOriginIsolated: true,
    webkit: {messageHandlers: {betterjitLab: {postMessage(s) {records.push(JSON.parse(s));}}}},
    WebAssembly: {Suspending: options.noJSPI ? undefined : function(){}, promising(){},
      Memory: class {constructor() {this.buffer = new ArrayBuffer(32);}}},
    fetch: async (url) => {requests.push(url); return {ok:true,
      json: async()=>({kernels}), arrayBuffer: async()=>new ArrayBuffer(0)};},
    FexLive: {async connect(base, get) {
      if (options.foreignFetch) await get('https://example.invalid/private');
      return { cfg: {memPages:options.badMemory ? 9000 : 1,imageLow:0}, stats:{}, runtime(){return {};},
        async call(_,__,entry) {if(options.nativeError) throw new Error('native translation failed');
          return kernels.find(k=>k.entry===entry).chk + (options.mismatch?1:0);},
        async translatorStats() {return {units:2};}};
    }},
  });
  vm.runInContext('window = globalThis;', context);
  vm.runInContext(source, context);
  return {run:context.BetterJITLab.run, records, requests};
}
test('all expected live checks must match before success', async()=>{
  const f=fixture(), r=await f.run('fex');
  assert.equal(r.passed,true);assert.equal(r.checked,2);
  assert(f.requests.every(p=>p.startsWith('http://127.0.0.1:1234/secret/')));
});
for(const options of [{mismatch:true},{noJSPI:true},{nativeError:true},{foreignFetch:true},{badMemory:true}]){
  test(`unsupported or failed execution cannot pass: ${JSON.stringify(options)}`,async()=>{
    const f=fixture(options), r=await f.run('fexw64');assert.equal(r.passed,false);
    assert(f.records.some(r=>r.suite==='error'||r.failures>0));
  });
}
test('only bundled fixture names are accepted',async()=>{
  const f=fixture();await assert.rejects(f.run('../game'));assert.equal(f.requests.length,0);
});
