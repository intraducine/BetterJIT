// SPDX-License-Identifier: GPL-3.0-or-later
// Experimental reference authority. Not loaded by the default Linux runtime.
(function(root) {
  'use strict';
  const storage=root.BetterJITGuestMemory;
  if(!storage||storage.STORAGE_VERSION!==1)throw new Error('Guest storage contract 1 required');
  const ABI=Object.freeze({version:1,checkpointVersion:1,stepVersion:3,coverageVersion:8,stepHeaderBytes:96,
    magic:0x314d4a42,internalPages:33,threadBase:0x10000,threadBytes:0x200000,
    scratchOffset:0x1f0000,scratchBytes:128,memoryRequest:0x10003,instructionBoundary:0x10004,maximumThreads:8,parkedState:4,
    userCopyBytes:65536});
  const FIELD=Object.freeze({magic:0,version:4,sequence:8,status:12,operation:16,width:20,access:24,reason:28,
    address:32,rip:40,checkpoint:48,operand0:56,operand1:64,result0:72,result1:80,faultAddress:88,
    checkpointRip:96,nextRip:104,completedSequence:112,boundaryControl:116,lease:120});
  const STATUS=Object.freeze({OK:0,FAULT:1,UNSUPPORTED:2});
  const OP=Object.freeze({READ:1,WRITE:2,CAS:3,FETCH_ADD:4,SYSCALL:5,FLAGS:6,BRANCH:7,READ_FLAGS:8,CALL:9,RETURN:10});
  const STEP=Object.freeze({OK:0,FAULT:1,UNSUPPORTED:2,SYSCALL:3});
  // Host startup gate / spilled syscall completion, separate from native step exits.
  const LIFECYCLE=Object.freeze({version:1,PENDING:0,READY:1,RUN:2,CANCEL:3,FAILED:4,syscallExit:4});
  const REASON=Object.freeze({NONE:0,RANGE:1,UNMAPPED:2,PROTECTION:3,ALIGNMENT:4,ALLOCATION:5,
    OPCODE:16,WIDTH:17,PROTOCOL:18,CHECKPOINT:19,STALE_LEASE:20,SEQUENCE:21,ACCESS:22,ADDRESS_DOMAIN:23,CONTROL_TARGET:24});
  const memories=new WeakSet(),registeredMemories=new WeakSet(),owners=new WeakMap(),brokers=new WeakMap(),waits=new WeakMap();
  const U64=1n<<64n;
  function u64(value) {
    if(typeof value!=='bigint'||value<-(1n<<63n)||value>=U64)throw new TypeError('Exact i64 BigInt required');
    return BigInt.asUintN(64,value);
  }
  function instructionContinuations(p) {
    const kind=p.continuationKind??0,target=p.branchTarget??0n;
    if(p.operation===OP.CALL) {
      const b=p.instruction;
      if(b.length!==5||b[0]!==0xe8||kind!==3||p.width!==8)throw new TypeError('Invalid direct call metadata');
      const next=p.rip+5n,expected=next+BigInt(new DataView(b.buffer,b.byteOffset,b.byteLength).getInt32(1,true));
      if(!canonical(p.rip)||p.nextRip!==next||!canonical(next)||!canonical(expected)||target!==expected)throw new TypeError('Invalid direct call target');
      return Object.freeze([target]);
    }
    if(p.operation===OP.RETURN) {
      if(p.instruction.length!==1||p.instruction[0]!==0xc3||kind!==4||target!==0n||p.width!==8||
         !canonical(p.rip)||p.nextRip!==p.rip+1n||!canonical(p.nextRip))throw new TypeError('Invalid checked return metadata');
      return Object.freeze([]); // resolved only from the broker-owned checked stack read
    }
    if(p.operation!==OP.BRANCH) {
      if(kind!==0||target!==0n)throw new TypeError('Unexpected branch metadata');
      return Object.freeze([p.nextRip]);
    }
    const b=p.instruction,v=new DataView(b.buffer,b.byteOffset,b.byteLength);let flow,offset;
    if(b.length===2&&[0x72,0x73,0x74,0x75,0x76,0x77,0x78,0x79,0xeb].includes(b[0])){flow=b[0]===0xeb?1:2;offset=BigInt(v.getInt8(1));}
    else if(b.length===5&&b[0]===0xe9){flow=1;offset=BigInt(v.getInt32(1,true));}
    else if(b.length===6&&b[0]===0x0f&&[0x82,0x83,0x84,0x85,0x86,0x87,0x88,0x89].includes(b[1])){flow=2;offset=BigInt(v.getInt32(2,true));}
    else throw new TypeError('Uncovered branch instruction');
    if(kind!==flow||typeof target!=='bigint'||target!==BigInt.asUintN(64,p.nextRip+offset))throw new TypeError('Invalid branch continuation');
    return Object.freeze(kind===1?[target]:[p.nextRip,target]);
  }
  function parseStepHeader(bytes) {
    if(!(bytes instanceof Uint8Array)||bytes.length!==ABI.stepHeaderBytes)throw new Error('Broker step header required');
    const v=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
    if(v.getUint32(0,true)!==0x31534a42||v.getUint32(4,true)!==ABI.version||
       v.getUint32(8,true)!==ABI.checkpointVersion||v.getUint32(12,true)!==ABI.stepVersion||
       v.getUint32(16,true)!==ABI.coverageVersion)throw new Error('Incompatible broker step ABI');
    const status=v.getUint32(20,true),operation=v.getUint32(24,true),width=v.getUint32(28,true),
      rip=v.getBigUint64(32,true),nextRip=v.getBigUint64(40,true),size=v.getUint32(56,true),length=v.getUint32(60,true);
    if(![0,2].includes(status)||
       (status===2&&(size||length))||(status===0&&(!size||length<1||length>15||nextRip!==rip+BigInt(length)||
         !(([0,5,6,7].includes(operation)&&width===0)||([1,2,8].includes(operation)&&[1,2,4,8].includes(width))||
           ([3,4].includes(operation)&&[4,8].includes(width))||([9,10].includes(operation)&&width===8)))))
      throw new Error('Invalid broker step metadata');
    if(v.getUint32(92,true)!==0)throw new Error('Invalid broker step reserved field');
    const result={status,operation,width,rip,nextRip,length,hash:v.getBigUint64(48,true),
      continuationKind:v.getUint32(88,true),branchTarget:v.getBigUint64(80,true),
      instruction:bytes.slice(64,64+length),codeBytes:size};
    if(status===0)try{result.continuations=instructionContinuations(result);}catch(error){throw new Error('Invalid broker continuation metadata: '+error.message);}
    return result;
  }

  function createInternalMemory() {
    const memory=new WebAssembly.Memory({initial:ABI.internalPages,maximum:ABI.internalPages,shared:true});
    memories.add(memory);return memory;
  }
  function canonical(value){return typeof value==='bigint'&&value>=0n&&value<(1n<<47n);}
  class BrokerInvariantError extends Error {
    constructor(message){super(message);this.name='BrokerInvariantError';}
  }
  class UserCopyUnsupported extends Error {
    constructor(){super('User copy exceeds the bounded transfer limit');this.name='UserCopyUnsupported';}
  }
  function copyLength(length) {
    if(typeof length==='number') {
      if(!Number.isSafeInteger(length))throw new TypeError('Exact user copy length required');
      length=BigInt(length);
    }
    if(typeof length!=='bigint'||length<0n)throw new TypeError('Nonnegative user copy length required');
    if(length>BigInt(ABI.userCopyBytes))throw new UserCopyUnsupported();
    return Number(length);
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
  function userOwner(broker,token,prepared=false) {
    const s=requireOwner(broker,token);
    if(!s.spilledSyscall||s.active||s.waits.size)throw new BrokerInvariantError('User copy requires a runnable spilled syscall boundary');
    if(!prepared&&s.preparedCopies.size)throw new BrokerInvariantError('Prepared copyout must complete first');
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
    const sp=layout.cpu.stackPointerOffset;
    if(sp!==undefined&&(!Number.isSafeInteger(sp)||sp<0||sp%8||sp+8>layout.cpu.size||
       (sp<layout.cpu.ripOffset+8&&sp+8>layout.cpu.ripOffset)))throw new TypeError('Invalid stack pointer checkpoint offset');
    return {spans,ripAddress:ABI.threadBase+spans[0].offset+layout.cpu.ripOffset,
      stackAddress:sp===undefined?undefined:ABI.threadBase+spans[0].offset+sp};
  }
  function cpuRip(s){return s.view.getBigUint64(s.layout.ripAddress,true);}
  function restore(s,snapshot=s.active.snapshot) {
    for(const p of snapshot)new Uint8Array(s.memory.buffer,ABI.threadBase+p.offset,p.bytes.length).set(p.bytes);
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
        lastSequence:0,checkpoint:0n,active:null,spilledSyscall:false,closed:false,poisoned:false,waits:new Set(),preparedCopies:new Set()};
      new Uint8Array(memory.buffer,ABI.threadBase+ABI.scratchOffset,ABI.scratchBytes).fill(0);
      s.scratch.setUint32(FIELD.magic,ABI.magic,true);s.scratch.setUint32(FIELD.version,ABI.version,true);
      s.scratch.setBigUint64(FIELD.lease,generation,true);
      registeredMemories.add(memory);owners.set(token,s);b.slots.set(slot,s);return token;
    }
    unregister(token) {
      const s=current(this,token);if(!s)return false;
      for(const rec of [...s.preparedCopies])rec.cancel();
      for(const rec of [...s.waits])finishWait(brokers.get(this),rec,-4n,false);
      brokers.get(this).slots.delete(s.slot);owners.delete(token);s.closed=true;s.active=null;s.syscallCheckpoint=null;return true;
    }
    // Called at a safe boundary after native code has spilled the full CPU state.
    // operation/width must come from compile-time admission, never guest input.
    beginInstruction(token,{rip,operation=0,width=0,continuations,nextRip}) {
      const s=requireOwner(this,token);rip=u64(rip);
      if(s.preparedCopies.size)throw new BrokerInvariantError('Prepared copyout must complete before BEGIN');
      if(s.active||s.waits.size)invariant(s,'Instruction already active or parked');
      s.spilledSyscall=false;s.syscallCheckpoint=null;
      if(!(([0,OP.SYSCALL,OP.FLAGS,OP.BRANCH].includes(operation)&&width===0)||([OP.READ,OP.WRITE,OP.READ_FLAGS].includes(operation)&&[1,2,4,8].includes(width))||
           ([OP.CAS,OP.FETCH_ADD].includes(operation)&&[4,8].includes(width))||([OP.CALL,OP.RETURN].includes(operation)&&width===8)))
        throw new TypeError('Unsupported instruction admission');
      if(operation===OP.BRANCH||operation===OP.CALL) {
        if(!Array.isArray(continuations)||continuations.length<1||continuations.length>2)throw new TypeError('Finite branch continuations required');
        continuations=Object.freeze(continuations.map(u64));
      }
      let stackBefore,stackAfter;
      if(operation===OP.CALL||operation===OP.RETURN) {
        if(s.layout.stackAddress===undefined||!canonical(rip)||nextRip!==rip+(operation===OP.CALL?5n:1n)||!canonical(nextRip)||
           (operation===OP.CALL&&(continuations.length!==1||!canonical(continuations[0])))||
           (operation===OP.RETURN&&continuations!==undefined&&(!Array.isArray(continuations)||continuations.length)))throw new TypeError('Checked stack control metadata required');
        stackBefore=s.view.getBigUint64(s.layout.stackAddress,true);
        stackAfter=stackBefore+(operation===OP.CALL?-8n:8n);
      }
      if(cpuRip(s)!==rip)invariant(s,'Full pre-instruction RIP was not spilled');
      if(s.checkpoint===U64-1n)invariant(s,'Checkpoint generation exhausted');
      const snapshot=s.layout.spans.map(p=>({offset:p.offset,
        bytes:new Uint8Array(s.memory.buffer,ABI.threadBase+p.offset,p.size).slice()}));
      s.active={rip,generation:++s.checkpoint,operation,width,continuations,snapshot,result:null,nextRip,stackBefore,stackAfter};return s.checkpoint;
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
         operation!==([OP.READ_FLAGS,OP.RETURN].includes(a.operation)?OP.READ:a.operation===OP.CALL?OP.WRITE:a.operation)||width!==a.width)return fail(REASON.CHECKPOINT);
      const address=q.getBigUint64(FIELD.address,true);
      if(a.operation===OP.CALL||a.operation===OP.RETURN) {
        if(!canonical(a.stackBefore)||!canonical(a.stackAfter))return fail(REASON.ADDRESS_DOMAIN);
        if(address!==(a.operation===OP.CALL?a.stackAfter:a.stackBefore)||
           (a.operation===OP.CALL&&q.getBigUint64(FIELD.operand0,true)!==a.nextRip))return fail(REASON.CHECKPOINT);
        if(a.operation===OP.CALL)try{s.space.executableSnapshot(a.continuations[0],1);s.space.read(a.continuations[0],1);}catch(error){
          if(error instanceof storage.MemoryFault)return fail(REASON.CONTROL_TARGET);throw error;
        }
      }
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
          if(a.operation===OP.RETURN) {
            if(!canonical(value))return fail(REASON.CONTROL_TARGET);
            try{s.space.executableSnapshot(value,1);s.space.read(value,1);}catch(error){
              if(error instanceof storage.MemoryFault)return fail(REASON.CONTROL_TARGET);throw error;
            }
          }
          return response(s,sequence,STATUS.OK,REASON.NONE,value);
        }
        let value=q.getBigUint64(FIELD.operand0,true);const bytes=new Uint8Array(width);
        for(let i=0;i<width;i++){bytes[i]=Number(value&255n);value>>=8n;}
        if(a.operation===OP.CALL) {
          // COW preparation can call the trusted allocator. Recheck ownership
          // after it returns, before publishing the return-address bytes.
          const tx=s.space.prepareWrite(address,width);
          try {
            if(current(this,token)!==s||s.active!==a||s.poisoned)invariant(s,'Stack write owner changed during preparation');
            tx.bytes.set(bytes);tx.commit();
          }finally{tx.cancel();}
        }else s.space.write(address,bytes);
        return response(s,sequence,STATUS.OK);
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
        const control=[OP.BRANCH,OP.CALL,OP.RETURN].includes(a.operation);
        nextRip=control?cpuRip(s):u64(nextRip);
        if(([OP.BRANCH,OP.CALL].includes(a.operation)&&!a.continuations.includes(nextRip))||
           (a.operation===OP.RETURN&&nextRip!==a.result?.data)||
           ([OP.CALL,OP.RETURN].includes(a.operation)&&s.view.getBigUint64(s.layout.stackAddress,true)!==a.stackAfter)||
           ([OP.READ,OP.WRITE,OP.CAS,OP.FETCH_ADD,OP.READ_FLAGS,OP.CALL,OP.RETURN].includes(a.operation)&&a.result?.status!==STATUS.OK)||
           ([0,OP.FLAGS,OP.BRANCH].includes(a.operation)&&a.result)||
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
      const result=Object.freeze({status,rip:nextRip,memory:a.result});
      s.active=null;s.spilledSyscall=status===STEP.SYSCALL;s.syscallCheckpoint=s.spilledSyscall?a:null;return result;
    }
    // Refuse a prepared-but-unsupported exec before any irreversible effect.
    abortSpilledSyscall(token) {
      const s=userOwner(this,token);
      if(s.preparedCopies.size||!s.syscallCheckpoint)throw new BrokerInvariantError('No abortable syscall checkpoint');
      const a=s.syscallCheckpoint;restore(s,a.snapshot);s.spilledSyscall=false;s.syscallCheckpoint=null;
      return Object.freeze({status:STEP.UNSUPPORTED,rip:a.rip,memory:null});
    }
    // Kernel copyin/copyout only, after Wasm has fully unwound. These never
    // return backing views and do not consume a memory-RPC sequence or call I/O.
    copyIn(token,address,length) {
      const s=userOwner(this,token);return s.space.read(u64(address),copyLength(length));
    }
    copyOut(token,address,bytes) {
      const s=userOwner(this,token);address=u64(address);
      if(!(bytes instanceof Uint8Array)||!(bytes.buffer instanceof ArrayBuffer)||bytes.buffer.resizable)
        throw new TypeError('Fixed ordinary user copy bytes required');
      copyLength(bytes.byteLength);
      // Snapshot before storage allocation callbacks; write() validates all
      // pages and stages every private-view detachment before publishing bytes.
      s.space.write(address,new Uint8Array(bytes));
    }
    readUserU64(token,address) {
      const bytes=this.copyIn(token,address,8);return new DataView(bytes.buffer,bytes.byteOffset,8).getBigUint64(0,true);
    }
    prepareCopyOut(token,address,length) {
      const s=userOwner(this,token),tx=s.space.prepareWrite(u64(address),copyLength(length));
      // A custom frame allocator can retire the registration during preparation.
      try{userOwner(this,token);}catch(error){tx.cancel();throw error;}
      const rec={open:true,cancel:()=>{
        if(!rec.open)return false;rec.open=false;s.preparedCopies.delete(rec);tx.cancel();return true;
      }};
      s.preparedCopies.add(rec);
      const guard=(commit,count)=>{
        try {
          userOwner(this,token,true);
          if(!rec.open||!s.preparedCopies.has(rec))throw new BrokerInvariantError('Prepared copyout is closed');
          if(!commit)return tx.validate();
          const n=tx.commit(count);rec.open=false;s.preparedCopies.delete(rec);return n;
        }catch(error){rec.cancel();throw error;}
      };
      return Object.freeze({bytes:tx.bytes,length:tx.length,cancel:rec.cancel,
        validate:()=>guard(false),commit:count=>guard(true,count)});
    }
    assertCopiesComplete(token) {
      if(requireOwner(this,token).preparedCopies.size)throw new BrokerInvariantError('Prepared copyout must complete before syscall reply');
    }
    // Called at a spilled syscall boundary. Comparison and enqueue have no
    // await/reply gap. Only the requester parks; the authority keeps running.
    waitFutex(token,{address,expected,private:priv=false},complete,onClose) {
      const s=requireOwner(this,token),b=brokers.get(this);
      if(s.preparedCopies.size)throw new BrokerInvariantError('Prepared copyout cannot park');
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
      if(s.preparedCopies.size)throw new BrokerInvariantError('Prepared copyout must complete before wake');
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
  root.BetterJITGuestMemoryBroker=Object.freeze({ABI,FIELD,STATUS,REASON,OP,STEP,LIFECYCLE,instructionContinuations,parseStepHeader,createInternalMemory,
    BrokerInvariantError,UserCopyUnsupported,GuestMemoryBroker});
})(typeof globalThis!=='undefined'?globalThis:self);
