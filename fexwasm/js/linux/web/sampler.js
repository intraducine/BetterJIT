// Sampling profiler (the page's sample=1; the translator's profrip=1): about
// 2000 times a second, what each guest thread is doing: in the kernel, in a
// futex wait, in a GPU call, or running the unit whose entry RIP it last
// stored (BackendConfig::ProfAddr). Every 10 s the busiest threads' top
// RIPs go to the log.
'use strict';
const SLOT_BASE = 256, SLOT_SIZE = 128, W_FUTEX = 21;
let mem = null, k32 = null, profAddr = 0, u32 = null;
const threads = new Map(); // tid -> { tb, s32, n, kern, futex, gpu, rips }
onmessage = (e) => {
  const d = e.data;
  if (d.op === 'init') { mem = d.mem; k32 = new Int32Array(d.ksab); profAddr = d.profAddr; loop(); }
  else if (d.op === 'add') threads.set(d.tid, { tb: d.tb, s32: (SLOT_BASE + d.slot * SLOT_SIZE) >> 2, n: 0, kern: 0, futex: 0, gpu: 0, rips: new Map() });
  else if (d.op === 'remove') threads.delete(d.tid);
};
const nap = new Int32Array(new SharedArrayBuffer(4));
async function loop() {
  let reportAt = performance.now() + 10000;
  for (;;) {
    const until = performance.now() + 50;
    while (performance.now() < until) {
      if (!u32 || u32.buffer !== mem.buffer) u32 = new Uint32Array(mem.buffer);
      for (const [, t] of threads) {
        t.n++;
        if (Atomics.load(k32, t.s32) !== 0) t.kern++;
        else if (Atomics.load(k32, t.s32 + W_FUTEX) !== 0) t.futex++;
        else if (u32[(t.tb + profAddr + 4) >> 2] === 2) t.gpu++;
        else {
          const rip = u32[(t.tb + profAddr) >> 2];
          t.rips.set(rip, (t.rips.get(rip) || 0) + 1);
        }
      }
      Atomics.wait(nap, 0, 0, 0.5);
    }
    await new Promise((r) => setTimeout(r, 0)); // (messages)
    if (performance.now() >= reportAt) {
      reportAt = performance.now() + 10000;
      const busy = [...threads].map(([tid, t]) => [tid, t, t.n - t.kern - t.futex - t.gpu]).filter((x) => x[1].n).sort((a, b) => b[2] - a[2]).slice(0, 3);
      for (const [tid, t, run] of busy) {
        const top = [...t.rips].sort((a, b) => b[1] - a[1]).slice(0, 40).map(([r, c]) => `${r.toString(16)}:${(100 * c / t.n).toFixed(1)}`).join(' ');
        // (and by 64 KB of address space: modules, once mapped offline)
        const pages = new Map();
        for (const [r, c] of t.rips) pages.set(r >>> 16, (pages.get(r >>> 16) || 0) + c);
        const byPage = [...pages].sort((a, b) => b[1] - a[1]).slice(0, 80).map(([p, c]) => `${(p << 16 >>> 0).toString(16)}:${(100 * c / t.n).toFixed(1)}`).join(' ');
        postMessage({ op: 'log', m: `[sample] tid ${tid} by 64 KB: ${byPage}` });
        postMessage({ op: 'log', m: `[sample] tid ${tid}: ${t.n} samples, running ${(100 * run / t.n).toFixed(0)}%, kernel ${(100 * t.kern / t.n).toFixed(0)}%, futex ${(100 * t.futex / t.n).toFixed(0)}%, gpu ${(100 * t.gpu / t.n).toFixed(0)}%; top (% of samples) ${top}` });
      }
      for (const [, t] of threads) { t.n = t.kern = t.futex = t.gpu = 0; t.rips.clear(); }
    }
  }
}
