// Minimal WebAssembly binary emitter plus the "translated guest program"
// code generators used by the dispatch/JIT tests. Runs in browsers, JSC and
// node (for local validation).
(function (G) {
  'use strict';

  // ---- encoding helpers ----------------------------------------------------
  function u32(n) { const o = []; do { let b = n & 0x7f; n >>>= 7; if (n) b |= 0x80; o.push(b); } while (n); return o; }
  function s32(n) {
    const o = []; n |= 0;
    for (;;) { const b = n & 0x7f; n >>= 7;
      if ((n === 0 && !(b & 0x40)) || (n === -1 && (b & 0x40))) { o.push(b); return o; }
      o.push(b | 0x80); }
  }
  function s64(v) {
    let n = BigInt.asIntN(64, BigInt(v)); const o = [];
    for (;;) { const b = Number(n & 0x7fn); n >>= 7n;
      if ((n === 0n && !(b & 0x40)) || (n === -1n && (b & 0x40))) { o.push(b); return o; }
      o.push(b | 0x80); }
  }
  function str(s) { const b = Array.from(s, c => c.charCodeAt(0)); return [...u32(b.length), ...b]; }
  // Loop-based concatenation: spreading large arrays overflows V8's stack.
  function cat(...parts) { const o = []; for (const p of parts) for (let i = 0; i < p.length; i++) o.push(p[i]); return o; }
  function vec(items) { const o = u32(items.length); for (const it of items) for (let i = 0; i < it.length; i++) o.push(it[i]); return o; }
  function section(id, body) { return cat([id], u32(body.length), body); }

  const T = { i32: 0x7f, i64: 0x7e, f32: 0x7d, f64: 0x7c, v128: 0x7b, funcref: 0x70, externref: 0x6f };
  const OP = {
    unreachable: 0x00, nop: 0x01, block: 0x02, loop: 0x03, if: 0x04, else: 0x05, end: 0x0b,
    br: 0x0c, br_if: 0x0d, br_table: 0x0e, return: 0x0f, call: 0x10, call_indirect: 0x11,
    return_call: 0x12, return_call_indirect: 0x13, drop: 0x1a, select: 0x1b,
    local_get: 0x20, local_set: 0x21, local_tee: 0x22, global_get: 0x23, global_set: 0x24,
    i32_load: 0x28, i64_load: 0x29, i32_load8_u: 0x2d, i32_store: 0x36, i64_store: 0x37, i32_store8: 0x3a,
    i32_const: 0x41, i64_const: 0x42,
    i32_eqz: 0x45, i32_eq: 0x46, i32_ne: 0x47, i32_lt_u: 0x49, i64_eqz: 0x50, i64_ne: 0x52,
    i32_add: 0x6a, i32_sub: 0x6b, i32_mul: 0x6c, i32_and: 0x71, i32_or: 0x72, i32_xor: 0x73, i32_shl: 0x74, i32_shr_u: 0x76,
    i64_add: 0x7c, i64_sub: 0x7d, i64_mul: 0x7e, i64_and: 0x83, i64_or: 0x84, i64_xor: 0x85,
    i64_shl: 0x86, i64_shr_u: 0x88, i64_rotl: 0x89,
    i32_wrap_i64: 0xa7, i64_extend_i32_u: 0xad,
  };

  // Module builder. funcs: [{type:[params, results], locals:[[count,type]], code:[bytes], export?:name}]
  function buildModule(m) {
    const types = [], typeKey = new Map();
    const typeIdx = (sig) => {
      const k = JSON.stringify(sig);
      if (!typeKey.has(k)) { typeKey.set(k, types.length); types.push(sig); }
      return typeKey.get(k);
    };
    // extraTypes first so callers can rely on their indices (0, 1, ...).
    (m.extraTypes || []).forEach(t => typeIdx(t));
    (m.imports || []).forEach(im => { if (im.kind === 'func') im.ti = typeIdx(im.type); });
    (m.funcs || []).forEach(f => { f.ti = typeIdx(f.type); });
    const out = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
    const emit = (sec) => { for (let i = 0; i < sec.length; i++) out.push(sec[i]); };
    emit(section(1, vec(types.map(([p, r]) => [0x60, ...vec(p.map(x => [x])), ...vec(r.map(x => [x]))]))));
    if (m.imports && m.imports.length) {
      emit(section(2, vec(m.imports.map(im => {
        const head = [...str(im.module), ...str(im.name)];
        if (im.kind === 'func') return [...head, 0x00, ...u32(im.ti)];
        if (im.kind === 'table') return [...head, 0x01, T.funcref, ...limits(im.min, im.max)];
        if (im.kind === 'memory') return [...head, 0x02, ...limits(im.min, im.max, im.shared)];
        throw new Error('bad import');
      }))));
    }
    const nImportedFuncs = (m.imports || []).filter(i => i.kind === 'func').length;
    emit(section(3, vec((m.funcs || []).map(f => u32(f.ti)))));
    if (m.table) emit(section(4, vec([[T.funcref, ...limits(m.table.min, m.table.max)]])));
    if (m.memory) emit(section(5, vec([limits(m.memory.min, m.memory.max, m.memory.shared)])));
    const exps = [];
    (m.funcs || []).forEach((f, i) => { if (f.export) exps.push([...str(f.export), 0x00, ...u32(nImportedFuncs + i)]); });
    if (m.exportTable) exps.push([...str(m.exportTable), 0x01, 0x00]);
    if (m.exportMemory) exps.push([...str(m.exportMemory), 0x02, 0x00]);
    emit(section(7, vec(exps)));
    if (m.elem) {
      emit(section(9, vec([[0x00, OP.i32_const, ...s32(m.elem.offset), OP.end,
        ...vec(m.elem.funcs.map(fi => u32(fi)))]])));
    }
    emit(section(10, vec((m.funcs || []).map(f => {
      const body = cat(vec((f.locals || []).map(([n, t]) => [...u32(n), t])), f.code, [OP.end]);
      return cat(u32(body.length), body);
    }))));
    return new Uint8Array(out);
  }
  function limits(min, max, shared) {
    if (shared) return [0x03, ...u32(min), ...u32(max)];
    return max === undefined ? [0x00, ...u32(min)] : [0x01, ...u32(min), ...u32(max)];
  }
  const memarg = (align, offset) => [...u32(align), ...u32(offset)];

  // ---- guest program layout -------------------------------------------------
  const L = { REGS: 0x1000, PERM: 0x2000, IND: 0x4000, TLB: 0x8000, GUEST: 0x100000, PAGES: 48 };
  // Guest virtual base for the soft-MMU variants: deliberately above 4 GB.
  const GVA = 0x7FF000000000n;

  // Emits the ops of one block. R(x) -> local index of guest reg x.
  // opts.pagecheck: each guest load/store checks a software page-permission
  // byte (the cost of emulating page protection / SMC tracking in software).
  // opts.softmmu: guest addresses are 64-bit virtual addresses translated through a
  // 256-entry direct-mapped software TLB (tag = va>>12, host page base); a miss
  // calls softFaultFn(va). This is what lifting the 4 GB / 2 GB limits costs on
  // the hit path.
  function emitOps(blk, R, opts, tmpAddr, faultFn, tmp64, softFaultFn) {
    const c = [];
    const xlate = (s, imm) => {
      c.push(OP.local_get, ...u32(R(s)), OP.i64_const, ...s64(imm), OP.i64_add,
        OP.i64_const, ...s64(0xFFFF8), OP.i64_and, OP.i64_const, ...s64(GVA), OP.i64_or, OP.local_set, ...u32(tmp64),
        OP.local_get, ...u32(tmp64), OP.i64_const, 12, OP.i64_shr_u, OP.i32_wrap_i64,
        OP.i32_const, ...s32(255), OP.i32_and, OP.i32_const, 4, OP.i32_shl, OP.local_tee, ...u32(tmpAddr),
        OP.i64_load, ...memarg(3, L.TLB),
        OP.local_get, ...u32(tmp64), OP.i64_const, 12, OP.i64_shr_u, OP.i64_ne,
        OP.if, 0x40, OP.local_get, ...u32(tmp64), OP.call, ...u32(softFaultFn), OP.end,
        OP.local_get, ...u32(tmpAddr), OP.i32_load, ...memarg(2, L.TLB + 8),
        OP.local_get, ...u32(tmp64), OP.i32_wrap_i64, OP.i32_const, ...s32(0xfff), OP.i32_and, OP.i32_add);
    };
    const addr = (s, imm) => {
      if (opts.softmmu) return xlate(s, imm);
      c.push(OP.local_get, ...u32(R(s)), OP.i64_const, ...s64(imm), OP.i64_add,
        OP.i64_const, ...s64(0xFFFF8), OP.i64_and, OP.i32_wrap_i64);
      if (opts.pagecheck) {
        c.push(OP.local_tee, ...u32(tmpAddr), OP.i32_const, ...s32(12), OP.i32_shr_u,
          OP.i32_load8_u, ...memarg(0, L.PERM), OP.i32_eqz, OP.if, 0x40, OP.call, ...u32(faultFn), OP.end,
          OP.local_get, ...u32(tmpAddr));
      }
    };
    for (const [op, d, s, imm] of blk.ops) {
      const rd = u32(R(d)), rs = u32(R(s));
      switch (op) {
        case 'add': c.push(OP.local_get, ...rd, OP.local_get, ...rs, OP.i64_add, OP.i64_const, ...s64(imm), OP.i64_add, OP.local_set, ...rd); break;
        case 'xor': c.push(OP.local_get, ...rd, OP.local_get, ...rs, OP.i64_const, ...s64(imm), OP.i64_add, OP.i64_xor, OP.local_set, ...rd); break;
        case 'mul': c.push(OP.local_get, ...rd, OP.local_get, ...rs, OP.i64_const, 1, OP.i64_or, OP.i64_mul, OP.local_set, ...rd); break;
        case 'rot': c.push(OP.local_get, ...rd, OP.i64_const, ...s64(imm), OP.i64_rotl, OP.local_get, ...rs, OP.i64_xor, OP.local_set, ...rd); break;
        case 'ld': c.push(OP.local_get, ...rd); addr(s, imm); c.push(OP.i64_load, ...memarg(3, opts.softmmu ? 0 : L.GUEST), OP.i64_add, OP.local_set, ...rd); break;
        case 'st': addr(s, imm); c.push(OP.local_get, ...rd, OP.i64_store, ...memarg(3, opts.softmmu ? 0 : L.GUEST)); break;
      }
    }
    return c;
  }
  // Pushes the next block index (i32) on the stack.
  function emitNext(blk, idx, R) {
    const t = blk.term;
    if (t.kind === 'cond') {
      return [OP.i32_const, ...s32(t.t[0]), OP.i32_const, ...s32(t.t[1]),
        OP.local_get, ...u32(R(t.c)), OP.i32_wrap_i64, OP.i32_const, 1, OP.i32_and, OP.select];
    }
    return [OP.local_get, ...u32(R(t.c)), OP.i32_wrap_i64, OP.i32_const, 3, OP.i32_and, OP.i32_const, 2, OP.i32_shl,
      OP.i32_load, ...memarg(2, L.IND + idx * 16)];
  }
  function regSets(blk) {
    const used = new Set(), written = new Set();
    for (const [op, d, s] of blk.ops) { used.add(d); used.add(s); if (op !== 'st') written.add(d); }
    used.add(blk.term.c);
    return { used: [...used].sort((a, b) => a - b), written: [...written].sort((a, b) => a - b) };
  }
  const loadReg = (x, local) => [OP.i32_const, 0, OP.i64_load, ...memarg(3, L.REGS + 8 * x), OP.local_set, ...u32(local)];
  const storeReg = (x, local) => [OP.i32_const, 0, OP.local_get, ...u32(local), OP.i64_store, ...memarg(3, L.REGS + 8 * x)];

  // A standalone block function. Param layout: [steps?] then locals r0..r15, next, tmp.
  // style 'ret': () -> i32 next ; style 'tail': (steps i32) -> () and chains itself.
  function blockFunc(blk, idx, style, opts, tailTypeIdx, faultFn) {
    const base = style === 'tail' ? 1 : 0;       // param 0 = steps for tail style
    const R = x => base + x, NEXT = base + 16, TMP = base + 17;
    const { used, written } = regSets(blk);
    const code = [];
    for (const x of used) code.push(...loadReg(x, R(x)));
    code.push(...emitOps(blk, R, opts, TMP, faultFn, base + 18, 1));
    code.push(...emitNext(blk, idx, R), OP.local_set, ...u32(NEXT));
    for (const x of written) code.push(...storeReg(x, R(x)));
    if (style === 'ret') {
      code.push(OP.local_get, ...u32(NEXT));
    } else {
      code.push(OP.local_get, 0, OP.i32_const, 1, OP.i32_sub, OP.local_tee, 0, OP.i32_eqz, OP.if, 0x40, OP.return, OP.end,
        OP.local_get, 0, OP.local_get, ...u32(NEXT), OP.return_call_indirect, ...u32(tailTypeIdx), 0x00);
    }
    return {
      type: style === 'ret' ? [[], [T.i32]] : [[T.i32], []],
      locals: [[16, T.i64], [2, T.i32], [1, T.i64]],
      code,
    };
  }

  const memImport = { module: 'e', name: 'mem', kind: 'memory', min: L.PAGES };
  const faultImport = { module: 'e', name: 'fault', kind: 'func', type: [[], []] };
  const softFaultImport = { module: 'e', name: 'softfault', kind: 'func', type: [[T.i64], []] };
  // fault is always func 0; softfault (when present) is func 1.
  const funcImports = (opts) => (opts && opts.softmmu) ? [faultImport, softFaultImport] : [faultImport];
  const RET_T = [[], [T.i32]], TAIL_T = [[T.i32], []];

  // Variant: all blocks in one function, guest regs in wasm locals, br_table dispatch.
  // Closest to "compile a whole region at once" — the best case for a wasm backend.
  function genSwitch(prog, opts = {}) {
    const N = prog.n, STEPS = 0, R = x => 1 + x, PC = 17, TMP = 18;
    const code = [];
    for (let x = 0; x < 16; x++) code.push(...loadReg(x, R(x)));
    code.push(OP.block, 0x40, OP.loop, 0x40,
      OP.local_get, STEPS, OP.i32_eqz, OP.br_if, 1,
      OP.local_get, STEPS, OP.i32_const, 1, OP.i32_sub, OP.local_set, STEPS);
    for (let i = 0; i < N; i++) code.push(OP.block, 0x40);
    code.push(OP.local_get, PC, OP.br_table, ...u32(N));
    for (let i = 0; i < N; i++) code.push(...u32(i));
    code.push(...u32(N - 1));
    for (let k = 0; k < N; k++) {
      code.push(OP.end);
      for (const b of emitOps(prog.blocks[k], R, opts, TMP, 0, 19, 1)) code.push(b);
      code.push(...emitNext(prog.blocks[k], k, R), OP.local_set, PC, OP.br, ...u32(N - 1 - k));
    }
    code.push(OP.end, OP.end);
    for (let x = 0; x < 16; x++) code.push(...storeReg(x, R(x)));
    return buildModule({
      imports: [...funcImports(opts), memImport],
      funcs: [{ type: [[T.i32], []], locals: [[16, T.i64], [2, T.i32], [1, T.i64]], code, export: 'run' }],
    });
  }

  // Variant: one function per block in a single module; wasm dispatcher loop
  // doing call_indirect through the module's own table.
  function genFnptr(prog, opts = {}) {
    const N = prog.n;
    const funcs = prog.blocks.map((b, i) => blockFunc(b, i, 'ret', opts, 0, 0));
    const disp = {
      type: [[T.i32], []], locals: [[1, T.i32]], export: 'run',
      code: [OP.block, 0x40, OP.loop, 0x40,
        OP.local_get, 0, OP.i32_eqz, OP.br_if, 1,
        OP.local_get, 0, OP.i32_const, 1, OP.i32_sub, OP.local_set, 0,
        OP.local_get, 1, OP.call_indirect, 0, 0x00, OP.local_set, 1, OP.br, 0, OP.end, OP.end],
    };
    return buildModule({
      imports: [...funcImports(opts), memImport], extraTypes: [RET_T],
      funcs: [...funcs, disp], table: { min: N, max: N },
      elem: { offset: 0, funcs: prog.blocks.map((_, i) => funcImports(opts).length + i) },
    });
  }

  // Variant: one function per block, each block tail-calls the next through the table.
  function genTail(prog, opts = {}) {
    const N = prog.n;
    const funcs = prog.blocks.map((b, i) => blockFunc(b, i, 'tail', opts, 0, 0));
    const start = { type: [[T.i32], []], export: 'run',
      code: [OP.local_get, 0, OP.i32_eqz, OP.if, 0x40, OP.return, OP.end, OP.local_get, 0, OP.i32_const, 0, OP.call_indirect, 0, 0x00] };
    return buildModule({
      imports: [...funcImports(opts), memImport], extraTypes: [TAIL_T],
      funcs: [...funcs, start], table: { min: N, max: N },
      elem: { offset: 0, funcs: prog.blocks.map((_, i) => funcImports(opts).length + i) },
    });
  }

  // Variant: one module per block (what an incremental JIT naturally produces).
  // Returns {blocks: [bytes], dispatcher: bytes}. Dispatcher imports the shared table.
  function genPerModule(prog, style, opts = {}) {
    const N = prog.n;
    const blocks = prog.blocks.map((b, i) => {
      const f = blockFunc(b, i, style, opts, 0, 0);
      f.export = 'f';
      const imports = [faultImport, memImport];
      if (style === 'tail') imports.push({ module: 'e', name: 'tbl', kind: 'table', min: N });
      return buildModule({ imports, extraTypes: [style === 'tail' ? TAIL_T : RET_T], funcs: [f] });
    });
    let dispatcher;
    if (style === 'ret') {
      dispatcher = buildModule({
        imports: [faultImport, memImport, { module: 'e', name: 'tbl', kind: 'table', min: N }], extraTypes: [RET_T],
        funcs: [{ type: [[T.i32], []], locals: [[1, T.i32]], export: 'run',
          code: [OP.block, 0x40, OP.loop, 0x40,
            OP.local_get, 0, OP.i32_eqz, OP.br_if, 1,
            OP.local_get, 0, OP.i32_const, 1, OP.i32_sub, OP.local_set, 0,
            OP.local_get, 1, OP.call_indirect, 0, 0x00, OP.local_set, 1, OP.br, 0, OP.end, OP.end] }],
      });
    } else {
      dispatcher = buildModule({
        imports: [faultImport, memImport, { module: 'e', name: 'tbl', kind: 'table', min: N }], extraTypes: [TAIL_T],
        funcs: [{ type: [[T.i32], []], export: 'run',
          code: [OP.local_get, 0, OP.i32_eqz, OP.if, 0x40, OP.return, OP.end, OP.local_get, 0, OP.i32_const, 0, OP.call_indirect, 0, 0x00] }],
      });
    }
    return { blocks, dispatcher };
  }

  // Shared guest state setup/checksum (must match gp_reset/gp_checksum in C).
  function resetState(mem, prog) {
    const dv = new DataView(mem.buffer);
    for (let i = 0; i < 16; i++) dv.setBigUint64(L.REGS + 8 * i, BigInt(i) * 0x1234567n + 1n, true);
    const g = new BigUint64Array(mem.buffer, L.GUEST, 1 << 17);
    for (let i = 0; i < (1 << 17); i++) g[i] = BigInt.asUintN(64, BigInt(i) * 0x9E3779B97F4A7C15n);
    new Uint8Array(mem.buffer, L.PERM, 256).fill(3);
    for (let p = 0; p < 256; p++) {   // soft-MMU TLB: guest page p of GVA -> host page
      dv.setBigUint64(L.TLB + p * 16, (GVA >> 12n) + BigInt(p), true);
      dv.setUint32(L.TLB + p * 16 + 8, L.GUEST + p * 4096, true);
    }
    prog.blocks.forEach((b, i) => {
      if (b.term.kind === 'ind') b.term.t.forEach((t, j) => dv.setUint32(L.IND + i * 16 + j * 4, t, true));
    });
  }
  function checksum(mem) {
    const M = 0xFFFFFFFFFFFFFFFFn, P = 0x100000001B3n;
    let h = 0n;
    const r = new BigUint64Array(mem.buffer, L.REGS, 16);
    for (let i = 0; i < 16; i++) h = ((h ^ r[i]) * P) & M;
    const g = new BigUint64Array(mem.buffer, L.GUEST, 1 << 17);
    for (let i = 0; i < (1 << 17); i++) h = ((h ^ g[i]) * P) & M;
    return Number((h ^ (h >> 32n)) & 0xFFFFFFFFn);
  }

  G.WasmGen = { cat, u32, s32, s64, str, vec, section, buildModule, limits, memarg, T, OP, L,
    genSwitch, genFnptr, genTail, genPerModule, resetState, checksum, RET_T, TAIL_T,
    emitOps, loadReg, storeReg, memImport, faultImport, softFaultImport, GVA };
})(typeof globalThis !== 'undefined' ? globalThis : this);
