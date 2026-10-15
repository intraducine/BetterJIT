// SPDX-License-Identifier: GPL-3.0-or-later
// Actual storage bytes and ownership under a synthetic payload budget.
// No translated guest execution, engine quota, resident-RAM or phone claim.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
vm.runInThisContext(fs.readFileSync(new URL('../../Sources/BetterJITLinux/Resources/linux/guest_memory.js',import.meta.url),'utf8'));
const {PAGE,PROT,MemoryFault,AllocationFailure,BackingBudget,SharedBacking,GuestAddressSpace}=BetterJITGuestMemory;
const P=BigInt(PAGE),LOW=0x10000n,HIGH=0x7ffe0000n,RW=PROT.READ|PROT.WRITE;
const fault=(reason,fn)=>assert.throws(fn,e=>e instanceof MemoryFault&&e.reason===reason);
const own=(t,budget,options)=>{const s=new GuestAddressSpace(budget,options);t.after(()=>s.close());return s;};

test('prepared copyout preallocates every COW page and commits only the returned prefix',t=>{
 const b=new BackingBudget(),o=new SharedBacking(b,2n*P);t.after(()=>o.close());const s=own(t,b);
 s.mapShared(HIGH,2n*P,o,0n,{privateView:true});const second=s.mappingInfo(HIGH+P).frameId;
 const tx=s.prepareWrite(HIGH+P-4n,8);assert.equal(b.stats().ownedPayloadBytes,4*PAGE);
 tx.bytes.fill(42);assert.deepEqual(s.read(HIGH+P-4n,8),new Uint8Array(8));
 const attempts=b.stats().allocationAttempts;assert.equal(tx.validate(),true);assert.equal(tx.commit(3),3);
 assert.equal(b.stats().allocationAttempts,attempts);assert.equal(b.stats().ownedPayloadBytes,3*PAGE);
 assert.deepEqual(s.read(HIGH+P-4n,8),Uint8Array.of(42,42,42,0,0,0,0,0));
 assert.equal(s.mappingInfo(HIGH+P).frameId,second);assert.equal(tx.cancel(),false);
 assert.throws(()=>tx.commit(),BetterJITGuestMemory.PreparedWriteConflict);
});
test('prepared cancellation and zero-byte commit preserve bytes and mapping identities',t=>{
 const b=new BackingBudget(),o=new SharedBacking(b,P);t.after(()=>o.close());const s=own(t,b);
 s.mapShared(HIGH,P,o,0n,{privateView:true});const id=s.mappingInfo(HIGH).frameId;
 let tx=s.prepareWrite(HIGH,8);tx.bytes.fill(9);assert.equal(tx.cancel(),true);assert.equal(tx.cancel(),false);
 assert.equal(b.stats().ownedPayloadBytes,PAGE);assert.equal(s.mappingInfo(HIGH).frameId,id);
 tx=s.prepareWrite(HIGH,8);tx.bytes.fill(8);assert.throws(()=>tx.commit(9),TypeError);
 assert.throws(()=>tx.commit(-1),TypeError);assert.throws(()=>tx.commit(0.5),TypeError);assert.equal(tx.commit(0),0);
 assert.equal(b.stats().ownedPayloadBytes,PAGE);assert.equal(s.mappingInfo(HIGH).frameId,id);
 assert.deepEqual(s.read(HIGH,8),new Uint8Array(8));s.write(HIGH,Uint8Array.of(7));assert.equal(s.read(HIGH,1)[0],7);
});
test('prepared allocation and protection failures occur before input can be consumed',t=>{
 const b=new BackingBudget({limitBytes:3*PAGE}),o=new SharedBacking(b,2n*P);t.after(()=>o.close());const s=own(t,b);
 s.mapShared(HIGH,2n*P,o,0n,{privateView:true});const ids=[HIGH,HIGH+P].map(a=>s.mappingInfo(a).frameId);let consumed=0;
 assert.throws(()=>{const tx=s.prepareWrite(HIGH+P-4n,8);consumed++;tx.commit();},AllocationFailure);
 assert.equal(consumed,0);assert.equal(b.stats().ownedPayloadBytes,2*PAGE);
 assert.deepEqual([HIGH,HIGH+P].map(a=>s.mappingInfo(a).frameId),ids);
 s.protect(HIGH+P,P,PROT.READ);
 assert.throws(()=>{s.prepareWrite(HIGH+P-4n,8);consumed++;},e=>e instanceof MemoryFault&&e.faultAddress===HIGH+P);
 assert.equal(consumed,0);assert.deepEqual(s.read(HIGH+P-4n,8),new Uint8Array(8));
});
test('prepared destinations refuse mapping changes, writes, atomics and fork until cancelled',t=>{
 const b=new BackingBudget(),s=own(t,b),o=new SharedBacking(b,P);t.after(()=>o.close());s.mapAnonymous(HIGH,P,RW);
 const tx=s.prepareWrite(HIGH,8);
 for(const fn of [()=>s.mapAnonymous(LOW,P),()=>s.mapShared(LOW,P,o),()=>s.protect(HIGH,P,PROT.NONE),
  ()=>s.unmap(HIGH,P),()=>s.decommit(HIGH,P),()=>s.write(HIGH,Uint8Array.of(1)),()=>s.copy(HIGH,HIGH,1),
  ()=>s.fetchAdd(HIGH,4,1n),()=>s.fork(),()=>s.prepareWrite(HIGH,1)])
  assert.throws(fn,BetterJITGuestMemory.PreparedWriteConflict);
 assert.equal(tx.validate(),true);assert.equal(s.read(HIGH,1)[0],0);tx.cancel();s.protect(HIGH,P,PROT.READ);
});
test('writes through a canonical alias invalidate staged snapshots before commit',t=>{
 for(const privateView of [false,true]) {
  const b=new BackingBudget(),o=new SharedBacking(b,P);t.after(()=>o.close());const a=own(t,b),c=own(t,b);
  a.mapShared(HIGH,P,o,0n,{privateView});c.mapShared(LOW,P,o);
  const id=a.mappingInfo(HIGH).frameId,tx=a.prepareWrite(HIGH,8);tx.bytes.fill(99);c.write(LOW+12n,Uint8Array.of(17));
  assert.throws(()=>tx.validate(),BetterJITGuestMemory.PreparedWriteConflict);
  assert.throws(()=>tx.commit(),BetterJITGuestMemory.PreparedWriteConflict);
  assert.equal(a.mappingInfo(HIGH).frameId,id);assert.equal(a.read(HIGH+12n,1)[0],17);
  assert.deepEqual(a.read(HIGH,8),new Uint8Array(8));assert.equal(b.stats().ownedPayloadBytes,PAGE);
 }
});
test('closing a space or detaching its staging buffer cancels prepared backing safely',t=>{
 const b=new BackingBudget(),o=new SharedBacking(b,P);t.after(()=>o.close());const s=own(t,b);
 s.mapShared(HIGH,P,o,0n,{privateView:true});let tx=s.prepareWrite(HIGH,8);
 structuredClone(tx.bytes.buffer,{transfer:[tx.bytes.buffer]});assert.throws(()=>tx.validate(),BetterJITGuestMemory.PreparedWriteConflict);
 assert.equal(b.stats().ownedPayloadBytes,PAGE);tx=s.prepareWrite(HIGH,8);s.close();o.close();
 assert.equal(b.stats().ownedPayloadBytes,0);assert.equal(tx.cancel(),false);assert.throws(()=>tx.commit(),BetterJITGuestMemory.PreparedWriteConflict);
});
test('allocator reentry cannot mutate or close a space during preparation',t=>{
 let s,reenter;const b=new BackingBudget({allocatePage:n=>{if(reenter)reenter();return new Uint8Array(n);}});
 const o=new SharedBacking(b,P);t.after(()=>o.close());s=own(t,b);s.mapShared(HIGH,P,o,0n,{privateView:true});
 for(const action of [()=>s.unmap(HIGH,P),()=>s.close()]) {
  reenter=action;assert.throws(()=>s.prepareWrite(HIGH,8),AllocationFailure);assert.equal(b.stats().ownedPayloadBytes,PAGE);
 }
 reenter=null;const tx=s.prepareWrite(HIGH,8);tx.bytes.fill(3);tx.commit();assert.equal(s.read(HIGH,1)[0],3);
});

