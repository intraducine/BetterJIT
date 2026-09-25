// Runs guest kernels with live translation from tools/fexserve (the stand-in
// for the app's native translator), like the device's fexlive suite:
//   node --experimental-wasm-jspi tools/liverun.js <dump-dir> [port] [kernel]
// The dump supplies the image and the kernel list (entries, expected checksums).
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
for (const f of ['../js/runtime.js', '../js/fexlive.js']) vm.runInThisContext(fs.readFileSync(path.join(__dirname, f), 'utf8'));
const [dir, port, want] = process.argv.slice(2);
(async () => {
  const dump = JSON.parse(fs.readFileSync(path.join(dir, 'config.json')));
  const live = await FexLive.connect('http://127.0.0.1:' + (port || 47200));
  const cfg = live.cfg;
  const mem = new WebAssembly.Memory({ initial: cfg.memPages, maximum: cfg.memPages, shared: !!cfg.shared });
  new Uint8Array(mem.buffer).set(fs.readFileSync(path.join(dir, 'image.bin')), cfg.imageLow);
  const rt = live.runtime(mem);
  for (const k of dump.kernels) {
    if (want && k.name !== want) continue;
    const t0 = performance.now();
    await live.call(rt, mem, k.entry, Math.max(1, Math.floor((k.n & 0xffffff) / 10)) | (k.n & ~0xffffff));
    const warm = performance.now() - t0;
    const t1 = performance.now();
    const chk = await live.call(rt, mem, k.entry, k.n);
    const ms = performance.now() - t1;
    console.log(`${k.name.padEnd(14)} ${ms.toFixed(1).padStart(8)} ms (first run ${warm.toFixed(1)} ms) chk ${chk === k.chk ? 'ok' : 'MISMATCH ' + chk + ' vs ' + k.chk}`);
  }
  console.log('client', JSON.stringify(live.stats), 'runtime', JSON.stringify(rt.stats));
  console.log('translator', JSON.stringify(await live.translatorStats()));
})().catch((e) => { console.error(e); process.exit(1); });
