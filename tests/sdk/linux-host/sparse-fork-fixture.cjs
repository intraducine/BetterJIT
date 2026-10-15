// SPDX-License-Identifier: GPL-3.0-or-later
// Guest forks, chooses its own path, and waits for/reaps its child.
const CODE=0x123400004000n,DATA=0x123456780000n,SHARED=0x124000000000n,PAGE=4096n,STACK=DATA+PAGE;
const imm64=n=>Array.from({length:8},(_,i)=>Number(BigInt.asUintN(64,n)>>BigInt(i*8)&255n));
function make({badStatus=false}={}) {
const source=[],labels=new Map();let next=CODE;
function emit(name,bytes,operation=0,width=0,label){const p={name,code:Uint8Array.from(bytes),rip:next,nextRip:next+BigInt(bytes.length),operation,width,label};next=p.nextRip;source.push(p);}
function mark(name){labels.set(name,next);}
function jz(name,label){emit(name,[0x74,0],7,0,label);}
emit('guest-stack',[0x48,0xbc,...imm64(STACK)]);emit('data-pointer',[0x48,0xbb,...imm64(DATA)]);emit('fork-number',[0xb8,57,0,0,0]);emit('fork',[15,5],5);
emit('save-fork-return',[0x48,0x89,0x03],2,8);emit('startup-error-value',[0x49,0xb8,...imm64(-11n)]);emit('compare-startup-error',[0x4c,0x39,0xc0],6);jz('startup-error-branch','error');
emit('test-fork-return',[0x48,0x85,0xc0],6);jz('choose-child','child');
emit('wait-child-pid',[0x48,0x89,0xc7]);emit('wait-status-address',[0x48,0xbe,...imm64(badStatus?1n:DATA+16n)]);emit('wait-options',[0xba,0,0,0,0]);emit('wait-rusage',[0x41,0xba,0,0,0,0]);emit('wait-number',[0xb8,61,0,0,0]);emit('wait',[15,5],5);
emit('save-wait-result',[0x48,0x89,0x43,0x20],2,8);emit('repeat-wait-number',[0xb8,61,0,0,0]);emit('repeat-wait',[15,5],5);emit('save-repeat-wait',[0x48,0x89,0x43,0x28],2,8);emit('parent-private-sentinel',[0xc7,0x43,8,17,0,0,0],2,4);emit('shared-address',[0x48,0xbf,...imm64(SHARED)]);emit('read-shared-after-wait',[0x8b,0x07],1,4);emit('save-shared-result',[0x48,0x89,0x43,0x18],2,8);emit('parent-exit-code',[0xbf,17,0,0,0]);emit('parent-exit-number',[0xb8,60,0,0,0]);emit('parent-exit',[15,5],5);
mark('child');emit('child-private-sentinel',[0xc7,0x43,8,43,0,0,0],2,4);emit('child-shared-address',[0x48,0xbf,...imm64(SHARED)]);emit('child-shared-sentinel',[0xc7,0x07,85,0,0,0],2,4);emit('child-exit-code',[0xbf,23,0,0,0]);emit('child-exit-number',[0xb8,60,0,0,0]);emit('child-exit',[15,5],5);
mark('error');emit('error-exit-code',[0xbf,31,0,0,0]);emit('error-exit-number',[0xb8,60,0,0,0]);emit('error-exit',[15,5],5);
for(const p of source)if(p.label){const offset=Number(labels.get(p.label)-p.nextRip);if(offset<-128||offset>127)throw Error('Fixture branch too far');p.code[1]=offset&255;}
return {CODE,DATA,SHARED,PAGE,STACK,childRip:labels.get('child'),program:source,image:Uint8Array.from(source.flatMap(p=>[...p.code]))};
}
module.exports={...make(),make};
