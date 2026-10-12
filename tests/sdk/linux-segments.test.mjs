// SPDX-License-Identifier: GPL-3.0-or-later
// Actual promoted syscall handlers and CPU backing memory, no guest execution claim.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
globalThis.self=globalThis;
vm.runInThisContext(fs.readFileSync(new URL('../../Sources/BetterJITLinux/Resources/linux/web/linux-kernel.js',import.meta.url),'utf8'));
const {Kernel}=LinuxBundle.require('./kernel.js'),{sys}=LinuxBundle.require('./syscalls.js'),{SYS}=LinuxBundle.require('./abi.js');
test('arch_prctl returns independent full-width FS and GS bases, including zero after reset',()=>{
 const mm={dv:new DataView(new ArrayBuffer(1024))},t={tb:0,proc:{mm}};
 const k={cfg:{ctx:0,gregsOff:0,fsOff:128,gsOff:136},cpu:Kernel.prototype.cpu};
 const call=(op,value)=>sys[SYS.arch_prctl].call(k,t,BigInt(op),BigInt(value));
 assert.equal(call(0x1002,0x1122334455n),0);assert.equal(call(0x1001,0x123456789an),0);
 assert.equal(call(0x1003,256),0);assert.equal(call(0x1004,264),0);
 assert.equal(mm.dv.getBigUint64(256,true),0x1122334455n);
 assert.equal(mm.dv.getBigUint64(264,true),0x123456789an);
 assert.equal(call(0x1001,0),0);assert.equal(call(0x1004,264),0);assert.equal(mm.dv.getBigUint64(264,true),0n);
 assert.equal(call(0x1003,256),0);assert.equal(mm.dv.getBigUint64(256,true),0x1122334455n);
});