test('three live spaces preserve high pointers and private bytes without backing their reserved holes',t=>{
 const b=new BackingBudget({limitBytes:6*PAGE}),ss=[0,1,2].map(()=>own(t,b,{virtualLimit:0x7fff0000n}));
 for(const [i,s]of ss.entries()){
  assert.equal(s.reserve(0x7f000000n,0xff0000n),0x7f000000n);
  assert.equal(s.stats().committedPages,0);
  s.commit(HIGH,P,RW);s.mapAnonymous(LOW,P,RW);
  s.write(HIGH,Uint8Array.of(20+i));s.write(LOW,Uint8Array.of(40+i));
  assert.equal(s.read(HIGH,1)[0],20+i);assert.equal(s.read(LOW,1)[0],40+i);
  fault('protection',()=>s.read(0x7f001000n,1));fault('unmapped',()=>s.read(0x20000n,1));
 }
 assert.equal(b.stats().ownedPayloadBytes,6*PAGE);
 assert.equal(new Set(ss.map(s=>s.mappingInfo(HIGH).frameId)).size,3);
 ss[1].write(HIGH,Uint8Array.of(99));assert.equal(ss[0].read(HIGH,1)[0],20);assert.equal(ss[2].read(HIGH,1)[0],22);
 for(const s of ss)s.close();assert.equal(b.stats().ownedPayloadBytes,0);
});
test('virtual limits are independent of the small backing budget and preserve full i64 bits',t=>{
 const b=new BackingBudget({limitBytes:PAGE}),s=own(t,b,{virtualLimit:1n<<48n});
 const at=0x123456780000n;assert.equal(s.mapAnonymous(at,P,RW),at);s.write(at,Uint8Array.of(73));
 assert.equal(s.read(at,1)[0],73);assert.equal(b.stats().ownedPayloadBytes,PAGE);
 fault('unmapped',()=>s.read(0x56780000n,1));
 assert.throws(()=>s.read(-1n,8),e=>e instanceof MemoryFault&&e.guestAddress===0xffffffffffffffffn&&e.width===8n);
 assert.throws(()=>s.read(1n<<64n,1),MemoryFault);
 assert.throws(()=>s.read(Number.MAX_SAFE_INTEGER+1,1),TypeError);
});
test('a valid access crossing the virtual limit reports its first inaccessible byte',t=>{
 const s=own(t,new BackingBudget(),{virtualLimit:0x12000n});s.mapAnonymous(0x11000n,P,RW);
 s.write(0x11ffcn,Uint8Array.of(1,2,3,4));
 for(const fn of [()=>s.read(0x11ffcn,8),()=>s.write(0x11ffcn,new Uint8Array(8).fill(9))])
  assert.throws(fn,e=>e instanceof MemoryFault&&e.reason==='range'&&e.guestAddress===0x11ffcn&&e.faultAddress===0x12000n&&e.width===8n);
 assert.deepEqual(s.read(0x11ffcn,4),Uint8Array.of(1,2,3,4));
 assert.throws(()=>s.read(0x12004n,1),e=>e.faultAddress===0x12004n&&e.guestAddress===0x12004n);
});
test('cross-page reads and writes gather nonadjacent backing frames and check every page before effects',t=>{
 const b=new BackingBudget(),s=own(t,b);s.mapAnonymous(LOW,P,RW);s.mapAnonymous(HIGH,P,RW);s.mapAnonymous(LOW+P,P,RW);
 const data=Uint8Array.of(1,2,3,4);s.write(LOW+P-2n,data);assert.deepEqual(s.read(LOW+P-2n,4),data);
 s.protect(LOW+P,P,PROT.READ);
 assert.throws(()=>s.write(LOW+P-1n,Uint8Array.of(8,9)),e=>e instanceof MemoryFault&&e.faultAddress===LOW+P);
 assert.equal(s.read(LOW+P-1n,1)[0],2);
 s.unmap(LOW+P,P);fault('unmapped',()=>s.read(LOW+P-1n,2));
});
test('NONE round-trip retains bytes and frames, while decommit and fresh remap zero data',t=>{
 const b=new BackingBudget(),s=own(t,b);s.mapAnonymous(HIGH,P,RW);s.write(HIGH,Uint8Array.of(77));
 const frame=s.mappingInfo(HIGH).frameId;s.protect(HIGH,P,PROT.NONE);fault('protection',()=>s.read(HIGH,1));
 assert.equal(b.stats().ownedPayloadBytes,PAGE);s.protect(HIGH,P,RW);
 assert.equal(s.mappingInfo(HIGH).frameId,frame);assert.equal(s.read(HIGH,1)[0],77);
 s.decommit(HIGH,P);assert.equal(b.stats().ownedPayloadBytes,0);s.commit(HIGH,P,RW);assert.equal(s.read(HIGH,1)[0],0);
 s.write(HIGH,Uint8Array.of(88));s.unmap(HIGH,P);s.mapAnonymous(HIGH,P,RW);assert.equal(s.read(HIGH,1)[0],0);
});
test('shared aliases retain one canonical payload until the final owner and mapper release it',t=>{
 const b=new BackingBudget({limitBytes:PAGE}),object=new SharedBacking(b,P);t.after(()=>object.close());
 const s=own(t,b);s.mapShared(LOW,P,object);s.mapShared(HIGH,P,object);
 s.write(LOW+3n,Uint8Array.of(91));assert.equal(s.read(HIGH+3n,1)[0],91);
 assert.equal(s.mappingInfo(LOW).frameId,s.mappingInfo(HIGH).frameId);assert.equal(b.stats().references,3);
 const child=s.fork();t.after(()=>child.close());assert.equal(b.stats().references,5);
 object.close();assert.equal(b.stats().references,4);s.unmap(LOW,P);assert.equal(b.stats().references,3);
 assert.equal(child.read(HIGH+3n,1)[0],91);s.close();assert.equal(b.stats().references,2);
 child.close();assert.equal(b.stats().references,0);assert.equal(b.stats().ownedPayloadBytes,0);
});
test('fork copies committed private pages, preserves reserved holes and shares canonical identities',t=>{
 const b=new BackingBudget(),object=new SharedBacking(b,P);t.after(()=>object.close());
 const s=own(t,b);s.mapAnonymous(LOW,P,RW);s.reserve(HIGH-P,2n*P);s.commit(HIGH,P,RW);s.mapShared(LOW+P,P,object);
 s.write(LOW,Uint8Array.of(71));const c=s.fork();t.after(()=>c.close());
 assert.equal(c.stats().reservedVirtualBytes,s.stats().reservedVirtualBytes);
 assert.notEqual(c.mappingInfo(LOW).frameId,s.mappingInfo(LOW).frameId);
 assert.equal(c.mappingInfo(LOW+P).frameId,s.mappingInfo(LOW+P).frameId);
 c.write(LOW,Uint8Array.of(72));assert.equal(s.read(LOW,1)[0],71);
 c.write(LOW+P,Uint8Array.of(90));assert.equal(s.read(LOW+P,1)[0],90);
 assert.equal(b.stats().ownedPayloadBytes,5*PAGE);fault('protection',()=>c.read(HIGH-P,1));
});
test('budget failure during replacement retains old mappings, data and frame identities',t=>{
 const b=new BackingBudget({limitBytes:2*PAGE}),s=own(t,b);s.mapAnonymous(LOW,P,RW);s.write(LOW,Uint8Array.of(73));
 const before=s.mappingInfo(LOW);
 assert.throws(()=>s.mapAnonymous(LOW,2n*P,RW,{replace:true}),AllocationFailure);
 assert.deepEqual(s.mappingInfo(LOW),before);assert.equal(s.read(LOW,1)[0],73);
 assert.equal(s.stats().reservedVirtualBytes,P);assert.equal(b.stats().ownedPayloadBytes,PAGE);
});
test('an allocator failure after staging one page rolls back commitment and releases staged bytes',t=>{
 let calls=0;const b=new BackingBudget({limitBytes:4*PAGE,allocatePage:n=>{if(++calls===2)throw new RangeError('injected allocation failure');return new Uint8Array(n);}});
 const s=own(t,b);s.reserve(LOW,3n*P);assert.throws(()=>s.commit(LOW,3n*P,RW),AllocationFailure);
 assert.equal(s.stats().committedPages,0);assert.equal(b.stats().ownedPayloadBytes,0);
 assert.equal(b.stats().peakPayloadBytes,PAGE);fault('protection',()=>s.read(LOW,1));
});
test('fork failure releases staged private copies and shared references without changing its parent',t=>{
 let failAt=Infinity,calls=0;const b=new BackingBudget({allocatePage:n=>{if(++calls===failAt)throw new RangeError('injected');return new Uint8Array(n);}});
 const object=new SharedBacking(b,P);t.after(()=>object.close());const s=own(t,b);
 s.mapShared(LOW,P,object);s.mapAnonymous(LOW+P,2n*P,RW);s.write(LOW+P,Uint8Array.of(66));
 const before=b.stats();failAt=calls+2;assert.throws(()=>s.fork(),AllocationFailure);
 assert.equal(b.stats().references,before.references);assert.equal(b.stats().ownedPayloadBytes,before.ownedPayloadBytes);
 assert.equal(s.read(LOW+P,1)[0],66);
});
test('private views detach on write while shared aliases remain coherent',t=>{
 const b=new BackingBudget(),object=new SharedBacking(b,P);t.after(()=>object.close());const s=own(t,b);
 s.mapShared(LOW,P,object,0n,{privateView:true});s.mapShared(HIGH,P,object);
 s.write(HIGH,Uint8Array.of(22));assert.equal(s.read(LOW,1)[0],22);
 s.write(LOW,Uint8Array.of(11));s.write(HIGH,Uint8Array.of(33));
 assert.equal(s.read(LOW,1)[0],11);assert.equal(s.read(HIGH,1)[0],33);
 assert.equal(s.mappingInfo(LOW).kind,'private');assert.notEqual(s.mappingInfo(LOW).frameId,s.mappingInfo(HIGH).frameId);
 assert.equal(b.stats().privateFrames,1);assert.equal(b.stats().sharedFrames,1);
});
test('a failing cross-page private-view write publishes neither detached pages nor partial bytes',t=>{
 const b=new BackingBudget({limitBytes:3*PAGE}),object=new SharedBacking(b,2n*P);t.after(()=>object.close());
 const s=own(t,b);s.mapShared(LOW,2n*P,object,0n,{privateView:true});
 const frames=[s.mappingInfo(LOW).frameId,s.mappingInfo(LOW+P).frameId],references=b.stats().references;
 assert.throws(()=>s.write(LOW+P-1n,Uint8Array.of(8,9)),AllocationFailure);
 assert.deepEqual(s.read(LOW+P-1n,2),Uint8Array.of(0,0));assert.equal(b.stats().ownedPayloadBytes,2*PAGE);
 assert.equal(b.stats().references,references);assert.deepEqual([s.mappingInfo(LOW).frameId,s.mappingInfo(LOW+P).frameId],frames);
});
test('private futex identity uses space and VA; shared identity follows canonical page and offset',t=>{
 const b=new BackingBudget(),object=new SharedBacking(b,P);t.after(()=>object.close());const s=own(t,b);
 s.mapShared(LOW,P,object);s.mapShared(HIGH,P,object);
 assert.deepEqual(s.futexIdentity(LOW+4n),s.futexIdentity(HIGH+4n));
 assert.notDeepEqual(s.futexIdentity(LOW+4n,{private:true}),s.futexIdentity(HIGH+4n,{private:true}));
 const c=s.fork();t.after(()=>c.close());assert.deepEqual(s.futexIdentity(LOW+4n),c.futexIdentity(HIGH+4n));
 assert.notDeepEqual(s.futexIdentity(LOW+4n,{private:true}),c.futexIdentity(LOW+4n,{private:true}));
 fault('alignment',()=>s.futexIdentity(LOW+1n));
});
test('bounds, alignment and permissions fail without wrapping, silently clipping or changing data',t=>{
 const b=new BackingBudget(),s=own(t,b,{virtualLimit:HIGH+P});s.mapAnonymous(HIGH,P,RW);s.write(HIGH,Uint8Array.of(77));
 fault('range',()=>s.read(HIGH+P-1n,2));fault('range',()=>s.read(HIGH+(1n<<32n),1));
 assert.throws(()=>s.protect(LOW+1n,P,PROT.READ),TypeError);
 assert.throws(()=>s.protect(HIGH,P,2**32),TypeError);
 assert.equal(s.read(HIGH,1)[0],77);assert.deepEqual(s.read(HIGH+P,0),new Uint8Array());
 s.protect(HIGH,P,PROT.READ|PROT.EXEC);assert.equal(s.read(HIGH,1,{execute:true})[0],77);
 fault('protection',()=>s.write(HIGH,Uint8Array.of(4)));
});
test('copy has memmove snapshot semantics across page boundaries and validates the whole destination',t=>{
 const b=new BackingBudget(),s=own(t,b);s.mapAnonymous(LOW,2n*P,RW);
 s.write(LOW+P-3n,Uint8Array.of(1,2,3,4,5));s.copy(LOW+P-2n,LOW+P-3n,5);
 assert.deepEqual(s.read(LOW+P-3n,6),Uint8Array.of(1,1,2,3,4,5));
 s.protect(LOW+P,P,PROT.READ);fault('protection',()=>s.copy(LOW+P-1n,LOW+P-3n,2));
 assert.equal(s.read(LOW+P-1n,1)[0],2);
});
test('closed handles and unsupported shared decommit preserve live aliases and release exactly once',t=>{
 const b=new BackingBudget(),object=new SharedBacking(b,P),s=own(t,b);s.mapShared(LOW,P,object);
 fault('unsupported-shared-decommit',()=>s.decommit(LOW,P));assert.equal(b.stats().references,2);
 object.close();assert.throws(()=>s.mapShared(HIGH,P,object),TypeError);s.write(LOW,Uint8Array.of(83));
 assert.equal(s.read(LOW,1)[0],83);s.close();s.close();object.close();assert.equal(b.stats().ownedPayloadBytes,0);
 fault('closed',()=>s.read(LOW,1));
});
test('an allocator cannot alias another live page, even in another budget',t=>{
 const bytes=new Uint8Array(PAGE),a=new BackingBudget({allocatePage:()=>bytes}),b=new BackingBudget({allocatePage:()=>bytes});
 const first=own(t,a),second=own(t,b);first.mapAnonymous(LOW,P,RW);first.write(LOW,Uint8Array.of(76));
 assert.throws(()=>second.mapAnonymous(HIGH,P,RW),AllocationFailure);
 assert.equal(first.read(LOW,1)[0],76);assert.equal(b.stats().ownedPayloadBytes,0);
 first.close();second.mapAnonymous(HIGH,P,RW);assert.equal(second.read(HIGH,1)[0],0);
});
test('shared objects cannot bypass another budget and returned bytes/metadata do not expose storage',t=>{
 const a=new BackingBudget(),b=new BackingBudget(),object=new SharedBacking(a,P);t.after(()=>object.close());
 const first=own(t,a),second=own(t,b);assert.throws(()=>second.mapShared(LOW,P,object),TypeError);
 first.mapShared(LOW,P,object);first.write(LOW,Uint8Array.of(74));const copy=first.read(LOW,1);copy[0]=0;
 assert.equal(first.read(LOW,1)[0],74);assert.ok(Object.isFrozen(first.mappingInfo(LOW)));assert.ok(Object.isFrozen(a.stats()));
});
test('protection allocation failure leaves old rights and committed bytes intact',t=>{
 const b=new BackingBudget({limitBytes:2*PAGE}),s=own(t,b);s.mapAnonymous(LOW,P,RW);s.reserve(LOW+P,2n*P);
 s.write(LOW,Uint8Array.of(65));const info=s.mappingInfo(LOW);
 assert.throws(()=>s.protect(LOW,3n*P,RW),AllocationFailure);
 assert.deepEqual(s.mappingInfo(LOW),info);assert.equal(s.read(LOW,1)[0],65);
 fault('protection',()=>s.read(LOW+P,1));assert.equal(b.stats().ownedPayloadBytes,PAGE);
});
test('canonical object and page offsets distinguish different shared words',t=>{
 const b=new BackingBudget(),object=new SharedBacking(b,2n*P),other=new SharedBacking(b,P);
 t.after(()=>object.close());t.after(()=>other.close());const s=own(t,b);
 s.mapShared(LOW,2n*P,object);s.mapShared(HIGH,P,object,P);s.mapShared(HIGH-P,P,other);
 assert.deepEqual(s.futexIdentity(LOW+P+4n),s.futexIdentity(HIGH+4n));
 assert.notDeepEqual(s.futexIdentity(LOW+4n),s.futexIdentity(HIGH+4n));
 assert.notDeepEqual(s.futexIdentity(HIGH-P+4n),s.futexIdentity(HIGH+4n));
 s.write(HIGH,Uint8Array.of(86));assert.equal(s.read(LOW+P,1)[0],86);assert.equal(s.read(LOW,1)[0],0);
});
test('all scalar/vector byte widths cross pages without clipping and preserve valid all-one values',t=>{
 const b=new BackingBudget(),s=own(t,b);s.mapAnonymous(LOW,2n*P,RW);
 for(const width of [1,2,4,8,16,32]){
  const at=LOW+P-BigInt(Math.max(1,width/2)),bytes=new Uint8Array(width).fill(255);
  s.write(at,bytes);assert.deepEqual(s.read(at,width),bytes);
 }
 const values=[0n,1n<<63n,0xffffffffffffffffn];
 for(const value of values){
  const bytes=new Uint8Array(8);new DataView(bytes.buffer).setBigUint64(0,value,true);
  s.write(LOW,bytes);const result=s.read(LOW,8);assert.equal(new DataView(result.buffer).getBigUint64(0,true),value);
 }
 s.unmap(LOW+P,P);fault('unmapped',()=>s.read(LOW+P-1n,8));
});
test('forked private views retain canonical bytes until either process writes its own page',t=>{
 const b=new BackingBudget(),object=new SharedBacking(b,P);t.after(()=>object.close());const s=own(t,b);
 s.mapShared(LOW,P,object,0n,{privateView:true});s.mapShared(HIGH,P,object);
 s.write(HIGH,Uint8Array.of(41));const c=s.fork();t.after(()=>c.close());
 assert.equal(c.mappingInfo(LOW).frameId,s.mappingInfo(LOW).frameId);
 c.write(LOW,Uint8Array.of(42));s.write(HIGH,Uint8Array.of(43));
 assert.equal(c.read(LOW,1)[0],42);assert.equal(s.read(LOW,1)[0],43);
 assert.equal(c.read(HIGH,1)[0],43);assert.equal(b.stats().privateFrames,1);
});
test('shared-data-block allocator wrappers are rejected before touching their bytes',()=>{
 const buffer=new SharedArrayBuffer(PAGE),view=new Uint8Array(buffer);view[0]=75;
 const wrapper=structuredClone(buffer),budget=new BackingBudget({allocatePage:()=>new Uint8Array(wrapper)});
 const space=new GuestAddressSpace(budget);
 assert.throws(()=>space.mapAnonymous(LOW,P,RW),AllocationFailure);
 assert.equal(view[0],75);assert.equal(budget.stats().ownedPayloadBytes,0);space.close();
});
