// SPDX-License-Identifier: GPL-3.0-or-later
// Decode diagnostic metadata only; live FEX fault inputs validate the producer.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import {createRequire} from 'node:module';
const {functionNames,unitMetadata,diagnosticCapture}=createRequire(import.meta.url)('./linux-host/wasm-names.cjs');
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
test('diagnostic manifests preserve signed 64-bit relocation displacement without JSON BigInt failure',()=>{
 const data=JSON.parse(JSON.stringify(unitMetadata(0x400078,{slot:5,reloc:{d:-0x100000004n,s:[2,3]}})));
 assert.equal(data.rip,'0x400078');assert.equal(data.relocation.displacementDecimal,'-4294967300');
 assert.deepEqual(data.relocation.slots,[2,3]);assert.equal(data.slot,5);
});
test('diagnostic capture deduplicates repeated requests and stops retaining bytes without aborting execution',()=>{
 const capture=diagnosticCapture({maxBytes:6,maxUnits:4});
 const unit={slot:5,code:Uint8Array.of(0,1,2),reloc:{d:0n,s:[]}};
 const first=capture.keep(1,0x4000,unit);assert.ok(first);
 for(let i=0;i<100;i++)assert.equal(capture.keep(1,0x4000,unit),null);
 assert.equal(capture.statistics().bytes,3);
 const changed=capture.keep(1,0x4000,{...unit,code:Uint8Array.of(0,1,3)});
 assert.ok(changed);assert.notEqual(changed.stem,first.stem);
 assert.equal(capture.keep(2,0x4000,unit),null);
 assert.deepEqual(capture.statistics(),{bytes:6,units:2,duplicateRequests:100,omittedRequests:1,truncated:true,maxBytes:6,maxUnits:4});
 assert.deepEqual([...unit.code],[0,1,2]);
 const count=diagnosticCapture({maxBytes:100,maxUnits:1});
 assert.ok(count.keep(1,0x4000,unit));assert.equal(count.keep(1,0x5000,unit),null);
 assert.equal(count.statistics().units,1);assert.equal(count.statistics().truncated,true);
});
test('bulk copy trace retains both operands and full length, and identifies the actual out-of-bounds operand',()=>{
 const mem={buffer:new ArrayBuffer(4096)},dv=new DataView(mem.buffer),at=0x80;
 for(const [off,value] of [[0,0x100000200n],[8,0x200n],[16,(51n<<32n)|1n],[40,0x200n],
  [48,0x100000010n],[56,0x1fffff000n],[64,0xfffff000n],[72,2n]])dv.setBigUint64(at+off,value,true);
 const fault=FexLinuxThread.readMemoryTrace(mem,0,{memoryTraceAddr:at,memoryTraceVersion:2});
 assert.equal(fault.accessKind,'copy');assert.equal(fault.byteLength,'0x100000010');
 assert.equal(fault.wasmByteLength,'0x10');assert.equal(fault.sourceGuestAddress,'0x1fffff000');
 assert.deepEqual(fault.outOfBoundsOperands,['source']);assert.equal(fault.boundsConfirmed,true);
 dv.setBigUint64(at+64,512n,true);
 assert.equal(FexLinuxThread.readMemoryTrace(mem,0,{memoryTraceAddr:at,memoryTraceVersion:2}).boundsConfirmed,false);
});
test('a valid last scalar access is not reported as the proved trap operand',()=>{
 const mem={buffer:new ArrayBuffer(4096)},dv=new DataView(mem.buffer),at=0x80;
 dv.setBigUint64(at,512n,true);dv.setBigUint64(at+16,8n,true);dv.setBigUint64(at+40,512n,true);
 const trace=FexLinuxThread.readMemoryTrace(mem,0,{memoryTraceAddr:at});
 assert.equal(trace.boundsConfirmed,false);assert.deepEqual(trace.outOfBoundsOperands,[]);
});
