// SPDX-License-Identifier: GPL-3.0-or-later
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';import F from './linux-host/sparse-exec-fixture.cjs';
for(const n of ['guest_memory','guest_image'])vm.runInThisContext(fs.readFileSync(new URL('../../Sources/BetterJITLinux/Resources/linux/'+n+'.js',import.meta.url),'utf8'));
const M=BetterJITGuestMemory,I=BetterJITGuestImage,enc=s=>new TextEncoder().encode(s),args={path:'/bin/second',argv:[enc('/bin/second'),enc('abcDEFg')],envp:[enc('K=VALUE')]};
function old(t,options){const budget=new M.BackingBudget(options),space=new M.GuestAddressSpace(budget,{virtualLimit:1n<<47n});space.mapAnonymous(F.DATA,F.PAGE,3);space.write(F.DATA,F.bootstrap().data);t.after(()=>space.close());return {space,budget};}
test('executable store owns immutable snapshots, requires execute permission and never falls through to host files',()=>{
 const bytes=F.elf().bytes,store=new I.ExecutableStore([{path:'/bin/second',bytes},{path:'/bin/noexec',bytes,mode:0o644}]);bytes.fill(7);const a=store.readExecutableSnapshot('/bin/second');assert.equal(a[0],127);a.fill(9);assert.equal(store.readExecutableSnapshot('/bin/second')[0],127);
 for(const [path,errno]of [['/etc/passwd',2],['/bin',13],['/bin/noexec',13]])assert.throws(()=>store.readExecutableSnapshot(path),e=>e.errno===errno);for(const path of ['bin/a','/bin/../a','/bin//a'])assert.throws(()=>store.readExecutableSnapshot(path),I.ImageUnsupported);
});
test('argument reads preserve high pointers, stop at page-ending NUL and fault on missing terminators or vector slots',t=>{
 const {space}=old(t),copy={copyIn:(p,n)=>space.read(p,n),readU64:p=>new DataView(space.read(p,8).buffer).getBigUint64(0,true)};
 const a=I.readArguments(copy,F.DATA+128n,F.DATA+64n,F.DATA+96n);assert.deepEqual(a,args);
 space.write(F.DATA+F.PAGE-2n,Uint8Array.of(65,0));assert.deepEqual(I.readCString(copy,F.DATA+F.PAGE-2n),Uint8Array.of(65));space.write(F.DATA+F.PAGE-1n,Uint8Array.of(66));assert.throws(()=>I.readCString(copy,F.DATA+F.PAGE-2n),M.MemoryFault);
 assert.throws(()=>I.readArguments(copy,F.DATA+128n,F.DATA+F.PAGE-4n,0n),M.MemoryFault);assert.throws(()=>I.readArguments(copy,F.DATA+128n,0n,0n),I.ImageUnsupported);assert.throws(()=>I.readCString(copy,1n),M.MemoryFault);
});
test('static ELF preparation maps independent RX/R/RW bytes, zero BSS and a full high-address initial stack',t=>{
 const {space,budget}=old(t),before=space.read(F.DATA,256),r=I.prepare(space,F.elf().bytes,args,new Uint8Array(16).fill(0x5a));t.after(()=>r.space.close());assert.notEqual(r.space,space);assert.equal(r.entry,F.TEXT);assert.equal(r.stackPointer%16n,0n);assert.deepEqual(space.read(F.DATA,256),before);
 assert.deepEqual(r.space.executableSnapshot(F.TEXT,1),Uint8Array.of(0x48));assert.throws(()=>r.space.write(F.HEADER,Uint8Array.of(0)),M.MemoryFault);assert.deepEqual(r.space.read(F.ELFDATA+8n,8192-8),new Uint8Array(8192-8));assert.throws(()=>r.space.write(F.TEXT,Uint8Array.of(0)),M.MemoryFault);assert.throws(()=>r.space.read(F.DATA,1),M.MemoryFault);assert.throws(()=>r.space.read(r.stackBase-1n,1),M.MemoryFault);
 const table=new DataView(r.space.read(r.stackPointer,176).buffer),u=i=>table.getBigUint64(i*8,true);assert.equal(u(0),2n);assert(u(1)>0xffffffffn);assert.equal(new TextDecoder().decode(I.readCString({copyIn:(p,n)=>r.space.read(p,n)},u(1))),'/bin/second');assert.equal(u(3),0n);assert.equal(u(5),0n);assert.equal(u(6),3n);assert.equal(u(7),F.HEADER+64n);assert.equal(u(16),25n);assert.deepEqual(r.space.read(u(17),16),new Uint8Array(16).fill(0x5a));r.space.close();assert.equal(budget.stats().ownedPayloadBytes,M.PAGE);
});
test('malformed ELF spans and unsupported layouts are rejected before changing the old image',t=>{
 const {space,budget}=old(t);for(const [mutate,kind]of [[v=>v.setBigUint64(32,0xfffffffffffffff0n,true),I.ImageError],[v=>v.setBigUint64(64+32,4097n,true),I.ImageError],[v=>v.setBigUint64(24,F.DATA,true),I.ImageError],[v=>v.setUint16(16,3,true),I.ImageUnsupported],[v=>v.setUint32(64+56,3,true),I.ImageUnsupported],[v=>v.setUint32(64+4,6,true),I.ImageUnsupported],[v=>v.setBigUint64(64+56+16,F.HEADER,true),I.ImageUnsupported],[v=>v.setUint32(64+56+4,7,true),I.ImageUnsupported]]){const b=F.elf().bytes;mutate(new DataView(b.buffer));assert.throws(()=>I.prepare(space,b,args,new Uint8Array(16)),kind);assert.equal(budget.stats().ownedPayloadBytes,M.PAGE);assert.equal(space.read(F.DATA+128n,1)[0],47);}
});
test('staged image allocation failure frees every staged page and preserves old mapping identity',t=>{
 const {space,budget}=old(t,{limitBytes:4*M.PAGE}),id=space.mappingInfo(F.DATA).frameId;assert.throws(()=>I.prepare(space,F.elf().bytes,args,new Uint8Array(16)),M.AllocationFailure);assert.equal(budget.stats().ownedPayloadBytes,M.PAGE);assert.equal(space.mappingInfo(F.DATA).frameId,id);
});

test('guest strings never wrap oversized pointers or strip a filename BOM into another executable path',t=>{
 const {space}=old(t),copy={copyIn:(p,n)=>space.read(p,n),readU64:p=>new DataView(space.read(p,8).buffer).getBigUint64(0,true)};assert.throws(()=>I.readCString(copy,1n<<64n),TypeError);assert.throws(()=>I.readCString(copy,Number(F.DATA)),TypeError);space.write(F.DATA+256n,Uint8Array.from([0xef,0xbb,0xbf,...enc('/bin/second'),0]));assert.throws(()=>I.readArguments(copy,F.DATA+256n,F.DATA+64n,0n),I.ImageUnsupported);
});
