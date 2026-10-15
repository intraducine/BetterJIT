// SPDX-License-Identifier: GPL-3.0-or-later
// Experimental kernel-owned storage contract. No default runtime integration.
(function(root) {
  'use strict';
  const PAGE=4096, P=BigInt(PAGE), U64=1n<<64n;
  const PROT=Object.freeze({NONE:0,READ:1,WRITE:2,EXEC:4});
  const budgets=new WeakMap(),backings=new WeakMap(),spaces=new WeakMap(),liveBuffers=new WeakSet();
  let nextSpace=1,nextObject=1,nextFrame=1;

  class MemoryFault extends Error {
    constructor(reason,address,width,access,faultAddress=address) {
      super('Guest memory '+reason);this.name='MemoryFault';
      Object.assign(this,{reason,guestAddress:address,width,access,faultAddress});
    }
  }
  class AllocationFailure extends Error {
    constructor(reason) {super('Guest backing allocation failed: '+reason);this.name='AllocationFailure';this.reason=reason;}
  }
  class PreparedWriteConflict extends Error {
    constructor(message){super(message);this.name='PreparedWriteConflict';}
  }
  function writeReady(s) {
    if(s.preparing||s.pending)throw new PreparedWriteConflict('Address space has a prepared write');
  }
  function cancelPrepared(s,rec) {
    if(!rec.live)return false;
    rec.live=false;if(s.pending===rec)s.pending=null;
    for(const p of rec.parts)if(p.staged&&!p.published)release(p.staged.frame);
    return true;
  }
  function integer(value,label) {
    if(typeof value==='number') {
      if(!Number.isSafeInteger(value))throw new TypeError(label+' must be an exact integer');
      return BigInt(value);
    }
    if(typeof value!=='bigint')throw new TypeError(label+' must be an integer');
    return value;
  }
  function address(value) {
    const n=integer(value,'Address');
    if(n<-(1n<<63n)||n>=U64)throw new MemoryFault('range',n,0,'address');
    return n<0?U64+n:n; // Wasm i64 arrives as signed JS BigInt; preserve its bits.
  }
  function protection(prot) {
    if(!Number.isInteger(prot)||prot<0||prot>7)throw new TypeError('Invalid protection');
    return prot;
  }
  function frameAllocate(budget,kind,initial) {
    const b=budgets.get(budget);b.attempts++;
    if(b.frames.size*PAGE+PAGE>b.limit){b.failures++;throw new AllocationFailure('budget');}
    let data;
    try {data=b.allocatePage(PAGE);}catch(error){b.failures++;throw new AllocationFailure('allocator');}
    if(!(data instanceof Uint8Array)||!(data.buffer instanceof ArrayBuffer)||data.buffer.resizable||
       data.byteLength!==PAGE||data.byteOffset||data.buffer.byteLength!==PAGE||liveBuffers.has(data.buffer)) {
      b.failures++;throw new AllocationFailure('invalid or aliased allocator page');
    }
    data.fill(0);if(initial)data.set(initial);
    const frame={id:nextFrame++,budget,kind,data,refs:1,revision:0};
    b.frames.set(frame.id,frame);liveBuffers.add(data.buffer);b.allocations++;
    b.peak=Math.max(b.peak,b.frames.size*PAGE);return frame;
  }
  function retain(frame){frame.refs++;return frame;}
  function release(frame) {
    if(--frame.refs<0)throw new Error('Guest backing reference underflow');
    if(frame.refs)return;
    const b=budgets.get(frame.budget);b.frames.delete(frame.id);liveBuffers.delete(frame.data.buffer);
    frame.data.fill(0);frame.data=null;
  }
  class BackingBudget {
    constructor({limitBytes=64*1024*1024,allocatePage=bytes=>new Uint8Array(bytes)}={}) {
      if(!Number.isSafeInteger(limitBytes)||limitBytes<0||limitBytes%PAGE||typeof allocatePage!=='function')
        throw new TypeError('Budget must be a nonnegative whole number of pages');
      budgets.set(this,{limit:limitBytes,allocatePage,frames:new Map(),peak:0,attempts:0,failures:0,allocations:0});
    }
    stats() {
      const b=budgets.get(this),frames=[...b.frames.values()];
      return Object.freeze({limitBytes:b.limit,ownedPayloadBytes:frames.length*PAGE,
        privateFrames:frames.filter(f=>f.kind==='private').length,sharedFrames:frames.filter(f=>f.kind==='shared').length,
        references:frames.reduce((n,f)=>n+f.refs,0),peakPayloadBytes:b.peak,
        allocationAttempts:b.attempts,allocationFailures:b.failures,totalAllocations:b.allocations});
    }
  }
  class SharedBacking {
    constructor(budget,byteLength) {
      if(!budgets.has(budget))throw new TypeError('BackingBudget required');
      const length=integer(byteLength,'Backing length');
      if(length<=0n||length%P||length>BigInt(Number.MAX_SAFE_INTEGER))throw new TypeError('Invalid backing length');
      const frames=[];
      try {for(let off=0n;off<length;off+=P)frames.push(frameAllocate(budget,'shared'));}
      catch(error){for(const f of frames)release(f);throw error;}
      backings.set(this,{budget,length,frames,id:nextObject++,closed:false});
    }
    close() {
      const s=backings.get(this);if(s.closed)return;s.closed=true;
      for(const f of s.frames)release(f);s.frames=[];
    }
  }
  function range(s,at,length,access,aligned=false) {
    const start=address(at),len=integer(length,'Length'),end=start+len;
    if(s.closed)throw new MemoryFault('closed',start,len,access);
    if(len<0n||start<s.minimum||end>s.limit||end<start)
      throw new MemoryFault('range',start,len,access,
        len>=0n&&start>=s.minimum&&start<s.limit&&end>s.limit?s.limit:start);
    if(aligned&&(!len||start%P||len%P))throw new TypeError('Mapping range must contain aligned whole pages');
    return {start,end,len};
  }
  function covered(s,r,access,required=0) {
    let at=r.start;
    for(const v of s.regions) {
      if(v.end<=at)continue;if(v.start>at)break;
      if((v.prot&required)!==required)throw new MemoryFault('protection',r.start,r.len,access,at);
      at=v.end<r.end?v.end:r.end;if(at===r.end)return;
    }
    if(at!==r.end)throw new MemoryFault('unmapped',r.start,r.len,access,at);
  }
  function overlaps(s,r){return s.regions.some(v=>v.start<r.end&&r.start<v.end);}
  function regionsReplace(s,r,prot) {
    const next=[];
    for(const v of s.regions) {
      if(v.end<=r.start||v.start>=r.end){next.push(v);continue;}
      if(v.start<r.start)next.push({...v,end:r.start});
      if(v.end>r.end)next.push({...v,start:r.end});
    }
    if(prot!==null)next.push({start:r.start,end:r.end,prot});
    next.sort((a,b)=>a.start<b.start?-1:a.start>b.start?1:0);
    s.regions=[];
    for(const v of next){const last=s.regions.at(-1);if(last&&last.end===v.start&&last.prot===v.prot)last.end=v.end;else s.regions.push(v);}
  }
  function dropPages(s,r) {
    for(const [page,pte]of s.pages)if(page>=r.start&&page<r.end){s.pages.delete(page);release(pte.frame);}
  }
  function segments(s,r,access,required) {
    if(!r.len)return [];
    covered(s,r,access,required);const result=[];
    for(let at=r.start;at<r.end;) {
      const page=at-at%P,pte=s.pages.get(page),end=page+P<r.end?page+P:r.end;
      if(!pte)throw new MemoryFault('uncommitted',r.start,r.len,access,at);
      result.push({page,pte,offset:Number(at-page),length:Number(end-at)});at=end;
    }
    return result;
  }
  function stagePages(s,r,prot,missingOnly=false) {
    const staged=[];if(!prot)return staged;
    try {
      for(let page=r.start;page<r.end;page+=P)if(!missingOnly||!s.pages.has(page))
        staged.push([page,{frame:frameAllocate(s.budget,'private'),kind:'private'}]);
      return staged;
    }catch(error){for(const [,p]of staged)release(p.frame);throw error;}
  }
  function atomicScalar(space,at,width,kind,operand,desired=0n) {
    if(![4,8].includes(width))throw new TypeError('Atomic width must be 4 or 8');
    const s=spaces.get(space);writeReady(s);const r=range(s,at,width,'atomic');
    segments(s,r,'atomic',PROT.READ|PROT.WRITE); // includes failed compare/exchange write intent
    const before=space.read(r.start,width);let old=0n;
    for(let i=width-1;i>=0;i--)old=old<<8n|BigInt(before[i]);
    operand=BigInt.asUintN(width*8,integer(operand,'Atomic operand'));
    let value=kind==='add'?BigInt.asUintN(width*8,old+operand):old===operand?
      BigInt.asUintN(width*8,integer(desired,'Atomic desired value')):old;
    const bytes=new Uint8Array(width);for(let i=0;i<width;i++){bytes[i]=Number(value&255n);value>>=8n;}
    // The entire operation is synchronous on the authority. Always perform
    // the compare/exchange write, even on mismatch, including COW validation.
    space.write(r.start,bytes);return old;
  }
  class GuestAddressSpace {
    constructor(budget,{virtualLimit=0xffff0000n,minimumAddress=0x10000n}={}) {
      if(!budgets.has(budget))throw new TypeError('BackingBudget required');
      const limit=integer(virtualLimit,'Virtual limit'),minimum=integer(minimumAddress,'Minimum address');
      if(limit>U64||minimum<0n||minimum>=limit||limit%P||minimum%P)throw new TypeError('Invalid virtual window');
      spaces.set(this,{budget,limit,minimum,id:nextSpace++,regions:[],pages:new Map(),closed:false,preparing:false,pending:null});
    }
    mapAnonymous(at,length,prot=PROT.READ|PROT.WRITE,{replace=false}={}) {
      const s=spaces.get(this);writeReady(s);const r=range(s,at,length,'map',true);protection(prot);
      if(!replace&&overlaps(s,r))throw new MemoryFault('overlap',r.start,r.len,'map');
      const staged=stagePages(s,r,prot); // Old mappings survive any allocation failure.
      dropPages(s,r);regionsReplace(s,r,prot);for(const [p,e]of staged)s.pages.set(p,e);
      return r.start;
    }
    reserve(at,length){return this.mapAnonymous(at,length,PROT.NONE);}
    commit(at,length,prot=PROT.READ|PROT.WRITE){return this.protect(at,length,prot);}
    protect(at,length,prot) {
      const s=spaces.get(this);writeReady(s);const r=range(s,at,length,'protect',true);protection(prot);covered(s,r,'protect');
      const staged=stagePages(s,r,prot,true);
      regionsReplace(s,r,prot);for(const [p,e]of staged)s.pages.set(p,e);return r.start;
    }
    decommit(at,length) {
      const s=spaces.get(this);writeReady(s);const r=range(s,at,length,'decommit',true);covered(s,r,'decommit');
      for(const [p,e]of s.pages)if(p>=r.start&&p<r.end&&e.kind!=='private')
        throw new MemoryFault('unsupported-shared-decommit',r.start,r.len,'decommit',p);
      dropPages(s,r);regionsReplace(s,r,PROT.NONE);
    }
    unmap(at,length) {
      const s=spaces.get(this);writeReady(s);const r=range(s,at,length,'unmap',true);
      dropPages(s,r);regionsReplace(s,r,null);
    }
    mapShared(at,length,backing,offset=0n,{prot=PROT.READ|PROT.WRITE,privateView=false,replace=false}={}) {
      const s=spaces.get(this);writeReady(s);const r=range(s,at,length,'map-shared',true),b=backings.get(backing);
      const off=integer(offset,'Backing offset');protection(prot);
      if(!b||b.closed||b.budget!==s.budget||off<0n||off%P||off+r.len>b.length)throw new TypeError('Invalid shared backing range');
      if(!replace&&overlaps(s,r))throw new MemoryFault('overlap',r.start,r.len,'map-shared');
      const staged=[];
      for(let p=r.start,o=off;p<r.end;p+=P,o+=P)staged.push([p,{frame:retain(b.frames[Number(o/P)]),
        kind:privateView?'private-view':'shared',objectId:b.id,objectOffset:o}]);
      dropPages(s,r);regionsReplace(s,r,prot);for(const [p,e]of staged)s.pages.set(p,e);return r.start;
    }
    read(at,length,{execute=false}={}) {
      const s=spaces.get(this),r=range(s,at,length,execute?'execute':'read');
      if(r.len>BigInt(Number.MAX_SAFE_INTEGER))throw new TypeError('Read result is too large');
      const parts=segments(s,r,execute?'execute':'read',execute?PROT.EXEC:PROT.READ);
      const bytes=new Uint8Array(Number(r.len));let off=0;
      for(const p of parts){bytes.set(p.pte.frame.data.subarray(p.offset,p.offset+p.length),off);off+=p.length;}
      return bytes;
    }
    executableSnapshot(at,length) {
      const s=spaces.get(this),r=range(s,at,length,'execute'),parts=segments(s,r,'execute',PROT.EXEC);
      if(s.regions.some(v=>v.start<r.end&&r.start<v.end&&(v.prot&PROT.WRITE))||parts.some(p=>p.pte.kind!=='private'))
        throw new MemoryFault('unsupported-executable-alias',r.start,r.len,'execute');
      return this.read(r.start,r.len,{execute:true});
    }
    prepareWrite(at,length) {
      const s=spaces.get(this);writeReady(s);const r=range(s,at,length,'write');
      if(r.len>BigInt(Number.MAX_SAFE_INTEGER))throw new TypeError('Prepared write is too large');
      const parts=segments(s,r,'write',PROT.WRITE),bytes=new Uint8Array(Number(r.len));
      const rec={live:true,parts,bytes,length:bytes.length,stamp:Symbol()};let off=0;
      s.preparing=true;
      try {
        for(const p of parts) {
          p.bufferOffset=off;off+=p.length;p.revision=p.pte.frame.revision;
          if(p.pte.kind==='private-view')p.staged={frame:frameAllocate(s.budget,'private',p.pte.frame.data),kind:'private'};
        }
        s.pending=rec;
      }catch(error){cancelPrepared(s,rec);throw error;}
      finally{s.preparing=false;}
      const validate=()=>{
        if(!rec.live||s.pending!==rec||s.closed)throw new PreparedWriteConflict('Prepared write is closed');
        if(bytes.byteLength!==rec.length){cancelPrepared(s,rec);throw new PreparedWriteConflict('Prepared buffer was detached');}
        for(const p of parts)if(s.pages.get(p.page)!==p.pte||p.pte.frame.revision!==p.revision) {
          cancelPrepared(s,rec);throw new PreparedWriteConflict('Prepared backing changed');
        }
        return true;
      };
      validate();
      return Object.freeze({bytes,length:rec.length,validate,cancel:()=>cancelPrepared(s,rec),
        commit(count=rec.length) {
          if(!Number.isSafeInteger(count)||count<0||count>rec.length)throw new TypeError('Invalid prepared prefix length');
          validate();
          // No frame allocation, callback or asynchronous gap after validation.
          // Prefix commits publish only touched COW pages; unused staging is freed.
          for(const p of parts) {
            const n=Math.max(0,Math.min(p.length,count-p.bufferOffset));
            if(!n){if(p.staged)release(p.staged.frame);continue;}
            const target=p.staged||p.pte;
            if(p.staged){s.pages.set(p.page,target);p.published=true;release(p.pte.frame);}
            for(let i=0;i<n;i++)target.frame.data[p.offset+i]=bytes[p.bufferOffset+i];
            target.frame.revision=rec.stamp;
          }
          rec.live=false;s.pending=null;return count;
        }
      });
    }
    write(at,bytes) {
      if(!(bytes instanceof Uint8Array))throw new TypeError('Uint8Array required');
      const prepared=this.prepareWrite(at,bytes.byteLength);
      try{prepared.bytes.set(bytes);prepared.commit();}finally{prepared.cancel();}
    }
    copy(destination,source,length) {
      const s=spaces.get(this);writeReady(s);const r=range(s,destination,length,'write');segments(s,r,'write',PROT.WRITE);
      const bytes=this.read(source,length);this.write(destination,bytes); // Explicit memmove snapshot semantics.
    }
    compareExchange(at,width,expected,desired){return atomicScalar(this,at,width,'cas',expected,desired);}
    fetchAdd(at,width,operand){return atomicScalar(this,at,width,'add',operand);}
    fork() {
      const s=spaces.get(this);writeReady(s);range(s,s.minimum,0,'fork');
      const child=new GuestAddressSpace(s.budget,{virtualLimit:s.limit,minimumAddress:s.minimum}),c=spaces.get(child);
      c.regions=s.regions.map(v=>({...v}));
      try {
        for(const [p,e]of s.pages)c.pages.set(p,e.kind==='private'?
          {frame:frameAllocate(s.budget,'private',e.frame.data),kind:'private'}:{...e,frame:retain(e.frame)});
        return child;
      }catch(error){child.close();throw error;}
    }
    createEmpty() {
      const s=spaces.get(this);writeReady(s);range(s,s.minimum,0,'new-image');
      return new GuestAddressSpace(s.budget,{virtualLimit:s.limit,minimumAddress:s.minimum});
    }
    mappingInfo(at) {
      const s=spaces.get(this),r=range(s,at,1,'identity');covered(s,r,'identity');
      const page=r.start-r.start%P,e=s.pages.get(page);if(!e)return null;
      return Object.freeze({guestPage:page,kind:e.kind,frameId:e.frame.id,
        objectId:e.objectId??null,objectOffset:e.objectOffset??null});
    }
    futexIdentity(at,{private:priv=false}={}) {
      const s=spaces.get(this),r=range(s,at,4,'futex');
      if(r.start%4n)throw new MemoryFault('alignment',r.start,r.len,'futex');
      const p=segments(s,r,'futex',PROT.READ)[0],e=p.pte;
      if(!priv&&e.objectId!==undefined)return Object.freeze({kind:'shared',objectId:e.objectId,
        page:e.objectOffset/P,byteOffset:p.offset});
      return Object.freeze({kind:'private',spaceId:s.id,guestAddress:r.start});
    }
    pinFutex(at,options) {
      const identity=this.futexIdentity(at,options),s=spaces.get(this),r=range(s,at,4,'futex');
      const p=segments(s,r,'futex',PROT.READ)[0];let frame=retain(p.pte.frame);
      return Object.freeze({identity,
        value(){if(!frame)throw new Error('Futex key lease is closed');
          return new DataView(frame.data.buffer,frame.data.byteOffset+p.offset,4).getUint32(0,true);},
        close(){if(frame){release(frame);frame=null;}}
      });
    }
    stats() {
      const s=spaces.get(this),unique=new Set([...s.pages.values()].map(e=>e.frame.id));
      return Object.freeze({closed:s.closed,virtualLimit:s.limit,reservedVirtualBytes:s.regions.reduce((n,v)=>n+v.end-v.start,0n),
        regionCount:s.regions.length,committedPages:s.pages.size,uniqueMappedPayloadBytes:unique.size*PAGE});
    }
    close() {
      const s=spaces.get(this);if(s.closed)return;
      if(s.preparing)throw new PreparedWriteConflict('Cannot close during preparation');
      if(s.pending)cancelPrepared(s,s.pending);s.closed=true;
      for(const e of s.pages.values())release(e.frame);s.pages.clear();s.regions=[];
    }
  }
  root.BetterJITGuestMemory=Object.freeze({STORAGE_VERSION:1,PAGE,PROT,MemoryFault,AllocationFailure,PreparedWriteConflict,
    BackingBudget,SharedBacking,GuestAddressSpace});
})(typeof globalThis!=='undefined'?globalThis:self);
