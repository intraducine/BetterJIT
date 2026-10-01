// SPDX-License-Identifier: GPL-3.0-or-later
// Validate the actual Swift-emitted guest module with synchronous JS imports.
// This is an encoding/byte-protocol test, not JSPI, Swift-service or iOS evidence.
const assert = require('node:assert/strict');
const {execFileSync} = require('node:child_process');
const bytes = Buffer.from(execFileSync('.build/fexhost-tests',['--wasm'],{encoding:'utf8'}).trim(),'base64');
const moduleBytes = new WebAssembly.Module(bytes);
for (const length of [64,4096]) {
  const memory = new WebAssembly.Memory({initial:16,maximum:1024});
  const input = Uint8Array.from({length},(_,i)=>(i*31+7)&255);
  new Uint8Array(memory.buffer).set(input,0);
  let calls=0;
  const instance = new WebAssembly.Instance(moduleBytes,{betterjit:{memory,call(service,offset,count,reply,capacity){
    calls++; assert.equal(service,1);assert.equal(offset,0);assert.equal(count,length);assert.equal(reply,65536);assert.equal(capacity,length);
    new Uint8Array(memory.buffer,reply,count).set(input.map(x=>x^0x5a));return count;
  }}});
  assert.equal(instance.exports.run(length),length);assert.equal(calls,1);
  assert.deepEqual(new Uint8Array(memory.buffer,65536,length),input.map(x=>x^0x5a));
}
console.log('PASS: 2 Swift-emitted Wasm byte-service fixtures; synchronous JS test imports, not device results.');
