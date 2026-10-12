// SPDX-License-Identifier: GPL-3.0-or-later
// Decode diagnostic metadata only; live FEX fault inputs validate the producer.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import {createRequire} from 'node:module';
const {functionNames}=createRequire(import.meta.url)('./linux-host/wasm-names.cjs');
globalThis.self=globalThis;
vm.runInThisContext(fs.readFileSync(new URL('../../Sources/BetterJITLinux/Resources/linux/thread_core.js',import.meta.url),'utf8'));
test('memory fault metadata retains full address separately from Wasm memarg address and segment bases',()=>{
 const mem={buffer:new ArrayBuffer(4096)},dv=new DataView(mem.buffer),tb=128,at=tb+0x80;
 for(const [off,value] of [[0,0x140003c40n],[8,0x400082n],[16,(123n<<32n)|8n],
  [24,0x20000000n],[32,0x30000000n],[40,0x40003c40n]])dv.setBigUint64(at+off,value,true);
 const fault=FexLinuxThread.readMemoryTrace(mem,tb,{memoryTraceAddr:0x80});
 assert.equal(fault.guestAddress,'0x140003c40');assert.equal(fault.wasmAddress,'0x40003c40');
 assert.equal(fault.fsBase,'0x20000000');assert.equal(fault.gsBase,'0x30000000');assert.equal(fault.width,8);
 assert.equal(fault.operation,123);assert.equal(fault.instructionHex,'');
 assert.equal(FexLinuxThread.readMemoryTrace(mem,tb,{}),null);
 assert.equal(FexLinuxThread.readMemoryTrace(mem,4090,{memoryTraceAddr:0x80}),null);
});
test('fault capture resolves named functions from real Wasm custom sections',()=>{
 const module=new WebAssembly.Module(Uint8Array.from([0,97,115,109,1,0,0,0,0,15,4,110,97,109,101,1,8,1,0,5,117,52,48,48,48]));
 assert.deepEqual(functionNames(module),['u4000']);
});
