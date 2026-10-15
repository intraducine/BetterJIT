// SPDX-License-Identifier: GPL-3.0-or-later
// A guest bootstrap forks and execs an immutable, real ELF64 file.
const CODE=0x123400004000n,DATA=0x123456780000n,PAGE=4096n,STACK=DATA+PAGE,
 HEADER=0x125500000000n,TEXT=HEADER+4n*PAGE,ELFDATA=HEADER+8n*PAGE;
const imm64=n=>Array.from({length:8},(_,i)=>Number(BigInt.asUintN(64,n)>>BigInt(i*8)&255n));
function assembler(base){let next=base;const program=[],labels=new Map();return {program,mark:n=>labels.set(n,next),
 emit(name,bytes,operation=0,width=0,label){const p={name,code:Uint8Array.from(bytes),rip:next,nextRip:next+BigInt(bytes.length),operation,width,label};next=p.nextRip;program.push(p);},
 finish(){for(const p of program)if(p.label){new DataView(p.code.buffer).setInt32(2,Number(labels.get(p.label)-p.nextRip),true);}return Uint8Array.from(program.flatMap(p=>[...p.code]));}};}
function target(){const a=assembler(TEXT),e=a.emit;
 function check(name,load,want){e(name,load,1,8);e(name+'-expected',[0x49,0xb8,...imm64(want)]);e(name+'-cmp',[0x4c,0x39,0xc0],6);e(name+'-jnz',[15,0x85,0,0,0,0],7,0,'fail');}
 check('argc',[0x48,0x8b,0x04,0x24],2n);
 e('argv0-pointer',[0x48,0x8b,0x7c,0x24,8],1,8);check('argv0',[0x48,0x8b,7],0x6365732f6e69622fn);
 e('argv1-pointer',[0x48,0x8b,0x7c,0x24,16],1,8);check('argv1',[0x48,0x8b,7],0x0067464544636261n);
 check('argv-null',[0x48,0x8b,0x44,0x24,24],0n);
 e('env0-pointer',[0x48,0x8b,0x7c,0x24,32],1,8);check('env0',[0x48,0x8b,7],0x0045554c41563d4bn);
 e('bss-pointer',[0x48,0xbf,...imm64(ELFDATA+8n)]);check('bss',[0x48,0x8b,7],0n);
 e('success-code',[0xbf,37,0,0,0]);e('exit-number',[0xb8,60,0,0,0]);e('exit',[15,5],5);
 a.mark('fail');e('failure-code',[0xbf,91,0,0,0]);e('failure-number',[0xb8,60,0,0,0]);e('failure-exit',[15,5],5);
 return {image:a.finish(),program:a.program};}
function elf(){const t=target(),b=new Uint8Array(8192+8),v=new DataView(b.buffer);b.set([127,69,76,70,2,1,1]);
 v.setUint16(16,2,true);v.setUint16(18,62,true);v.setUint32(20,1,true);v.setBigUint64(24,TEXT,true);v.setBigUint64(32,64n,true);v.setUint16(52,64,true);v.setUint16(54,56,true);v.setUint16(56,3,true);
 for(const [i,p]of [[0,[4,0n,HEADER,4096n,4096n]],[1,[5,4096n,TEXT,BigInt(t.image.length),4096n]],[2,[6,8192n,ELFDATA,8n,8192n]]]){const at=64+i*56;v.setUint32(at,1,true);v.setUint32(at+4,p[0],true);for(const [off,n]of [[8,p[1]],[16,p[2]],[32,p[3]],[40,p[4]],[48,PAGE]])v.setBigUint64(at+off,n,true);}
 b.set(t.image,4096);b.set([1,2,3,4,5,6,7,8],8192);return {bytes:b,...t};}
function bootstrap(){const a=assembler(CODE),e=a.emit;
 e('stack',[0x48,0xbc,...imm64(STACK)]);e('data',[0x48,0xbb,...imm64(DATA)]);e('fork-number',[0xb8,57,0,0,0]);e('fork',[15,5],5);e('test-fork',[0x48,0x85,0xc0],6);e('child-branch',[15,0x84,0,0,0,0],7,0,'child');
 e('child-pid',[0x48,0x89,0xc7]);e('save-pid',[0x48,0x89,3],2,8);e('wait-status',[0x48,0xbe,...imm64(DATA+8n)]);e('options',[0xba,0,0,0,0]);e('rusage',[0x41,0xba,0,0,0,0]);e('wait-number',[0xb8,61,0,0,0]);e('wait',[15,5],5);e('save-wait',[0x48,0x89,0x43,16],2,8);e('parent-code',[0xbf,17,0,0,0]);e('parent-exit-number',[0xb8,60,0,0,0]);e('parent-exit',[15,5],5);
 a.mark('child');e('exec-path',[0x48,0xbf,...imm64(DATA+128n)]);e('exec-argv',[0x48,0xbe,...imm64(DATA+64n)]);e('exec-envp',[0x48,0xba,...imm64(DATA+96n)]);e('exec-number',[0xb8,59,0,0,0]);e('exec',[15,5],5);e('save-exec-error',[0x48,0x89,0x43,24],2,8);e('error-code',[0xbf,31,0,0,0]);e('error-number',[0xb8,60,0,0,0]);e('error-exit',[15,5],5);
 const data=new Uint8Array(4096),v=new DataView(data.buffer);for(const [at,p]of [[64,DATA+128n],[72,DATA+160n],[96,DATA+192n]])v.setBigUint64(at,p,true);
 for(const [at,s]of [[128,'/bin/second\0'],[160,'abcDEFg\0'],[192,'K=VALUE\0']])data.set(new TextEncoder().encode(s),at);
 return {image:a.finish(),program:a.program,data};}
module.exports={CODE,DATA,PAGE,STACK,HEADER,TEXT,ELFDATA,elf,bootstrap};
