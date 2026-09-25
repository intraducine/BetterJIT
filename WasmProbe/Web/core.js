// Engine-independent suites, shared by the WKWebView page and the in-app
// JSContext (no JIT). `env.now()` returns ms; `env.emit(obj)` records a result.
(function (G) {
  'use strict';

  const KERNELS = [
    ['intmix', 100000000], ['sieve', 10], ['qsort', 4], ['matmul', 60], ['nbody', 3000000],
    ['hash', 40], ['interp', 20000000], ['ptrchase', 5000000], ['memcpy', 200], ['crc32', 4], ['tree', 1000000],
  ];

  function runKernels(bytes, env, opts) {
    opts = opts || {};
    const t0 = env.now();
    const inst = new WebAssembly.Instance(new WebAssembly.Module(bytes), {});
    env.emit({ suite: 'kernels', event: 'instantiate', ms: env.now() - t0 });
    const reps = opts.reps || 3;
    for (const [name, n] of KERNELS) {
      if (opts.only && !opts.only.includes(name)) continue;
      const f = inst.exports['k_' + name];
      if (opts.warmup !== false) f(1);
      let best = Infinity, first = 0, chk = 0;
      for (let r = 0; r < reps; r++) {
        const t = env.now();
        chk = f(n) >>> 0;
        const d = env.now() - t;
        if (r === 0) first = d;
        if (d < best) best = d;
      }
      env.emit({ suite: 'kernels', kernel: name, n, ms: best, firstMs: first, chk });
    }
  }

  function runDispatch(prog, env, opts) {
    opts = opts || {};
    const W = G.WasmGen, S = opts.steps || 2000000, reps = opts.reps || 3;
    const mem = new WebAssembly.Memory({ initial: W.L.PAGES });
    const fault = () => { throw new Error('guest page fault'); };
    const softfault = (va) => { throw new Error('soft-TLB miss at ' + va.toString(16)); };
    const imp = { e: { mem, fault, softfault } };
    const inst = (bytes, im) => new WebAssembly.Instance(new WebAssembly.Module(bytes), im || imp);
    function report(name, compileMs, fn, extra) {
      W.resetState(mem, prog);
      const t0 = env.now(); fn(S); const cold = env.now() - t0;
      const chk = W.checksum(mem);
      let best = Infinity;
      for (let r = 0; r < reps; r++) {
        W.resetState(mem, prog);
        const t = env.now(); fn(S); const d = env.now() - t;
        if (d < best) best = d;
      }
      env.emit(Object.assign({ suite: 'dispatch', variant: name, blocks: prog.n, steps: S, compileMs, coldMs: cold,
        ms: best, nsPerBlock: best * 1e6 / S, chk }, extra || {}));
    }
    const variants = [
      ['switch', W.genSwitch, {}], ['switch+pagecheck', W.genSwitch, { pagecheck: true }],
      ['fnptr', W.genFnptr, {}], ['fnptr+pagecheck', W.genFnptr, { pagecheck: true }],
      ['tail', W.genTail, {}],
      ['switch+softmmu', W.genSwitch, { softmmu: true }], ['fnptr+softmmu', W.genFnptr, { softmmu: true }],
    ];
    const want = (name) => !opts.only || opts.only.includes(name);
    for (const [name, gen, o] of variants) {
      if (!want(name)) continue;
      env.emit({ suite: 'dispatch', event: 'start', variant: name });
      try {
        const t = env.now(); const b = gen(prog, o); const tg = env.now() - t;
        const i = inst(b);
        report(name, env.now() - t, i.exports.run, { genMs: tg, wasmBytes: b.length });
      } catch (e) { env.emit({ suite: 'dispatch', variant: name, error: String(e) }); }
    }
    for (const style of ['ret', 'tail']) {
      if (!want('permodule-' + style) && !(style === 'ret' && want('js-dispatch'))) continue;
      env.emit({ suite: 'dispatch', event: 'start', variant: 'permodule-' + style });
      try {
        const t = env.now();
        const g = W.genPerModule(prog, style);
        const tbl = new WebAssembly.Table({ element: 'anyfunc', initial: prog.n });
        const e = { e: { mem, tbl, fault } };
        g.blocks.forEach((b, i) => tbl.set(i, inst(b, e).exports.f));
        const d = inst(g.dispatcher, e);
        const bytes = g.blocks.reduce((a, b) => a + b.length, 0);
        report('permodule-' + style, env.now() - t, d.exports.run, { modules: prog.n + 1, wasmBytes: bytes });
        if (style === 'ret') {
          const fns = g.blocks.map((_, i) => tbl.get(i));
          report('js-dispatch', 0, (s) => { let pc = 0; while (s--) pc = fns[pc](); });
        }
      } catch (e) { env.emit({ suite: 'dispatch', variant: 'permodule-' + style, error: String(e) }); }
    }
  }

  // Cost of JIT-style code generation: compile+instantiate latency for many
  // small modules vs batched modules, and the tier-up curve.
  function runJitCost(prog, env, opts) {
    opts = opts || {};
    const W = G.WasmGen;
    const mem = new WebAssembly.Memory({ initial: W.L.PAGES });
    const tbl = new WebAssembly.Table({ element: 'anyfunc', initial: 4096 });
    const imp = { e: { mem, tbl, fault() {} } };
    const g = W.genPerModule(prog, 'ret');
    // 1) one module per block, sync compile + instantiate.
    {
      const lat = [];
      const t0 = env.now();
      for (let i = 0; i < g.blocks.length; i++) {
        const t = env.now();
        const inst = new WebAssembly.Instance(new WebAssembly.Module(g.blocks[i]), imp);
        tbl.set(i, inst.exports.f);
        lat.push(env.now() - t);
      }
      lat.sort((a, b) => a - b);
      env.emit({ suite: 'jitcost', test: 'module-per-block-sync', modules: g.blocks.length, totalMs: env.now() - t0,
        avgUs: 1000 * lat.reduce((a, b) => a + b, 0) / lat.length, p50Us: 1000 * lat[lat.length >> 1],
        p99Us: 1000 * lat[Math.floor(lat.length * 0.99)], avgBytes: g.blocks.reduce((a, b) => a + b.length, 0) / g.blocks.length });
    }
    // 2) batched: K blocks per module (functions in one module).
    for (const K of [8, 64, 512]) {
      const sub = { n: prog.n, blocks: prog.blocks };
      let total = 0, mods = 0, bytes = 0;
      for (let start = 0; start + K <= prog.n; start += K) {
        const part = { n: prog.n, blocks: prog.blocks.slice(start, start + K) };
        // genFnptr expects table size == n; build a module whose table holds only K entries.
        const b = W.genFnptr({ n: K, blocks: part.blocks.map(x => x) });
        const t = env.now();
        new WebAssembly.Instance(new WebAssembly.Module(b), imp);
        total += env.now() - t; mods++; bytes += b.length;
      }
      env.emit({ suite: 'jitcost', test: 'batched-sync', blocksPerModule: K, modules: mods, totalMs: total,
        usPerBlock: 1000 * total / (mods * K), bytesPerBlock: bytes / (mods * K) });
    }
    // 3) tier-up curve: fresh fnptr module, run in chunks and time each chunk.
    if (opts.curve !== false) {
      const b = W.genFnptr(prog);
      const run = new WebAssembly.Instance(new WebAssembly.Module(b), imp).exports.run;
      W.resetState(mem, prog);
      const chunk = opts.chunk || 20000, curve = [];
      const tStart = env.now();
      for (let c = 0; c < (opts.chunks || 60); c++) {
        const t = env.now(); run(chunk); curve.push(+(1e6 * (env.now() - t) / chunk).toFixed(1));
      }
      env.emit({ suite: 'jitcost', test: 'tierup-curve', chunkSteps: chunk, nsPerBlockByChunk: curve, totalMs: env.now() - tStart });
    }
  }

  G.ProbeCore = { KERNELS, runKernels, runDispatch, runJitCost };
})(typeof globalThis !== 'undefined' ? globalThis : this);
