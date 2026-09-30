const ok = (details={},metrics={},counters={},notes=[]) => ({status:'passed',details,metrics,counters,notes});
const unsupported = (reason,details={}) => ({status:'unsupported',details:{...details,reason},metrics:{},counters:{},notes:[]});
const now = () => performance.now();
const fnv = bytes => {
  let h = 2166136261 >>> 0;
  for (const b of bytes) h = Math.imul(h ^ b,16777619) >>> 0;
  return h;
};
const b64 = bytes => {
  let s = '';
  for (let i=0;i<bytes.length;i+=16384) s += String.fromCharCode(...bytes.subarray(i,i+16384));
  return btoa(s);
};
const fromB64 = text => Uint8Array.from(atob(text), c => c.charCodeAt(0));
const metricKey = n => String(n).replace(/[^0-9a-zA-Z_]/g,'_');
const hasOPFS = () => typeof globalThis.navigator?.storage?.getDirectory === 'function';
function writeExact(handle,bytes,at) {
  let done=0;
  while(done<bytes.length) {
    const n=handle.write(bytes.subarray(done),{at:at+done});
    if(!Number.isInteger(n) || n<=0 || n>bytes.length-done) throw new Error('short OPFS write');
    done+=n;
  }
}
function readExact(handle,bytes,at) {
  let done=0;
  while(done<bytes.length) {
    const n=handle.read(bytes.subarray(done),{at:at+done});
    if(!Number.isInteger(n) || n<=0 || n>bytes.length-done) throw new Error('short OPFS read');
    done+=n;
  }
}

async function features() {
  let min = Infinity, prev = performance.now();
  for (let i=0;i<2000;i++) { const x=performance.now(), d=x-prev; if (d>0 && d<min) min=d; prev=x; }
  return ok({
    crossOriginIsolated:String(globalThis.crossOriginIsolated === true),
    jspi:String(typeof WebAssembly.Suspending === 'function' && typeof WebAssembly.promising === 'function'),
    sharedArrayBuffer:String(typeof SharedArrayBuffer === 'function'),
    atomics:String(typeof Atomics === 'object'),
    worker:String(typeof Worker === 'function'),
    opfs:String(hasOPFS()),
    webgpu:String(!!globalThis.navigator?.gpu),
    hardwareConcurrency:String(globalThis.navigator?.hardwareConcurrency ?? 0)
  }, {timerResolutionMilliseconds:Number.isFinite(min)?min:0});
}

async function nativeRoundTrip(args,ctx) {
  const sizes = Array.isArray(args?.sizes) ? args.sizes : [64,4096,65536,1048576];
  const repeats = Number.isInteger(args?.repeats) ? Math.max(1,Math.min(5,args.repeats)) : 2;
  const metrics={}, counters={roundTrips:0,totalBytes:0};
  for (const n of sizes) {
    if (!Number.isInteger(n) || n<1 || n>4*1024*1024) throw new Error('invalid diagnostic size');
    const bytes=Uint8Array.from({length:n},(_,i)=>(i*31+7)&255), text=b64(bytes);
    const samples=[];
    for (let r=0;r<repeats;r++) {
      const t=now(), reply=await ctx.hostCall('diag.echo',text); samples.push(now()-t);
      const got=fromB64(reply);
      if (got.length!==bytes.length || fnv(got)!==fnv(bytes)) throw new Error('native round-trip checksum mismatch');
      counters.roundTrips++; counters.totalBytes += n;
    }
    const avg=samples.reduce((a,b)=>a+b,0)/samples.length, mb=n/1048576;
    metrics['bytes_'+metricKey(n)+'_avg_ms']=avg;
    metrics['bytes_'+metricKey(n)+'_MBps']=mb/Math.max(avg/1000,0.000001);
  }
  return ok({mappedActive:String(!!ctx.mappedActive)},metrics,counters);
}

