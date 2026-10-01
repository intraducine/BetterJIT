// Guest threads on workers (Node worker_threads or Web Workers) that share one
// WebAssembly.Memory. Every worker runs one guest thread at a time with its
// own runtime (instances, table, dispatcher) and its own Sys area at its
// thread base; the modules must be built for that (ThreadBaseGlobal,
// SharedMemory). Workers sit in a pool: a job on a worker's control slot
// starts a guest thread there. The guest's syscalls: 1000 create(entry, arg,
// stack top) -> thread id or -EAGAIN, 1001 exit, 202 futex(addr, op, val)
// (0 wait, 1 wake), 24 sched_yield. Needs fexruntime.js loaded first.
(function (G) {
  'use strict';

  const TB_STRIDE = 0x20_0000;  // Sys area per worker
  const CTL = 0x0BF0_0000;      // control slots: 32 bytes per worker
  const IDLE = 0, CLAIMED = 1, JOB = 2, QUIT = 3;
  const MAIN_STACK = -1n;       // job stack: the kernel's stack, returning to halt

  // units.bin -> Map(rip32 -> bytes); regions.bin -> Map(entry rip32 -> bytes)
  function parseUnits(ub) {
    const units = new Map(), dv = new DataView(ub.buffer, ub.byteOffset, ub.byteLength);
    for (let i = 0, off = 4, n = dv.getUint32(0, true); i < n; i++) {
      const rip = dv.getUint32(off, true), len = dv.getUint32(off + 4, true);
      units.set(rip, ub.subarray(off + 8, off + 8 + len));
      off += 8 + len;
    }
    return units;
  }
  // A region only depends on its entry: a thread whose profile picks other
  // units still gets it (region code leaves through its miss paths).
  function parseRegions(rb) {
    const regions = new Map(), dv = new DataView(rb.buffer, rb.byteOffset, rb.byteLength);
    for (let i = 0, off = 4, n = dv.getUint32(0, true); i < n; i++) {
      const cnt = dv.getUint32(off, true), entry = dv.getUint32(off + 4, true);
      off += 4 + 4 * cnt;
      const len = dv.getUint32(off, true);
      regions.set(entry, rb.subarray(off + 4, off + 4 + len));
      off += 4 + len;
    }
    return regions;
  }

  // Main side: starts `entry(arg)` on worker `slot`'s guest thread.
  function submit(mem, slot, entry, arg) {
    const ctl = new Int32Array(mem.buffer, CTL), c64 = new BigInt64Array(mem.buffer, CTL);
    c64[4 * slot + 1] = BigInt(entry); c64[4 * slot + 2] = BigInt(arg); c64[4 * slot + 3] = MAIN_STACK;
    Atomics.store(ctl, 8 * slot, JOB);
    Atomics.notify(ctl, 8 * slot);
  }
  function quit(mem, slot) {
    const ctl = new Int32Array(mem.buffer, CTL);
    Atomics.store(ctl, 8 * slot, QUIT);
    Atomics.notify(ctl, 8 * slot);
  }

  // Main side, shared code: compiles each unit and region once and posts the
  // same WebAssembly.Module to every worker that asks (they share the engine's
  // compiled code). Handles a worker's { req, kind, key } messages; returns
  // true if the message was one.
  function translationServer(units, regions) {
    const unitMods = new Map(), regionMods = new Map();
    const stats = { unitRequests: 0, regionRequests: 0, compiled: 0 };
    function get(kind, key) {
      const map = kind === 'unit' ? unitMods : regionMods, src = kind === 'unit' ? units : regions;
      const k = kind === 'unit' ? key : key[0];
      if (!map.has(k)) {
        const bytes = src.get(k);
        map.set(k, bytes ? { module: new WebAssembly.Module(bytes), bytes: bytes.length } : null);
        if (bytes) stats.compiled++;
      }
      return map.get(k);
    }
    return {
      stats,
      handle(m, reply) {
        if (m.req === undefined) return false;
        m.kind === 'unit' ? stats.unitRequests++ : stats.regionRequests++;
        reply({ res: m.req, code: get(m.kind, m.key) });
        return true;
      },
    };
  }

  // Worker side of the server: request(kind, key) -> Promise; feed replies
  // to onReply.
  function requester(post) {
    const pending = new Map();
    let next = 0;
    return {
      request(kind, key) {
        return new Promise((res) => { pending.set(next, res); post({ req: next++, kind, key }); });
      },
      onReply(m) {
        if (m.res === undefined) return false;
        const res = pending.get(m.res);
        pending.delete(m.res);
        res(m.code);
        return true;
      },
    };
  }

  // Worker side: runs jobs until QUIT. o: { mem, slot, threads, cfg, units,
  // regions, dispatcher, state, post, now }, or instead of units/regions a
  // request(kind, key) function for shared code (async; returns a Promise).
  // A job that returns to halt posts { ms, chk, created }; a thread that
  // exits posts nothing.
  async function workerLoop(o) {
    const { mem, slot, threads, cfg, units, regions, post } = o;
    const u8 = new Uint8Array(mem.buffer), i32 = new Int32Array(mem.buffer), dv = new DataView(mem.buffer);
    const ctl = new Int32Array(mem.buffer, CTL), c64 = new BigInt64Array(mem.buffer, CTL);
    const tb = cfg.threadBase + slot * TB_STRIDE;
    const EXIT = { exit: true };
    let created = 0, futexWaits = 0, regionMisses = 0;
    const syscall = (n, a0, a1, a2) => {
      switch (Number(n)) {
        case 1000: // create(entry, arg, stack top): an idle worker takes it
          for (let k = 1; k < threads; k++) {
            if (Atomics.compareExchange(ctl, 8 * k, IDLE, CLAIMED) !== IDLE) continue;
            c64[4 * k + 1] = a0; c64[4 * k + 2] = a1; c64[4 * k + 3] = a2;
            Atomics.store(ctl, 8 * k, JOB);
            Atomics.notify(ctl, 8 * k);
            created++;
            return BigInt(k);
          }
          return -11n; // EAGAIN
        case 1001: throw EXIT;
        case 202: { // futex
          const a = Number(a0 & 0xffffffffn) >> 2, op = Number(a1) & 127;
          if (op === 0) { futexWaits++; return Atomics.wait(i32, a, Number(BigInt.asIntN(32, a2))) === 'not-equal' ? -11n : 0n; }
          if (op === 1) return BigInt(Atomics.notify(i32, a, Math.min(Number(a2), 0x7fffffff)));
          return -38n;
        }
        case 24: return 0n;
      }
      return undefined;
    };
    const shared = !!o.request;
    const rt = FexRuntime.createRuntime({
      mem, threadBase: tb, now: o.now, syscall,
      ...(shared ? {
        translateAsync: (r) => o.request('unit', r),
        translateRegionAsync: async (rips) => { const r = await o.request('region', Array.from(rips)); if (!r) regionMisses++; return r; },
      } : {
        translate: (r) => units.get(r) || null,
        translateRegion: (rips) => { const r = regions.get(rips[0]); if (!r) regionMisses++; return r || null; },
      }),
      hotAddr: cfg.hotAddr, hotThreshold: o.noRegions ? 0 : cfg.hotThreshold, dispatcher: o.dispatcher,
      dispatchBase: cfg.dispatchBase, dispatchBits: cfg.dispatchBits, slotTagBase: cfg.slotTagBase || 0, slotTagCount: cfg.slotTagCount || 0,
    });
    const W = BigInt(cfg.windowHi) << 32n, GR = tb + cfg.ctx + cfg.gregsOff;
    post({ ready: true, slot });
    for (;;) {
      let s;
      while ((s = Atomics.load(ctl, 8 * slot)) < JOB) Atomics.wait(ctl, 8 * slot, s);
      if (s === QUIT) break;
      const entry = c64[4 * slot + 1], arg = c64[4 * slot + 2], stack = c64[4 * slot + 3];
      u8.set(o.state, tb + cfg.ctx);
      dv.setBigUint64(GR + 7 * 8, BigInt.asUintN(64, arg), true); // RDI
      let sp = stack;
      if (stack === MAIN_STACK) {
        dv.setBigUint64(cfg.stackTop - 8, W + BigInt(cfg.halt), true);
        sp = W + BigInt(cfg.stackTop - 8);
      }
      dv.setBigUint64(GR + 4 * 8, BigInt.asUintN(64, sp), true); // RSP
      created = 0;
      const t = o.now();
      try {
        if (shared) {
          await rt.runAsync(Number(entry & 0xffffffffn), cfg.halt);
        } else {
          rt.run(Number(entry & 0xffffffffn), cfg.halt);
        }
        post({ ms: o.now() - t, chk: Number(dv.getBigUint64(GR, true) & 0xffffffffn), created });
      } catch (e) {
        if (e !== EXIT) {
          post({ error: String(e && e.stack || e), slot });
          Atomics.store(ctl, 8 * slot, IDLE);
          throw e;
        }
      }
      Atomics.store(ctl, 8 * slot, IDLE);
    }
    const st = rt.stats;
    post({ slot, stats: { units: st.units, regions: st.regions, misses: st.misses, compileMs: +st.compileMs.toFixed(1), regionMisses, futexWaits } });
  }

  G.FexThreads = { TB_STRIDE, CTL, parseUnits, parseRegions, submit, quit, workerLoop, translationServer, requester };
})(globalThis);
