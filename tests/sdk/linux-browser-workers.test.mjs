// SPDX-License-Identifier: GPL-3.0-or-later
// Tests the page's actual worker owner; these are lifecycle fixtures, not guests.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
function group() {
 const context=vm.createContext({self:{},Map});
 vm.runInContext(fs.readFileSync(new URL('../../Sources/BetterJITLinux/Resources/linux/web/owned_workers.js',import.meta.url),'utf8'),context);
 return new context.self.FexGuestWorkers();
}
function worker() {
 return {onmessage:()=>{},onerror:()=>{},messages:[],terminated:0,
  postMessage(m){this.messages.push(m);},terminate(){assert.equal(this.onmessage,null);assert.equal(this.onerror,null);this.terminated++;}};
}
test('exec replacement disposes captures and stale completion cannot remove its replacement',()=>{
 const g=group(),old=worker(),next=worker();let releases=0;
 g.add(100,old,()=>releases++);g.add(100,next,()=>releases++);
 assert.equal(old.terminated,1);assert.equal(releases,1);assert.equal(g.current.get(100),next);
 assert.equal(g.dispose(old),false);assert.equal(g.current.get(100),next);
 assert.equal(g.reply(old,{op:'unit'}),false);assert.equal(old.messages.length,0);
 g.close();g.close();assert.equal(next.terminated,1);assert.equal(releases,2);
 assert.equal(g.owned.size,0);assert.equal(g.current.size,0);
});
test('pending translation resolves after close without posting to a disposed worker',async()=>{
 const g=group(),w=worker();g.add(1,w,()=>{});
 let resolve;const pending=new Promise(r=>{resolve=r;}).then(m=>g.reply(w,m));
 g.close();resolve({op:'unit',id:4});assert.equal(await pending,false);
 assert.equal(w.messages.length,0);assert.equal(w.onmessage,null);
});
test('kill releases only its worker once and active replies still reach their owner',()=>{
 const g=group(),left=worker(),right=worker();let releases=0;
 g.add(1,left,()=>releases++);g.add(2,right,()=>releases++);
 g.kill(1);g.kill(1);assert.equal(releases,1);assert.equal(g.reply(right,{op:'unit'}),true);
 assert.equal(right.messages.length,1);g.close();assert.equal(releases,2);
});
test('a late spawn after close is terminated and released without regaining ownership',()=>{
 const g=group(),w=worker();let releases=0;g.close();g.add(7,w,()=>releases++);
 assert.equal(w.terminated,1);assert.equal(releases,1);assert.equal(g.owned.size,0);
 assert.equal(g.reply(w,{op:'unit'}),false);
});
