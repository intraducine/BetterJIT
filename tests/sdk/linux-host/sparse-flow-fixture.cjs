// SPDX-License-Identifier: GPL-3.0-or-later
// Guest clone return value selects parent/child paths; no host chooses their RIPs.
const F=require('./sparse-clone-fixture.cjs');
const source=F.program.slice(0,9).map(p=>[p.name,[...p.code],p.operation,p.width]);
source.push(['test-clone-return',[0x48,0x85,0xc0],6,0],['child-branch',[0x74,7],7,0],
 ['parent-exit-code',[0xbf,17,0,0,0],0,0],['join-exit',[0xeb,5],7,0],
 ['child-exit-code',[0xbf,23,0,0,0],0,0],['exit-number',[0xb8,60,0,0,0],0,0],['exit',[15,5],5,0]);
let next=F.CODE;
const program=source.map(([name,code,operation,width])=>{const rip=next;next+=BigInt(code.length);return {name,code:Uint8Array.from(code),rip,nextRip:next,operation,width};});
module.exports={...F,program,image:Uint8Array.from(program.flatMap(p=>[...p.code])),parentExitCode:17,childExitCode:23};
