// ELF64 x86-64 parsing for execve (js/linux/kernel.js maps the segments).
'use strict';

const PT_LOAD = 1, PT_INTERP = 3, PT_PHDR = 6, PT_GNU_STACK = 0x6474e551;

// -> { type: 'exec'|'dyn', entry, phoff, phentsize, phnum, phdrs: [{type, flags, offset, vaddr, filesz, memsz, align}],
//      interp: string|null, minVaddr, maxVaddr } or null if not an x86-64 ELF64.
function parse(bytes) {
  if (bytes.length < 64 || bytes[0] !== 0x7f || bytes[1] !== 0x45 || bytes[2] !== 0x4c || bytes[3] !== 0x46) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes[4] !== 2 || bytes[5] !== 1 || dv.getUint16(18, true) !== 62) return null; // ELFCLASS64, LSB, EM_X86_64
  const etype = dv.getUint16(16, true);
  const e = {
    type: etype === 2 ? 'exec' : etype === 3 ? 'dyn' : null,
    entry: Number(dv.getBigUint64(24, true)),
    phoff: Number(dv.getBigUint64(32, true)),
    phentsize: dv.getUint16(54, true),
    phnum: dv.getUint16(56, true),
    phdrs: [],
    interp: null,
    minVaddr: Infinity,
    maxVaddr: 0,
  };
  if (!e.type) return null;
  for (let i = 0; i < e.phnum; i++) {
    const o = e.phoff + i * e.phentsize;
    if (o + 56 > bytes.length) return null;
    const p = {
      type: dv.getUint32(o, true),
      flags: dv.getUint32(o + 4, true),
      offset: Number(dv.getBigUint64(o + 8, true)),
      vaddr: Number(dv.getBigUint64(o + 16, true)),
      filesz: Number(dv.getBigUint64(o + 32, true)),
      memsz: Number(dv.getBigUint64(o + 40, true)),
      align: Number(dv.getBigUint64(o + 48, true)),
    };
    e.phdrs.push(p);
    if (p.type === PT_LOAD) {
      e.minVaddr = Math.min(e.minVaddr, p.vaddr);
      e.maxVaddr = Math.max(e.maxVaddr, p.vaddr + p.memsz);
    } else if (p.type === PT_INTERP) {
      let s = '';
      for (let k = p.offset; k < p.offset + p.filesz && bytes[k]; k++) s += String.fromCharCode(bytes[k]);
      e.interp = s;
    }
  }
  return e;
}

module.exports = { parse, PT_LOAD, PT_INTERP, PT_PHDR, PT_GNU_STACK };
