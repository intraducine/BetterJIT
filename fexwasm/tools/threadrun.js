// Runs a fexrun --dump package with real guest threads on Node worker_threads
// (js/fexthreads.js). The dump must be built for threads: FEXWASM_TB,
// FEXWASM_SHARED, and FEXWASM_AOT for code only other threads run.
//   node [--experimental-wasm-jspi] tools/threadrun.js <dump-dir> <kernel> [n] [threads]
// SHARED=1: the main thread compiles each module once and posts it to the
// workers (needs JSPI); otherwise every worker compiles its own copies.
'use strict';
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
for (const f of ['../js/runtime.js', '../js/fexthreads.js']) vm.runInThisContext(fs.readFileSync(path.join(__dirname, f), 'utf8'));

const rd = (dir, f) => fs.readFileSync(path.join(dir, f));

if (isMainThread) {
  const [dir, want, nArg, threadsArg] = process.argv.slice(2);
  const threads = threadsArg ? parseInt(threadsArg) : 4;
  const cfg = JSON.parse(rd(dir, 'config.json'));
  if (!cfg.shared || cfg.threadBase < 0) throw new Error('dump not built with FEXWASM_TB and FEXWASM_SHARED');
  const mem = new WebAssembly.Memory({ initial: cfg.memPages, maximum: cfg.memPages, shared: true });
  new Uint8Array(mem.buffer).set(rd(dir, 'image.bin'), cfg.imageLow);
  let ready = 0, onResult = null;
  const shared = !!process.env.SHARED;
  const server = shared ? FexThreads.translationServer(FexThreads.parseUnits(rd(dir, 'units.bin')), FexThreads.parseRegions(rd(dir, 'regions.bin'))) : null;
  for (let k = 0; k < threads; k++) {
    const w = new Worker(__filename, { workerData: { dir, mem, slot: k, threads, shared } });
    w.on('message', (m) => {
      if (server && server.handle(m, (r) => w.postMessage(r))) return;
      if (m.ready) { if (++ready === threads) start(); return; }
      if (m.stats) { console.log(`  [t${m.slot}]`, JSON.stringify(m.stats)); return; }
      if (m.error) { console.error(`worker ${m.slot}: ${m.error}`); process.exit(1); }
      onResult(m);
    });
    w.on('error', (e) => { console.error(`worker ${k}:`, e); process.exit(1); });
  }
  const job = (entry, n) => new Promise((res) => { onResult = res; FexThreads.submit(mem, 0, entry, n); });
  async function start() {
    for (const k of cfg.kernels) {
      if (want && k.name !== want) continue;
      const n = parseInt(nArg) || k.n;
      const warm = await job(k.entry, Math.max(1, Math.floor((n & 0xffffff) / 10)) | (n & ~0xffffff));
      const r = await job(k.entry, n);
      const ok = n !== k.n ? '' : r.chk === k.chk ? ' ok' : ' MISMATCH';
      console.log(`${k.name} n=${n} threads=${threads}: ${r.ms.toFixed(1)} ms (warm-up ${warm.ms.toFixed(1)}) chk=${r.chk}${ok} created=${r.created} (fexrun 1 thread ${k.macWasmMs.toFixed(1)} ms)`);
    }
    for (let k = 0; k < threads; k++) FexThreads.quit(mem, k);
    if (server) setTimeout(() => console.log('  server', JSON.stringify(server.stats)), 300);
  }
} else {
  const { dir, mem, slot, threads, shared } = workerData;
  const req = shared ? FexThreads.requester((m) => parentPort.postMessage(m)) : null;
  if (req) parentPort.on('message', (m) => req.onReply(m));
  FexThreads.workerLoop({
    mem, slot, threads, cfg: JSON.parse(rd(dir, 'config.json')), now: () => performance.now(),
    ...(shared ? { request: req.request } : { units: FexThreads.parseUnits(rd(dir, 'units.bin')), regions: FexThreads.parseRegions(rd(dir, 'regions.bin')) }),
    dispatcher: rd(dir, 'dispatcher.wasm'), state: rd(dir, 'state.bin'), noRegions: !!process.env.NOREGIONS,
    post: (m) => parentPort.postMessage(m),
  });
}
