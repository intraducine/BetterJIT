// SPDX-License-Identifier: GPL-3.0-or-later
// Legitimate libc-free x86-64 fault inputs; the expected outcome is a trap,
// not successful Linux or Windows execution. Each ELF has one RX PT_LOAD.
const ENTRY=0x400078;
function elf(code) {
 const bytes=Buffer.alloc(120+code.length);
 Buffer.from('7f454c46020101000000000000000000','hex').copy(bytes);
 bytes.writeUInt16LE(2,16);bytes.writeUInt16LE(62,18);bytes.writeUInt32LE(1,20);
 bytes.writeBigUInt64LE(BigInt(ENTRY),24);bytes.writeBigUInt64LE(64n,32);
 bytes.writeUInt16LE(64,52);bytes.writeUInt16LE(56,54);bytes.writeUInt16LE(1,56);
 bytes.writeUInt32LE(1,64);bytes.writeUInt32LE(5,68);
 bytes.writeBigUInt64LE(0x400000n,80);bytes.writeBigUInt64LE(0x400000n,88);
 bytes.writeBigUInt64LE(BigInt(bytes.length),96);bytes.writeBigUInt64LE(BigInt(bytes.length),104);
 bytes.writeBigUInt64LE(4096n,112);code.copy(bytes,120);return bytes;
}
function fixture(segment) {
 if (segment==='fill' || segment.startsWith('copy-')) {
  const fill=segment==='fill',bad=0x1fffff000n,dest=segment==='copy-source'?0x90000n:bad,
    source=segment==='copy-source'?bad:BigInt(ENTRY),code=[Buffer.from('fc','hex')]; // cld
  function mov(hex,value){const b=Buffer.from(hex+'0000000000000000','hex');b.writeBigUInt64LE(value,2);code.push(b);}
  mov('48bf',dest);
  if(fill)code.push(Buffer.from('31c0','hex'));else mov('48be',source);
  code.push(Buffer.from('b910000000','hex'));
  const rip=ENTRY+code.reduce((n,b)=>n+b.length,0),instruction=Buffer.from(fill?'f3aa':'f3a4','hex');code.push(instruction);
  const hex=value=>'0x'+value.toString(16);
  return {bytes:elf(Buffer.concat(code)),expected:{rip:hex(rip),guestAddress:hex(dest),wasmAddress:hex(dest&0xffffffffn),
   width:1,fsBase:'0x0',gsBase:'0x0',instructionHex:instruction.toString('hex'),wasmOpcode:'0xfc',
   wasmBulkOpcode:fill?'0xb':'0xa',accessKind:fill?'fill':'copy',byteLength:'0x10',wasmByteLength:'0x10',boundsConfirmed:true,
   ...(fill?{}:{sourceGuestAddress:hex(source),sourceWasmAddress:hex(source&0xffffffffn)})}};
 }
 const direct=segment==='direct',fs=segment==='fs';
 const base=direct?0n:fs?0x20000000n:0x30000000n;
 const address=0x1fffff000n,offset=address-base;
 const code=[];
 if(!direct) {
  // mov eax,158; mov edi,ARCH_SET_FS/GS; movabs rsi,base; syscall
  const setup=Buffer.from(fs?'b89e000000bf0210000048be00000000000000000f05':'b89e000000bf0110000048be00000000000000000f05','hex');
  setup.writeBigUInt64LE(base,12);code.push(setup);
 }
 const move=Buffer.from('48b80000000000000000','hex');move.writeBigUInt64LE(offset,2);code.push(move);
 const instruction=Buffer.from(direct?'488b18':fs?'64488b18':'65488b18','hex');
 const rip=ENTRY+code.reduce((n,b)=>n+b.length,0);code.push(instruction);
 return {bytes:elf(Buffer.concat(code)),expected:{rip:'0x'+rip.toString(16),guestAddress:'0x'+address.toString(16),
  wasmAddress:'0xfffff000',width:8,fsBase:fs?'0x20000000':'0x0',gsBase:!direct&&!fs?'0x30000000':'0x0',
  instructionHex:instruction.toString('hex'),wasmOpcode:'0x29',boundsConfirmed:true}};
}
module.exports={fixture};
