// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import test from 'node:test';
import {Worker} from 'node:worker_threads';
import {createRequire} from 'node:module';
const {GuestWorkers}=createRequire(import.meta.url)('./linux-host/workers.cjs');
test('exec replacement survives the old worker exit and every owned worker is closed',async()=>{
 const group=new GuestWorkers();let released=0;
 const old=new Worker('setInterval(()=>{},1000)',{eval:true}),next=new Worker('setInterval(()=>{},1000)',{eval:true});
 group.add(100,old,()=>released++);group.kill(100);group.add(100,next,()=>released++);
 await old.terminate();assert.equal(group.get(100),next);assert.ok(group.owned.has(next));
 await group.close();assert.equal(group.get(100),undefined);assert.equal(group.owned.size,0);assert.equal(released,2);
});
