// SPDX-License-Identifier: GPL-3.0-or-later
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const {runIsolatedGuest}=require('./linux-host/supervise.cjs');
const {fixture:faultFixture,codeBoundaryFixture}=require('./linux-host/fault-fixtures.cjs');
const {windowsVersion}=require('./linux-host/console.cjs');
const REPO=path.resolve(__dirname,'../..');
function fixture(name){const source=fs.readFileSync(path.join(REPO,'Examples/FEXHost',name+'.swift'),'utf8');return Buffer.from(source.match(/Data\(base64Encoded:\s*"([A-Za-z0-9+/=]+)"/)[1],'base64');}
function userspaceScript(){return fs.readFileSync(path.join(REPO,'Examples/FEXHost/LinuxUserspaceWorkload.swift'),'utf8').match(/static let script = #"""\n([\s\S]*?)\n\s*"""#/)[1].replace(/^    /gm,'');}
async function main() {
 const root=path.resolve(process.argv[2]??'.build/device-linuxroot');
 const translator=path.resolve(process.argv[3]??'.build/host-fex/fexserve');
 const output=path.resolve(process.argv[4]??'.build/live-linux-results.json');
 const payload=Buffer.from(Array.from({length:256*1024},(_,i)=>(i*31+7)&255));
 const digest=crypto.createHash('sha256').update(payload).digest('hex');
 const overlay={'/test/hello-static':fixture('LinuxSmokeFixture'),'/test/session-static':fixture('LinuxSessionFixture'),
   '/test/session-input.txt':Buffer.from('BetterJIT data\n'),'/test/userspace.bin':payload,'/input/document':payload};
 const faults=['direct','fs','gs','fill','copy-destination','copy-source'].map(segment=>{
  const f=faultFixture(segment),name=`/test/fault-${segment}`;overlay[name]=f.bytes;
  return {id:'linux-faulttrace-'+segment,argv:[name],expectedFault:f.expected,
   translatorOptions:'depth=24 memtrace=1',debugDirectory:path.join(REPO,'.build/wine-instruction-trace',segment)};
 });
 overlay['/test/code-boundary']=codeBoundaryFixture();
 const cases=[
  {id:'linux-elf',argv:['/test/hello-static'],marker:'BetterJIT Linux OK'},
  {id:'linux-services',argv:['/test/session-static'],cwd:'/test',marker:'BetterJIT Linux services OK'},
  {id:'linux-file-hash',argv:['/bin/busybox','sha256sum','/test/userspace.bin'],digest},
  {id:'consumer-document-digest',argv:['/bin/busybox','sha256sum','/input/document'],sharedAddressSpace:false,digest},
  {id:'linux-userspace',argv:['/bin/busybox','sh','-c',userspaceScript()],marker:'BetterJIT userspace OK',
   markers:['BetterJIT files OK','BetterJIT signals OK','BetterJIT process status OK'],digest},
  {id:'linux-userspace-constructor-pressure',argv:['/bin/busybox','sh','-c',userspaceScript()],memoryConstructionLimit:3,
   marker:'BetterJIT userspace OK',markers:['BetterJIT files OK','BetterJIT signals OK','BetterJIT process status OK'],digest},
  {id:'wine-command',argv:['/opt/wine/bin/wine','cmd','/c','ver'],optional:true,timeout:120},
  {id:'wine-command-no-preloader',argv:['/opt/wine/bin/wine','cmd','/c','ver'],
   environment:{WINELOADERNOEXEC:'1',WINEARCH:'win64'},optional:true,timeout:120},
  ...(fs.existsSync(path.join(root,'opt/wine-flat/.betterjit-wine-flat.json')) ? [
   {id:'wine-command-flat-window',argv:['/bin/busybox','sh','-c','/opt/wine-flat/share/betterjit-provenance/fs-reset.elf && /opt/wine-flat/share/betterjit-provenance/spawn-contract.elf && exec /opt/wine-flat/bin/wine /usr/lib/wine/x86_64-windows/cmd.exe /c ver'],
    marker:'BetterJIT Wine FS reset OK',markers:['PASS: real spawn fd/cwd/environment/signal/session contracts'],sharedAddressSpace:false,
    environment:{WINELOADERNOEXEC:'1',WINEARCH:'win64',WINEPREFIX:'/home/user/.wine-flat',BETTERJIT_WINE_SPAWN:'1',
     WINEDLLPATH:'/usr/lib/wine',LD_LIBRARY_PATH:'/opt/wine-flat/lib/wine/x86_64-unix:/usr/lib',WINEDEBUG:'+module,+loaddll,+process'},timeout:180,
    translatorOptions:'depth=24 memtrace=1',debugDirectory:path.join(REPO,'.build/wine-instruction-trace','wine-flat')}
  ] : []),
  ...faults,
  {id:'linux-code-boundary',argv:['/test/code-boundary'],expectedCodeRejection:true},
  {id:'wine-instruction-trace',argv:['/opt/wine/bin/wine','cmd','/c','ver'],
   environment:{WINELOADERNOEXEC:'1',WINEARCH:'win64'},optional:true,timeout:120,
   translatorOptions:'depth=24 memtrace=1',debugDirectory:path.join(REPO,'.build/wine-instruction-trace','wine')}
 ];
 const report={schema:1,source:process.env.GITHUB_SHA??null,evidence:'Live FEX→Wasm on host; not Apple WebKit or device evidence.',records:[]};
 if(!cases.some(spec=>spec.id==='wine-command-flat-window'))report.records.push({id:'wine-command-flat-window',status:'unsupported',reason:'Separate source-built flat-window Wine input is absent.'});
 let requiredFailed=false;
 for(const spec of cases) {
  console.log(`RUN ${spec.id}: ${spec.argv.slice(0,3).join(' ')}; deadline ${(spec.timeout??90)+5}s`);
  try {
   const result=await runIsolatedGuest({translator,root,overlay,...spec,trace:true});
   const expectedFault=spec.expectedFault && result.code===139 && result.memoryFaults.some(f=>
    Object.entries(spec.expectedFault).every(([k,v])=>k==='instructionHex'?f[k].startsWith(v):f[k]===v));
   const boundary=spec.expectedCodeRejection && result.code===139 && result.units.requests>0 &&
    /(?:translation failed|fatal: signal 11)/.test(result.stderr);
   const correct=(spec.expectedCodeRejection?boundary:((spec.expectedFault?expectedFault:result.code===0) && result.translator.units>0 && result.units.compiled>0)) &&
    (!spec.marker||result.stdout.includes(spec.marker)) && (!spec.markers||spec.markers.every(m=>result.stdout.includes(m))) && (!spec.digest||result.stdout.includes(spec.digest)) &&
    (!spec.id.startsWith('wine-')||windowsVersion(result.stdout)!==null);
   report.records.push({id:spec.id,status:correct?'passed':'failed',purpose:spec.memoryConstructionLimit?'Real guest workload under injected constructor exhaustion; not a device quota measurement':spec.expectedCodeRejection?'Expected unmapped-code rejection; no successful guest workload claim':spec.expectedFault?'Expected-fault diagnostic validation':'Real guest workload',expectedFault:spec.expectedFault??null,windowsVersion:spec.id.startsWith('wine-')?windowsVersion(result.stdout):undefined,...result});
   console.log(`${correct?'PASS':'FAIL'} ${spec.id}: exit ${result.code}, ${result.translator.units} native FEX units, ${result.units.compiled} Wasm modules, ${result.milliseconds.toFixed(0)} ms`);
   if(result.memoryFaults.length)console.log(JSON.stringify({id:spec.id,expectedFault:spec.expectedFault??null,memoryFaults:result.memoryFaults}));
   if(spec.id.startsWith('wine-'))console.log(JSON.stringify({id:spec.id,
    failedMappings:result.stderr.split('\n').filter(line=>/mmap\(/.test(line)&&/= E12$/.test(line)).slice(-20)}));
   if(spec.id==='wine-command-flat-window') {
    console.log(JSON.stringify({id:spec.id,diagnosticCapture:result.diagnosticCapture}));
    const trace=result.stderr.split('\n').filter(line=>/\[guest-file\]|execve .*\(space |direct loader:|:module:|loaddll|:process:|could not load|failed to load/.test(line));
    console.log(JSON.stringify({id:spec.id,loaderAndFileTrace:trace.length>260?[...trace.slice(0,60),...trace.slice(-200)]:trace}));
   }
   if(!correct)console.error(JSON.stringify({id:spec.id,expectedDigest:spec.digest,stdout:result.stdout,stderr:result.stderr.slice(-8192),translationLog:result.translationLog.slice(-8192)}));
   if(!correct&&!spec.optional)requiredFailed=true;
  } catch(error){report.records.push({id:spec.id,status:'failed',error:String(error.stack||error),cleanupError:error.cleanupError,translatorStatus:error.translatorStatus,causeDetail:error.causeDetail,diagnosticCapture:error.diagnosticCapture,stdout:error.stdout,stderr:error.stderr,translationLog:error.translationLog});console.error(`FAIL ${spec.id}: ${error}`);console.error(JSON.stringify({cleanupError:error.cleanupError,translatorStatus:error.translatorStatus,causeDetail:error.causeDetail,diagnosticCapture:error.diagnosticCapture,stdout:error.stdout,stderr:error.stderr?.slice(-8192),translationLog:error.translationLog}));if(!spec.optional)requiredFailed=true;}
  fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n');
  // Fresh sessions let Wine/other cases expose independent blockers too.
 }
 if(requiredFailed)process.exitCode=1;
}
main().catch(error=>{console.error(error);process.exitCode=1;});
