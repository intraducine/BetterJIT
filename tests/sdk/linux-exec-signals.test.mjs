// SPDX-License-Identifier: GPL-3.0-or-later
// Actual promoted exec syscall path with image/worker stubs; not guest execution.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
globalThis.self=globalThis;
vm.runInThisContext(fs.readFileSync(new URL('../../Sources/BetterJITLinux/Resources/linux/web/linux-kernel.js',import.meta.url),'utf8'));
const {Kernel,Process,Thread,EXIT_THREAD,KError}=LinuxBundle.require('./kernel.js');
const {SYS,E}=LinuxBundle.require('./abi.js');
const {sys}=LinuxBundle.require('./syscalls.js');
function setup(fail=false) {
 const killed=[],k=new Kernel({vfs:{},killThread:tid=>killed.push(tid)},{});
 const proc=new Process(k,100,1),t=new Thread(proc,100,0,0);let replacement;
 t.sigmask=1n<<11n;proc.threads.set(t.tid,t);k.threads.set(t.tid,t);k.slots[0]=t;
 proc.actions[10].handler=0x1234n;proc.actions[12].handler=1n;
 k.path=()=>'/fixture/child';k.strArray=()=>[];
 k.loadImage=()=>{if(fail)throw new KError(E.NOENT);return {space:2};};
 k.freeTb=()=>{};k.releaseImage=()=>{};
 k.installImage=()=>replacement=new Thread(proc,100,1,0);
 return {k,t,proc,killed,replacement:()=>replacement};
}
for(const name of ['execve','execveat'])test(`${name} preserves the caller signal mask when replacing its worker`,()=>{
 const s=setup();
 assert.equal(sys[SYS[name]].call(s.k,s.t,0n,0n,0n,0n,0n),EXIT_THREAD);
 assert.equal(s.replacement().sigmask,1n<<11n);
 assert.equal(s.proc.actions[10].handler,0n);assert.equal(s.proc.actions[12].handler,1n);
 assert.deepEqual(s.killed,[100]);assert.equal(s.t.dead,true);
});
test('failed exec leaves the caller mask, dispositions and worker intact',()=>{
 const s=setup(true);
 assert.throws(()=>sys[SYS.execve].call(s.k,s.t,0n,0n,0n),e=>e.code===E.NOENT);
 assert.equal(s.t.sigmask,1n<<11n);assert.equal(s.proc.actions[10].handler,0x1234n);
 assert.equal(s.t.dead,false);assert.deepEqual(s.killed,[]);assert.equal(s.replacement(),undefined);
});
