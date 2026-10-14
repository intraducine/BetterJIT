// SPDX-License-Identifier: GPL-3.0-or-later
// Host-suite policy only. Mocked results are not Wine/FEX execution evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const directory=path.dirname(fileURLToPath(import.meta.url));
const filename=path.join(directory,'live-linux.cjs');
const localRequire=createRequire(filename);
async function suite({flat=false,required=false,nestedMarker=true,terminal=false}={}) {
 let report;const launched=[];
 const process={argv:['node',filename,'/fixture/root','/fixture/translator','/fixture/results.json'],
  env:{BETTERJIT_REQUIRE_WINE_FLAT:required?'1':'0'}};
 const fakeFS={...fs,existsSync:name=>name.endsWith('/opt/wine-flat/.betterjit-wine-flat.json')?flat:fs.existsSync(name),
  writeFileSync:(_name,value)=>{report=JSON.parse(value);}};
 const encode=text=>Array.from(text,c=>'\x1b[?25l'+(c===' '?'\x1b[K\x1b[1C':c)+'\x1b[?25h').join('');
 const runIsolatedGuest=async spec=>{launched.push(spec);return ({
  code:spec.expectedFault||spec.expectedCodeRejection||spec.optional?139:0,
  stdout:[spec.id==='wine-nested-createprocess'?'':'Microsoft Windows 10.0',
   spec.id==='wine-nested-createprocess'&&!nestedMarker?'':spec.marker,...(spec.markers??[]),spec.digest].filter(Boolean).map(s=>terminal?encode(s):s).join('\n'),
  stderr:spec.expectedCodeRejection?'translation failed':'',translationLog:'',milliseconds:1,
  translator:{units:1},units:{requests:1,compiled:1},memoryFaults:spec.expectedFault?[spec.expectedFault]:[]});};
 await vm.runInNewContext(fs.readFileSync(filename,'utf8'),{__dirname:directory,Buffer,process,
  console:{log(){},error(){}},require:name=>name==='fs'?fakeFS:name==='./linux-host/supervise.cjs'?{runIsolatedGuest}:localRequire(name)}, {filename});
 return {report,launched,code:process.exitCode??0};
}
test('missing optional Wine candidate is reported unsupported; required candidate fails',async()=>{
 const optional=await suite();const required=await suite({required:true});
 assert.equal(optional.code,0);assert.equal(required.code,1);
 assert.deepEqual(required.report.records.filter(r=>r.status==='unsupported').map(r=>r.id),
  ['wine-command-flat-window','wine-nested-createprocess','wine-fs-contract','wine-spawn-contract']);
 assert.equal(required.report.records.find(r=>r.id==='linux-userspace').status,'passed');
});
test('nested CreateProcess needs its own markers and execution evidence, not version output',async()=>{
 const passed=await suite({flat:true,required:true});const failed=await suite({flat:true,required:true,nestedMarker:false});
 assert.equal(passed.code,0);assert.equal(failed.code,1);
 assert.equal((await suite({flat:true,required:true,terminal:true})).code,0);
 const nested=passed.report.records.find(r=>r.id==='wine-nested-createprocess');
 assert.equal(nested.status,'passed');assert.equal(nested.windowsVersion,null);
 assert.equal(failed.report.records.find(r=>r.id==='wine-nested-createprocess').status,'failed');
});

test('adapted workloads and contracts are separate direct guest sessions',async()=>{
 const {launched}=await suite({flat:true,required:true});
 const command=launched.find(s=>s.id==='wine-command-flat-window');
 assert.deepEqual([...command.argv],['/opt/wine-flat/bin/wine','/usr/lib/wine/x86_64-windows/cmd.exe','/c','ver']);
 for(const id of ['wine-fs-contract','wine-spawn-contract']){
  const spec=launched.find(s=>s.id===id);assert.equal(spec.argv.length,1);
  assert.match(spec.argv[0],/contract\.elf$|fs-reset\.elf$/);
  assert.equal(spec.sharedAddressSpace,false);
  assert.ok(launched.indexOf(spec)>launched.findIndex(s=>s.id==='wine-nested-createprocess'));
 }
});
