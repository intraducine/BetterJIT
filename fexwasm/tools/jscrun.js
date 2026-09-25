// Replays a fexrun --dump package in the jsc shell (for profiling JSC's code).
//   jsc tools/jscrun.js -- <dump-dir> <kernel> [n]
const dir = arguments[0], want = arguments[1], nArg = arguments[2] ? parseInt(arguments[2]) : 0;
load('js/runtime.js');
const rd = (f) => new Uint8Array(readFile(dir + '/' + f, 'binary'));
const cfg = JSON.parse(readFile(dir + '/config.json'));
const img = rd('image.bin'), state = rd('state.bin'), ub = rd('units.bin');
const units = new Map(), udv = new DataView(ub.buffer);
for (let i = 0, off = 4, n = udv.getUint32(0, true); i < n; i++) {
  const rip = udv.getUint32(off, true), len = udv.getUint32(off + 4, true);
  units.set(rip, ub.slice(off + 8, off + 8 + len)); off += 8 + len;
}
const regions = new Map();
try {
  const rb = rd('regions.bin'), rdv = new DataView(rb.buffer);
  for (let i = 0, off = 4, n = rdv.getUint32(0, true); i < n; i++) {
    const cnt = rdv.getUint32(off, true), rips = [];
    for (let k = 0; k < cnt; k++) rips.push(rdv.getUint32(off + 4 + 4 * k, true));
    off += 4 + 4 * cnt;
    const len = rdv.getUint32(off, true);
    regions.set(rips.join(','), rb.slice(off + 4, off + 4 + len)); off += 4 + len;
  }
} catch (e) {}
let regionMisses = 0;
const mem = new WebAssembly.Memory({ initial: cfg.memPages });
const u8 = new Uint8Array(mem.buffer), dv = new DataView(mem.buffer);
u8.set(img, cfg.imageLow);
const rt = FexRuntime.createRuntime({ mem, translate: (r) => units.get(r) || null, now: () => performance.now(),
  translateRegion: (rips) => { const r = regions.get(Array.from(rips).join(',')); if (!r) regionMisses++; return r || null; }, hotAddr: cfg.hotAddr, hotThreshold: cfg.hotThreshold,
  dispatcher: rd('dispatcher.wasm'), dispatchBase: cfg.dispatchBase, dispatchBits: cfg.dispatchBits, slotTagBase: cfg.slotTagBase || 0, slotTagCount: cfg.slotTagCount || 0 });
const W = BigInt(cfg.windowHi) << 32n, G = cfg.ctx + cfg.gregsOff;
const win64 = cfg.guestAbi === 'win64'; // argument in RCX, 32-byte shadow space above the return address
function call(entry, arg) {
  u8.set(state, cfg.ctx);
  const ret = cfg.stackTop - (win64 ? 0x48 : 8);
  dv.setBigUint64(G + (win64 ? 1 : 7) * 8, BigInt(arg), true);
  dv.setBigUint64(ret, W + BigInt(cfg.halt), true);
  dv.setBigUint64(G + 4 * 8, W + BigInt(ret), true);
  rt.run(entry, cfg.halt);
  return Number(dv.getBigUint64(G, true) & 0xffffffffn);
}
for (const k of cfg.kernels) {
  if (want && k.name !== want) continue;
  const n = nArg || k.n;
  call(k.entry, Math.max(1, Math.floor(n / 10))); // warm-up as on the device: profile, form regions, tier up
  const t = performance.now(); const chk = call(k.entry, n); const ms = performance.now() - t;
  print(`${k.name} n=${n} ${ms.toFixed(1)} ms chk=${chk} (expected ${k.chk}) ${(ms * 1e6 / n).toFixed(1)} ns/iter regions=${rt.stats.regions} misses=${regionMisses}`);
}
