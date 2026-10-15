// SPDX-License-Identifier: GPL-3.0-or-later
// Branch-free guest clone/exit program: both threads execute the same continuation.
const CODE=0x123400004000n,DATA=0x123456780000n,PAGE=4096n;
const PARENT_STACK=DATA+PAGE,CHILD_STACK=DATA+3n*PAGE;
const imm64=n=>Array.from({length:8},(_,i)=>Number(n>>BigInt(i*8)&255n));
const source=[
 ['parent-stack',[0x48,0xbc,...imm64(PARENT_STACK)]],
 ['clone-number',[0xb8,56,0,0,0]],
 ['clone-flags',[0xbf,0,0x0f,1,0]],
 ['child-stack',[0x48,0xbe,...imm64(CHILD_STACK)]],
 ['no-parent-tid',[0xba,0,0,0,0]],
 ['no-child-tid',[0x41,0xba,0,0,0,0]],
 ['no-tls',[0x41,0xb8,0,0,0,0]],
 ['clone',[0x0f,0x05],5,0],
 ['save-return-on-own-stack',[0x48,0x89,0x44,0x24,0xf8],2,8],
 ['exit-code-from-return',[0x48,0x89,0xc7]],
 ['exit-number',[0xb8,60,0,0,0]],
 ['exit',[0x0f,0x05],5,0],
 ['must-not-execute',[0x48,0xc7,0x44,0x24,0xf8,0xff,0xff,0xff,0xff],2,8],
];
let next=CODE;
const program=source.map(([name,code,operation=0,width=0])=>{const rip=next;next+=BigInt(code.length);return {name,code:Uint8Array.from(code),rip,nextRip:next,operation,width};});
module.exports={CODE,DATA,PAGE,PARENT_STACK,CHILD_STACK,program,image:Uint8Array.from(program.flatMap(p=>[...p.code]))};
