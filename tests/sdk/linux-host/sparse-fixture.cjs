// SPDX-License-Identifier: GPL-3.0-or-later
// Synthetic, libc-free MOV instruction program. No device inputs.
const CODE=0x123400004000n,DATA=0x123456780000n,SHARED=0x124000000000n;
const FS=0x100000000n,GS=0x200000000n,PAGE=4096n;
const SOURCE=0x1122334455667788n,FS_VALUE=0xf500000000000010n,GS_VALUE=0x6500000000000020n;
const entries=[
 ['private-store',[0x48,0x89,0x03],2,8],
 ['private-load',[0x48,0x8b,0x13],1,8],
 ['all-one-load',[0x48,0x8b,0x4b,0x10],1,8],
 ['shared-store',[0x49,0x89,0x01],2,8],
 ['shared-load-0',[0x4d,0x8b,0x10],1,8],
 ['shared-load-1',[0x4d,0x8b,0x58,0x08],1,8],
 ['shared-load-2',[0x4d,0x8b,0x60,0x10],1,8],
 ['cross-page-store',[0x48,0x89,0x83,0xfc,0x0f,0,0],2,8],
 ['cross-page-load',[0x4c,0x8b,0xab,0xfc,0x0f,0,0],1,8],
 ['fs-load',[0x64,0x4c,0x8b,0x73,0x20],1,8],
 ['gs-load',[0x65,0x4c,0x8b,0x7b,0x28],1,8],
 ['change-source',[0x48,0xb8,0x88,0x77,0x66,0x55,0x44,0x33,0x22,0x11],0,0],
 ['protected-cross-page-store',[0x48,0x89,0x83,0xfc,0x0f,0,0],2,8],
];
let next=CODE;
const program=entries.map(([name,code,operation,width])=>{
 const rip=next;next+=BigInt(code.length);return {name,code:Uint8Array.from(code),rip,nextRip:next,operation,width};
});
const code=Uint8Array.from(program.flatMap(p=>[...p.code]));
const sentinel=i=>0xffffffffffffffffn-BigInt(i);
module.exports={CODE,DATA,SHARED,FS,GS,PAGE,SOURCE,FS_VALUE,GS_VALUE,program,code,sentinel};
