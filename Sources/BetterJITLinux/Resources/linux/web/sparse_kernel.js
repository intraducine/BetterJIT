// SPDX-License-Identifier: GPL-3.0-or-later
// Experimental single process: checked ELF, captured output, normal exit only.
'use strict';
importScripts('../guest_memory.js','../guest_memory_broker.js','../guest_image.js','linux-kernel.js');
const M=BetterJITGuestMemory,I=BetterJITGuestImage,{Kernel}=LinuxBundle.require('./kernel.js');
let ownedKernel,ownedImage,ownedBudget;
onmessage=({data:d})=>{onmessage=null;
 try{
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,1,0);
  ownedBudget=new M.BackingBudget({limitBytes:32*1024*1024});const empty=new M.GuestAddressSpace(ownedBudget,{virtualLimit:1n<<47n}),encoder=new TextEncoder(),args={path:d.argv[0],argv:d.argv.map(x=>encoder.encode(x)),envp:Object.entries(d.env).map(([k,v])=>encoder.encode(k+'='+v))};
  try{ownedImage=I.prepare(empty,d.elf,args,crypto.getRandomValues(new Uint8Array(16)));}finally{empty.close();}
  let terminal;
  ownedKernel=new Kernel({state:d.state,vfs:{},log:()=>{},sparseLifecycleVersion:4,sparseProcessLifecycle:false,
   writeSparseOutput:({fd,bytes})=>{postMessage({op:'output',fd,bytes});return bytes.length;},
   sparseExit:t=>{terminal={status:t.sparse.terminalStatus,guestExitCode:t.sparse.guestExitCode};ownedKernel.done=true;}
  },d.cfg);
  const a=ownedKernel.createSparseProcess({space:ownedImage.space,entryRip:ownedImage.entry,dynamic:true,standardIO:true});
  a.thread.sparse.view.setBigUint64(a.thread.tb+d.cfg.ctx+d.cfg.gregsOff+32,ownedImage.stackPointer,true);
  postMessage({op:'spawn',spec:{...a.worker,maximumSteps:20000},codes:ownedImage.codes});ownedKernel.run();
  postMessage({op:'kernel-result',terminal,steps:a.thread.sparse.steps,internalBytes:a.worker.mem.buffer.byteLength,broker:ownedKernel.sparseBroker.stats(),backing:ownedBudget.stats(),workerRetirementAcknowledged:false,retainedUntilSessionTeardown:true});
  // Keep storage and internal context alive; no fake W_OCCUPIED ACK, reaping,
  // namespace drop, backing reuse or browser termination-completion claim.
 }catch(error){postMessage({op:error instanceof I.ImageUnsupported?'unsupported':'failure',message:String(error)});}
};
