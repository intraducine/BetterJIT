// A guest thread's worker, host-neutral: runs the thread's translated code
// (js/runtime.js in async mode, units and regions fetched from the
// translator) against its process's memory, and takes its syscalls to the
// kernel worker (js/linux/kernel.js) through its slot, except the few it can
// do alone (futex waits and wakes on the shared memory, clocks).
// runThread(env): env.data (spawn info), env.post(msg), and optionally
// env.unitBroker, env.threadMap, env.dumpDir + env.dump(name, bytes). Needs
// FexRuntime. (FexLinuxThread.UnitCache: the broker's side, for hosts.)
(function (G) {
'use strict';

function readMemoryTrace(mem, tb, cfg) {
  if (!cfg.memoryTraceAddr) return null;
  const at = tb + cfg.memoryTraceAddr, bytes = mem.buffer.byteLength;
  if (at < 0 || at + 48 > bytes) return null;
  const dv = new DataView(mem.buffer), hex = (value) => '0x' + value.toString(16);
  const rip = dv.getBigUint64(at + 8, true), op = dv.getBigUint64(at + 16, true);
  const pc = Number(rip), code = Number.isSafeInteger(pc) && pc >= 0 && pc < bytes
    ? new Uint8Array(mem.buffer, pc, Math.min(16, bytes - pc)) : [];
  const result = { guestAddress:hex(dv.getBigUint64(at, true)), rip:hex(rip),
    operation:Number(op >> 32n), width:Number(op & 0xffffffffn),
    fsBase:hex(dv.getBigUint64(at + 24, true)), gsBase:hex(dv.getBigUint64(at + 32, true)),
    wasmAddress:hex(dv.getBigUint64(at + 40, true)), memoryBytes:bytes,
    instructionHex:[...code].map(b=>b.toString(16).padStart(2,'0')).join('') };
  let length = BigInt(result.width);
  if (cfg.memoryTraceVersion >= 2 && at + 80 <= bytes) {
    const count = dv.getBigUint64(at + 48, true), kind = Number(dv.getBigUint64(at + 72, true));
    Object.assign(result, {accessKind:['scalar','fill','copy','cacheline-zero','context-clear'][kind] || 'unknown',
      byteLength:hex(count), wasmByteLength:hex(kind ? count & 0xffffffffn : count)});
    length = BigInt(result.wasmByteLength);
    if (kind === 2) Object.assign(result, {sourceGuestAddress:hex(dv.getBigUint64(at + 56, true)),
      sourceWasmAddress:hex(dv.getBigUint64(at + 64, true))});
  }
  const outside = address => BigInt(address) + length > BigInt(bytes);
  result.outOfBoundsOperands = [];
  if (outside(result.wasmAddress)) result.outOfBoundsOperands.push('address');
  if (result.sourceWasmAddress && outside(result.sourceWasmAddress)) result.outOfBoundsOperands.push('source');
  result.boundsConfirmed = result.outOfBoundsOperands.length > 0;
  const gs = dv.getBigUint64(at + 32, true);
  if (gs && gs + 24n <= BigInt(bytes)) {
    result.gsBaseWords = [0,8,16].map(off => hex(dv.getBigUint64(Number(gs) + off, true)));
  }
  return result;
}

function runThread(env) {
  const { pid, tid, tb, mem, space, slot, ksab, cfg, dispatcher, xlat, bootEpoch } = env.data;
    const post = env.post;
  const SLOT_BASE = 256, SLOT_SIZE = 128;
  const S_IDLE = 0, S_REQ = 1, S_DONE = 2, F_REDIRECT = 1, F_EXIT = 2;
  const NR_FAULT = 0x10000, NR_SIGCHECK = 0x10002;
  const W_SIGPEND = 20, W_FUTEX = 21; // slot words: a signal waits for us; the address we futex-wait on
  const W_UNCODE = 27, W_UNCODE_LO = 28, W_UNCODE_HI = 29; // (kernel.js codeGone: code we may have translated went away)
  let dropRange = null; // (what to drop once the thread is back in its loop)
  let flushAll = false; // (a new code epoch: all of it)
  const codeEpoch = env.data.codeEpoch ? new Int32Array(env.data.codeEpoch) : null;
  const STOP = 2; // a RIP the guest never reaches: the dispatcher runs until a miss
  const BREAK_RIP = 4;

  const k32 = new Int32Array(ksab), k64 = new BigInt64Array(ksab);
  const s32 = (SLOT_BASE + slot * SLOT_SIZE) >> 2, s64 = s32 >> 1;
  const EXIT = { exit: true }, REDIRECT = { redirect: true };
  const stats = { kcalls: 0, local: 0, kwaitMs: 0, aliveMs: 0 };
  const bornAt = performance.now();

  const kspin = env.data.kspinMs || 0;
  function kcall(nr, a0, a1, a2, a3, a4, a5) {
    stats.kcalls++;
    const w0 = performance.now();
    k64[s64 + 1] = BigInt(nr);
    k64[s64 + 2] = a0 || 0n;
    k64[s64 + 3] = a1 || 0n;
    k64[s64 + 4] = a2 || 0n;
    k64[s64 + 5] = a3 || 0n;
    k64[s64 + 6] = a4 || 0n;
    k64[s64 + 7] = a5 || 0n;
    Atomics.store(k32, s32, S_REQ);
    Atomics.add(k32, 0, 1);
    Atomics.notify(k32, 0);
    // (a while watching for the reply, most of which come in microseconds
    // from a kernel that is awake, before sleeping: see kernel.js spinMs)
    if (kspin) {
      const until = w0 + kspin;
      while (Atomics.load(k32, s32) !== S_DONE && performance.now() < until);
    }
    for (;;) {
      const v = Atomics.load(k32, s32);
      if (v === S_DONE) break;
      Atomics.wait(k32, s32, v);
    }
    const flags = k32[s32 + 1], r = k64[s64 + 8];
    Atomics.store(k32, s32, S_IDLE);

    const waited = performance.now() - w0;
    stats.kwaitMs += waited;
    if (prof) { const e = prof.k.get(nr) || [0, 0]; e[0]++; e[1] += waited; prof.k.set(nr, e); }
    // (slowWait=MS: syscalls that took longer, to find stalls)
    if (env.data.slowWait && waited > env.data.slowWait) post({ op: 'log', m: `[tid ${tid}] syscall ${nr} (${a0}, ${a1}, ${a2}, ${a3}) took ${waited.toFixed(0)} ms -> ${r}` });
    if (flags & F_EXIT) throw EXIT;
    if (flags & F_REDIRECT) throw REDIRECT;
    return r;
  }

  // Clocks as the kernel sees them: realtime from the epoch, monotonic from boot.
  const absNow = () => performance.timeOrigin + performance.now();
  function clockMs(clk) {
    if (clk === 0 || clk === 5 || clk === 8) return absNow();
    return absNow() - bootEpoch;
  }
  function writeTimespec(p, ms) {
    const dv = new DataView(mem.buffer), s = Math.floor(ms / 1000);
    dv.setBigInt64(p, BigInt(s), true);
    dv.setBigInt64(p + 8, BigInt(Math.floor((ms - s * 1000) * 1e6)), true);
  }
  const lo = (b) => Number(b & 0xffffffffn);
  const s32v = (b) => Number(BigInt.asIntN(32, b));

  function futex(a0, a1, a2, a3, a4, a5) {
    const uaddr = lo(a0), opf = Number(a1 & 0xffffffffn), op = opf & 0x7f, val = s32v(a2);
    if (uaddr & 3) return -22n;
    const m = new Int32Array(mem.buffer), idx = uaddr >>> 2;
    switch (op) {
      case 0: case 9: { // WAIT, WAIT_BITSET
        let ms = Infinity;
        const tp = lo(a3);
        if (tp) {
          const dv = new DataView(mem.buffer);
          ms = Number(dv.getBigInt64(tp, true)) * 1000 + Number(dv.getBigInt64(tp + 8, true)) / 1e6;
          if (op === 9) ms -= clockMs(opf & 256 ? 0 : 1); // absolute
          if (ms < 0) return -110n;
        }
        // the kernel wakes us (a notify on this address) when a signal comes
        Atomics.store(k32, s32 + W_FUTEX, uaddr);
        if (Atomics.load(k32, s32 + W_SIGPEND)) {
          Atomics.store(k32, s32 + W_FUTEX, 0);
          return kcall(NR_SIGCHECK, -4n);
        }
        const fw0 = env.data.slowWait || prof ? performance.now() : 0;
        const r = Atomics.wait(m, idx, val, ms);
        Atomics.store(k32, s32 + W_FUTEX, 0);
        if (prof) { prof.fw++; prof.fwMs += performance.now() - fw0; }
        if (env.data.slowWait && performance.now() - fw0 > env.data.slowWait)
          post({ op: 'log', m: `[tid ${tid}] futex wait ${uaddr.toString(16)} (timeout ${ms}) took ${(performance.now() - fw0).toFixed(0)} ms: ${r}` });
        const res = r === 'not-equal' ? -11n : r === 'timed-out' ? -110n : 0n;
        if (Atomics.load(k32, s32 + W_SIGPEND)) return kcall(NR_SIGCHECK, res === 0n ? -4n : res);
        return res;
      }
      case 1: case 10: // WAKE, WAKE_BITSET
        if (prof) prof.fwake++;
        return BigInt(Atomics.notify(m, idx, val < 0 ? Infinity : val));
      case 3: case 4: { // REQUEUE, CMP_REQUEUE: everyone wakes (waiters recheck)
        if (op === 4 && Atomics.load(m, idx) !== s32v(a5)) return -11n;
        return BigInt(Atomics.notify(m, idx));
      }
      case 5: { // WAKE_OP
        const uaddr2 = lo(a4), idx2 = uaddr2 >>> 2, v3 = s32v(a5);
        const opx = (v3 >>> 28) & 7, cmp = (v3 >>> 24) & 15;
        let oparg = (v3 << 8) >> 20, cmparg = (v3 << 20) >> 20;
        if (v3 & (8 << 28)) oparg = 1 << oparg;
        let old;
        for (;;) {
          old = Atomics.load(m, idx2);
          const nv = opx === 0 ? oparg : opx === 1 ? old + oparg : opx === 2 ? old | oparg : opx === 3 ? old & ~oparg : old ^ oparg;
          if (Atomics.compareExchange(m, idx2, old, nv) === old) break;
        }
        let n = Atomics.notify(m, idx, val);
        const c = cmp === 0 ? old === cmparg : cmp === 1 ? old !== cmparg : cmp === 2 ? old < cmparg : cmp === 3 ? old <= cmparg : cmp === 4 ? old > cmparg : old >= cmparg;
        if (c) n += Atomics.notify(m, idx2, lo(a3));
        return BigInt(n);
      }
      default:
        return -38n;
    }
  }

  // Channels to the app through the page's channel workers (web/chan_web.js),
  // one request at a time each; their mailboxes come with the spawn.
  // where 0: request and response in guest memory; 1: in the mailbox's data
  // buffer, which fill() writes and take(result) reads while the mailbox is ours.
  function chanCall(mb, req, len, resp, cap, where, take, fill) {
    while (Atomics.compareExchange(mb, 0, 0, 1) !== 0) Atomics.wait(mb, 0, 1, 1);
    if (fill) fill();
    mb[2] = req; mb[3] = len; mb[4] = resp; mb[5] = cap; mb[7] = where;
    Atomics.store(mb, 1, 1);
    Atomics.notify(mb, 1);
    // (spin while the answer is microseconds away; then sleep)
    for (let t0 = 0, n = 0; Atomics.load(mb, 1) !== 2; n++) {
      if ((n & 255) === 255) {
        const t = performance.now();
        if (!t0) t0 = t;
        else if (t - t0 > 1) Atomics.wait(mb, 1, 1, 1);
      }
    }
    const r = mb[6], out = take ? take(r) : r;
    Atomics.store(mb, 1, 0);
    Atomics.store(mb, 0, 0);
    Atomics.notify(mb, 0, 1);
    return out;
  }
  // gpu(request, length, response, capacity) -> the response's length or
  // -errno (DXMT's native half, in the app): through this thread's own GPU
  // channel (env.gpuOpen), opened on the first call, which then runs again
  let gpu = null, gpuOpening = null, gpuStatsAt = 0;
  const profState = cfg.profAddr ? (tb + cfg.profAddr + 4) >> 2 : 0; // (the sampler's: 2 in a GPU call)
  function gpuCall(req, len, resp, cap) {
    if (gpu) {
      if (profState) new Uint32Array(mem.buffer)[profState] = 2;
      const r = BigInt(gpu.call(new Uint8Array(mem.buffer), lo(req), lo(len), lo(resp), lo(cap)));
      if (profState) new Uint32Array(mem.buffer)[profState] = 0;
      // (gpuStats=1: every 2 s, how long this thread's calls took, and waited for the app)
      const s = gpu.stats, t = performance.now();
      if (env.data.gpuStats && s && t - gpuStatsAt > 2000) {
        if (s.n) post({ op: 'log', m: `[tid ${tid}] gpu: ${s.n} calls, ${(1000 * s.ms / s.n).toFixed(1)} us each (${(1000 * s.waitMs / s.n).toFixed(1)} waiting for the app)` });
        s.n = s.ms = s.waitMs = 0;
        gpuStatsAt = t;
      }
      return r;
    }
    if (!env.gpuOpen) return -38n;
    gpuOpening = env.gpuOpen(tid, env.data.xlat, env.data.gpuKind).then((c) => { gpu = c; }, (err) => {
      post({ op: 'log', m: `[tid ${tid}] no GPU channel: ${err && err.message}` });
      gpu = { call: () => -38 };
    });
    const dv = new DataView(mem.buffer), c = tb + cfg.ctx, g = c + cfg.gregsOff;
    dv.setBigUint64(c + cfg.ripOff, dv.getBigUint64(g + 8, true) - 2n, true); // (RCX - 2: the syscall again)
    dv.setBigUint64(g, 0x46574420n, true);
    throw REDIRECT;
  }
  // a unit's bytes from the translator (the response to /xlat/unit), or null
  const xlatMb = env.data.xlatMailbox ? new Int32Array(env.data.xlatMailbox) : null;
  const xlatData = xlatMb ? new Uint8Array(env.data.xlatData) : null;
  const xlatDv = xlatMb ? new DataView(env.data.xlatData) : null;
  // op 6: code written in place, at addr (bytes: at most the data buffer's)
  function xlatPatch(addr, bytes) {
    return chanCall(xlatMb, 0, 32 + bytes.length, 4096, 0, 1, null, () => {
      xlatDv.setUint32(0, 6, true);
      xlatDv.setUint32(4, space, true);
      xlatDv.setBigUint64(8, BigInt(addr), true);
      xlatDv.setBigUint64(16, 0n, true);
      xlatDv.setBigUint64(24, 0n, true);
      xlatData.set(bytes, 32);
    });
  }
  // Pages mapped writable and executable (kernel.js Mm.wx) may have new code
  // with no syscall to say so (a packer's, a JIT's): before a unit there, the
  // translator's copy of its page (and the next, which it may run into) is
  // brought up to date if it changed since this thread last looked, and this
  // thread's own translations from it go.
  const wx = env.data.wx ? new Uint8Array(env.data.wx) : null;
  const wxSeen = new Map(); // page -> its checksum when last sent
  if (env.data.traceCode) post({ op: 'log', m: `[tid ${tid}] wx bitmap: ${wx ? 'yes' : 'no'}` });
  async function refreshCode(rip) {
    for (let page = rip >>> 12, last = page + 1; page <= last; page++) {
      if (!(wx[page >>> 3] & (1 << (page & 7)))) continue;
      const w = new Int32Array(mem.buffer, page * 4096, 1024);
      let h = 0x811c9dc5;
      for (let i = 0; i < 1024; i++) h = Math.imul(h ^ w[i], 0x01000193);
      const was = wxSeen.get(page);
      if (was === h) continue;
      wxSeen.set(page, h);
      const bytes = new Uint8Array(mem.buffer, page * 4096, 4096).slice();
      if (xlatMb && Atomics.load(xlatMb, 15) === 1) xlatPatch(page * 4096, bytes);
      else await fetch(`${xlat}/xlat/patch?space=${space}&addr=${(page * 4096).toString(16)}`, { method: 'POST', body: bytes });
      if (was !== undefined) rt.dropCode(page * 4096, page * 4096 + 4096);
      if (env.data.traceCode) post({ op: 'log', m: `[tid ${tid}] code at ${(page * 4096).toString(16)} ${was === undefined ? 'sent' : 'changed'} (unit ${rip.toString(16)})` });
      stats.patches = (stats.patches || 0) + 1;
    }
  }

  function xlatUnit(rip) {
    return chanCall(xlatMb, 0, 32, 4096, xlatData.length - 4096, 1,
      (r) => (r > 0 ? xlatData.slice(4096, 4096 + r) : null),
      () => { // (op 1: a unit; a: its RIP)
        xlatDv.setUint32(0, 1, true);
        xlatDv.setUint32(4, space, true);
        xlatDv.setBigUint64(8, BigInt(rip), true);
        xlatDv.setBigUint64(16, 0n, true);
        xlatDv.setBigUint64(24, 0n, true);
      });
  }

  // (threadStats=1) every 2 s, where this thread's time went: syscalls to the
  // kernel by number, futex waits, GPU calls, units; the rest is its own code
  const prof = env.data.threadStats ? { at: performance.now(), k: new Map(), req: new Map(), sel: new Map(), local: 0, fw: 0, fwMs: 0, fwake: 0, gpu0: 0, gpuMs0: 0, unit0: 0, unitMs0: 0 } : null;
  function profReport() {
    const t = performance.now(), span = t - prof.at;
    if (span < 2000) return;
    let kn = 0, kms = 0;
    for (const [, [n, ms]] of prof.k) { kn += n; kms += ms; }
    const gs = gpu && gpu.stats ? gpu.stats : null;
    const gpuN = gs ? gs.n - prof.gpu0 : 0, gpuMs = gs ? gs.ms - prof.gpuMs0 : 0;
    const uN = tstats.units - prof.unit0, uMs = tstats.fetchMs - prof.unitMs0;
    const busy = span - kms - prof.fwMs - gpuMs - uMs;
    if (kn + prof.local + prof.fw + gpuN + uN > 10) {
      const top = [...prof.k].sort((a, b) => b[1][1] - a[1][1]).slice(0, 5).map(([nr, [n, ms]]) => `${nr}:${n}/${ms.toFixed(0)}ms`).join(' ');
      post({ op: 'log', m: `[tid ${tid}] ${(span / 1000).toFixed(1)} s: own code ${(100 * busy / span).toFixed(0)}%, kernel ${kn} calls ${kms.toFixed(0)} ms (${top}), syscalls ${prof.local}, ` +
        `futex ${prof.fw} waits ${prof.fwMs.toFixed(0)} ms ${prof.fwake} wakes, gpu ${gpuN} calls ${gpuMs.toFixed(0)} ms, units ${uN} ${uMs.toFixed(0)} ms` +
        (prof.req.size ? `; server requests ${[...prof.req].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([c, n]) => `${c}x${n}`).join(' ')}` : '') +
        (prof.sel.size ? `; selects ${[...prof.sel].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([c, n]) => `${c} x${n}`).join(', ')}` : '') });
      prof.req.clear();
      prof.sel.clear();
    }
    prof.at = t; prof.k.clear(); prof.local = prof.fw = prof.fwMs = prof.fwake = 0;
    if (gs) { prof.gpu0 = gs.n; prof.gpuMs0 = gs.ms; }
    prof.unit0 = tstats.units; prof.unitMs0 = tstats.fetchMs;
  }

  function syscall(n, a0, a1, a2, a3, a4, a5) {
    if (prof) {
      prof.local++;
      // (a write of a Wine server request: its code, the first int of 64 bytes)
      if (n === 1n && a2 >= 64n) { const code = new DataView(mem.buffer).getInt32(lo(a1), true); prof.req.set(code, (prof.req.get(code) || 0) + 1); }
      // (writev, as Wine's send_request does: the header is iov[0]'s first 64 bytes)
      if (n === 20n && a2 >= 1n) {
        const dv = new DataView(mem.buffer), base = Number(dv.getBigUint64(lo(a1), true) & 0xffffffffn), size = Number(dv.getBigUint64(lo(a1) + 8, true));
        if (size >= 64) {
          const code = dv.getInt32(base, true);
          prof.req.set(code, (prof.req.get(code) || 0) + 1);
          if (code === 29 && a2 >= 2n) { // (select: what it waits for; its op is the last piece)
            const iv = lo(a1) + 16 * (Number(a2) - 1), p = Number(dv.getBigUint64(iv, true) & 0xffffffffn), n = Number(dv.getBigUint64(iv + 8, true));
            const t = dv.getBigInt64(base + 24, true), op = n >= 4 ? dv.getUint32(p, true) : -1;
            const hs = []; for (let o = 4; o + 4 <= n && hs.length < 4; o += 4) hs.push(dv.getUint32(p + o, true).toString(16));
            const k = `op${op} f${dv.getInt32(base + 12, true)} t${t === 0n ? '0' : t === 0x7fffffffffffffffn ? 'inf' : t < 0n ? 'rel' + Number(-t / 10n) + 'us' : 'abs'} h[${hs.join(',')}]`;
            prof.sel.set(k, (prof.sel.get(k) || 0) + 1);
          }
        }
      }
      profReport();
    }
    // (debugging) the last syscall number and first argument, and how many, in the slot
    k32[s32 + 22] = Number(n);
    k32[s32 + 23]++;
    k32[s32 + 24] = Number(a1 & 0xffffffffn);
    k32[s32 + 25] = Number(a0 & 0xffffffffn);
    // the kernel waits for us (a signal, or the system freezing): even the
    // syscalls done here go to it then (futex has its own check)
    if (n !== 202n && Atomics.load(k32, s32 + W_SIGPEND)) return kcall(n, a0, a1, a2, a3, a4, a5);
    switch (Number(n)) {
      case 202: stats.local++; return futex(a0, a1, a2, a3, a4, a5);
      case 228: stats.local++; writeTimespec(lo(a1), clockMs(s32v(a0))); return 0n; // clock_gettime
      case 96: { // gettimeofday
        stats.local++;
        if (lo(a0)) {
          const ms = absNow(), dv = new DataView(mem.buffer), s = Math.floor(ms / 1000);
          dv.setBigInt64(lo(a0), BigInt(s), true);
          dv.setBigInt64(lo(a0) + 8, BigInt(Math.floor((ms - s * 1000) * 1000)), true);
        }
        return 0n;
      }
      case 24: stats.local++; return 0n; // sched_yield
      case 0x46574420: return gpuCall(a0, a1, a2, a3); // (the GPU channel: see web/gpu_web.js)
      case 186: return BigInt(tid);
      case 98: { // getrusage: this thread's time alive as its user time (games ask each frame; the kernel's answer is no better)
        if (!lo(a1)) return -14n;
        stats.local++;
        const us = Math.round((performance.now() - bornAt) * 1000), dv = new DataView(mem.buffer), p = lo(a1);
        for (let o = 0; o < 144; o += 8) dv.setBigUint64(p + o, 0n, true);
        dv.setBigUint64(p, BigInt(Math.floor(us / 1e6)), true);
        dv.setBigUint64(p + 8, BigInt(us % 1e6), true);
        return 0n;
      }
      default: {
        const r = kcall(n, a0, a1, a2, a3, a4, a5);
        // a new code epoch (UnitCache): the syscall ends here as below, and
        // the thread drops all its units before it goes on
        if (codeEpoch && Atomics.load(codeEpoch, 0) !== rt.epochSeen()) {
          flushAll = true;
          const dv = new DataView(mem.buffer), c = tb + cfg.ctx, g = c + cfg.gregsOff;
          dv.setBigUint64(g, BigInt.asUintN(64, r), true);
          dv.setBigUint64(c + cfg.ripOff, dv.getBigUint64(g + 8, true), true); // (rcx: after the syscall)
          throw REDIRECT;
        }
        // code went away (kernel.js codeGone): the syscall ends here (its
        // result in rax, on from its return address), and its translations
        // go before the thread goes on (units are on the stack now)
        if (Atomics.load(k32, s32 + W_UNCODE)) {
          // (the flag first: the kernel starts a new range if it adds one after)
          Atomics.store(k32, s32 + W_UNCODE, 0);
          const lo = k32[s32 + W_UNCODE_LO] >>> 0, hi = k32[s32 + W_UNCODE_HI] >>> 0;
          // none of ours there, the usual case (a DLL being loaded): nothing to do
          if (!rt.hasCode(lo, hi)) return r;
          dropRange = dropRange ? [Math.min(dropRange[0], lo), Math.max(dropRange[1], hi)] : [lo, hi];
          const dv = new DataView(mem.buffer), c = tb + cfg.ctx, g = c + cfg.gregsOff;
          dv.setBigUint64(g, BigInt.asUintN(64, r), true);
          dv.setBigUint64(c + cfg.ripOff, dv.getBigUint64(g + 8, true), true); // (rcx: after the syscall)
          throw REDIRECT;
        }
        return r;
      }
    }
  }

  // Translation over HTTP (the app serves the same routes on the device).
  const tstats = { units: 0, regions: 0, fetchMs: 0, compileMs: 0, bytes: 0 };
  // FEXWASM_DUMP_TRAPS=dir: keep module bytes, and write out the units on a trapping stack.
  const dumpDir = env.dumpDir;
  const kept = new Map();
  // env.unitBroker(space, rip): the host fetches and compiles units, once
  // for all its workers ({module, slot, bytes} or null): workers that each
  // compiled the same code took 5x the memory (iPhone, 16 workers).
  async function unit(rip) {
    const t0 = performance.now();
    if (wx) await refreshCode(rip);
    if (xlatMb && Atomics.load(xlatMb, 15) === 1 && env.moduleFor && !dumpDir) { // (HTTP until the app has the channel)
      // the bytes through the channel, the module from the page (compiled once for every worker)
      const u = parseUnit(xlatUnit(rip) || new Uint8Array(0));
      if (!u) { tstats.fetchMs += performance.now() - t0; return null; }
      const code = u.code.slice();
      const t1 = performance.now();
      const module = await env.moduleFor(u.key, code);
      const t2 = performance.now();
      tstats.fetchMs += t2 - t0;
      // (slowWait=MS: units that took longer, to find stalls)
      if (env.data.slowWait && t2 - t0 > env.data.slowWait)
        post({ op: 'log', m: `[tid ${tid}] unit ${rip.toString(16)} took ${(t2 - t0).toFixed(0)} ms (translator ${(t1 - t0).toFixed(0)}, module ${(t2 - t1).toFixed(0)}; ${code.length} bytes)` });
      tstats.units++;
      tstats.bytes += code.length;
      return { module, bytes: code.length, slot: u.slot, reloc: u.reloc };
    }
    if (env.unitBroker && !dumpDir) {
      const r = await env.unitBroker(space, rip);
      tstats.fetchMs += performance.now() - t0;
      if (!r) return null;
      tstats.units++;
      tstats.bytes += r.bytes;
      return r;
    }
    const r = await fetch(`${xlat}/xlat/unit?space=${space}&rip=${rip}`, {signal:requests.signal});
    const u = parseUnit(new Uint8Array(await r.arrayBuffer()));
    checkOpen();
    tstats.fetchMs += performance.now() - t0;
    if (!u) return null;
    const t1 = performance.now();
    const module = new WebAssembly.Module(u.code);
    if (dumpDir) kept.set('u' + rip.toString(16), u.code.slice());
    tstats.compileMs += performance.now() - t1;
    tstats.units++;
    tstats.bytes += u.code.length;
    return { module, bytes: u.code.length, slot: u.slot, reloc: u.reloc };
  }
  async function region(rips, profile) {
    const words = [rips.length, ...rips];
    words.push(rips.length);
    for (const r of rips) {
      const s = profile.successors(r);
      words.push(r, s.length, ...s);
    }
    const sites = profile.callSites();
    words.push(sites.length);
    for (const [ret, t] of sites) words.push(ret, t.length, ...t);
    const t0 = performance.now();
    const r = await fetch(`${xlat}/xlat/region?space=${space}`, { method: 'POST', body: new Uint32Array(words) });
    const b = new Uint8Array(await r.arrayBuffer());
    tstats.fetchMs += performance.now() - t0;
    if (!b.length) return null;
    tstats.regions++;
    tstats.bytes += b.length;
    if (dumpDir) kept.set('r' + rips[0].toString(16), b.slice());
    return { module: new WebAssembly.Module(b), bytes: b.length };
  }

  const rt = FexRuntime.createRuntime({
    mem,
    epoch: codeEpoch,
    now: () => performance.now(),
    dispatcher: new WebAssembly.Module(dispatcher),
    translateAsync: unit,
    translateRegionAsync: env.data.noRegions ? null : region, // (noRegions: units only, for measuring)
    regionAfterMs: env.data.regionAfterMs,
    syscall,
    threadBase: tb,
    hotAddr: cfg.hotAddr, hotThreshold: cfg.hotThreshold, missAddr: cfg.missAddr,
    dispatchBase: cfg.dispatchBase, dispatchBits: cfg.dispatchBits,
    slotTagBase: cfg.slotTagBase, slotTagCount: cfg.slotTagCount,
    unitCounterBase: cfg.unitCounterBase, unitCounterBits: cfg.unitCounterBits,
    callSiteBase: cfg.callSiteBase, callSiteBits: cfg.callSiteBits,
  });


  async function main() {
    if (env.threadMap) post({ op: 'log', m: `[threadmap] tid ${tid} pid ${pid} node ${env.threadMap}` });
    const ctx = tb + cfg.ctx;
    const ripOf = () => Number(new DataView(mem.buffer).getBigUint64(ctx + cfg.ripOff, true) & 0xffffffffn);
    for (;;) {
      try {
        await rt.runAsync(ripOf(), STOP);
        throw new Error('reached the stop address');
      } catch (e) {
        if (e === REDIRECT) {
          stats.redirects = (stats.redirects || 0) + 1;
          if (dropRange) stats.redirectDrops = (stats.redirectDrops || 0) + 1;
          if (gpuOpening) { await gpuOpening; gpuOpening = null; }
          if (flushAll) {
            flushAll = false;
            rt.newEpoch();
          }
          if (dropRange) {
            const [lo, hi] = dropRange;
            dropRange = null;
            if (env.data.traceCode) post({ op: 'log', m: `[tid ${tid}] dropping its code at ${lo.toString(16)}-${hi.toString(16)}` });
            rt.dropCode(lo, hi);
          }
          continue;
        }
        if (e === EXIT) break;
        let sig = 11, rip = 0, code = 0;
        const m = /translation failed at 0x([0-9a-f]+)/.exec((e && e.message) || '');
        if (m) {
          rip = parseInt(m[1], 16);
          if (rip === BREAK_RIP) {
            const dv = new DataView(mem.buffer);
            sig = dv.getUint8(tb + cfg.faultAddr) || 5;
            code = dv.getUint8(tb + cfg.faultAddr + 1);
          }
        } else {
          const memoryTrace = e && e.name === 'RuntimeError' && /(?:out of bounds|bounds access)/i.test(e.message || '')
            ? readMemoryTrace(mem, tb, cfg) : null;
          if (memoryTrace) {
            if (memoryTrace.boundsConfirmed) rip = Number(BigInt(memoryTrace.rip));
            post({ op:'memoryFault', tid, pid, space, fault:{...memoryTrace, stack:String(e.stack || e)} });
            post({ op:'log', m:'[memory-fault] ' + JSON.stringify(memoryTrace) });
          }
          const frames = e && e.stack ? e.stack.split('\n') : [];
          post({ op: 'log', m: `[tid ${tid}] ${e && e.name}: ${e && e.message} (memory ${mem.buffer.byteLength.toString(16)}; ${frames.length} frames)\n  ${frames.slice(0, 6).join('\n  ')}` });
          // (the guest code of the unit it was in, as it is now)
          const um = /\b[ur]([0-9a-f]+)[@ ]/.exec((e && e.stack) || '');
          if (um) {
            const at = parseInt(um[1], 16), b = new Uint8Array(mem.buffer, at, Math.min(48, mem.buffer.byteLength - at));
            post({ op: 'log', m: `[tid ${tid}] code at ${at.toString(16)}: ${[...b].map((x) => x.toString(16).padStart(2, '0')).join('')}` });
          }
          code = -1;
          if (dumpDir && e && e.stack) {
            for (const m2 of e.stack.matchAll(/at ([ur][0-9a-f]+) /g)) {
              const b = kept.get(m2[1]);
              if (b && env.dump) env.dump(`${pid}-${tid}-${m2[1]}.wasm`, b);
            }
          }
        }
        try {
          kcall(NR_FAULT, BigInt(sig), BigInt(rip), BigInt(code));
        } catch (e2) {
          if (e2 !== EXIT) throw e2;
        }
        break;
      }
    }
    stats.aliveMs = performance.now() - bornAt;
    stats.deepExits = new DataView(mem.buffer).getUint32(tb + 0x6C, true); // (FEXWASM_COUNTDEEP)
    post({ op: 'threadStats', tid, pid, stats, tstats, rt: rt.stats });
  }
  return main();

}

// A unit from the translator (linux mode): u32 slot, u64 module hash, i64
// displacement, u32 n, n u32 inline cache slots, the module.
function parseUnit(b) {
  if (b.length < 24) return null;
  const dv = new DataView(b.buffer, b.byteOffset, b.length);
  const n = dv.getUint32(20, true), head = 24 + 4 * n;
  if (b.length < head) return null;
  const s = [];
  for (let i = 0; i < n; i++) s.push(dv.getUint32(24 + 4 * i, true));
  return { slot: dv.getUint32(0, true), key: dv.getUint32(4, true) + ':' + dv.getUint32(8, true), code: b.subarray(head),
    reloc: { d: dv.getBigInt64(12, true), s } };
}

// The host side of unitBroker: fetches units from the translator and
// compiles each distinct module (by the hash the translator sends) once.
// Code epochs (epochBytes): compiled code is most of WebContent's memory
// (JSC keeps ~6x a module's wasm size, and every thread's instance of it),
// and most of it runs once (Wine starting up); after epochBytes of wasm
// compiled, the cache forgets its modules and epoch[0] goes up, so each
// thread drops all its units at its next safe point (thread_core's
// syscalls, runtime.js misses) and JSC can free what nobody uses again.
function UnitCache(xlat, fetchImpl, epochBytes = 0) {
  const mods = new Map(); // module hash -> Promise<WebAssembly.Module>
  const stats = { requests: 0, compiled: 0, compiledBytes: 0, fetchMs: 0, compileMs: 0, epochs: 0 };
  const epoch = new Int32Array(new SharedArrayBuffer(4));
  let bytesThisEpoch = 0, closed = false;
  const requests = new AbortController();
  const checkOpen = () => { if (closed) throw new Error('Unit cache is closed'); };
  function close() { closed = true; requests.abort(); mods.clear(); }
  function compiled(n) {
    stats.compiled++;
    stats.compiledBytes += n;
    bytesThisEpoch += n;
    if (epochBytes && bytesThisEpoch > epochBytes) {
      bytesThisEpoch = 0;
      mods.clear();
      stats.epochs++;
      Atomics.add(epoch, 0, 1);
    }
  }
  async function get(space, rip, retainCode = false) {
    checkOpen();
    stats.requests++;
    const t0 = performance.now();
    const r = await (fetchImpl || fetch)(`${xlat}/xlat/unit?space=${space}&rip=${rip}`, {signal:requests.signal});
    const u = parseUnit(new Uint8Array(await r.arrayBuffer()));
    checkOpen();
    const t1 = performance.now();
    stats.fetchMs += t1 - t0;
    if (!u) return null;
    let p = mods.get(u.key);
    if (!p) {
      p = WebAssembly.compile(u.code);
      mods.set(u.key, p);
      compiled(u.code.length);
    }
    const module = await p;
    checkOpen();
    stats.compileMs += performance.now() - t1;
    return { module, slot: u.slot, bytes: u.code.length, reloc: u.reloc, code:retainCode ? u.code.slice() : undefined };
  }
  // the module for bytes the caller has (by their hash)
  function module(key, code) {
    checkOpen();
    let p = mods.get(key);
    if (!p) {
      p = WebAssembly.compile(code);
      mods.set(key, p);
      compiled(code.length);
    }
    stats.requests++;
    return p;
  }
  return { get, module, stats, epoch, close };
}
G.FexLinuxThread = { UnitCache, runThread, readMemoryTrace };
})(typeof globalThis !== 'undefined' ? globalThis : self);
