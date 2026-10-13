// SPDX-License-Identifier: GPL-3.0-or-later
// Exercise promoted kernel lifecycle under an injected engine allocation limit.
// This is failure-path verification, not guest/device execution evidence.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
function runtime() {
 let clock=0,remaining=10,allocations=0,waits=0;
 const context=vm.createContext({self:{},performance:{now:()=>clock},SharedArrayBuffer,Int32Array,Uint8Array,DataView,Map,Set,
  RangeError,WebAssembly:{Memory:class {constructor(d){allocations++;if(remaining--<=0)throw new RangeError('engine memory reservation limit');return new WebAssembly.Memory(d);}}},
  Atomics:{...Atomics,wait:(_a,_i,_v,ms)=>{clock+=ms;waits++;return 'timed-out';}}});
 vm.runInContext(fs.readFileSync(new URL('../../Sources/BetterJITLinux/Resources/linux/web/linux-kernel.js',import.meta.url),'utf8'),context);
 const req=context.self.LinuxBundle.require;
 return {kernel:req('./kernel.js'),sys:req('./syscalls.js').sys,abi:req('./abi.js'),
  setRemaining:n=>{remaining=n;},stats:()=>({clock,allocations,waits})};
}
test('fork allocation failure leaves no child, descriptor reference or waiter-visible ghost',()=>{
 const r=runtime(),{Mm,Process,Kernel,KError}=r.kernel;
 const k={nextPid:101,procs:new Map(),cfg:{ctx:0,gregsOff:0},cpu:Kernel.prototype.cpu,allocSlot:()=>0};
 const parent=new Process(k,100,1);parent.image={};parent.mm=new Mm(32,1);
 let references=1;parent.fds.set(3,{file:{ref(){references++;return this;}}});
 k.procs.set(100,parent);r.setRemaining(0);
 const call=()=>r.sys[r.abi.SYS.fork].call(k,{proc:parent,tb:0});
 for(let i=0;i<2;i++)assert.throws(call,error=>error instanceof KError&&error.code===r.abi.E.NOMEM);
 assert.equal(k.procs.size,1);assert.equal(parent.children.size,0);assert.equal(references,1);
});
test('allocation pressure waits for retired memory quarantine before reusing the existing reservation',()=>{
 const r=runtime(),{MemoryPool}=r.kernel,pool=new MemoryPool();
 const e=pool.take(32,1);pool.give(e.mem,[],32);r.setRemaining(0);
 const reused=pool.take(32,1);
 assert.equal(reused.mem,e.mem);assert.equal(r.stats().waits,1);assert.equal(r.stats().clock,1500);
 assert.equal(r.stats().allocations,2);assert.equal(pool.free.length,0);
});
test('capacity failure with no retired candidate returns ENOMEM without an unbounded wait',()=>{
 const r=runtime(),{MemoryPool,KError}=r.kernel;r.setRemaining(0);
 assert.throws(()=>new MemoryPool().take(32,1),e=>e instanceof KError&&e.code===r.abi.E.NOMEM);
 assert.equal(r.stats().waits,0);
});
