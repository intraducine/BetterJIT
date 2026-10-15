// SPDX-License-Identifier: GPL-3.0-or-later
const F=require('./sparse-exec-fixture.cjs');
function cases(){return[
 {id:'empty',input:new Uint8Array(0)},
 {id:'text',input:new TextEncoder().encode('Hello, BetterJIT stdin!\né🙂\n')},
 {id:'split-utf8',input:new TextEncoder().encode('x'.repeat(4095)+'é🙂\n')},
 {id:'large',input:new TextEncoder().encode('line: BetterJIT stdin 0123456789\n'.repeat(9000)).slice(0,256*1024)},
 {id:'argument',input:new TextEncoder().encode('unconsumed'),argument:'unexpected',exitCode:64},
 {id:'closed-stdin',input:new Uint8Array(0),closed:true,exitCode:74},
 {id:'shared-cursor',input:new TextEncoder().encode('A shared cursor survives fork and exec. é🙂\n'),preRead:true},
 {id:'leading-bom',input:new TextEncoder().encode('\ufeffHello BOM\n')},
 {id:'boundary-bom',input:new TextEncoder().encode('x'.repeat(4096)+'\ufeffAfter read boundary\n')},
 {id:'split-bom',input:new TextEncoder().encode('x'.repeat(4095)+'\ufeffSplit across reads\n')}
];}
function bootstrap(preRead){const b=F.bootstrap();if(!preRead)return b;
 const program=[];let rip=F.CODE;const emit=(name,code,operation=0)=>{program.push({name,code:Uint8Array.from(code),rip,nextRip:rip+BigInt(code.length),operation,width:0});rip+=BigInt(code.length);},imm=n=>Array.from({length:8},(_,i)=>Number(n>>BigInt(i*8)&255n));
 emit('stdin-number',[0xb8,0,0,0,0]);emit('stdin-fd',[0xbf,0,0,0,0]);emit('stdin-buffer',[0x48,0xbe,...imm(F.DATA+512n)]);emit('stdin-count',[0xba,1,0,0,0]);emit('stdin-read',[15,5],5);emit('prefix-write-number',[0xb8,1,0,0,0]);emit('prefix-write-fd',[0xbf,1,0,0,0]);emit('prefix-write',[15,5],5);
 const delta=rip-F.CODE;return{...b,image:Uint8Array.from([...program.flatMap(p=>[...p.code]),...b.image]),program:[...program,...b.program.map(p=>({...p,rip:p.rip+delta,nextRip:p.nextRip+delta}))]};
}
module.exports={cases,bootstrap};
