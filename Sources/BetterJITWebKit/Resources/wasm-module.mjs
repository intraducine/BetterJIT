// SPDX-License-Identifier: GPL-3.0-or-later
// Resource/signature preflight for the SDK's numeric Wasm profile. This is not
// an instruction validator: WebAssembly.compile still validates the whole module.
// Binary grammar: https://webassembly.github.io/spec/core/binary/modules.html
export class Fault extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
export const requireThat = (ok, code, message) => { if (!ok) throw new Fault(code, message); };
export const integer = (n, lo, hi) => Number.isSafeInteger(n) && n >= lo && n <= hi;
const types = new Map([[0x7f,'i32'],[0x7e,'i64'],[0x7d,'f32'],[0x7c,'f64'],[0x7b,'v128']]);
const decoder = new TextDecoder('utf-8', { fatal: true });
class Reader {
  constructor(bytes, start = 0, end = bytes.length) { this.bytes = bytes; this.p = start; this.end = end; }
  byte() { requireThat(this.p < this.end, 'invalidModule', 'Truncated section.'); return this.bytes[this.p++]; }
  u32() {
    let n = 0;
    for (let shift = 0; shift < 35; shift += 7) {
      const b = this.byte();
      requireThat(shift < 28 || (b & 0xf0) === 0, 'invalidModule', 'Oversized LEB128.');
      n += (b & 127) * 2 ** shift;
      if (!(b & 128)) return n;
    }
    throw new Fault('invalidModule', 'Malformed LEB128.');
  }
  count(maximum = 65536) {
    const n = this.u32();
    requireThat(n <= maximum && n <= this.end - this.p, 'invalidModule', 'Oversized or truncated vector.');
    return n;
  }
  name() {
    const n = this.u32();
    requireThat(n <= 65536 && n <= this.end - this.p, 'invalidModule', 'Invalid name length.');
    const bytes = this.bytes.subarray(this.p, this.p += n);
    try { return decoder.decode(bytes); } catch { throw new Fault('invalidModule', 'Invalid UTF-8 name.'); }
  }
  signature() {
    const n = this.count(65536), values = [];
    for (let i = 0; i < n; i++) {
      const type = types.get(this.byte());
      requireThat(type, 'unsupportedModule', 'Only numeric/SIMD function types are supported.'); values.push(type);
    }
    return values;
  }
  finish() { requireThat(this.p === this.end, 'invalidModule', 'Section size does not match its contents.'); }
}
export function inspectModule(bytes, { maximumTableElements = 65536 } = {}) {
  requireThat(bytes instanceof Uint8Array && bytes.length >= 8 &&
    bytes.subarray(0,8).every((b,i) => b === [0,97,115,109,1,0,0,0][i]), 'invalidModule', 'Expected Wasm v1.');
  const r = new Reader(bytes, 8), signatures = [], functions = [], exports = new Map(), seen = new Set();
  let tables = 0, memories = 0;
  while (r.p < r.end) {
    const id = r.byte(), length = r.u32(), end = r.p + length;
    requireThat(end <= r.end, 'invalidModule', 'Section extends beyond module.');
    if (id) { requireThat(!seen.has(id) && id <= 13, 'invalidModule', 'Duplicate or unknown section.'); seen.add(id); }
    const s = new Reader(bytes, r.p, end); r.p = end;
    switch (id) {
      case 1: {
        const count = s.count();
        for (let i = 0; i < count; i++) {
          requireThat(s.byte() === 0x60, 'unsupportedModule', 'Recursive/GC types are outside this SDK profile.');
          signatures.push({ parameters: s.signature(), results: s.signature() });
        }
        break;
      }
      case 2: {
        const count = s.count();
        for (let i = 0; i < count; i++) {
          const module = s.name(), field = s.name(), kind = s.byte();
          requireThat(module === 'betterjit', 'importDenied', 'Only SDK imports are permitted.');
          if (kind === 0 && field === 'call') {
            const type = s.u32(), sig = signatures[type];
            requireThat(sig && sig.parameters.join(',') === 'i32,i32,i32,i32,i32' && sig.results.join(',') === 'i32',
              'signature', 'betterjit.call has the wrong signature.');
            functions.push(type);
          } else if (kind === 2 && field === 'memory') {
            requireThat(++memories === 1, 'importDenied', 'Only one session memory is supported.');
            const flags = s.u32();
            requireThat(flags === 0 || flags === 1, 'unsupportedModule', 'Only unshared memory32 is supported.');
            const initial = s.u32(), maximum = flags ? s.u32() : 65536;
            requireThat(initial <= maximum && maximum <= 65536, 'invalidModule', 'Invalid memory limits.');
          } else { throw new Fault('importDenied', 'Unsupported SDK import.'); }
        }
        break;
      }
      case 3: { const count = s.count(); for (let i = 0; i < count; i++) functions.push(s.u32()); break; }
      case 4: {
        const count = s.count();
        for (let i = 0; i < count; i++) {
          requireThat(s.byte() === 0x70, 'unsupportedModule', 'Only funcref tables are supported.');
          requireThat(s.u32() === 1, 'tableLimit', 'Tables must declare a finite maximum.');
          const initial = s.u32(), maximum = s.u32();
          requireThat(initial <= maximum && maximum <= maximumTableElements - tables,
            'tableLimit', 'Declared tables exceed the session budget.');
          tables += maximum;
        }
        break;
      }
      case 5: requireThat(s.u32() === 0, 'memoryOwnership', 'Import betterjit.memory instead of defining private memory.'); break;
      case 7: {
        const count = s.count();
        for (let i = 0; i < count; i++) {
          const name = s.name(), kind = s.byte(), index = s.u32();
          requireThat(!exports.has(name), 'invalidModule', 'Duplicate export.');
          exports.set(name, { kind, index });
        }
        break;
      }
      case 8: throw new Fault('startDenied', 'Export an explicit initialization function; start sections are not allowed.');
      default: s.p = end; // Code/data/global semantics are checked by the engine compiler.
    }
    s.finish();
  }
  const exportedFunctions = new Map();
  for (const [name, ex] of exports) if (ex.kind === 0) {
    const sig = signatures[functions[ex.index]];
    requireThat(sig, 'invalidModule', 'Invalid exported function type.');
    exportedFunctions.set(name, sig);
  }
  return { functions: exportedFunctions, tableElements: tables };
}