async function wasmMemory(args) {
  const initialMB=Math.max(16,Math.min(512,Number(args?.initialMB)||64));
  const growMB=Math.max(0,Math.min(512,Number(args?.growMB)||64));
  const page=65536, initial=Math.ceil(initialMB*1048576/page), grow=Math.ceil(growMB*1048576/page);
  let memory;
  try { memory=new WebAssembly.Memory({initial,maximum:Math.min(16384,initial+grow+256)}); }
  catch { return unsupported('WebAssembly.Memory allocation failed at the requested size.',{initialMB:String(initialMB)}); }
  const touch = mem => {
    const u8=new Uint8Array(mem.buffer); let checksum=0;
    for (let i=0;i<u8.length;i+=4096) { const v=(i>>>12)&255; u8[i]=v; checksum=(checksum+v)>>>0; }
    return checksum;
  };
  let t=now(), a=touch(memory), firstMs=now()-t, growMs=0, b=a;
  if (grow>0) { t=now(); memory.grow(grow); growMs=now()-t; t=now(); b=touch(memory); firstMs += now()-t; }
  return ok({checksum:String(b)},{
    initialBytes:initial*page,finalBytes:memory.buffer.byteLength,touchMilliseconds:firstMs,growMilliseconds:growMs
  });
}

async function opfsIO(args) {
  if (!hasOPFS()) return unsupported('OPFS is unavailable.');
  const mb=Math.max(4,Math.min(64,Number(args?.megabytes)||16)), total=mb*1048576;
  const root=await globalThis.navigator.storage.getDirectory(), name='betterjit-diag-'+crypto.randomUUID()+'.bin';
  const fh=await root.getFileHandle(name,{create:true});
  if (typeof fh.createSyncAccessHandle !== 'function') { await root.removeEntry(name); return unsupported('Synchronous OPFS access is unavailable.'); }
  const h=await fh.createSyncAccessHandle(), chunk=new Uint8Array(1024*1024);
  for (let i=0;i<chunk.length;i++) chunk[i]=(i*17+3)&255;
  const expect=fnv(chunk);
  try {
    h.truncate(total); let t=now();
    for (let at=0;at<total;at+=chunk.length) writeExact(h,chunk,at);
    h.flush(); const writeMs=now()-t;
    const read=new Uint8Array(chunk.length); t=now();
    for (let at=0;at<total;at+=read.length) { read.fill(0); readExact(h,read,at); if (fnv(read)!==expect) throw new Error('OPFS checksum mismatch'); }
    const readMs=now()-t;
    const estimate=await globalThis.navigator.storage.estimate();
    return ok({quotaBytes:String(estimate.quota??0),usageBytes:String(estimate.usage??0)},{
      bytes:total,writeMilliseconds:writeMs,readMilliseconds:readMs,
      writeMBps:mb/Math.max(writeMs/1000,0.000001),readMBps:mb/Math.max(readMs/1000,0.000001)
    });
  } finally { try{h.close();}catch{}; try{await root.removeEntry(name);}catch{} }
}

async function paging(args) {
  if (!hasOPFS()) return unsupported('OPFS is unavailable.');
  const pageSize=16384, spanMB=Math.max(64,Math.min(1024,Number(args?.spanMB)||256));
  const frameMB=Math.max(16,Math.min(256,Number(args?.frameMB)||32));
  const accesses=Math.max(1000,Math.min(100000,Number(args?.accesses)||20000));
  const spanPages=Math.floor(spanMB*1048576/pageSize), frameCount=Math.floor(frameMB*1048576/pageSize);
  const root=await globalThis.navigator.storage.getDirectory(), name='betterjit-page-'+crypto.randomUUID()+'.bin';
  const fh=await root.getFileHandle(name,{create:true});
  if (typeof fh.createSyncAccessHandle !== 'function') { await root.removeEntry(name); return unsupported('Synchronous OPFS access is unavailable.'); }
  const h=await fh.createSyncAccessHandle(), frames=new Uint8Array(frameCount*pageSize);
  const tags=new Int32Array(frameCount); tags.fill(-1); const dirty=new Uint8Array(frameCount);
  const expected=new Uint8Array(spanPages);
  let faults=0,writeBacks=0,state=0x12345678;
  const rng=()=>{state^=state<<13;state^=state>>>17;state^=state<<5;return state>>>0;};
  const t=now();
  try {
    h.truncate(spanPages*pageSize);
    for(let i=0;i<accesses;i++){
      const page=rng()%spanPages, slot=page%frameCount, base=slot*pageSize;
      if(tags[slot]!==page){
        if(tags[slot]>=0 && dirty[slot]) { writeExact(h,frames.subarray(base,base+pageSize),tags[slot]*pageSize); writeBacks++; }
        frames.fill(0,base,base+pageSize); readExact(h,frames.subarray(base,base+pageSize),page*pageSize);
        tags[slot]=page; dirty[slot]=0; faults++;
      }
      frames[base]^=1; expected[page]^=1; dirty[slot]=1;
    }
    for(let slot=0;slot<frameCount;slot++) if(tags[slot]>=0 && dirty[slot]) {
      writeExact(h,frames.subarray(slot*pageSize,(slot+1)*pageSize),tags[slot]*pageSize); writeBacks++;
    }
    h.flush();
    const check=new Uint8Array(pageSize);
    let verified=0;
    for(let page=0;page<spanPages;page+=257) {
      check.fill(0); readExact(h,check,page*pageSize);
      if(check[0]!==expected[page]) throw new Error('software paging verification mismatch');
      verified++;
    }
    const ms=now()-t;
    return ok({pageSize:String(pageSize),spanMB:String(spanMB),frameMB:String(frameMB)},{
      accesses,faults,writeBacks,verifiedPages:verified,milliseconds:ms,usPerFault:1000*ms/Math.max(1,faults)
    });
  } finally { try{h.close();}catch{}; try{await root.removeEntry(name);}catch{} }
}

