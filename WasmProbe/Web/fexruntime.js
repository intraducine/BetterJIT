// Dispatcher for FEX-translated wasm units. The host provides:
//   host.mem                 WebAssembly.Memory holding guest memory and CPU state
//   host.translate(rip32)    -> Uint8Array (a wasm module exporting run() -> i32), or null
//   host.translateRegion(Uint32Array of rip32s) -> Uint8Array or null (optional)
//   host.now()               -> milliseconds
//   host.dispatcher          optional Uint8Array: the wasm dispatcher module
//   host.dispatchBase/Bits   its RIP -> table-index hash (must match the backend)
//   host.hotAddr/hotThreshold  region profiling (must match the backend; 0 = off)
//   host.unitCounterBase/Bits  the units' own entry counters (BackendConfig)
//   host.codeBudget          wasm bytes of live code before a full flush (JSC
//                            stops JIT-compiling for good past ~160 MB)
// Async mode (host.translateAsync(rip), host.translateRegionAsync(rips, profile),
// each -> Promise of { module: WebAssembly.Module, bytes: size, slot? } or
// null; profile: { successors(rip), callSites() } from the dispatcher's
// tables, slot: the table slot the translator picked for a unit): the code
// comes from elsewhere, e.g. compiled once by a translator thread and posted
// to every guest-thread worker, which then share it. Needs JSPI: the units'
// hot() import suspends the wasm stack while its region is on the way. Use
// runAsync() instead of run().
// Guest RIPs are the low 32 bits of the guest address window.
(function (G) {
  'use strict';

  const ENTRY = 64, SUCCESSORS = 12, MAX_REGION = 24;

  function createRuntime(host) {
    const cache = new Map();
    const table = new WebAssembly.Table({ element: 'anyfunc', initial: 256 });
    const stats = { units: 0, wasmBytes: 0, translateMs: 0, compileMs: 0, jsDispatches: 0, misses: 0, regions: 0, regionUnits: 0, flushes: 0 };
    const codeBudget = host.codeBudget || Infinity;
    let liveBytes = 0; // wasm bytes of the code the table holds
    const unitBytes = new Map(); // rip -> its unit's wasm bytes, while that unit is live
    // The dispatcher calls hot(rip) when a unit (or a unit's call site) gets hot.
    let hotBusy = false;
    const hotQueue = [];
    const asyncMode = !!host.translateAsync;
    const hotSync = (rip) => {
      rip >>>= 0;
      if (!profiling || inRegion.has(rip)) return;
      hotQueue.push(rip);
      if (hotBusy) return; // compiling already: picked up by the loop below
      hotBusy = true;
      try {
        while (hotQueue.length) {
          const r = hotQueue.shift();
          if (!inRegion.has(r) && cache.has(r)) formRegion(r);
        }
      } finally {
        hotBusy = false;
      }
    };
    // Async: the wasm stack waits (JSPI) for the region, which is then
    // installed before the unit that got hot carries on.
    const hotAsync = async (rip) => {
      rip >>>= 0;
      if (!profiling || inRegion.has(rip) || !cache.has(rip) || !host.translateRegionAsync) return;
      const rips = regionRips(rip);
      const t0 = host.now();
      const r = await host.translateRegionAsync(new Uint32Array(rips), profile);
      stats.translateMs += host.now() - t0;
      if (r) installRegion(rips, r.module, r.bytes);
    };
    const hot = asyncMode ? new WebAssembly.Suspending(hotAsync) : hotSync;
    // What the dispatcher saw, for a translator that can't read our memory:
    // the successors recorded for a unit, and the call sites' targets.
    const callSiteBits = host.callSiteBits || 12;
    const profile = {
      successors(rip) {
        const dv = new DataView(host.mem.buffer), e = entryOf(dv, rip), out = [];
        if (dv.getUint32(e, true) !== rip) return out;
        for (let k = 0; k < SUCCESSORS; k++) {
          const s = dv.getUint32(e + 16 + 4 * k, true);
          if (s === 0) break;
          out.push(s);
        }
        return out;
      },
      callSites() {
        const dv = new DataView(host.mem.buffer), out = [], callSiteBase = (host.callSiteBase || 0x120000) + tbOff;
        for (let h = 0; h < 1 << callSiteBits; h++) {
          const e = callSiteBase + 32 * h, ret = dv.getUint32(e, true);
          if (ret === 0 || dv.getUint32(e + 16, true) === 0) continue;
          const t = [];
          for (let k = 0; k < 4; k++) {
            const x = dv.getUint32(e + 16 + 4 * k, true);
            if (x) t.push(x);
          }
          out.push([ret, t]);
        }
        return out;
      },
    };
    const inRegion = new Set();
    // Units call dispatch (with their register arguments); JS calls enter,
    // which moves those registers between CPUState and wasm values.
    // Threads: each thread's Sys area (CPUState, dispatcher tables) is at
    // host.threadBase, which the modules import as e.tb when built for it.
    const tb = host.threadBase === undefined ? undefined : new WebAssembly.Global({ value: 'i32', mutable: false }, host.threadBase);
    const tbOff = host.threadBase || 0;
    const dex = host.dispatcher
      ? new WebAssembly.Instance(host.dispatcher instanceof WebAssembly.Module ? host.dispatcher : new WebAssembly.Module(host.dispatcher),
        { e: tb ? { mem: host.mem, tbl: table, hot, tb } : { mem: host.mem, tbl: table, hot } }).exports : null;
    const dispatch = dex ? dex.dispatch : null, enter = dex ? dex.enter || dex.dispatch : null;
    // Units call back into the dispatcher for guest calls; without the wasm
    // dispatcher a JS version stands in.
    // The guest's syscall instruction: host.syscall(number, a0..a5) as BigInts
    // -> BigInt, falling back to a few Linux calls here (others: -ENOSYS).
    const syscall = (n, a0, a1, a2, a3, a4, a5) => {
      if (host.syscall) {
        const r = host.syscall(n, a0, a1, a2, a3, a4, a5);
        if (r !== undefined) return r;
      }
      switch (Number(n)) {
        case 1: { // write(fd, buf, len): to host.log
          const len = Number(a2), p = Number(a1 & 0xffffffffn);
          if (host.log) host.log(new TextDecoder().decode(new Uint8Array(host.mem.buffer).slice(p, p + len)));
          return a2;
        }
        case 24: return 0n; // sched_yield
        case 39: case 186: return 1n; // getpid, gettid
        case 201: return BigInt(Math.floor(Date.now() / 1000)); // time
        default: return -38n; // ENOSYS
      }
    };
    const imports = {
      e: {
        syscall,
        mem: host.mem,
        tbl: table, // for the units' call inline caches
        hot,        // units report reaching the hot threshold
        ...(tb ? { tb } : {}),
        dispatch: dispatch || jsDispatch,
        // rdtsc: nanoseconds since the runtime started; rdrand: Math.random.
        cycles: host.cycles || (() => BigInt(Math.floor(host.now() * 1e6))),
        rdrand: host.rdrand || (() => BigInt.asIntN(64, BigInt(Math.floor(Math.random() * 2 ** 32)) << 32n | BigInt(Math.floor(Math.random() * 2 ** 32)))),
        // x87 transcendentals in reduced (double) precision, as FEX's fallbacks
        sin: Math.sin,
        cos: Math.cos,
        tan: Math.tan,
        atan2: Math.atan2,
        f2xm1: (x) => Math.expm1(x * Math.LN2),
        fyl2x: (x, y) => y * Math.log2(x),
        fyl2xp1: (x, y) => y * Math.log2(1 + x),
        fscale: (x, y) => (x === 0 ? x : x * Math.pow(2, Math.trunc(y))),
        fprem: (x, y) => x % y,
        fprem1: (x, y) => {
          // IEEE remainder: quotient rounded to nearest, ties to even
          if (!Number.isFinite(y) && Number.isFinite(x)) return x;
          const q = x / y, n = Math.round(q);
          const even = Math.abs(q - Math.trunc(q)) === 0.5 ? 2 * Math.round(q / 2) : n;
          const r = x - even * y;
          return r === 0 ? x * 0 : r; // a zero keeps x's sign
        },
      },
    };
    // Region code is done being profiled: its calls skip the call-site profile.
    const regionImports = dex && dex.dispatchnp ? { e: Object.assign({}, imports.e, { dispatch: dex.dispatchnp }) } : imports;
    function jsDispatch(rip, stop) {
      rip >>>= 0; stop >>>= 0;
      while (rip !== stop) {
        const f = cache.get(rip);
        if (f === undefined) return rip; // untranslated: unwind to run()
        rip = f() >>> 0;
        stats.jsDispatches++;
      }
      return rip;
    }
    const bits = host.dispatchBits || 14, mask = (1 << bits) - 1, base = (host.dispatchBase || 0x20000) + tbOff;
    const hotAddr = host.hotAddr || 0, profiling = !!(dispatch && host.hotThreshold && (host.translateRegion || host.translateRegionAsync));
    // u32 RIP per table slot, which call inline caches check before calling the slot
    const slotTagBase = (host.slotTagBase || 0) + tbOff, slotTagCount = host.slotTagCount || 0;
    let nextIndex = 1;

    // Drops all translated code (a full flush, as QEMU does), so the engine
    // can free it. Called from run() between dispatcher runs; a unit still
    // on the wasm stack keeps its instance alive until it returns, and then
    // misses in the cleared tables.
    function flush() {
      const u8 = new Uint8Array(host.mem.buffer);
      u8.fill(0, base, base + (1 << bits) * ENTRY);
      if (slotTagCount) u8.fill(0, slotTagBase, slotTagBase + 4 * slotTagCount);
      if (host.unitCounterBase) {
        const c = host.unitCounterBase + tbOff;
        u8.fill(0, c, c + 4 * (1 << (host.unitCounterBits || 14)));
      }
      for (let i = 1; i < nextIndex; i++) table.set(i, null);
      nextIndex = 1;
      cache.clear();
      unitBytes.clear();
      inRegion.clear();
      hotQueue.length = 0;
      liveBytes = 0;
      stats.flushes++;
    }
    // Byte offset of rip's hash entry, or of the empty slot where it goes.
    function entryOf(dv, rip) {
      for (let h = Math.imul(rip, 0x9E3779B1) >>> (32 - bits); ; h = (h + 1) & mask) {
        const e = base + h * ENTRY, r = dv.getUint32(e, true);
        if (r === rip || r === 0) return e;
      }
    }

    const moduleOf = (code) => (code instanceof WebAssembly.Module ? code : new WebAssembly.Module(code));

    function compile(rip) {
      const t0 = host.now();
      const bytes = host.translate(rip);
      stats.translateMs += host.now() - t0;
      if (!bytes) throw new Error('translation failed at 0x' + rip.toString(16));
      return install(rip, bytes, bytes.length);
    }

    // Puts a unit's code (bytes or a compiled Module of `size` bytes) in
    // the table and the dispatcher's hash.
    function install(rip, code, size, slot) {
      if (dispatch && liveBytes + size > codeBudget) flush();
      liveBytes += size;
      unitBytes.set(rip, size);
      const t1 = host.now();
      const f = new WebAssembly.Instance(moduleOf(code), imports).exports.run;
      stats.compileMs += host.now() - t1;
      stats.units++;
      stats.wasmBytes += size;
      cache.set(rip, f);
      if (dispatch) {
        // The translator's slot (the same in every thread), or the next free one.
        const idx = slot || nextIndex++;
        if (idx >= table.length) table.grow(Math.max(table.length, idx + 1 - table.length));
        if (slot && slot >= nextIndex) nextIndex = slot + 1;
        table.set(idx, f);
        const dv = new DataView(host.mem.buffer);
        const e = entryOf(dv, rip);
        dv.setUint32(e + 4, idx, true);
        dv.setUint32(e, rip, true);
        if (idx < slotTagCount) dv.setUint32(slotTagBase + 4 * idx, rip, true);
      }
      return f;
    }

    // A unit got hot: compile it together with the translated units it was
    // seen exiting to (breadth first, transitively) into one region function,
    // which takes over the unit's table slot.
    function formRegion(rip) {
      const rips = regionRips(rip);
      const t0 = host.now();
      const bytes = host.translateRegion(new Uint32Array(rips));
      stats.translateMs += host.now() - t0;
      if (bytes) installRegion(rips, bytes, bytes.length);
    }
    function regionRips(rip) {
      const dv = new DataView(host.mem.buffer);
      const rips = [rip];
      let internal = false; // some recorded edge stays inside the region
      for (let q = 0; q < rips.length && rips.length < MAX_REGION; q++) {
        const e = entryOf(dv, rips[q]);
        if (dv.getUint32(e, true) !== rips[q]) continue;
        for (let k = 0; k < SUCCESSORS && rips.length < MAX_REGION; k++) {
          const s = dv.getUint32(e + 16 + 4 * k, true);
          if (s === 0) break;
          if (rips.includes(s)) {
            internal = true;
          } else if (cache.has(s)) {
            rips.push(s);
            internal = true;
          }
        }
      }
      if (host.log) {
        const e = entryOf(dv, rip), w = [];
        for (let k = 0; k < 16; k++) w.push(dv.getUint32(e + 4 * k, true).toString(16));
        host.log('hot 0x' + rip.toString(16) + ': region of ' + rips.map((r) => r.toString(16)).join(' ') + ' entry ' + w.join(' '));
      }
      // A unit with no edges back into the region is still recompiled: as a
      // region its hot call sites get their profiled targets inlined.
      return rips;
    }
    function installRegion(rips, code, size) {
      const dv = new DataView(host.mem.buffer);
      if (liveBytes + size > codeBudget) return; // (over budget: the next miss flushes)
      liveBytes += size;
      const t1 = host.now();
      const ex = new WebAssembly.Instance(moduleOf(code), regionImports).exports;
      stats.compileMs += host.now() - t1;
      stats.regions++;
      stats.wasmBytes += size;
      // Every unit the region kept gets its entry thunk: run for the first,
      // u<rip> for the others.
      for (const name of Object.keys(ex)) {
        const r = name === 'run' ? rips[0] : name[0] === 'u' ? parseInt(name.slice(1), 16) : -1;
        if (r < 0) continue;
        const e = entryOf(dv, r);
        if (dv.getUint32(e, true) === r) table.set(dv.getUint32(e + 4, true), ex[name]);
        // The unit's own code is dead now: drop our reference so the engine
        // can free it.
        cache.set(r, ex[name]);
        if (unitBytes.has(r)) {
          liveBytes -= unitBytes.get(r);
          unitBytes.delete(r);
        }
        inRegion.add(r);
        stats.regionUnits++;
      }
    }

    // Runs guest code from `rip` until control reaches `stop`.
    function run(rip, stop) {
      if (dispatch) {
        for (;;) {
          rip = enter(rip, stop) >>> 0;
          if (rip === stop) return;
          stats.misses++;
          compile(rip);
        }
      }
      while (rip !== stop) {
        let f = cache.get(rip);
        if (f === undefined) f = compile(rip);
        rip = f() >>> 0;
        stats.jsDispatches++;
      }
    }

    // Async mode: misses wait for their unit (the wasm stack is unwound by
    // then, so no JSPI is needed here; enter is still promising so that hot()
    // can suspend below it).
    const enterAsync = asyncMode && enter ? WebAssembly.promising(enter) : null;
    async function runAsync(rip, stop) {
      for (;;) {
        rip = (await enterAsync(rip, stop)) >>> 0;
        if (rip === stop) return;
        stats.misses++;
        const t0 = host.now();
        const r = await host.translateAsync(rip);
        stats.translateMs += host.now() - t0;
        if (!r) throw new Error('translation failed at 0x' + rip.toString(16));
        install(rip, r.module, r.bytes, r.slot);
      }
    }

    return { run, runAsync, compile, stats };
  }

  G.FexRuntime = { createRuntime };
})(globalThis);
