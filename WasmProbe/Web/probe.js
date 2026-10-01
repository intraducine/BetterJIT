// Browser-only suites. The native runner calls Probe.run(name, args) through
// callAsyncJavaScript; results go back through the "log" message handler.
(function () {
  'use strict';
  const H = window.webkit.messageHandlers;
  const now = () => performance.now();
  const emit = (o) => H.log.postMessage(JSON.stringify(o));
  const env = { now, emit };
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const params = new URLSearchParams(location.search);

  async function fetchBytes(p) { const r = await fetch(p); return new Uint8Array(await r.arrayBuffer()); }
  async function fetchJSON(p) { return (await fetch(p)).json(); }
  function stats(arr) {
    const a = arr.slice().sort((x, y) => x - y), sum = a.reduce((p, c) => p + c, 0);
    const q = (f) => a[Math.min(a.length - 1, Math.floor(a.length * f))];
    return { n: a.length, avg: sum / a.length, min: a[0], p50: q(0.5), p90: q(0.9), p99: q(0.99), max: a[a.length - 1] };
  }
  function pattern(size) {
    const b = new Uint8Array(size);
    for (let i = 0; i < size; i++) b[i] = (i * 131 + (i >> 8)) & 0xff;
    return b;
  }
  function toB64(bytes) {
    if (bytes.toBase64) return bytes.toBase64();
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }
  const mbps = (bytes, ms) => (bytes / 1048576) / (ms / 1000);

  // RPC to OPFS workers ('A' owns the main handle; 'B' tests a second handle).
  const OW = {};
  function opfsWorker(tag) {
    if (!OW[tag]) {
      const w = new Worker('opfs_worker.js'), pend = new Map(); let seq = 0;
      w.onmessage = (e) => {
        const d = e.data;
        if (d.progress) { emit({ suite: 'opfs', event: 'progress', worker: tag, ...d.progress }); return; }
        const p = pend.get(d.id); if (p) { pend.delete(d.id); p(d); }
      };
      OW[tag] = { call: (op, args) => new Promise((res) => { const id = ++seq; pend.set(id, res); w.postMessage({ id, op, args }); }) };
    }
    return OW[tag];
  }

  const SUITES = {
    async opfs(a) {
      const d = await opfsWorker(a.worker || 'A').call(a.op, a.args);
      const o = { suite: 'opfs', op: a.op, worker: a.worker || 'A', ...(d.error ? { error: d.error, stack: d.stack } : { result: d.r }) };
      emit(o);
      return JSON.stringify(o);
    },

    async env() {
      let minDelta = Infinity, t = now();
      for (let i = 0; i < 300000; i++) { const u = now(); if (u !== t) { minDelta = Math.min(minDelta, u - t); t = u; } }
      const o = {
        suite: 'env', origin: location.origin, ua: navigator.userAgent, secureContext: isSecureContext,
        crossOriginIsolated: self.crossOriginIsolated, hardwareConcurrency: navigator.hardwareConcurrency,
        timerResolutionMs: minDelta, webgpu: !!navigator.gpu, u8ToBase64: !!Uint8Array.prototype.toBase64,
        features: WasmFeatures.detect(),
      };
      emit(o);
      return 'ok';
    },

    // x86-64 guest kernels translated ahead of time by fexwasm (FEX IR -> wasm):
    // replays the same calls as on the Mac through the same JS dispatcher.
    async fexkernels(a) {
      const dir = a.dir || 'fex'; // fexw64: the same kernels built for the Win64 ABI
      const cfg = await fetchJSON(dir + '/config.json');
      const img = await fetchBytes(dir + '/image.bin'), state = await fetchBytes(dir + '/state.bin'), ub = await fetchBytes(dir + '/units.bin');
      const dispatcher = a.jsDispatch ? null : await fetchBytes(dir + '/dispatcher.wasm');
      const units = new Map(), udv = new DataView(ub.buffer, ub.byteOffset, ub.byteLength);
      for (let i = 0, off = 4, n = udv.getUint32(0, true); i < n; i++) {
        const rip = udv.getUint32(off, true), len = udv.getUint32(off + 4, true);
        units.set(rip, ub.slice(off + 8, off + 8 + len));
        off += 8 + len;
      }
      // Regions compiled on the Mac, looked up by their unit list (profiling
      // picks the same lists here: same code, same inputs, same thresholds).
      const regions = new Map();
      if (!a.noRegions) {
        try {
          const rb = await fetchBytes(dir + '/regions.bin'), rdv = new DataView(rb.buffer, rb.byteOffset, rb.byteLength);
          for (let i = 0, off = 4, n = rdv.getUint32(0, true); i < n; i++) {
            const cnt = rdv.getUint32(off, true), rips = [];
            for (let k = 0; k < cnt; k++) rips.push(rdv.getUint32(off + 4 + 4 * k, true));
            off += 4 + 4 * cnt;
            const len = rdv.getUint32(off, true);
            regions.set(rips.join(','), rb.slice(off + 4, off + 4 + len));
            off += 4 + len;
          }
        } catch (e) { emit({ suite: 'fexkernels', regionsError: String(e) }); }
      }
      const mem = new WebAssembly.Memory({ initial: cfg.memPages });
      const u8 = new Uint8Array(mem.buffer), dv = new DataView(mem.buffer);
      u8.set(img, cfg.imageLow);
      let regionMisses = 0;
      const rt = FexRuntime.createRuntime({ mem, translate: (rip) => units.get(rip) || null, now, dispatcher,
        translateRegion: (rips) => { const r = regions.get(Array.from(rips).join(',')); if (!r) regionMisses++; return r || null; },
        hotAddr: cfg.hotAddr, hotThreshold: a.noRegions ? 0 : cfg.hotThreshold,
        dispatchBase: cfg.dispatchBase, dispatchBits: cfg.dispatchBits, slotTagBase: cfg.slotTagBase || 0, slotTagCount: cfg.slotTagCount || 0 });
      const W = BigInt(cfg.windowHi) << 32n, G = cfg.ctx + cfg.gregsOff;
      const win64 = cfg.guestAbi === 'win64'; // argument in RCX, 32-byte shadow space above the return address
      const call = (entry, arg) => {
        u8.set(state, cfg.ctx);
        const ret = cfg.stackTop - (win64 ? 0x48 : 8);
        dv.setBigUint64(G + (win64 ? 1 : 7) * 8, BigInt(arg), true);           // RCX / RDI
        dv.setBigUint64(ret, W + BigInt(cfg.halt), true);                       // return address = halt
        dv.setBigUint64(G + 4 * 8, W + BigInt(ret), true);                      // RSP
        rt.run(entry, cfg.halt);
        return { chk: Number(dv.getBigUint64(G, true) & 0xffffffffn), dispatches: rt.stats.misses + rt.stats.jsDispatches };
      };
      for (const k of cfg.kernels) {
        call(k.entry, Math.max(1, Math.floor(k.n / 10))); // warm-up: profile and recompile before timing
        const t = now(); const r = call(k.entry, k.n); const ms = now() - t;
        emit({ suite: 'fexkernels', dir, kernel: k.name, n: k.n, ms, chk: r.chk, match: r.chk === k.chk, dispatches: r.dispatches,
          macNativeMs: k.macNativeMs, macWasmMs: k.macWasmMs });
      }
      emit({ suite: 'fexkernels', stats: rt.stats, regionsAvailable: regions.size, regionMisses });
      return 'ok';
    },

    // The same x86-64 guest with real threads: Box2D's scheduler threads run
    // on Web Workers sharing one wasm memory (fexthreads.js), TSO mode 3.
    // Pool of T workers = at most T guest threads; the kernel asks for 4.
    async fexthreads(a) {
      const dir = a.dir || 'fexmt';
      const cfg = await fetchJSON(dir + '/config.json');
      const img = await fetchBytes(dir + '/image.bin');
      const mem = new WebAssembly.Memory({ initial: cfg.memPages, maximum: cfg.memPages, shared: true });
      const u8 = new Uint8Array(mem.buffer);
      // shared: this page compiles each module once and posts it to the workers.
      const server = a.shared ? FexThreads.translationServer(FexThreads.parseUnits(await fetchBytes(dir + '/units.bin')),
        FexThreads.parseRegions(await fetchBytes(dir + '/regions.bin'))) : null;
      // (threads may be "1+4": the suite list on the command line is comma-separated)
      const list = typeof a.threads === 'string' ? a.threads.split('+').map(Number) : a.threads;
      for (const T of list || [1, 2, 3, 4]) {
        u8.set(img, cfg.imageLow);
        u8.fill(0, FexThreads.CTL, cfg.threadBase + 8 * FexThreads.TB_STRIDE); // control slots and Sys areas
        let onResult = null, nReady = 0, onReady;
        const ready = new Promise((r) => { onReady = r; });
        const stats = [], ws = [];
        for (let k = 0; k < T; k++) {
          const w = new Worker('fexworker.js');
          w.onmessage = (e) => {
            const m = e.data;
            if (server && server.handle(m, (r) => w.postMessage(r))) return;
            if (m.ready) { if (++nReady === T) onReady(); } else if (m.stats) stats.push(m.stats); else if (onResult) onResult(m);
          };
          w.onerror = (e) => emit({ suite: 'fexthreads', threads: T, workerError: String(e.message) });
          w.postMessage({ mem, slot: k, threads: T, dir, shared: !!a.shared });
          ws.push(w);
        }
        await ready;
        const job = (entry, n) => new Promise((res) => { onResult = res; FexThreads.submit(mem, 0, entry, n); });
        for (const k of cfg.kernels) {
          if (a.kernel && k.name !== a.kernel) continue;
          const n = a.n || k.n;
          const warm = await job(k.entry, Math.max(1, Math.floor(n / 10)));
          if (warm.error) { emit({ suite: 'fexthreads', threads: T, error: warm.error }); break; }
          const r = await job(k.entry, n);
          if (r.error) { emit({ suite: 'fexthreads', threads: T, error: r.error }); break; }
          emit({ suite: 'fexthreads', shared: !!a.shared, threads: T, kernel: k.name, n, ms: r.ms, warmMs: warm.ms, chk: r.chk, match: n === k.n ? r.chk === k.chk : null,
            created: r.created, macNativeMs: k.macNativeMs, macWasmMs: k.macWasmMs });
        }
        for (let k = 0; k < T; k++) FexThreads.quit(mem, k);
        await sleep(200);
        emit({ suite: 'fexthreads', shared: !!a.shared, threads: T, workerStats: stats, server: server && server.stats });
        ws.forEach((w) => w.terminate());
      }
      return 'ok';
    },

    // Does a WebAssembly.Module posted to workers share its compiled (and
    // tiered-up) code? Worker A warms a module up; then worker B gets the
    // same Module object and worker C a fresh one compiled from the bytes.
    // Shared code shows as B being fast from its first calls.
    async modshare(a) {
      const bytes = await fetchBytes('bench.wasm');
      const mod = new WebAssembly.Module(bytes);
      const kernel = a.kernel || 'k_intmix', n = a.n || 200000, calls = a.calls || 40;
      const src = `onmessage = (e) => { const { m, bytes, kernel, n, calls } = e.data;
        const t0 = performance.now();
        const mm = m || new WebAssembly.Module(bytes);
        const t1 = performance.now();
        const ex = new WebAssembly.Instance(mm, {}).exports;
        const t2 = performance.now();
        const per = [];
        for (let i = 0; i < calls; i++) { const t = performance.now(); ex[kernel](n); per.push(+(performance.now() - t).toFixed(3)); }
        postMessage({ compileMs: t1 - t0, instMs: t2 - t1, per }); };`;
      const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
      const run = (payload) => new Promise((res) => {
        const w = new Worker(url);
        w.onmessage = (e) => { res(e.data); w.terminate(); };
        w.onerror = (e) => { res({ error: String(e.message), per: [] }); w.terminate(); };
        w.postMessage(payload);
      });
      const A = await run({ m: mod, kernel, n, calls: calls * 5 });
      emit({ suite: 'modshare', worker: 'A (posted module, first user)', compileMs: A.compileMs, instMs: A.instMs, first: A.per.slice(0, 8), last: A.per.slice(-4) });
      const B = await run({ m: mod, kernel, n, calls });
      emit({ suite: 'modshare', worker: 'B (same module, after A warmed it)', compileMs: B.compileMs, instMs: B.instMs, first: B.per.slice(0, 8), last: B.per.slice(-4) });
      const C = await run({ bytes, kernel, n, calls });
      emit({ suite: 'modshare', worker: 'C (own module from bytes)', compileMs: C.compileMs, instMs: C.instMs, first: C.per.slice(0, 8), last: C.per.slice(-4) });
      return 'ok';
    },

    async fexthreads_shared(a) { return SUITES.fexthreads(Object.assign({}, a, { shared: true })); },

    // Live translation on the device: FEX + the wasm backend in the app
    // translate each unit and region as the guest reaches it (/xlat/*), and
    // this page compiles and runs them (runtime async mode, JSPI for regions).
    // The dump directory only supplies the guest image and the kernel list.
    async fexlive_http(a) { return SUITES.fexlive(Object.assign({}, a, { http: true })); },

    async fexlive(a) {
      const dir = a.dir || 'fex';
      const dump = await fetchJSON(dir + '/config.json');
      const opts = (a.opts || '') + (dump.guestAbi === 'win64' ? ' abi=win64' : '');
      let t = now();
      const init = await fetch('/xlat/init?dir=' + dir + '&opts=' + encodeURIComponent(opts));
      if (!init.ok) { emit({ suite: 'fexlive', error: await init.text() }); return 'error'; }
      const initMs = now() - t;
      const live = await FexLive.connect('', fetch, a.http ? null : 'ws://127.0.0.1:' + (params.get('ws') || 47114));
      const cfg = live.cfg;
      const mem = new WebAssembly.Memory({ initial: cfg.memPages, maximum: cfg.memPages, shared: !!cfg.shared });
      new Uint8Array(mem.buffer).set(await fetchBytes(dir + '/image.bin'), cfg.imageLow);
      const rt = live.runtime(mem);
      for (const k of dump.kernels) {
        if (a.kernel && k.name !== a.kernel) continue;
        const warmN = Math.max(1, Math.floor((k.n & 0xffffff) / 10)) | (k.n & ~0xffffff);
        t = now(); await live.call(rt, mem, k.entry, warmN); const firstMs = now() - t;
        t = now(); const chk = await live.call(rt, mem, k.entry, k.n); const ms = now() - t;
        emit({ suite: 'fexlive', dir, kernel: k.name, n: k.n, ms, firstMs, chk, match: chk === k.chk });
      }
      emit({ suite: 'fexlive', dir, initMs, client: live.stats, runtime: rt.stats, translator: await live.translatorStats() });
      return 'ok';
    },

    async kernels(a) { ProbeCore.runKernels(await fetchBytes('bench.wasm'), env, a); return 'ok'; },
    async dispatch(a) { ProbeCore.runDispatch(await fetchJSON('guestprog.json'), env, a); return 'ok'; },
    async jitcost(a) { ProbeCore.runJitCost(await fetchJSON('guestprog.json'), env, a); return 'ok'; },

    // Address-space reservations (nothing touched).
    async memres() {
      const r = { suite: 'memres' };
      for (const pages of [16384, 32768, 49152, 65536]) {
        try { new WebAssembly.Memory({ initial: pages }); r['initial_' + (pages / 16) + 'MB'] = 'ok'; }
        catch (e) { r['initial_' + (pages / 16) + 'MB'] = String(e); }
      }
      try { new WebAssembly.Memory({ initial: 16, maximum: 65536, shared: true }); r.shared_max4GB = 'ok'; } catch (e) { r.shared_max4GB = String(e); }
      // Fast (guard-page) memories are capped; later instances fall back to explicit bounds checks.
      const bytes = await fetchBytes('bench.wasm'), mod = new WebAssembly.Module(bytes), insts = [];
      try { for (let i = 0; i < 16; i++) insts.push(new WebAssembly.Instance(mod, {})); } catch (e) { r.instErr = String(e); }
      r.instances = insts.length;
      const timeOf = (inst) => { inst.exports.k_hash(1); let best = Infinity; for (let i = 0; i < 3; i++) { const t = now(); inst.exports.k_hash(8); best = Math.min(best, now() - t); } return best; };
      r.hash_ms_by_instance = insts.map(timeOf).map(x => +x.toFixed(1));
      emit(r);
      return 'ok';
    },

    // Grow and touch until grow fails or the WebContent process is killed.
    async memtouch(a) {
      const step = a.stepPages || 1024;
      let totalMB = 0;
      for (let memIdx = 0; memIdx < 8; memIdx++) {
        const m = new WebAssembly.Memory({ initial: 1, maximum: 65536 });
        (window.__keep = window.__keep || []).push(m);
        let pages = 1;
        for (;;) {
          try { m.grow(step); } catch (e) { emit({ suite: 'memtouch', event: 'growfail', memIdx, memMB: pages / 16, totalMB, error: String(e) }); break; }
          const u8 = new Uint8Array(m.buffer), t = now();
          for (let off = pages * 65536; off < (pages + step) * 65536; off += 16384) u8[off] = 1;
          pages += step; totalMB += step / 16;
          emit({ suite: 'memtouch', event: 'progress', memIdx, memMB: pages / 16, totalMB, touchMs: +(now() - t).toFixed(1) });
          await sleep(40);
        }
      }
      return 'done';
    },

    async ipc(a) {
      // Tiny round trips through WKScriptMessageHandlerWithReply.
      for (let i = 0; i < 20; i++) await H.echo.postMessage(i);
      let lat = [];
      for (let i = 0; i < 1000; i++) { const t = now(); await H.echo.postMessage(i); lat.push((now() - t) * 1000); }
      emit({ suite: 'ipc', test: 'reply-rtt-tiny', unit: 'us', ...stats(lat) });
      // Fire-and-forget rate (ordered channel; the last message waits for the rest).
      {
        const t = now(); for (let i = 0; i < 10000; i++) H.sink.postMessage(i); await H.echo.postMessage('flush');
        emit({ suite: 'ipc', test: 'post-rate-tiny', msgs: 10000, ms: now() - t, usPerMsg: (now() - t) * 1000 / 10000 });
      }
      // What each JS type turns into on the native side.
      const types = { string: 'hi', number: 1.5, array: [1, 2, 3], object: { a: 1 }, arraybuffer: new ArrayBuffer(16),
        uint8array: new Uint8Array(16), dataview: new DataView(new ArrayBuffer(8)) };
      for (const [k, v] of Object.entries(types)) {
        try { emit({ suite: 'ipc', test: 'type', js: k, native: await H.echo.postMessage(v) }); }
        catch (e) { emit({ suite: 'ipc', test: 'type', js: k, error: String(e) }); }
      }
      // Bulk JS -> native.
      for (const size of [65536, 1 << 20, 8 << 20, 32 << 20]) {
        const bytes = pattern(size);
        let t = now(); const b64 = toB64(bytes); const encMs = now() - t;
        t = now(); const r1 = await H.echo.postMessage({ k: 'b64', s: b64 }); const b64Ms = now() - t;
        t = now(); let r2; try { r2 = await H.echo.postMessage(bytes.buffer); } catch (e) { r2 = String(e); } const abMs = now() - t;
        t = now(); let r3, postMs; try { const resp = await fetch('sink', { method: 'POST', body: bytes }); r3 = await resp.text(); } catch (e) { r3 = String(e); } postMs = now() - t;
        emit({ suite: 'ipc', test: 'bulk-js-to-native', bytes: size,
          base64: { encodeMs: encMs, sendMs: b64Ms, MBps: mbps(size, encMs + b64Ms), native: r1 },
          arraybuffer: { ms: abMs, MBps: mbps(size, abMs), native: r2 },
          fetchPOST: { ms: postMs, MBps: mbps(size, postMs), native: r3 } });
      }
      // Bulk native -> JS via fetch GET, landing in a wasm memory.
      const mem = new WebAssembly.Memory({ initial: 1024 });
      for (const size of [65536, 1 << 20, 8 << 20, 32 << 20]) {
        const runs = [];
        for (let r = 0; r < 3; r++) {
          const t = now();
          const ab = await (await fetch('blob?n=' + size)).arrayBuffer();
          const t2 = now();
          new Uint8Array(mem.buffer).set(new Uint8Array(ab), 0);
          runs.push({ fetchMs: t2 - t, copyMs: now() - t2, got: ab.byteLength });
        }
        const best = runs.reduce((a, b) => (a.fetchMs + a.copyMs <= b.fetchMs + b.copyMs ? a : b));
        emit({ suite: 'ipc', test: 'bulk-native-to-js-fetch', bytes: size, ...best, MBps: mbps(size, best.fetchMs + best.copyMs) });
      }
      // Tiny fetch round trips.
      lat = [];
      for (let i = 0; i < 300; i++) { const t = now(); await (await fetch('rpc', { method: 'POST', body: 'x' })).text(); lat.push((now() - t) * 1000); }
      emit({ suite: 'ipc', test: 'fetch-rtt-tiny', unit: 'us', ...stats(lat) });
      return 'ok';
    },

    // Synchronous calls from a worker (what blocking guest syscalls would need).
    async worker(a) {
      const w = new Worker('worker.js');
      const call = (msg) => new Promise((res) => { w.onmessage = (e) => { if (e.data.req === undefined) res(e.data); else onReq(e.data); }; w.postMessage(msg); });
      let sab = null, i32 = null;
      const onReq = async (d) => {
        if (d.native) await H.echo.postMessage(d.req);
        Atomics.store(i32, 0, 1); Atomics.notify(i32, 0);
      };
      emit({ suite: 'worker', test: 'syncxhr-rtt', unit: 'us', ...(await call({ test: 'syncxhr', n: 300 })) });
      emit({ suite: 'worker', test: 'syncxhr-bulk', ...(await call({ test: 'syncxhr-bulk' })) });
      if (typeof SharedArrayBuffer === 'function' && self.crossOriginIsolated) {
        sab = new SharedArrayBuffer(64); i32 = new Int32Array(sab);
        emit({ suite: 'worker', test: 'atomics-rtt-main-only', unit: 'us', ...(await call({ test: 'atomics', n: 1000, sab, native: false })) });
        emit({ suite: 'worker', test: 'atomics-rtt-via-native', unit: 'us', ...(await call({ test: 'atomics', n: 1000, sab, native: true })) });
      } else {
        emit({ suite: 'worker', test: 'atomics', skipped: 'no SharedArrayBuffer / not crossOriginIsolated' });
      }
      w.terminate();
      return 'ok';
    },

    // Do N workers running wasm at once scale across the CPU cores?
    async threads(a) {
      const bytes = await fetchBytes('bench.wasm');
      const kernel = a.kernel || 'intmix', n = a.n || 50000000;
      for (const N of a.counts || [1, 2, 3, 4, 6, 8]) {
        const ws = Array.from({ length: N }, () => new Worker('worker.js'));
        const t = now();
        const res = await Promise.all(ws.map(w => new Promise(res => { w.onmessage = e => res(e.data); w.postMessage({ test: 'kernel', kernel, n, bytes }); })));
        const wall = now() - t;
        ws.forEach(w => w.terminate());
        const per = res.map(r => r.ms);
        emit({ suite: 'threads', workers: N, kernel, n, wallMs: wall, perWorkerMs: per.map(x => +x.toFixed(1)),
          speedupVs1: null, throughputPerSec: N * n / (Math.max(...per) / 1000) });
      }
      return 'ok';
    },

    // Cost of emulating x86 TSO with wasm atomics (seq_cst): plain vs atomic
    // loads/stores, alone and with 4 workers reading the same shared lines.
    async tso(a) {
      const W = WasmGen, OP = W.OP;
      // mode: 'plain' | 'atomic' (seq_cst accesses) | 'fence' (plain accesses, atomic.fence after
      // each load and before each store: the barrier-based way to keep x86 ordering)
      const body = (mode, write) => {
        // 'mixed': fence after each load, atomic (swpal) stores without fences
        const atomic = mode === 'atomic', fence = mode === 'fence' || mode === 'mixed', atomicStore = atomic || mode === 'mixed';
        const c = [OP.loop, 0x40];
        for (let k = 0; k < 4; k++) {   // 4 loads from the shared lines at address 0
          c.push(OP.local_get, 2, OP.i32_const, ...W.s32(8 * k));
          if (atomic) c.push(0xfe, 0x11, 3, 0); else c.push(OP.i64_load, 3, 0);
          if (fence) c.push(0xfe, 0x03, 0x00);
          c.push(OP.i64_add, OP.local_set, 2);
        }
        if (write) for (let k = 0; k < 2; k++) {   // 2 stores to this worker's own lines (param 1)
          if (fence && !atomicStore) c.push(0xfe, 0x03, 0x00);
          c.push(OP.local_get, 1, OP.i32_const, ...W.s32(8 * k), OP.i32_add, OP.local_get, 2);
          if (atomicStore) c.push(0xfe, 0x18, 3, 0); else c.push(OP.i64_store, 3, 0);
        }
        c.push(OP.local_get, 0, OP.i32_const, 1, OP.i32_sub, OP.local_tee, 0, OP.br_if, 0, OP.end, OP.local_get, 2);
        return c;
      };
      const fn = (name, mode, write) => ({ type: [[W.T.i32, W.T.i32], [W.T.i64]], locals: [[1, W.T.i64]], code: body(mode, write), export: name });
      const bytes = W.buildModule({ imports: [{ module: 'e', name: 'mem', kind: 'memory', min: 16, max: 16, shared: true }],
        funcs: [fn('plainRW', 'plain', true), fn('atomicRW', 'atomic', true), fn('plainR', 'plain', false), fn('atomicR', 'atomic', false),
          fn('fenceR', 'fence', false), fn('fenceRW', 'fence', true), fn('mixedRW', 'mixed', true)] });
      const mem = new WebAssembly.Memory({ initial: 16, maximum: 16, shared: true });
      const ex = new WebAssembly.Instance(new WebAssembly.Module(bytes), { e: { mem } }).exports;
      const N = 20000000, single = {};
      for (const k of ['plainRW', 'atomicRW', 'fenceRW', 'mixedRW', 'plainR', 'atomicR', 'fenceR']) {
        ex[k](100000, 4096);
        let best = Infinity;
        for (let r = 0; r < 3; r++) { const t = now(); ex[k](N, 4096); best = Math.min(best, now() - t); }
        single[k] = +(best * 1e6 / N).toFixed(2);
      }
      emit({ suite: 'tso', test: 'single-thread ns/iter (4 loads [+2 stores])', ...single });
      // 4 workers, all loading the same 32 bytes (shared lines), each storing privately.
      const src = `onmessage = (e) => { const { bytes, mem, k, n, base } = e.data;
        const ex = new WebAssembly.Instance(new WebAssembly.Module(bytes), { e: { mem } }).exports;
        ex[k](100000, base); const t = performance.now(); ex[k](n, base); postMessage(performance.now() - t); };`;
      const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
      const multi = {};
      for (const k of ['plainR', 'fenceR', 'plainRW', 'fenceRW', 'mixedRW']) {
        const ws = Array.from({ length: 4 }, () => new Worker(url));
        const n = 5000000;
        const times = await Promise.all(ws.map((w, i) => new Promise((res) => { w.onmessage = (e) => res(e.data); w.postMessage({ bytes, mem, k, n, base: 4096 + 256 * i }); })));
        ws.forEach(w => w.terminate());
        multi[k] = +(Math.max(...times) * 1e6 / n).toFixed(2);
      }
      emit({ suite: 'tso', test: '4 workers: shared loads, private stores; ns/iter', ...multi });
      return 'ok';
    },

    async ws(a) {
      const port = a.port || params.get('ws');
      const sock = new WebSocket('ws://127.0.0.1:' + port);
      sock.binaryType = 'arraybuffer';
      await new Promise((res, rej) => { sock.onopen = res; sock.onerror = () => rej(new Error('ws error')); });
      let pending = null;
      sock.onmessage = (e) => { const p = pending; pending = null; p(e.data); };
      const send = (buf) => new Promise((res) => { pending = res; sock.send(buf); });
      const mk = (mode, n, size) => { const b = new Uint8Array(Math.max(5, size)); b[0] = mode; new DataView(b.buffer).setUint32(1, n, true); return b; };
      for (let i = 0; i < 20; i++) await send(mk(0, 0, 8));
      const lat = [];
      for (let i = 0; i < 1000; i++) { const t = now(); await send(mk(0, 0, 8)); lat.push((now() - t) * 1000); }
      emit({ suite: 'ws', test: 'rtt-tiny', unit: 'us', ...stats(lat) });
      for (const size of [65536, 1 << 20, 8 << 20]) {
        const buf = mk(1, 0, size), reps = size >= (8 << 20) ? 8 : 32;
        let t = now(); for (let i = 0; i < reps; i++) await send(buf); const upMs = now() - t;
        t = now(); let got = 0; for (let i = 0; i < reps; i++) got += (await send(mk(2, size, 8))).byteLength; const downMs = now() - t;
        emit({ suite: 'ws', test: 'bulk', bytes: size, reps, upMBps: mbps(size * reps, upMs), downMBps: mbps(got, downMs) });
      }
      sock.close();
      return 'ok';
    },

    async webgpu() {
      if (!navigator.gpu) { emit({ suite: 'webgpu', available: false }); return 'none'; }
      const ad = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
      if (!ad) { emit({ suite: 'webgpu', available: true, adapter: null }); return 'noadapter'; }
      const lim = {};
      for (const k of ['maxBufferSize', 'maxStorageBufferBindingSize', 'maxTextureDimension2D', 'maxComputeWorkgroupStorageSize',
        'maxComputeInvocationsPerWorkgroup', 'maxBindGroups', 'maxColorAttachments', 'maxVertexBuffers', 'maxStorageBuffersPerShaderStage']) lim[k] = ad.limits[k];
      const info = ad.info ? { vendor: ad.info.vendor, architecture: ad.info.architecture, device: ad.info.device, description: ad.info.description } : null;
      emit({ suite: 'webgpu', available: true, info, features: [...ad.features].sort(), limits: lim });
      const dev = await ad.requestDevice({ requiredLimits: { maxBufferSize: ad.limits.maxBufferSize, maxStorageBufferBindingSize: ad.limits.maxStorageBufferBindingSize } });
      const sm = dev.createShaderModule({ code: `
        @vertex fn vs(@builtin(vertex_index) v: u32, @builtin(instance_index) i: u32) -> @builtin(position) vec4f {
          let p = array(vec2f(0, 0.05), vec2f(-0.05, -0.05), vec2f(0.05, -0.05));
          let o = vec2f(f32(i % 100u) / 50.0 - 1.0, f32((i / 100u) % 100u) / 50.0 - 1.0);
          return vec4f(p[v] + o, 0, 1);
        }
        @fragment fn fs() -> @location(0) vec4f { return vec4f(1, 0.5, 0, 1); }` });
      const pipe = dev.createRenderPipeline({ layout: 'auto', vertex: { module: sm, entryPoint: 'vs' },
        fragment: { module: sm, entryPoint: 'fs', targets: [{ format: 'rgba8unorm' }] } });
      const tex = dev.createTexture({ size: [512, 512], format: 'rgba8unorm', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
      await dev.queue.onSubmittedWorkDone();
      for (const draws of [1, 100, 1000, 10000]) {
        const enc = [], done = [];
        for (let r = 0; r < 12; r++) {
          const t = now();
          const ce = dev.createCommandEncoder();
          const pass = ce.beginRenderPass({ colorAttachments: [{ view: tex.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }] });
          pass.setPipeline(pipe);
          for (let i = 0; i < draws; i++) pass.draw(3, 1, 0, i);
          pass.end();
          dev.queue.submit([ce.finish()]);
          const t2 = now();
          await dev.queue.onSubmittedWorkDone();
          if (r >= 2) { enc.push(t2 - t); done.push(now() - t); }
        }
        emit({ suite: 'webgpu', test: 'drawcalls', draws, encodeSubmitMs: stats(enc).p50, toCompleteMs: stats(done).p50, toCompleteP90: stats(done).p90 });
      }
      for (const size of [1 << 20, 16 << 20, 64 << 20]) {
        const buf = dev.createBuffer({ size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC });
        const rb = dev.createBuffer({ size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
        const data = pattern(size);
        let t = now(); dev.queue.writeBuffer(buf, 0, data); await dev.queue.onSubmittedWorkDone(); const upMs = now() - t;
        t = now();
        const ce = dev.createCommandEncoder(); ce.copyBufferToBuffer(buf, 0, rb, 0, size); dev.queue.submit([ce.finish()]);
        await rb.mapAsync(GPUMapMode.READ); const view = new Uint8Array(rb.getMappedRange()); const ok = view[12345] === data[12345]; rb.unmap();
        const downMs = now() - t;
        emit({ suite: 'webgpu', test: 'transfer', bytes: size, uploadMBps: mbps(size, upMs), readbackMBps: mbps(size, downMs), ok });
        buf.destroy(); rb.destroy();
      }
      return 'ok';
    },

    // Is the page still running at full speed in the current view state?
    async liveness(a) {
      const r = { suite: 'liveness', state: a.state, visibility: document.visibilityState };
      if (!window.__benchInst) window.__benchInst = new WebAssembly.Instance(new WebAssembly.Module(await fetchBytes('bench.wasm')), {});
      const k = window.__benchInst.exports;
      k.k_intmix(1000);
      let t = now(); k.k_intmix(20000000); r.intmix20M_ms = +(now() - t).toFixed(1);
      r.setTimeout0 = await new Promise((res) => { let c = 0; const s = now(); const tick = () => { c++; if (now() - s < 1000) setTimeout(tick, 0); else res({ count: c, ms: Math.round(now() - s) }); }; setTimeout(tick, 0); });
      r.rAF = await new Promise((res) => { let c = 0, done = false; const s = now(); const f = () => { if (done) return; c++; requestAnimationFrame(f); }; requestAnimationFrame(f); setTimeout(() => { done = true; res({ count: c, ms: Math.round(now() - s) }); }, 1000); });
      emit(r);
      return 'ok';
    },

    // How much JIT-compiled code can we keep alive before tier-up stops working?
    async jitcap(a) {
      const W = WasmGen, OP = W.OP;
      const mem = new WebAssembly.Memory({ initial: W.L.PAGES });
      W.resetState(mem, { n: 0, blocks: [] });
      let seed = 1;
      const rnd = (n) => { seed = (seed * 1103515245 + 12345) >>> 0; return (seed >>> 8) % n; };
      const kinds = ['add', 'xor', 'mul', 'rot', 'ld', 'st', 'add', 'xor'];
      const opsPer = a.ops || 600, iters = a.iters || 3000, maxMods = a.max || 3000;
      const keep = []; let total = 0, window_ = [];
      const t0 = now();
      for (let m = 0; m < maxMods; m++) {
        const ops = [];
        for (let i = 0; i < opsPer; i++) {
          const k = kinds[rnd(kinds.length)];
          ops.push([k, rnd(16), rnd(16), k === 'rot' ? 1 + rnd(63) : (k === 'ld' || k === 'st') ? rnd(65536) & ~7 : rnd(1 << 30)]);
        }
        const R = (x) => 1 + x, code = [];
        for (let x = 0; x < 16; x++) code.push(...W.loadReg(x, R(x)));
        code.push(OP.loop, 0x40);
        for (const b of W.emitOps({ ops }, R, {}, 18, 0)) code.push(b);
        code.push(OP.local_get, 0, OP.i32_const, 1, OP.i32_sub, OP.local_tee, 0, OP.br_if, 0, OP.end);
        for (let x = 0; x < 16; x++) code.push(...W.storeReg(x, R(x)));
        const bytes = W.buildModule({ imports: [W.faultImport, W.memImport],
          funcs: [{ type: [[W.T.i32], []], locals: [[16, W.T.i64], [2, W.T.i32]], code, export: 'run' }] });
        let inst;
        try { inst = new WebAssembly.Instance(new WebAssembly.Module(bytes), { e: { mem, fault() {} } }); }
        catch (e) { emit({ suite: 'jitcap', event: 'fail', modules: m, error: String(e) }); break; }
        inst.exports.run(iters);
        const t = now(); inst.exports.run(iters); window_.push((now() - t) * 1e6 / (iters * opsPer));
        keep.push(inst); total += bytes.length;
        if (m % 100 === 99) {
          emit({ suite: 'jitcap', event: 'progress', modules: m + 1, wasmMB: +(total / 1048576).toFixed(2),
            elapsedMs: Math.round(now() - t0), nsPerOp_p50: +stats(window_).p50.toFixed(3), nsPerOp_max: +stats(window_).max.toFixed(3) });
          window_ = [];
          await sleep(5);
        }
      }
      return 'done';
    },

    // Is JIT memory given back? Fill the pool until new modules drop to the
    // interpreter, drop every reference, churn garbage so GC runs, then check
    // whether fresh modules are JIT-compiled again.
    async jitgc(a) {
      const W = WasmGen, OP = W.OP;
      const mem = new WebAssembly.Memory({ initial: W.L.PAGES });
      W.resetState(mem, { n: 0, blocks: [] });
      let seed = 7;
      const rnd = (n) => { seed = (seed * 1103515245 + 12345) >>> 0; return (seed >>> 8) % n; };
      const kinds = ['add', 'xor', 'mul', 'rot', 'add', 'xor'];
      const opsPer = a.ops || 4000, iters = a.iters || 400;
      const make = () => {
        const ops = [];
        for (let i = 0; i < opsPer; i++) {
          const k = kinds[rnd(kinds.length)];
          ops.push([k, rnd(16), rnd(16), k === 'rot' ? 1 + rnd(63) : rnd(1 << 30)]);
        }
        const R = (x) => 1 + x, code = [];
        for (let x = 0; x < 16; x++) code.push(...W.loadReg(x, R(x)));
        code.push(OP.loop, 0x40);
        for (const b of W.emitOps({ ops }, R, {}, 18, 0)) code.push(b);
        code.push(OP.local_get, 0, OP.i32_const, 1, OP.i32_sub, OP.local_tee, 0, OP.br_if, 0, OP.end);
        for (let x = 0; x < 16; x++) code.push(...W.storeReg(x, R(x)));
        return W.buildModule({ imports: [W.faultImport, W.memImport],
          funcs: [{ type: [[W.T.i32], []], locals: [[16, W.T.i64], [2, W.T.i32]], code, export: 'run' }] });
      };
      // ns/op of a fresh module after it has run enough to tier up
      const probe = (keep) => {
        const bytes = make();
        const inst = new WebAssembly.Instance(new WebAssembly.Module(bytes), { e: { mem, fault() {} } });
        inst.exports.run(iters);
        const t = now(); inst.exports.run(iters);
        if (keep) keep.push(inst);
        return { ns: (now() - t) * 1e6 / (iters * opsPer), bytes: bytes.length };
      };
      let keep = [], total = 0;
      const base = stats([0, 1, 2, 3, 4].map(() => probe(null).ns)).p50;
      if (a.cycles) {
        // Fill a.cycleMB, drop, churn; repeat. JIT memory is returned if the
        // cumulative total can exceed the ~158 MB pool while staying fast.
        let cum = 0;
        for (let c = 0; c < a.cycles; c++) {
          let mb = 0, slow = 0, n = 0;
          keep = [];
          while (mb < a.cycleMB) {
            const r = probe(keep);
            mb += r.bytes / 1048576; cum += r.bytes / 1048576; n++;
            if (r.ns > base * 3) slow++;
            if (n % 300 === 0) await sleep(1);
          }
          emit({ suite: 'jitgc', phase: 'cycle', cycle: c, cycleMB: +mb.toFixed(1), cumulativeMB: +cum.toFixed(1), slowModules: slow, modules: n });
          keep = null;
          for (let round = 0; round < 3; round++) {
            let junk = [];
            for (let i = 0; i < 400; i++) junk.push(new Array(50000).fill(i));
            junk = null;
            await sleep(400);
          }
        }
        return 'done';
      }
      emit({ suite: 'jitgc', phase: 'baseline', nsPerOp: +base.toFixed(3), wasmKBPerModule: +(make().length / 1024).toFixed(1) });
      const t0 = now();
      let slowRun = 0, m = 0;
      for (; m < (a.max || 4000) && now() - t0 < (a.fillMs || 90000); m++) {
        const r = probe(keep);
        total += r.bytes;
        slowRun = r.ns > base * 3 ? slowRun + 1 : 0;
        if (m % 200 === 199) {
          emit({ suite: 'jitgc', phase: 'fill', modules: m + 1, wasmMB: +(total / 1048576).toFixed(1), nsPerOp: +r.ns.toFixed(3) });
          await sleep(2);
        }
        if (slowRun >= 5) break;
      }
      emit({ suite: 'jitgc', phase: 'full', modules: m, wasmMB: +(total / 1048576).toFixed(1), exhausted: slowRun >= 5,
        elapsedMs: Math.round(now() - t0), nsNow: +probe(null).ns.toFixed(3) });
      // drop everything and churn
      keep = null;
      for (let round = 0; round < (a.rounds || 6); round++) {
        let junk = [];
        for (let i = 0; i < 400; i++) junk.push(new Array(50000).fill(i));
        junk = null;
        await sleep(500);
        const r = [0, 1, 2].map(() => probe(null).ns);
        emit({ suite: 'jitgc', phase: 'after-drop', round, nsPerOp: r.map((x) => +x.toFixed(3)) });
      }
      return 'done';
    },
  };

  window.Probe = {
    async run(name, args) {
      try { return await SUITES[name](args || {}); }
      catch (e) { emit({ suite: name, error: String(e), stack: String(e.stack || '') }); return 'error'; }
    },
    recvB64(s) { return (Uint8Array.fromBase64 ? Uint8Array.fromBase64(s) : Uint8Array.from(atob(s), c => c.charCodeAt(0))).length; },
    recvString(s) { return s.length; },
  };
  document.getElementById('status').textContent = 'ready ' + location.origin;
})();