const child = () => new Worker(new URL('./diagnostic-worker.mjs',import.meta.url),{type:'module'});
const childCall = (w,msg) => new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>reject(new Error('diagnostic child worker timed out')),10000);
  w.onmessage=e=>{clearTimeout(timer); e.data?.ok?resolve(e.data):reject(new Error('diagnostic child worker failed'));};
  w.onerror=()=>{clearTimeout(timer);reject(new Error('diagnostic child worker error'));};
  w.postMessage(msg);
});
async function sharedWorkers() {
  if (typeof SharedArrayBuffer!=='function' || typeof Atomics!=='object' || typeof Worker!=='function')
    return unsupported('SharedArrayBuffer, Atomics or Worker is unavailable.');
  let buffer, wasmSharedMemory=false;
  try {
    const memory=new WebAssembly.Memory({initial:1,maximum:1,shared:true});
    buffer=memory.buffer; wasmSharedMemory=buffer instanceof SharedArrayBuffer;
  } catch {
    buffer=new SharedArrayBuffer(65536);
  }
  const view=new Int32Array(buffer,0,1), workers=[child(),child()], iterations=20000, t=now();
  try {
    await Promise.all(workers.map(w=>childCall(w,{kind:'atomics',buffer,iterations})));
    const value=Atomics.load(view,0);
    if(value!==workers.length*iterations) throw new Error('Atomics total mismatch');
    return ok({crossOriginIsolated:String(globalThis.crossOriginIsolated===true),wasmSharedMemory:String(wasmSharedMemory)},{
      workers:workers.length,iterationsPerWorker:iterations,finalValue:value,milliseconds:now()-t
    });
  } finally { workers.forEach(w=>w.terminate()); }
}
async function moduleClone() {
  if (typeof Worker!=='function') return unsupported('Worker is unavailable.');
  const bytes=new Uint8Array([0,97,115,109,1,0,0,0,1,5,1,96,0,1,127,3,2,1,0,7,7,1,3,114,117,110,0,0,10,6,1,4,0,65,42,11]);
  const module=await WebAssembly.compile(bytes), w=child(), t=now();
  try {
    const result=await childCall(w,{kind:'module',module});
    if(result.value!==42) throw new Error('cloned module returned wrong result');
    return ok({}, {milliseconds:now()-t,result:result.value});
  } finally { w.terminate(); }
}

export async function runDiagnostic(name,args={},ctx={}) {
  switch(name) {
    case 'features': return features();
    case 'native-roundtrip': return nativeRoundTrip(args,ctx);
    case 'wasm-memory': return wasmMemory(args);
    case 'opfs-io': return opfsIO(args);
    case 'paging': return paging(args);
    case 'shared-workers': return sharedWorkers();
    case 'module-clone': return moduleClone();
    default: throw new Error('unknown diagnostic operation');
  }
}
