// SPDX-License-Identifier: GPL-3.0-or-later
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';
import F from './linux-host/sparse-linux-image-fixture.cjs';
for(const n of ['guest_memory','guest_image','guest_linux_image'])vm.runInThisContext(fs.readFileSync(new URL('../../Sources/BetterJITLinux/Resources/linux/'+n+'.js',import.meta.url),'utf8'));
const M=BetterJITGuestMemory,I=BetterJITGuestImage,L=BetterJITGuestLinuxImage,enc=s=>new TextEncoder().encode(s),args={path:'/test/wine',argv:[enc('/test/wine'),enc('cmd'),enc('/c'),enc('ver')],envp:[enc('WINEARCH=win64')]},random=new Uint8Array(16).fill(0x5a);
function setup(t,options={}){const budget=new M.BackingBudget(options),old=new M.GuestAddressSpace(budget,{virtualLimit:1n<<47n});old.mapAnonymous(0x10000n,4096n,3);old.write(0x10000n,Uint8Array.of(0x51));t.after(()=>old.close());return {old,budget};}
const store=bytes=>new I.ExecutableStore([{path:F.INTERP,bytes:bytes??F.image({interpreter:true})}]);
const prepare=(old,main=F.image(),interp=store())=>L.prepare(old,main,args,random,interp);
function aux(image){const read=p=>new DataView(image.space.read(p,8).buffer).getBigUint64(0,true),argc=read(image.stackPointer);let at=image.stackPointer+8n*(argc+2n);while(read(at))at+=8n;at+=8n;const map=new Map();while(read(at)){map.set(read(at),read(at+8n));at+=16n;}return map;}
test('interpreter bootstrap maps high PIE addresses and transfers control to interpreter with main-program auxv',t=>{
 const {old,budget}=setup(t),image=prepare(old);t.after(()=>image.space.close());const a=aux(image);
 assert.equal(image.entry,F.BASE+0x1000n);assert.equal(image.imageEntry,F.MAIN+0x1000n);assert.equal(image.phdr,F.MAIN+64n);assert.equal(image.stackPointer%16n,0n);
 assert.deepEqual(image.interpreter,{path:F.INTERP,base:F.BASE,entry:F.BASE+0x1000n});
 for(const [key,value]of [[3n,image.phdr],[4n,56n],[5n,7n],[6n,4096n],[7n,F.BASE],[8n,0n],[9n,image.imageEntry],[23n,0n]])assert.equal(a.get(key),value);
 assert.deepEqual(image.space.read(a.get(25n),16),random);assert.equal(new TextDecoder().decode(I.readCString({copyIn:(p,n)=>image.space.read(p,n)},a.get(31n))),args.path);
 assert.deepEqual(image.space.read(F.MAIN+0x3000n,0x180),new Uint8Array(0x180).fill(0x5a));assert.deepEqual(image.space.read(F.MAIN+0x3180n,0x80),new Uint8Array(0x80).fill(0x6b));assert.deepEqual(image.space.read(F.MAIN+0x3200n,0x1000),new Uint8Array(0x1000));
 assert.throws(()=>image.space.write(F.MAIN+0x1000n,Uint8Array.of(0)),M.MemoryFault);assert.throws(()=>image.space.executableSnapshot(F.MAIN+0x3180n,1),M.MemoryFault);
 assert.equal(image.codes.length,2);assert.equal(image.relocationsApplied,false);assert.equal(image.tlsInitialized,false);assert.equal(image.relroSealed,false);
 assert.equal(old.read(0x10000n,1)[0],0x51);image.space.close();assert.equal(budget.stats().ownedPayloadBytes,4096);
});
test('ET_EXEC image remains at its fixed address while interpreter is relocated',t=>{
 const {old}=setup(t),main=F.image({type:2}),v=new DataView(main.buffer);v.setBigUint64(24,0x401000n,true);
 for(let i=0;i<v.getUint16(56,true);i++){const at=64+i*56;if(v.getUint32(at,true)!==0x6474e551)v.setBigUint64(at+16,v.getBigUint64(at+16,true)+0x400000n,true);}
 const image=prepare(old,main);t.after(()=>image.space.close());assert.equal(image.loadBias,0n);assert.equal(image.imageEntry,0x401000n);assert.equal(aux(image).get(7n),F.BASE);
});
test('default static loader still refuses PIE and PT_INTERP images',t=>{
 const {old}=setup(t);assert.throws(()=>I.prepare(old,F.image(),args,random),I.ImageUnsupported);assert.throws(()=>I.prepare(old,F.image({type:2}),args,random),I.ImageUnsupported);
});
test('interpreter snapshots preserve immutability and absence/permissions fail before allocation',t=>{
 const {old,budget}=setup(t),bytes=F.image({interpreter:true}),s=store(bytes);bytes.fill(0);const first=s.readExecutableSnapshot(F.INTERP);first.fill(0);const image=prepare(old,F.image(),s);image.space.close();const before=budget.stats();
 for(const [files,errno]of [[[],2],[[{path:F.INTERP,bytes:F.image({interpreter:true}),mode:0o644}],13]])assert.throws(()=>prepare(old,F.image(),new I.ExecutableStore(files)),e=>e.errno===errno);
 assert.deepEqual(budget.stats(),before);assert.throws(()=>L.prepare(old,F.image(),args,random,{}),TypeError);
});
test('malformed dynamic images and unsupported layouts preserve the old space and budget',t=>{
 const {old,budget}=setup(t),before=budget.stats(),cases=[
  ['truncated headers',b=>new DataView(b.buffer).setBigUint64(32,BigInt(b.length-8),true)],
  ['duplicate interpreter',b=>new DataView(b.buffer).setUint32(64+4*56,3,true)],
  ['unterminated interpreter',b=>{b[0x380+F.INTERP.length]=65;}],
  ['embedded NUL',b=>{b[0x382]=0;}],
  ['relative interpreter',b=>{b[0x380]=65;}],
  ['non UTF-8',b=>{b[0x382]=255;}],
  ['overlapping pages',b=>new DataView(b.buffer).setBigUint64(64+3*56+16,0x1180n,true)],
  ['writable executable',b=>new DataView(b.buffer).setUint32(64+2*56+4,7,true)],
  ['overflow',b=>new DataView(b.buffer).setBigUint64(64+3*56+40,(1n<<64n)-1n,true)],
  ['metadata alias',b=>new DataView(b.buffer).setBigUint64(64+4*56+16,0x31b0n,true)],
  ['unknown segment',b=>new DataView(b.buffer).setUint32(64+4*56,0x1234,true)],
  ['executable stack',b=>new DataView(b.buffer).setUint32(64+6*56+4,7,true)],
  ['oversized image',()=>new Uint8Array(1024*1024+1)],
  ['huge backing',b=>new DataView(b.buffer).setBigUint64(64+3*56+40,40n*1024n*1024n,true)]
 ];
 for(const [name,mutate]of cases){let b=F.image();const changed=mutate(b);if(changed instanceof Uint8Array)b=changed;assert.throws(()=>prepare(old,b),e=>e instanceof I.ImageError||e instanceof I.ImageUnsupported,name);assert.deepEqual(budget.stats(),before,name);assert.equal(old.read(0x10000n,1)[0],0x51);}
 const nested=F.image();assert.throws(()=>prepare(old,F.image(),store(nested)),I.ImageError);
});
test('load failure after partial preparation releases every new guest frame',t=>{
 const {old,budget}=setup(t,{limitBytes:6*4096}),before=budget.stats();assert.throws(()=>prepare(old),M.AllocationFailure);assert.deepEqual(budget.stats().ownedPayloadBytes,before.ownedPayloadBytes);assert.equal(old.read(0x10000n,1)[0],0x51);
});
test('interpreter layout conflicts and a too-small guest window fail before mapping',t=>{
 const {old,budget}=setup(t),main=F.image({type:2}),v=new DataView(main.buffer);
 v.setBigUint64(24,F.BASE+0x1000n,true);for(let i=0;i<v.getUint16(56,true);i++){const at=64+i*56;if(v.getUint32(at,true)!==0x6474e551)v.setBigUint64(at+16,v.getBigUint64(at+16,true)+F.BASE,true);}
 assert.throws(()=>prepare(old,main),I.ImageUnsupported);assert.equal(budget.stats().ownedPayloadBytes,4096);
 const small=new M.GuestAddressSpace(budget,{virtualLimit:1n<<32n});t.after(()=>small.close());assert.throws(()=>prepare(small),I.ImageUnsupported);
});
test('explicit PHDR, TLS templates and passive GNU notes are checked as load aliases',t=>{
 const {old,budget}=setup(t);
 const extra=(type,flags,off,va,size,memsz=size)=>{const b=F.image(),v=new DataView(b.buffer),n=v.getUint16(56,true),at=64+n*56;v.setUint16(56,n+1,true);v.setUint32(at,type,true);v.setUint32(at+4,flags,true);for(const [p,x]of [[8,off],[16,va],[32,size],[40,memsz],[48,8n]])v.setBigUint64(at+p,x,true);return b;};
 const tls=extra(7,4,0x2180n,0x3180n,0x20n,0x80n),image=prepare(old,tls);assert.equal(image.tlsInitialized,false);image.space.close();
 const broken=tls.slice();new DataView(broken.buffer).setBigUint64(64+7*56+16,0x8000n,true);assert.throws(()=>prepare(old,broken),I.ImageError);
 const note=extra(4,4,0x500n,0x500n,32n),v=new DataView(note.buffer);for(const [p,x]of [[0x500,4],[0x504,16],[0x508,5],[0x50c,0x00554e47],[0x510,0xc0000002],[0x514,4],[0x518,3],[0x51c,0]])v.setUint32(p,x,true);
 let r=prepare(old,note);r.space.close();v.setUint32(0x510,0xc0008002,true);v.setUint32(0x518,1,true);r=prepare(old,note);r.space.close();
 for(const [p,x]of [[0x518,2],[0x514,8],[0x50c,0x11111111],[0x508,99]]){const b=note.slice();new DataView(b.buffer).setUint32(p,x,true);assert.throws(()=>prepare(old,b),I.ImageUnsupported);}
 // Insert PHDR before INTERP/LOAD; its file range must describe all eight entries.
 const ph=F.image(),pv=new DataView(ph.buffer);ph.copyWithin(120,64,64+7*56);ph.fill(0,64,120);pv.setUint16(56,8,true);pv.setUint32(64,6,true);pv.setUint32(68,4,true);for(const [p,x]of [[72,64n],[80,64n],[96,8n*56n],[104,8n*56n],[112,8n]])pv.setBigUint64(p,x,true);
 r=prepare(old,ph);r.space.close();pv.setBigUint64(80,72n,true);assert.throws(()=>prepare(old,ph),I.ImageError);assert.equal(budget.stats().ownedPayloadBytes,4096);
});
test('argument and random bounds cannot allocate a partial Linux image',t=>{
 const {old,budget}=setup(t),before=budget.stats();
 for(const changed of [{...args,path:'/test/../wine'},{...args,argv:[]},{...args,argv:[new Uint8Array(4096)]},{...args,envp:[Uint8Array.of(0)]}])assert.throws(()=>L.prepare(old,F.image(),changed,random,store()),I.ImageUnsupported);
 assert.throws(()=>L.prepare(old,F.image(),args,new Uint8Array(15),store()),TypeError);assert.deepEqual(budget.stats(),before);
});
