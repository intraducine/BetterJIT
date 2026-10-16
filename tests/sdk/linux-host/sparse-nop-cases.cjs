// SPDX-License-Identifier: GPL-3.0-or-later
// Explicit architectural NOP encodings, shared only as oracle inputs.
function operand(mod,rm,sib=0x24) {
  const bytes=[(mod<<6)|rm];
  if(mod!==3&&rm===4)bytes.push(sib);
  const width=mod===1?1:mod===2||mod===0&&(rm===5||rm===4&&(sib&7)===5)?4:0;
  return [...bytes,...Array(width).fill(0x81)];
}
function cases() {
  const unique=new Map(),add=bytes=>{if(bytes.length<=15)unique.set(Buffer.from(bytes).toString('hex'),bytes);};
  const prefixes=[[],[0x66],[0x67],[0x26],[0x2e],[0x36],[0x3e],[0x64],[0x65],
    [0x66,0x66,0x2e],[0x64,0x67,0x66],[0x65,0x64,0x26,0x2e,0x36,0x3e],
    [0x67,0x67,0x66,0x66],Array(14).fill(0x66)];
  for(const prefix of prefixes){
    add([...prefix,0x90]);
    for(let rex=0x40;rex<=0x4f;rex++)if(!(rex&1))add([...prefix,rex,0x90]);
    for(const [mod,rm,sib]of [[0,0],[0,4,0],[0,5],[1,7],[2,4,0],[3,0],[3,7]])
      add([...prefix,0x0f,0x1f,...operand(mod,rm,sib)]);
  }
  // Every ModRM addressing mode and REX bit, including register operands.
  for(let mod=0;mod<4;mod++)for(let rm=0;rm<8;rm++)for(let rex=0x40;rex<=0x4f;rex++)
    add([rex,0x0f,0x1f,...operand(mod,rm)]);
  // Every SIB scale/index/base combination at each displacement width.
  for(let mod=0;mod<3;mod++)for(let sib=0;sib<256;sib++)add([0x0f,0x1f,...operand(mod,4,sib)]);
  // Exact next instruction from the retained Wine/musl bootstrap receipt.
  add([0x66,0x66,0x2e,0x0f,0x1f,0x84,0,0,0,0,0]);
  // Legal 15-byte boundaries for both opcode families and ModRM displacement.
  add([...Array(12).fill(0x66),0x0f,0x1f,0xc0]);
  add([...Array(7).fill(0x66),0x0f,0x1f,0x84,0,0,0,0,0]);
  return [...unique.values()];
}
module.exports={cases};
