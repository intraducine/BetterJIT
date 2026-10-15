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
test('ordinary compiler zero-file BSS loads may start within a distinct page without mapping file-prefix bytes',t=>{
 const {space}=old(t),b=F.elf().bytes,v=new DataView(b.buffer),at=64+2*56;v.setBigUint64(at+8,64n,true);v.setBigUint64(at+16,F.ELFDATA+64n,true);v.setBigUint64(at+32,0n,true);const image=I.prepare(space,b,args,new Uint8Array(16));t.after(()=>image.space.close());assert.deepEqual(image.space.read(F.ELFDATA,128),new Uint8Array(128));assert.deepEqual(image.space.read(F.ELFDATA+64n,8192),new Uint8Array(8192));
 v.setBigUint64(at+32,8n,true);assert.throws(()=>I.prepare(space,b,args,new Uint8Array(16)),I.ImageUnsupported);
});

function compatibleNote(){
 const b=F.elf().bytes,v=new DataView(b.buffer),off=512n;v.setUint16(56,5,true);
 for(const [i,type]of [[3,4],[4,0x6474e553]]){const at=64+i*56;v.setUint32(at,type,true);v.setUint32(at+4,4,true);for(const [n,x]of [[8,off],[16,F.HEADER+off],[32,32n],[40,32n],[48,8n]])v.setBigUint64(at+n,x,true);}
 for(const [n,x]of [[0,4],[4,16],[8,5],[12,0x00554e47],[16,0xc0000002],[20,4],[24,3],[28,0]])v.setUint32(Number(off)+n,x,true);
 return {b,v};
}
test('compiler GNU compatibility metadata aliases read-only bytes without enabling CET or adding mappings',t=>{
 const {space,budget}=old(t);
 for(let features=0;features<=3;features++){
  const {b,v}=compatibleNote();v.setUint32(512+24,features,true);const image=I.prepare(space,b,args,new Uint8Array(16));
  try{assert.deepEqual(image.space.read(F.HEADER+512n,32),b.slice(512,544));assert.throws(()=>image.space.write(F.HEADER+512n,Uint8Array.of(1)),M.MemoryFault);assert.equal(image.codes.length,1);}finally{image.space.close();}
  assert.equal(budget.stats().ownedPayloadBytes,M.PAGE);
 }
});
test('malformed, required or ambiguously mapped GNU properties refuse before allocation and preserve the old image',t=>{
 const {space,budget}=old(t),id=space.mappingInfo(F.DATA).frameId,before=space.read(F.DATA,256);
 for(const [mutate,kind]of [
  [v=>v.setBigUint64(64+3*56+8,BigInt(v.byteLength),true),I.ImageError],
  [v=>v.setUint32(512,5,true),I.ImageError],[v=>v.setUint32(516,15,true),I.ImageError],[v=>v.setUint32(524,0,true),I.ImageError],
  [v=>v.setUint32(532,8,true),I.ImageError],[v=>v.setUint32(540,1,true),I.ImageError],
  [v=>v.setUint32(528,0xc0008002,true),I.ImageUnsupported],[v=>v.setUint32(536,4,true),I.ImageUnsupported],
  [v=>v.setUint32(64+4*56,4,true),I.ImageUnsupported],
  [v=>v.setBigUint64(64+4*56+16,F.HEADER+520n,true),I.ImageUnsupported],
  [v=>{v.setBigUint64(64+3*56+16,F.TEXT+512n,true);v.setBigUint64(64+4*56+16,F.TEXT+512n,true);},I.ImageUnsupported]
 ]){const {b,v}=compatibleNote();mutate(v);assert.throws(()=>I.prepare(space,b,args,new Uint8Array(16)),kind);assert.equal(budget.stats().ownedPayloadBytes,M.PAGE);assert.equal(space.mappingInfo(F.DATA).frameId,id);assert.deepEqual(space.read(F.DATA,256),before);}
});
