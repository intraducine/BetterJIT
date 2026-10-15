// SPDX-License-Identifier: GPL-3.0-or-later
const CODE=0x123400010000n,SHARED=0x124000000000n,PRIVATE=0x125000000000n,PAGE=4096n,ITERATIONS=16;
const PRIVATE_VALUE=0x9988776655443322n,ALIAS=SHARED+(1n<<32n);
const bytes64=value=>{let x=BigInt.asUintN(64,value);return Array.from({length:8},()=>{const b=Number(x&255n);x>>=8n;return b;});};
function program(index) {
 let rip=CODE+BigInt(index)*PAGE;const entries=[],pauses=[];
 function add(name,code,operation=0,width=0){const start=rip;rip+=BigInt(code.length);entries.push({name,code:Uint8Array.from(code),rip:start,nextRip:rip,operation,width});}
 const imm=(reg,value,name)=>add(name??'mov-immediate',[0x48|(reg>=8?1:0),0xb8+(reg&7),...bytes64(value)]);
 const move=(dst,src,name)=>add(name??'mov-register',[0x48|(dst>=8?1:0)|(src>=8?4:0),0x89,0xc0|((src&7)<<3)|(dst&7)]);
 function syscall(name,op,offset,value,timeout=0n,release) {
  imm(0,202n);imm(7,SHARED+BigInt(index)*0x10000n+offset);imm(6,BigInt(op));imm(2,value);imm(10,timeout);
  if(release!==undefined)pauses.push({after:entries.length,release});
  add(name,[0x0f,0x05],5,0);
 }
 if(index<3)for(let i=0;i<ITERATIONS;i++){imm(0,1n);add('counter-add',[0xf0,0x48,0x0f,0xc1,0x03],4,8);}
 else add('observer-start',[0x90]);
 pauses.push({after:entries.length,count:2,release:3});
 if(index===0) {
  syscall('private-wait',128,0x100n,0n);move(12,0,'save-private-wait');
  imm(0,BigInt(ITERATIONS*3));imm(2,99n);add('counter-cas-success',[0xf0,0x48,0x0f,0xb1,0x13],3,8);move(14,0,'save-cas-old');
  syscall('shared-wait',0,0x104n,0n);move(13,0,'save-shared-wait');
 } else if(index===1) {
  syscall('private-wake-other-mm',129,0x100n,1n,0n,5);move(12,0,'save-private-wake');
  syscall('shared-wake-alias',1,0x104n,1n,0n,7);move(13,0,'save-shared-wake');
  add('counter-final-read',[0x48,0x8b,0x03],1,8);move(15,0,'save-final-counter');
 } else if(index===2) {
  imm(0,0n);imm(2,77n);pauses.push({after:entries.length,release:5});
  add('counter-cas-mismatch',[0xf0,0x48,0x0f,0xb1,0x13],3,8);move(14,0,'save-mismatch-old');
  imm(0,PRIVATE_VALUE);add('private-progress-store',[0x49,0x89,0x01],2,8);add('private-progress-load',[0x4d,0x8b,0x39],1,8);
  syscall('compare-mismatch',0,0x108n,8n);move(13,0,'save-compare-mismatch');
  // Relative timeout remains a real guest futex timeout, independently of the
  // explicit same-mm wake exercised by the fourth thread.
  imm(0,202n);imm(7,PRIVATE+0x200n);imm(6,128n);imm(2,0n);imm(10,PRIVATE+0x100n);
  add('private-timeout',[0x0f,0x05],5,0);move(12,0,'save-timeout');
  // Stop immediately after this syscall: cancellation is verified without
  // claiming support for delivery of the queued signal to another instruction.
  imm(0,202n);imm(7,PRIVATE+0x204n);imm(6,128n);imm(2,0n);imm(10,0n);
  add('signal-cancelled-wait',[0x0f,0x05],5,0);
 } else {
  // This thread shares process 0's GuestAddressSpace, with independent CPU
  // state. The alias differs by 2^32 while naming the same canonical bytes.
  imm(0,202n);imm(7,ALIAS+0x100n);imm(6,129n);imm(2,1n);imm(10,0n);
  pauses.push({after:entries.length,release:9});
  add('private-wake-same-mm-other-alias',[0x0f,0x05],5,0);move(12,0,'save-alias-wake');
  imm(0,202n);imm(7,SHARED+0x100n);imm(6,129n);imm(2,1n);imm(10,0n);
  pauses.push({after:entries.length,release:11});
  add('private-wake-same-mm-same-va',[0x0f,0x05],5,0);move(13,0,'save-exact-wake');
 }
 return {index,entry:entries[0].rip,stopRip:rip,entries,pauses};
}
const programs=[0,1,2,3].map(program),image=new Uint8Array(4*Number(PAGE));
for(const p of programs)for(const e of p.entries)image.set(e.code,Number(e.rip-CODE));
module.exports={CODE,SHARED,PRIVATE,ALIAS,PAGE,ITERATIONS,PRIVATE_VALUE,programs,image};
