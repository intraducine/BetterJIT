// SPDX-License-Identifier: GPL-3.0-or-later
// Executes the app's promoted Linux kernel/runtime with fresh native FEX translations.
const fs=require('fs'),path=require('path'),vm=require('vm'),net=require('net');
const {Worker}=require('worker_threads'),{spawn}=require('child_process');
const {rootIndex}=require('./root.cjs');
const {GuestWorkers}=require('./workers.cjs');
const {functionNames,unitMetadata}=require('./wasm-names.cjs');
const REPO=path.resolve(__dirname,'../../..');
const resources=path.join(REPO,'Sources/BetterJITLinux/Resources');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function runGuest({translator,root,argv,overlay={},cwd='/',timeout=90,trace=false,onProgress,environment={},
  translatorOptions='depth=24',debugDirectory}) {
  if(typeof WebAssembly.Suspending!=='function'||typeof WebAssembly.promising!=='function')throw Error('Run Node with --experimental-wasm-jspi.');
  const port=await new Promise((resolve,reject)=>{const server=net.createServer();server.on('error',reject);server.listen(0,'127.0.0.1',()=>{const port=server.address().port;server.close(()=>resolve(port));});});
  const origin=`http://127.0.0.1:${port}`;
  const server=spawn(translator,['--linux',String(port),translatorOptions],{stdio:['ignore','pipe','pipe'],
    env:{...process.env,FEXWASM_NATIVE_TRACE:'1'}});
  let translationLog='';server.stderr.on('data',bytes=>translationLog=(translationLog+bytes).slice(-65536));
  let bootError;server.on('error',error=>{bootError=error;});
  const threads=new GuestWorkers(),memoryFaults=[],capturedUnits=new Map();let kernel,timer,stdout='',stderr='',dumpBytes=0;const started=performance.now();
  if(debugDirectory)fs.mkdirSync(debugDirectory,{recursive:true});
  let lastProgress=0;
  function progress() {
    const now=performance.now();
    if(onProgress&&now-lastProgress>500) {
      lastProgress=now;onProgress({stdout:stdout.slice(-65536),stderr:stderr.slice(-65536),translationLog,milliseconds:now-started});
    }
  }
  try {
    let ready=false;
    for(let i=0;i<200;i++) {
      if(bootError)throw bootError;
      if(server.exitCode!==null)throw Error('Native FEX translator exited: '+translationLog);
      try {if((await fetch(origin+'/xlat/stats?space=0')).ok){ready=true;break;}}catch{}
      await sleep(25);
    }
    if(!ready)throw Error('Native FEX translator startup exceeded 5 seconds: '+translationLog);
    async function get(route,json=false) {const response=await fetch(origin+route);if(!response.ok)throw Error(route+' '+response.status);return json?response.json():new Uint8Array(await response.arrayBuffer());}
    const cfg=await get('/xlat/config?space=0',true),dispatcher=await get('/xlat/dispatcher?space=0'),state=await get('/xlat/state?space=0');
    if(debugDirectory)fs.writeFileSync(path.join(debugDirectory,'config.json'),JSON.stringify(cfg,null,2)+'\n');
    await get('/xlat/drop?space=0');
    globalThis.self=globalThis;vm.runInThisContext(fs.readFileSync(path.join(resources,'linux/thread_core.js'),'utf8'));
    const units=FexLinuxThread.UnitCache(origin),bridge=new SharedArrayBuffer(16),words=new Int32Array(bridge);
    const bootEpoch=performance.timeOrigin+performance.now()-1e6;
    const uid=process.getuid?.()??1000,gid=process.getgid?.()??1000;
    overlay={...overlay,'/etc/passwd':Buffer.from(`root:x:0:0:root:/root:/bin/sh\nuser:x:${uid}:${gid}:user:/home/user:/bin/sh\n`),
      '/etc/group':Buffer.from(`root:x:0:\nuser:x:${gid}:user\n`)};
    const result=await new Promise((resolve,reject)=>{
      timer=setTimeout(()=>reject(Error(`Guest deadline ${timeout}s exceeded\n${stderr.slice(-8192)}`)),timeout*1000);
      kernel=new Worker(path.join(__dirname,'kernel.cjs'),{workerData:{resources,root,overlay,index:rootIndex(root,overlay),
        cfg,state,bridge,bootEpoch,argv,cwd,trace,uid,gid,env:Object.entries({HOME:'/home/user',USER:'user',PATH:'/opt/wine/bin:/usr/bin:/bin',
          LANG:'C',WINEDEBUG:'-all',WINEDLLOVERRIDES:'winemenubuilder.exe=d',LD_LIBRARY_PATH:'/opt/wine/lib/wine/x86_64-unix',...environment}).map(([k,v])=>`${k}=${v}`)}});
      kernel.on('error',reject);
      kernel.on('message',async message=>{
        try {
          switch(message.op) {
          case 'spawn': {
            const worker=new Worker(path.join(__dirname,'thread.cjs'),{workerData:{...message,resources,cfg,dispatcher,
              xlat:origin,bootEpoch,codeEpoch:units.epoch.buffer,regionAfterMs:30000},resourceLimits:{stackSizeMb:8}});
            worker.on('error',reject);
            threads.add(message.tid,worker,()=>Atomics.store(new Int32Array(message.ksab),((256+message.slot*128)>>2)+26,0));
            worker.on('message',async response=>{
              try {
                if(response.op==='unit'){
                  const unit=await units.get(response.space,response.rip,!!debugDirectory);
                  if(unit?.code&&debugDirectory) {
                    dumpBytes+=unit.code.length;
                    if(dumpBytes>64*1024*1024)throw Error('Diagnostic unit capture exceeded 64 MiB.');
                    const stem=`space-${response.space}-rip-${response.rip.toString(16)}`;
                    fs.writeFileSync(path.join(debugDirectory,stem+'.wasm'),unit.code);
                    fs.writeFileSync(path.join(debugDirectory,stem+'.json'),JSON.stringify(unitMetadata(response.rip,unit))+'\n');
                    for(const name of functionNames(unit.module))if(/^[ur][0-9a-f]+$/.test(name))capturedUnits.set(name,{code:unit.code,file:stem+'.wasm'});
                  }
                  worker.postMessage({op:'unit',id:response.id,...unit});
                }
                else if(response.op==='memoryFault') {
                  const fault=response.fault,frame=/at ([ur][0-9a-f]+) \(wasm:[^\n]*?:0x([0-9a-f]+)\)/.exec(fault.stack),unit=frame&&capturedUnits.get(frame[1]);
                  if(unit){const offset=parseInt(frame[2],16),opcode=unit.code[offset];Object.assign(fault,{wasmModule:unit.file,wasmByteOffset:'0x'+offset.toString(16),wasmOpcode:'0x'+opcode?.toString(16)});
                    if(opcode===0xfc)fault.wasmBulkOpcode='0x'+unit.code[offset+1]?.toString(16);
                  }
                  memoryFaults.push(fault);
                  if(debugDirectory)fs.writeFileSync(path.join(debugDirectory,`fault-${response.pid}-${response.tid}.json`),JSON.stringify(fault,null,2)+'\n');
                }
                else if(response.op==='fatal')reject(Error(response.message));
                else if(response.op==='log')stderr+=response.m+'\n';
              } catch(error){reject(error);}
            });break;
          }
          case 'kill':threads.kill(message.tid);break;
          case 'code':case 'uncode':case 'drop': {
            let route,options;
            if(message.op==='code') {route=`/xlat/code?space=${message.space}&addr=${message.address.toString(16)}&abi=${message.abi}`;options={method:'POST',body:message.bytes};}
            else if(message.op==='uncode')route=`/xlat/uncode?space=${message.space}&addr=${message.address.toString(16)}&size=${message.size.toString(16)}`;
            else route=`/xlat/drop?space=${message.space}`;
            const response=await fetch(origin+route,options);words[1]=response.ok?0:1;Atomics.store(words,0,1);Atomics.notify(words,0);break;
          }
          case 'write':if(message.fd===2)stderr+=Buffer.from(message.bytes).toString();else stdout+=Buffer.from(message.bytes).toString();progress();break;
          case 'log':stderr+=message.message+'\n';progress();break;
          case 'fatal':reject(Error(message.message));break;
          case 'exit':resolve(message);break;
          }
        } catch(error){words[1]=1;Atomics.store(words,0,1);Atomics.notify(words,0);reject(error);}
      });
    });
    const totals=await get('/xlat/totals',true);
    return {...result,stdout,stderr,translationLog,milliseconds:performance.now()-started,
      translator:totals,units:{...units.stats},memoryFaults,evidence:'Host Node workers use promoted SDK kernel/thread/runtime and live native FEX → Wasm; no native FEX JIT or recorded modules.'};
  } catch(error) {
    error.stdout=stdout;error.stderr=stderr.slice(-65536);error.translationLog=translationLog;
    error.translatorStatus={exitCode:server.exitCode,signal:server.signalCode};
    error.causeDetail=error.cause?String(error.cause.stack||error.cause):undefined;
    throw error;
  } finally {
    clearTimeout(timer);await kernel?.terminate();await threads.close();
    if(server.exitCode===null)server.kill();
  }
}
module.exports={runGuest};
