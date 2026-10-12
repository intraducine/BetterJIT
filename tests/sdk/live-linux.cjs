// SPDX-License-Identifier: GPL-3.0-or-later
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const {runIsolatedGuest}=require('./linux-host/supervise.cjs');
const {fixture:faultFixture}=require('./linux-host/fault-fixtures.cjs');
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
   '/test/session-input.txt':Buffer.from('BetterJIT data\n'),'/test/userspace.bin':payload};
 const faults=['direct','fs','gs'].map(segment=>{
  const f=faultFixture(segment),name=`/test/fault-${segment}`;overlay[name]=f.bytes;
  return {id:'linux-faulttrace-'+segment,argv:[name],expectedFault:f.expected,
   translatorOptions:'depth=24 memtrace=1',debugDirectory:path.join(REPO,'.build/wine-instruction-trace',segment)};
 });
 const cases=[
  {id:'linux-elf',argv:['/test/hello-static'],marker:'BetterJIT Linux OK'},
  {id:'linux-services',argv:['/test/session-static'],cwd:'/test',marker:'BetterJIT Linux services OK'},
  {id:'linux-file-hash',argv:['/bin/busybox','sha256sum','/test/userspace.bin'],digest},
  {id:'linux-userspace',argv:['/bin/busybox','sh','-c',userspaceScript()],marker:'BetterJIT userspace OK',
   markers:['BetterJIT files OK','BetterJIT signals OK','BetterJIT process status OK'],digest},
  {id:'wine-command',argv:['/opt/wine/bin/wine','cmd','/c','ver'],optional:true,timeout:120},
  {id:'wine-command-no-preloader',argv:['/opt/wine/bin/wine','cmd','/c','ver'],
   environment:{WINELOADERNOEXEC:'1',WINEARCH:'win64'},optional:true,timeout:120},
  ...faults,
  {id:'wine-instruction-trace',argv:['/opt/wine/bin/wine','cmd','/c','ver'],
   environment:{WINELOADERNOEXEC:'1',WINEARCH:'win64'},optional:true,timeout:120,
   translatorOptions:'depth=24 memtrace=1',debugDirectory:path.join(REPO,'.build/wine-instruction-trace','wine')}
 ];
 const report={schema:1,source:process.env.GITHUB_SHA??null,evidence:'Live FEX→Wasm on host; not Apple WebKit or device evidence.',records:[]};
 let requiredFailed=false;
 for(const spec of cases) {
  console.log(`RUN ${spec.id}: ${spec.argv.slice(0,3).join(' ')}; deadline ${(spec.timeout??90)+5}s`);
  try {
   const result=await runIsolatedGuest({translator,root,overlay,...spec,trace:true});
   const expectedFault=spec.expectedFault && result.code===139 && result.memoryFaults.some(f=>
    Object.entries(spec.expectedFault).every(([k,v])=>k==='instructionHex'?f[k].startsWith(v):f[k]===v));
   const correct=(spec.expectedFault?expectedFault:result.code===0) && result.translator.units>0 && result.units.compiled>0 &&
    (!spec.marker||result.stdout.includes(spec.marker)) && (!spec.markers||spec.markers.every(m=>result.stdout.includes(m))) && (!spec.digest||result.stdout.includes(spec.digest)) &&
    (!spec.id.startsWith('wine-')||/^\s*(Microsoft )?Windows[^\n]*\d+\.\d+/im.test(result.stdout));
   report.records.push({id:spec.id,status:correct?'passed':'failed',...result});
   console.log(`${correct?'PASS':'FAIL'} ${spec.id}: exit ${result.code}, ${result.translator.units} native FEX units, ${result.units.compiled} Wasm modules, ${result.milliseconds.toFixed(0)} ms`);
   if(result.memoryFaults.length)console.log(JSON.stringify({id:spec.id,expectedFault:spec.expectedFault??null,memoryFaults:result.memoryFaults}));
   if(!correct)console.error(JSON.stringify({id:spec.id,expectedDigest:spec.digest,stdout:result.stdout,stderr:result.stderr.slice(-8192),translationLog:result.translationLog.slice(-8192)}));
   if(!correct&&!spec.optional)requiredFailed=true;
  } catch(error){report.records.push({id:spec.id,status:'failed',error:String(error.stack||error),cleanupError:error.cleanupError,stdout:error.stdout,stderr:error.stderr,translationLog:error.translationLog});console.error(`FAIL ${spec.id}: ${error}`);console.error(JSON.stringify({cleanupError:error.cleanupError,stdout:error.stdout,stderr:error.stderr?.slice(-8192),translationLog:error.translationLog}));if(!spec.optional)requiredFailed=true;}
  fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n');
  // Fresh sessions let Wine/other cases expose independent blockers too.
 }
 if(requiredFailed)process.exitCode=1;
}
main().catch(error=>{console.error(error);process.exitCode=1;});
