// SPDX-License-Identifier: GPL-3.0-or-later
const {workerData:d,parentPort}=require('worker_threads');
const fs=require('fs'),path=require('path'),vm=require('vm');
// Fault injection for the real guest regression, not a device quota model.
// Returned memories are real Wasm memories; only later constructor calls fail.
if(d.memoryConstructionLimit!==undefined) {
  if(!Number.isInteger(d.memoryConstructionLimit)||d.memoryConstructionLimit<1)throw Error('Invalid injected construction limit');
  const NativeMemory=WebAssembly.Memory;let constructed=0;
  WebAssembly.Memory=class {
    constructor(descriptor) {
      if(constructed>=d.memoryConstructionLimit)throw new RangeError('Injected constructor exhaustion; collection has not released a reservation');
      const memory=new NativeMemory(descriptor);constructed++;return memory;
    }
  };
}
globalThis.self=globalThis;
vm.runInThisContext(fs.readFileSync(path.join(d.resources,'linux/web/linux-kernel.js'),'utf8'));
const {Kernel}=LinuxBundle.require('./kernel.js');
LinuxBundle.require('./syscalls.js');
const {WebVfs}=LinuxBundle.require('./vfs_web.js');
const {readSource}=require('./root.cjs');
const overlay=Object.fromEntries(Object.entries(d.overlay).map(([k,v])=>[k,Buffer.from(v)]));
const fetchFile=p=>new Uint8Array(readSource(d.root,overlay,p));
fetchFile.range=(p,offset,length,into)=>into.set(readSource(d.root,overlay,p,offset,length));
const bridge=new Int32Array(d.bridge);
function call(message) {
  Atomics.store(bridge,0,0);parentPort.postMessage(message);
  const deadline=performance.now()+30000;
  while(Atomics.load(bridge,0)===0) {
    Atomics.wait(bridge,0,0,100);
    if(performance.now()>deadline)throw Error('Native translator request exceeded 30 seconds.');
  }
  if(bridge[1])throw Error('Native translator request failed.');return 0;
}
const vfs=new WebVfs(d.index,fetchFile,d.uid,d.gid);
// Read-only, bounded host evidence for the actual DLL/loader lookup. Preserve
// the VFS operation and its original result/exception; never fabricate files.
if(d.tracePaths) {
  let budget=400;
  for(const method of ['open','stat']) {
    const original=vfs[method];
    vfs[method]=function(guest,...args) {
      const record=outcome=>{
        if(budget>0&&/kernel32\.dll|kernelbase\.dll|wineboot|cmd\.exe|ntdll\.so/i.test(guest)) {
          budget--;parentPort.postMessage({op:'log',message:`[guest-file] ${method} ${String(guest).slice(0,400)} ${outcome}`});
        }
      };
      try {const result=original.call(this,guest,...args);record('OK');return result;}
      catch(error){record('ERROR '+(error.code??error.name));throw error;}
    };
  }
}
const host={vfs,state:new Uint8Array(d.state),uid:d.uid,gid:d.gid,
  cpus:4,cwd:d.cwd,trace:d.trace,traceExec:d.tracePaths,sharedSpace:d.sharedAddressSpace!==false,standardIO:d.standardIO,spinMs:0,win64:'',
  spawnThread:info=>parentPort.postMessage({op:'spawn',...info}),
  killThread:tid=>parentPort.postMessage({op:'kill',tid}),
  code:(space,address,bytes,abi=0)=>call({op:'code',space,address,bytes,abi}),
  uncode:(space,address,size)=>call({op:'uncode',space,address,size}),
  dropSpace:space=>call({op:'drop',space}),
  write:(fd,bytes)=>parentPort.postMessage({op:'write',fd,bytes}),
  log:message=>parentPort.postMessage({op:'log',message}),
  exit:(code,k)=>{k.done=true;parentPort.postMessage({op:'exit',code,syscalls:k.stats.syscalls,
    byNr:[...k.stats.byNr],fetched:k.vfs.fetched});}};
try {
  const kernel=new Kernel(host,d.cfg);kernel.bootEpoch=d.bootEpoch;
  kernel.dumpFlag=new Int32Array(d.bridge,8,1);kernel.boot(d.argv,d.env);kernel.run();
} catch(error) {parentPort.postMessage({op:'fatal',message:error.stack||String(error)});}
