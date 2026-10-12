// SPDX-License-Identifier: GPL-3.0-or-later
// Tests the OS deadline supervisor with deliberately stuck IPC fixtures, not FEX.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
const {runIsolatedGuest}=createRequire(import.meta.url)('./linux-host/supervise.cjs');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'betterjit-supervisor-'));
const entry=path.join(temp,'case.cjs');
fs.writeFileSync(entry,`process.once('message',spec=>{
 if(spec.done)process.send({result:{code:0,stdout:'fixture'}},()=>{});
 else process.send({progress:{stdout:'partial fixture evidence'}},()=>{while(true){}});
});`);
test('OS supervisor retains results and cleans up the owned runner',async()=>{
 const result=await runIsolatedGuest({done:true,timeout:2},{entry,graceSeconds:0});
 assert.equal(result.code,0);assert.equal(result.stdout,'fixture');
});
test('OS supervisor stops an unresponsive event loop and retains partial evidence',async()=>{
 const started=performance.now();
 await assert.rejects(runIsolatedGuest({timeout:0.25},{entry,graceSeconds:0}),error=>
  /supervisor deadline/.test(error.message)&&error.stdout==='partial fixture evidence');
 assert.ok(performance.now()-started<3000);
});
test.after(()=>fs.rmSync(temp,{recursive:true}));
