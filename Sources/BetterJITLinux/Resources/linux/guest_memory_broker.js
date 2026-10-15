// SPDX-License-Identifier: GPL-3.0-or-later
// Experimental reference authority. Not loaded by the default Linux runtime.
(function(root) {
  'use strict';
  const storage=root.BetterJITGuestMemory;
  if(!storage||storage.STORAGE_VERSION!==1)throw new Error('Guest storage contract 1 required');
  const ABI=Object.freeze({version:1,checkpointVersion:1,stepVersion:2,coverageVersion:2,
    magic:0x314d4a42,internalPages:33,threadBase:0x10000,threadBytes:0x200000,
    scratchOffset:0x1f0000,scratchBytes:128,memoryRequest:0x10003,instructionBoundary:0x10004,maximumThreads:8,parkedState:4});
  const FIELD=Object.freeze({magic:0,version:4,sequence:8,status:12,operation:16,width:20,access:24,reason:28,
    address:32,rip:40,checkpoint:48,operand0:56,operand1:64,result0:72,result1:80,faultAddress:88,
    checkpointRip:96,nextRip:104,completedSequence:112,boundaryControl:116,lease:120});
  const STATUS=Object.freeze({OK:0,FAULT:1,UNSUPPORTED:2});
  const OP=Object.freeze({READ:1,WRITE:2,CAS:3,FETCH_ADD:4,SYSCALL:5});
  const STEP=Object.freeze({OK:0,FAULT:1,UNSUPPORTED:2,SYSCALL:3});
  const REASON=Object.freeze({NONE:0,RANGE:1,UNMAPPED:2,PROTECTION:3,ALIGNMENT:4,ALLOCATION:5,
    OPCODE:16,WIDTH:17,PROTOCOL:18,CHECKPOINT:19,STALE_LEASE:20,SEQUENCE:21,ACCESS:22,ADDRESS_DOMAIN:23});
  const memories=new WeakSet(),registeredMemories=new WeakSet(),owners=new WeakMap(),brokers=new WeakMap(),waits=new WeakMap();
  const U64=1n<<64n;
  function u64(value) {
    if(typeof value!=='bigint'||value<-(1n<<63n)||value>=U64)throw new TypeError('Exact i64 BigInt required');
    return BigInt.asUintN(64,value);
  }
  function createInternalMemory() {
    const memory=new WebAssembly.Memory({initial:ABI.internalPages,maximum:ABI.internalPages,shared:true});
    memories.add(memory);return memory;
  }
  class BrokerInvariantError extends Error {
    constructor(message){super(message);this.name='BrokerInvariantError';}
  }
  function invariant(s,message) {s.poisoned=true;throw new BrokerInvariantError(message);}
  function current(broker,token) {
    const s=owners.get(token),b=brokers.get(broker);
    return s&&s.broker===broker&&b.slots.get(s.slot)===s&&!s.closed?s:null;
  }
  function requireOwner(broker,token) {
    const s=current(broker,token);
    if(!s)throw new BrokerInvariantError('Retired or foreign thread registration');
    if(s.poisoned)throw new BrokerInvariantError('Thread registration failed an invariant');
    return s;
  }
  function layoutFor(layout) {
    if(!layout||layout.version!==ABI.checkpointVersion)throw new TypeError('Checkpoint layout version 1 required');
    const spans=['cpu','lazyFlags','roundMode'].map(name=>{
      const p=layout[name];
      if(!p||!Number.isSafeInteger(p.offset)||!Number.isSafeInteger(p.size)||p.offset<0||p.size<=0||
         p.offset+p.size>ABI.threadBytes)throw new TypeError('Invalid checkpoint span');
      return Object.freeze({name,offset:p.offset,size:p.size});
    });
    if(spans[1].size!==24||spans[2].size!==4||!Number.isSafeInteger(layout.cpu.ripOffset)||
       layout.cpu.ripOffset<0||layout.cpu.ripOffset+8>spans[0].size)throw new TypeError('Invalid architectural checkpoint');
    const all=[...spans,{offset:ABI.scratchOffset,size:ABI.scratchBytes}].sort((a,b)=>a.offset-b.offset);
    for(let i=1;i<all.length;i++)if(all[i-1].offset+all[i-1].size>all[i].offset)
      throw new TypeError('Checkpoint and scratch spans must be disjoint');
    return {spans,ripAddress:ABI.threadBase+spans[0].offset+layout.cpu.ripOffset};
  }
  function cpuRip(s){return s.view.getBigUint64(s.layout.ripAddress,true);}
  function restore(s) {
    for(const p of s.active.snapshot)new Uint8Array(s.memory.buffer,ABI.threadBase+p.offset,p.bytes.length).set(p.bytes);
  }
  function response(s,sequence,status,reason=REASON.NONE,data=0n,faultAddress=0n) {
    const v=s.scratch;
    v.setUint32(FIELD.status,status,true);v.setUint32(FIELD.reason,reason,true);
    v.setBigUint64(FIELD.result0,data,true);v.setBigUint64(FIELD.result1,0n,true);
    v.setBigUint64(FIELD.faultAddress,faultAddress,true);
    v.setBigUint64(FIELD.checkpointRip,s.active?.rip??0n,true);
    v.setBigUint64(FIELD.nextRip,0n,true);v.setUint32(FIELD.boundaryControl,0,true);
    // The transport publishes S_DONE only after this method returns.
    v.setUint32(FIELD.completedSequence,sequence,true);
    const result=Object.freeze({status,reason,data,faultAddress,rip:s.active?.rip??0n});
    if(s.active)s.active.result=result;
    const b=brokers.get(s.broker);b[status===STATUS.OK?'ok':status===STATUS.FAULT?'faults':'unsupported']++;
    return Object.freeze({accepted:true,...result});
  }
  function futexKey(identity) {
    return identity.kind==='private'?'p:'+identity.spaceId+':'+identity.guestAddress.toString(16):
      's:'+identity.objectId+':'+identity.page+':'+identity.byteOffset;
  }
  function finishWait(b,rec,result,notify,deferred) {
    if(rec.done)return false;
    rec.done=true;const q=b.queues.get(rec.key),i=q.indexOf(rec);q.splice(i,1);if(!q.length)b.queues.delete(rec.key);
    rec.owner.waits.delete(rec);waits.delete(rec.handle);rec.pin.close();rec.pin=null;b.waiting--;b.completed++;
    const complete=()=>{rec.onClose?.();if(notify&&!rec.owner.poisoned&&current(rec.owner.broker,rec.token)===rec.owner)rec.complete(result);};
    if(deferred)deferred.push(complete);else complete();
    return true;
  }
  class GuestMemoryBroker {
    constructor(){brokers.set(this,{slots:new Map(),nextLease:1n,requests:0,ok:0,faults:0,unsupported:0,rejected:0,
      queues:new Map(),waiting:0,queued:0,completed:0});}
    register(slot,{space,memory,checkpointLayout}) {
      const b=brokers.get(this);
      if(!Number.isSafeInteger(slot)||slot<0||b.slots.has(slot))throw new TypeError('Unoccupied trusted thread slot required');
      if(!(space instanceof storage.GuestAddressSpace)||space.stats().closed)throw new TypeError('Live GuestAddressSpace required');
      if(!memories.has(memory)||registeredMemories.has(memory)||memory.buffer.byteLength!==ABI.internalPages*65536)
        throw new TypeError('Fresh bounded internal memory required');
      const layout=layoutFor(checkpointLayout);
      if(b.nextLease>=U64)throw new BrokerInvariantError('Thread lease exhausted');
      const generation=b.nextLease++,token=Object.freeze({generation});
      const s={broker:this,slot,generation,space,memory,layout,view:new DataView(memory.buffer),
        scratch:new DataView(memory.buffer,ABI.threadBase+ABI.scratchOffset,ABI.scratchBytes),
        lastSequence:0,checkpoint:0n,active:null,closed:false,poisoned:false,waits:new Set()};
      new Uint8Array(memory.buffer,ABI.threadBase+ABI.scratchOffset,ABI.scratchBytes).fill(0);
      s.scratch.setUint32(FIELD.magic,ABI.magic,true);s.scratch.setUint32(FIELD.version,ABI.version,true);
      s.scratch.setBigUint64(FIELD.lease,generation,true);
      registeredMemories.add(memory);owners.set(token,s);b.slots.set(slot,s);return token;
    }
    unregister(token) {
      const s=current(this,token);if(!s)return false;
      for(const rec of [...s.waits])finishWait(brokers.get(this),rec,-4n,false);
      brokers.get(this).slots.delete(s.slot);owners.delete(token);s.closed=true;s.active=null;return true;
    }
    // Called at a safe boundary after native code has spilled the full CPU state.
    // operation/width must come from compile-time admission, never guest input.
    beginInstruction(token,{rip,operation=0,width=0}) {
      const s=requireOwner(this,token);rip=u64(rip);
      if(s.active||s.waits.size)invariant(s,'Instruction already active or parked');
      if(!(([0,OP.SYSCALL].includes(operation)&&width===0)||([OP.READ,OP.WRITE].includes(operation)&&[1,2,4,8].includes(width))||
           ([OP.CAS,OP.FETCH_ADD].includes(operation)&&[4,8].includes(width))))
        throw new TypeError('Unsupported instruction admission');
      if(cpuRip(s)!==rip)invariant(s,'Full pre-instruction RIP was not spilled');
      if(s.checkpoint===U64-1n)invariant(s,'Checkpoint generation exhausted');
      const snapshot=s.layout.spans.map(p=>({offset:p.offset,
        bytes:new Uint8Array(s.memory.buffer,ABI.threadBase+p.offset,p.size).slice()}));
      s.active={rip,generation:++s.checkpoint,operation,width,snapshot,result:null};return s.checkpoint;
    }
    // The caller uses its authenticated thread record's token, not a request PID.
    // This synchronous route has no syscall, signal, redirect or await callbacks.
    dispatch(token,{lease,sequence}) {
      const b=brokers.get(this),s=current(this,token);
      if(!s||lease!==s.generation){b.rejected++;return Object.freeze({accepted:false,reason:REASON.STALE_LEASE});}
      if(s.poisoned)throw new BrokerInvariantError('Thread registration failed an invariant');
      if(!Number.isInteger(sequence)||sequence<=0||sequence>0xffffffff||sequence!==s.lastSequence+1) {
        b.rejected++;return Object.freeze({accepted:false,reason:REASON.SEQUENCE});
      }
      if(s.active?.result)invariant(s,'More than one memory request in an admitted instruction');
      const q=new DataView(new Uint8Array(s.memory.buffer,ABI.threadBase+ABI.scratchOffset,ABI.scratchBytes).slice().buffer);
      s.lastSequence=sequence;b.requests++;
      const fail=reason=>response(s,sequence,STATUS.UNSUPPORTED,reason);
      if(q.getUint32(FIELD.magic,true)!==ABI.magic||q.getUint32(FIELD.version,true)!==ABI.version||
         q.getUint32(FIELD.sequence,true)!==sequence||q.getBigUint64(FIELD.lease,true)!==lease)return fail(REASON.PROTOCOL);
      const operation=q.getUint32(FIELD.operation,true),width=q.getUint32(FIELD.width,true),access=q.getUint32(FIELD.access,true);
      if(![OP.READ,OP.WRITE,OP.CAS,OP.FETCH_ADD].includes(operation))return fail(REASON.OPCODE);
      if(![1,2,4,8].includes(width)||([OP.CAS,OP.FETCH_ADD].includes(operation)&&![4,8].includes(width)))return fail(REASON.WIDTH);
      if(access!==(operation===OP.READ?storage.PROT.READ:operation===OP.WRITE?storage.PROT.WRITE:storage.PROT.READ|storage.PROT.WRITE))
        return fail(REASON.ACCESS);
      const a=s.active;
      if(!a||q.getBigUint64(FIELD.rip,true)!==a.rip||q.getBigUint64(FIELD.checkpoint,true)!==a.generation||
         operation!==a.operation||width!==a.width)return fail(REASON.CHECKPOINT);
      const address=q.getBigUint64(FIELD.address,true);
      if([OP.CAS,OP.FETCH_ADD].includes(operation)&&address%BigInt(width))return fail(REASON.ALIGNMENT);
      try {
        if(operation===OP.CAS||operation===OP.FETCH_ADD) {
          const old=operation===OP.CAS?s.space.compareExchange(address,width,q.getBigUint64(FIELD.operand0,true),q.getBigUint64(FIELD.operand1,true)):
            s.space.fetchAdd(address,width,q.getBigUint64(FIELD.operand0,true));
          return response(s,sequence,STATUS.OK,REASON.NONE,old);
        }
        if(operation===OP.READ) {
          const bytes=s.space.read(address,width);let value=0n;
          for(let i=width-1;i>=0;i--)value=(value<<8n)|BigInt(bytes[i]);
          return response(s,sequence,STATUS.OK,REASON.NONE,value);
        }
        let value=q.getBigUint64(FIELD.operand0,true);const bytes=new Uint8Array(width);
        for(let i=0;i<width;i++){bytes[i]=Number(value&255n);value>>=8n;}
        s.space.write(address,bytes);return response(s,sequence,STATUS.OK);
      } catch(error) {
        if(error instanceof storage.AllocationFailure)return response(s,sequence,STATUS.FAULT,REASON.ALLOCATION,0n,address);
        if(error instanceof storage.MemoryFault) {
          if(error.faultAddress<0n||error.faultAddress>=U64)return fail(REASON.ADDRESS_DOMAIN);
          const reason=({range:REASON.RANGE,unmapped:REASON.UNMAPPED,uncommitted:REASON.UNMAPPED,
            protection:REASON.PROTECTION,alignment:REASON.ALIGNMENT})[error.reason];
          if(reason!==undefined)return response(s,sequence,STATUS.FAULT,reason,0n,error.faultAddress);
        }
        invariant(s,'Unexpected storage failure: '+String(error));
      }
    }
    // Called only after STEP_* has returned and no guest Wasm locals remain live.
    finishInstruction(token,{status,nextRip}) {
      const s=requireOwner(this,token),a=s.active;
      if(!a)invariant(s,'No instruction checkpoint');
      if(status===STEP.OK) {
        nextRip=u64(nextRip);
        if((a.operation&&a.operation!==OP.SYSCALL&&a.result?.status!==STATUS.OK)||(!a.operation&&a.result)||
           a.operation===OP.SYSCALL||cpuRip(s)!==nextRip)
          invariant(s,'Full successful post-state was not spilled');
      } else if(status===STEP.SYSCALL) {
        nextRip=u64(nextRip);
        if(a.operation!==OP.SYSCALL||a.result||cpuRip(s)!==nextRip)invariant(s,'Invalid spilled syscall boundary');
      } else if(status===STEP.FAULT) {
        if(a.result?.status!==STATUS.FAULT)invariant(s,'STEP_FAULT without a typed memory fault');
        restore(s);nextRip=a.rip;
      } else if(status===STEP.UNSUPPORTED) {
        if(a.result&&a.result.status!==STATUS.UNSUPPORTED)invariant(s,'Unsupported instruction after a memory effect');
        restore(s);nextRip=a.rip;
      } else invariant(s,'Unknown step result');
      const result=Object.freeze({status,rip:nextRip,memory:a.result});s.active=null;return result;
    }
    // Called at a spilled syscall boundary. Comparison and enqueue have no
    // await/reply gap. Only the requester parks; the authority keeps running.
    waitFutex(token,{address,expected,private:priv=false},complete,onClose) {
      const s=requireOwner(this,token),b=brokers.get(this);
      if(s.active||s.waits.size)invariant(s,'Futex wait requires an idle spilled thread');
      if(typeof complete!=='function'||(onClose!==undefined&&typeof onClose!=='function'))throw new TypeError('Futex completion required');
      const value=Number(BigInt.asUintN(32,u64(expected))),pin=s.space.pinFutex(address,{private:priv});
      let queued=false;
      try {
        if(pin.value()!==value)return Object.freeze({parked:false,result:-11n});
        const key=futexKey(pin.identity),handle=Object.freeze({}),
          rec={owner:s,token,key,handle,pin,complete,onClose,done:false};
        let q=b.queues.get(key);if(!q)b.queues.set(key,q=[]);
        q.push(rec);s.waits.add(rec);waits.set(handle,rec);b.waiting++;b.queued++;queued=true;
        return Object.freeze({parked:true,handle});
      } finally {if(!queued)pin.close();}
    }
    wakeFutex(token,{address,count,private:priv=false}) {
      const s=requireOwner(this,token),b=brokers.get(this);
      if(s.active||s.waits.size)invariant(s,'Futex wake requires a runnable spilled thread');
      if(!Number.isInteger(count)||count<0||count>0x7fffffff)throw new TypeError('Invalid futex wake count');
      const pin=s.space.pinFutex(address,{private:priv});let key;
      try{key=futexKey(pin.identity);}finally{pin.close();}
      const selected=(b.queues.get(key)||[]).slice(0,count),deferred=[];
      for(const rec of selected)finishWait(b,rec,0n,true,deferred);
      for(const complete of deferred)complete();
      return selected.length;
    }
    cancelFutex(handle,result=-110n,{notify=true}={}) {
      const rec=waits.get(handle);
      if(!rec||rec.owner.broker!==this)return false;
      if(typeof result!=='bigint')throw new TypeError('Exact futex result required');
      return finishWait(brokers.get(this),rec,result,notify);
    }
    futexStats(){const b=brokers.get(this);return Object.freeze({waiting:b.waiting,queued:b.queued,completed:b.completed});}
    stats() {
      const b=brokers.get(this);return Object.freeze({threads:b.slots.size,requests:b.requests,ok:b.ok,
        faults:b.faults,unsupported:b.unsupported,rejected:b.rejected});
    }
  }
  root.BetterJITGuestMemoryBroker=Object.freeze({ABI,FIELD,STATUS,REASON,OP,STEP,createInternalMemory,
    BrokerInvariantError,GuestMemoryBroker});
})(typeof globalThis!=='undefined'?globalThis:self);
