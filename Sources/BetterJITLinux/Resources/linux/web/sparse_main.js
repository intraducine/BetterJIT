// SPDX-License-Identifier: GPL-3.0-or-later
// Explicit single-process browser profile. No JSPI, fork/exec or retirement ACK.
(function(){
 'use strict';const q=new URLSearchParams(location.search),origin=location.origin,abort=new AbortController(),workers=[],cache=new Map(),decoders={1:new TextDecoder('utf-8',{ignoreBOM:true}),2:new TextDecoder('utf-8',{ignoreBOM:true})};
 let closed=false,sequence=0,delivery=Promise.resolve(),retained=0,truncated=false,cacheBytes=0,kernelResult,threadResult,settling=false;
 const serial=x=>JSON.stringify(x,(_k,v)=>typeof v==='bigint'?'0x'+v.toString(16):v);
 async function get(route,init={}){const r=await fetch(origin+route,{...init,signal:abort.signal});if(!r.ok)throw Error('Sparse runtime HTTP '+r.status);return r;}
 function send(events){delivery=delivery.then(async()=>{if(closed)return;await get('/events',{method:'POST',body:JSON.stringify({sequence:sequence++,events})});});return delivery;}
 function text(kind,value){if(!value||truncated)return;let bytes=new TextEncoder().encode(value),n=Math.min(bytes.length,4*1024*1024-retained);if(n<bytes.length)while(n>0&&(bytes[n]&0xc0)===0x80)n--;value=new TextDecoder().decode(bytes.subarray(0,n));retained+=n;const view=document.getElementById(kind==='log'?'out':kind);if(view)view.textContent+=value;const events=value?[{kind,text:value}]:[];if(n<bytes.length){truncated=true;events.push({kind:'truncated'});}if(events.length)send(events);}
 function stop(){if(closed)return;closed=true;abort.abort();for(const w of workers)w.terminate();workers.length=0;cache.clear();}
 globalThis.betterjitClose=stop;addEventListener('pagehide',stop,{once:true});
 async function fail(kind,message){if(closed||settling)return;settling=true;try{await send([{kind,text:String(message).slice(0,2048)}]);}catch{}stop();}
 async function settle(){if(settling||!kernelResult||!threadResult)return;settling=true;const k=kernelResult,t=threadResult;
  try{if(k.terminal.status===2||t.status===2){await send([{kind:'unsupported',text:'The compiled command reached an instruction or syscall outside the sparse profile.'}]);return;}
   if(k.terminal.status!==0||t.status!==0||k.terminal.guestExitCode===undefined||t.guestExitCode!==k.terminal.guestExitCode||k.broker.threads!==0||k.internalBytes!==33*65536||!k.retainedUntilSessionTeardown||k.workerRetirementAcknowledged)throw Error('Incomplete sparse command termination');
   for(const fd of [1,2])text(fd===1?'stdout':'stderr',decoders[fd].decode());
   text('log','[sparse-command] '+serial({steps:k.steps,internalBytes:k.internalBytes,broker:k.broker,backing:k.backing,retainedUntilSessionTeardown:true,workerRetirementAcknowledged:false,jspiRequired:false})+'\n');
   await send([{kind:'exit',code:t.guestExitCode}]);
  }catch(error){await send([{kind:'failure',text:String(error)}]);}
  // Keep the workers, backing and native catalogue retained until session close.
 }
 async function start(){
  if(!crossOriginIsolated||typeof SharedArrayBuffer==='undefined')return fail('unsupported','This engine lacks isolated shared memory required by the compiled C command.');
  try{new WebAssembly.Memory({initial:33,maximum:33,shared:true});}catch{return fail('unsupported','This engine cannot create the bounded shared WebAssembly memory.');}
  const argv=JSON.parse(q.get('argv')||'[]'),env=JSON.parse(q.get('env')||'{}');if(!Array.isArray(argv)||!argv.length||argv.some(x=>typeof x!=='string'||x.includes('\0'))||!env||Array.isArray(env)||typeof env!=='object')throw Error('Invalid sparse command arguments');
  const [cfg,state,elf]=await Promise.all([get('/xlat/config?space=1').then(r=>r.json()),get('/xlat/state?space=1').then(r=>r.arrayBuffer()).then(b=>new Uint8Array(b)),get('/fs/file?p='+encodeURIComponent(argv[0])).then(r=>r.arrayBuffer()).then(b=>new Uint8Array(b))]);
  const B=BetterJITGuestMemoryBroker;if(cfg.guestMemory!=='broker1'||cfg.memoryABI!==B.ABI.version||cfg.stepABI!==B.ABI.stepVersion||cfg.coverageVersion!==B.ABI.coverageVersion)throw Error('Sparse native backend profile mismatch');
  let issued=false;const kernel=new Worker('sparse_kernel.js');workers.push(kernel);kernel.onerror=e=>fail('failure',e.message||'Sparse kernel worker failed');kernel.onmessage=async({data:m})=>{
   if(closed)return;try{
    if(m.op==='output'){if(!decoders[m.fd]||!(m.bytes instanceof Uint8Array))throw Error('Invalid sparse output');text(m.fd===1?'stdout':'stderr',decoders[m.fd].decode(m.bytes,{stream:true}));}
    else if(m.op==='kernel-result'){kernelResult=m;settle();}
    else if(m.op==='unsupported'||m.op==='failure')fail(m.op,m.message);
    else if(m.op==='spawn'){
     if(issued)throw Error('Sparse browser lifecycle operations are unsupported');issued=true;
     for(const code of m.codes)await get('/xlat/code?space='+m.spec.space+'&addr='+code.address.toString(16),{method:'POST',body:code.bytes});
     if(closed)return;const worker=new Worker('sparse_thread.js');workers.push(worker);worker.onerror=e=>fail('failure',e.message||'Sparse command worker failed');worker.onmessage=async({data:r})=>{
      if(closed)return;try{if(r.op==='thread-result'){threadResult=r.result;settle();}else if(r.op==='failure')fail('failure',r.message);else if(r.op==='unit-request'){
       if(r.space!==m.spec.space||typeof r.rip!=='bigint')throw Error('Foreign sparse code request');let promise=cache.get(r.rip);
       if(!promise){if(cache.size>=128)throw Error('Sparse command translation limit reached');promise=(async()=>{const bytes=new Uint8Array(await(await get('/xlat/step?space='+r.space+'&rip='+r.rip)).arrayBuffer());cacheBytes+=bytes.length;if(cacheBytes>1024*1024)throw Error('Sparse command translation bytes exceeded');const u=FexLinuxThread.parseBrokerStep(bytes);if(u.status===0)u.module=await WebAssembly.compile(u.code);return u;})();cache.set(r.rip,promise);}
       const unit=await promise;if(!closed)worker.postMessage({op:'unit-reply',id:r.id,unit});
      }}catch(error){fail('failure',error);}
     };worker.postMessage({op:'start',spec:m.spec});
    }
   }catch(error){fail('failure',error);}
  };kernel.postMessage({cfg,state,elf,argv,env});
 }
 start().catch(error=>fail('failure',error));
})();
