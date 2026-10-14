// SPDX-License-Identifier: GPL-3.0-or-later
// Exercise promoted kernel lifecycle under an injected engine allocation limit.
// This is failure-path verification, not guest/device execution evidence.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
function runtime({maximumInitialPages=Infinity}={}) {
 let clock=0,remaining=10,allocations=0,waits=0,growthLimit=Infinity;const descriptors=[];
 const context=vm.createContext({self:{},performance:{now:()=>clock},SharedArrayBuffer,Int32Array,Uint8Array,DataView,Map,Set,
  RangeError,WebAssembly:{Memory:class {constructor(d){allocations++;descriptors.push(d);if(remaining--<=0||d.initial>maximumInitialPages)throw new RangeError('engine memory reservation limit');const m=new WebAssembly.Memory(d),grow=m.grow.bind(m);m.grow=n=>{if(m.buffer.byteLength/65536+n>growthLimit)throw new RangeError('engine memory growth limit');return grow(n);};return m;}}},
  Atomics:{...Atomics,wait:(_a,_i,_v,ms)=>{clock+=ms;waits++;return 'timed-out';}}});
 vm.runInContext(fs.readFileSync(new URL('../../Sources/BetterJITLinux/Resources/linux/web/linux-kernel.js',import.meta.url),'utf8'),context);
 const req=context.self.LinuxBundle.require;
 return {kernel:req('./kernel.js'),sys:req('./syscalls.js').sys,abi:req('./abi.js'),
  setRemaining:n=>{remaining=n;},setGrowthLimit:n=>{growthLimit=n;},setClock:n=>{clock=n;},stats:()=>({clock,allocations,waits,descriptors})};
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
test('fork stages allocation and copies only inherited mappings without aliasing or raising maximum',()=>{
 const r=runtime({maximumInitialPages:16}),{Mm}=r.kernel,owner={},other={},childOwner={};
 const parent=new Mm(1024,1);parent.ensure(512*65536);
 parent.vmas=[{start:65536,end:3*65536,owner},{start:8*65536,end:9*65536,owner:other}];
 parent.u8.set([1,2,3,4],65536);parent.markDirty(65536,65540);
 const child=parent.clone(owner,childOwner,{parentPid:100});
 assert.equal(child.maxPages,parent.maxPages);assert.equal(child.mem.buffer.byteLength,16*65536);
 assert.equal(r.stats().descriptors.at(-1).initial,16);assert.equal(child.vmas.length,1);
 assert.equal(child.vmas[0].owner,childOwner);assert.deepEqual([...child.u8.slice(65536,65540)],[1,2,3,4]);
 child.u8[65536]=9;assert.equal(parent.u8[65536],1);
});
test('failed inherited-mapping growth reports exact stage and leaves no successful child copy',()=>{
 const r=runtime(),{Mm,Kernel,KError}=r.kernel,owner={},logs=[];
 const k=new Kernel({vfs:{},log:m=>logs.push(m)},{});
 const parent=new Mm(1024,1);parent.ensure(512*65536);
 parent.vmas=[{start:65536,end:512*65536,owner}];r.setGrowthLimit(16);
 assert.throws(()=>parent.clone(owner,{}, {parentPid:100}),e=>e instanceof KError&&e.code===r.abi.E.NOMEM);
 const events=logs.filter(x=>x.startsWith('[memory-allocation] ')).map(x=>JSON.parse(x.slice(20)));
 const event=events.find(x=>x.event==='failed');assert.equal(event.stage,'grow');
 assert.equal(event.currentBytes,16*65536);assert.equal(event.requestedEnd,512*65536);
 assert.equal(event.maximumPages,1024);assert.equal(event.parentPid,100);
 assert.match(event.scope,/not OS resident memory/);assert.equal(k.procs.size,0);
});
test('a different immutable maximum releases incompatible spares without clearing a worker-owned buffer',()=>{
 const r=runtime(),{MemoryPool}=r.kernel,pool=new MemoryPool(),events=[];
 pool.diagnostic=e=>events.push(e);
 const retired=pool.take(32,1);new Uint8Array(retired.mem.buffer)[0]=73;
 pool.give(retired.mem,[[0,1]],32);
 const next=pool.take(64,1);
 assert.equal(pool.free.length,0);assert.notEqual(next.mem,retired.mem);
 assert.equal(new Uint8Array(retired.mem.buffer)[0],73);
 assert.equal(r.stats().descriptors.at(-1).maximum,64);
 const event=events.find(e=>e.event==='pool-pruned');assert.equal(event.requestedMaximumPages,64);
 assert.equal(event.discarded[0].maximumPages,32);assert.equal(event.discarded[0].currentBytes,65536);
 assert.equal(event.pool.length,0);assert.equal(r.stats().waits,0);
});
test('retirement retains one spare per maximum and the original quarantine deadline',()=>{
 const r=runtime(),{MemoryPool}=r.kernel,pool=new MemoryPool(),events=[];
 pool.diagnostic=e=>events.push(e);
 const first=pool.take(32,1),second=pool.take(32,1);
 pool.give(first.mem,[[0,1]],32);const deadline=pool.free[0].readyAt;
 pool.give(second.mem,[[4,5]],32);
 assert.equal(pool.free.length,1);assert.equal(pool.free[0].mem,first.mem);
 assert.equal(pool.free[0].readyAt,deadline);assert.equal(pool.free[0].dirty[0][0],0);
 r.setRemaining(0);assert.equal(pool.take(32,1).mem,first.mem);
 assert.equal(r.stats().waits,1);assert.equal(r.stats().clock,1500);
 assert.equal(events.find(e=>e.reason==='duplicate maximum spare').discarded.length,1);
});
test('a grown spare replaces a smaller one while keeping its own quarantine',()=>{
 const r=runtime(),{MemoryPool}=r.kernel,pool=new MemoryPool();
 const small=pool.take(32,1),grown=pool.take(32,2);
 pool.give(small.mem,[],32);r.setClock(600);pool.give(grown.mem,[[4,5]],32);
 assert.equal(pool.free.length,1);assert.equal(pool.free[0].mem,grown.mem);
 assert.equal(pool.free[0].readyAt,2100);r.setRemaining(0);r.setGrowthLimit(1);
 assert.equal(pool.take(32,2).mem,grown.mem);assert.equal(r.stats().clock,2100);
});
