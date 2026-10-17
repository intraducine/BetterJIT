// SPDX-License-Identifier: GPL-3.0-or-later
// Repository-only exact source drift check; intentionally outside the SDK export.
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';
import crypto from 'node:crypto';import os from 'node:os';import path from 'node:path';import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
for(const n of ['guest_memory','guest_memory_broker'])vm.runInThisContext(fs.readFileSync(new URL('../../Sources/BetterJITLinux/Resources/linux/'+n+'.js',import.meta.url),'utf8'));
const B=BetterJITGuestMemoryBroker;
test('SDK allowlist alone contains the inputs needed by all exported Node tests',()=>{
 const root=fileURLToPath(new URL('../../',import.meta.url)),specBytes=fs.readFileSync(new URL('../../distribution/sdk-files.json',import.meta.url)),
  spec=JSON.parse(specBytes),temporary=fs.mkdtempSync(path.join(os.tmpdir(),'betterjit-sdk-export-')),sdk=path.join(temporary,'BetterJIT-SDK'),hashes={};
 const sha=b=>crypto.createHash('sha256').update(b).digest('hex'),inside=(base,name)=>{base=path.resolve(base);const resolved=path.resolve(base,name);assert(resolved.startsWith(base+path.sep));return resolved;};
 try{for(const [destination,source]of Object.entries(spec.files)){
   const target=inside(sdk,destination),input=inside(root,source);assert(fs.lstatSync(input).isFile(),source);const bytes=fs.readFileSync(input);
   fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,bytes,{mode:fs.statSync(input).mode&0o777});hashes[destination]=sha(bytes);
  }
  assert.equal(fs.existsSync(path.join(sdk,'fexwasm/src/backend.cpp')),false,'The SDK must not need the unshipped backend implementation');
  assert.equal(fs.existsSync(path.join(sdk,'tests/fexhost/read-arithmetic-materializer.test.mjs')),false,'Repository-only checks must not enter the exported Node glob');
  const tests=fs.readdirSync(path.join(sdk,'tests/sdk')).filter(n=>n.endsWith('.test.mjs')).sort().map(n=>'tests/sdk/'+n);
  // A Node test worker passes NODE_TEST_CONTEXT to children; inheriting it
  // would make a nested --test invocation skip every file while exiting zero.
  const env={...process.env};delete env.NODE_TEST_CONTEXT;
  const run=spawnSync(process.execPath,['--test','--test-reporter=tap',...tests],{cwd:sdk,env,encoding:'utf8',timeout:60000,maxBuffer:8*1024*1024});
  const evidence=path.join(root,'.build');fs.mkdirSync(evidence,{recursive:true});fs.writeFileSync(path.join(evidence,'sdk-export-shape-tests.log'),run.stdout+'\n'+run.stderr);
  const completed=Number(run.stdout.match(/^# tests (\d+)$/m)?.[1]??0),passed=Number(run.stdout.match(/^# pass (\d+)$/m)?.[1]??0),skipped=Number(run.stdout.match(/^# skipped (\d+)$/m)?.[1]??0);
  const summary={kind:'allowlist-only working-source SDK test copy; no commit or publication',allowlistSHA256:sha(specBytes),exportedFiles:Object.keys(hashes).length,completed,passed,skipped,
   sourceHashes:hashes,testFiles:tests,exitCode:run.status,signal:run.signal,backendSourceAbsent:true,repositoryOnlyTestAbsent:true,
   stdoutSHA256:sha(run.stdout),stderrSHA256:sha(run.stderr)};
  fs.writeFileSync(path.join(evidence,'sdk-export-shape-results.json'),JSON.stringify(summary,null,2)+'\n');
  assert.equal(run.error,undefined);assert.equal(run.status,0,run.stdout+'\n'+run.stderr);
  assert(completed>=tests.length,'The nested runner must actually execute every exported test file');
  assert.match(run.stdout,/SUB headers and static kernel plans/);assert.match(run.stdout,/owned FA\/FB checks reject/);
  assert.equal(passed+skipped,completed);
 }finally{fs.rmSync(temporary,{recursive:true,force:true});}
});
test('production arithmetic materializer matches exact source-bound C++ semantics',()=>{
 const source=fs.readFileSync(new URL('../../fexwasm/src/backend.cpp',import.meta.url),'utf8'),
  helpers=source.slice(source.indexOf('enum FlagKind : int32_t {'),source.indexOf('// Whether an arm64 condition holds')),
  body=source.slice(source.indexOf('uint32_t MaterializeFlags(uint32_t Kind,'),source.indexOf('\nstd::vector<uint8_t> BuildDispatcher'));
 assert.equal(crypto.createHash('sha256').update(helpers+body).digest('hex'),'b5d2f4deb1edc0aaeb68085158038ffe9326a0be90eb070fa414b6109adbb776');
 const values=[0n,1n,15n,16n,0x7fffffffn,0x80000000n,0xffffffffn,0x100000000n,0x7fffffffffffffffn,0x8000000000000000n,0xffffffffffffffffn],rows=[];
 for(const kind of [0,1,2,19,20])for(const a of values)for(const b of values)for(const stored of [0,0x20000000,0xffffffff])rows.push([kind,a,b,stored]);
 let seed=0x5b1e827341n;for(let i=0;i<1024;i++){seed=BigInt.asUintN(64,seed*6364136223846793005n+1442695040888963407n);const a=seed;seed=BigInt.asUintN(64,seed*6364136223846793005n+1442695040888963407n);for(const kind of [0,1,2,19,20])rows.push([kind,a,seed,Number(seed&0xffffffffn)]);}
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'betterjit-arithmetic-flags-'));
 try{const cpp=path.join(directory,'reference.cpp'),binary=path.join(directory,'reference');fs.writeFileSync(cpp,'#include <cstdint>\n#include <cstring>\n#include <iostream>\n'+helpers+body+'\nint main(){uint32_t k,n;uint64_t a,b;while(std::cin>>k>>std::hex>>a>>b>>n>>std::dec)std::cout<<MaterializeFlags(k,a,b,n)<<"\\n";}\n');
  const build=spawnSync(process.env.CXX||'c++',['-std=c++20','-O2',cpp,'-o',binary],{encoding:'utf8',timeout:20000});assert.equal(build.status,0,build.stderr);
  const run=spawnSync(binary,[],{input:rows.map(([k,a,b,n])=>`${k} ${a.toString(16)} ${b.toString(16)} ${n.toString(16)}\n`).join(''),encoding:'utf8',timeout:20000});assert.equal(run.status,0,run.stderr);
  assert.deepEqual(rows.map(([k,a,b,n])=>B.materializeArithmeticNZCV(k,a,b,n)),run.stdout.trim().split('\n').map(Number));
 }finally{fs.rmSync(directory,{recursive:true,force:true});}
 for(const kind of [-1,3,4,15,16,31,32,0xffffffff])assert.throws(()=>B.materializeArithmeticNZCV(kind,0n,0n,0),/Unknown/);
});
