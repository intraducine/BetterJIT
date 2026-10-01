// Owns an OPFS FileSystemSyncAccessHandle and runs file-backed memory tests:
// raw I/O, app<->worker sharing through the same file, and a demand-paged
// guest address space much larger than the WebContent memory limit.
importScripts('pager.js');

let ah = null, fileName = null;
let bigMem = null;   // one wasm memory reused by every bigmem run (a second would breach the ~2 GB WebContent limit)
const now = () => performance.now();

function stats(arr) {
  const a = arr.slice().sort((x, y) => x - y), sum = a.reduce((p, c) => p + c, 0);
  const q = (f) => a[Math.min(a.length - 1, Math.floor(a.length * f))];
  return { n: a.length, avg: sum / a.length, min: a[0], p50: q(0.5), p90: q(0.9), p99: q(0.99), max: a[a.length - 1] };
}
// Must match sh_fill_u32 / sh_fnv_u32 in Sources/shared_helpers.c.
function fillPattern(u32, seed) { let x = seed >>> 0 || 1; for (let i = 0; i < u32.length; i++) { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; u32[i] = x >>> 0; } }
function fnv(u32) { let h = 2166136261; for (let i = 0; i < u32.length; i++) { h ^= u32[i]; h = Math.imul(h, 16777619); } return h >>> 0; }

const H = {
  async open({ name, mode }) {
    const root = await navigator.storage.getDirectory();
    const fh = await root.getFileHandle(name, { create: true });
    const t = now();
    ah = mode ? await fh.createSyncAccessHandle({ mode }) : await fh.createSyncAccessHandle();
    fileName = name;
    return { size: ah.getSize(), openMs: now() - t, proto: Object.getOwnPropertyNames(Object.getPrototypeOf(ah)) };
  },
  async estimate() { return navigator.storage.estimate ? await navigator.storage.estimate() : 'n/a'; },
  // A second handle on the same file, opened from another worker (tests exclusivity).
  async openOther({ name, mode }) {
    const root = await navigator.storage.getDirectory();
    const fh = await root.getFileHandle(name, { create: true });
    try { const h = mode ? await fh.createSyncAccessHandle({ mode }) : await fh.createSyncAccessHandle(); h.close(); return 'opened'; }
    catch (e) { return 'refused: ' + e; }
  },
  header({ magic, sizeBytes }) {
    const enc = new TextEncoder().encode(magic);
    ah.write(enc, { at: 0 });
    if (sizeBytes && ah.getSize() < sizeBytes) ah.truncate(sizeBytes);
    ah.flush();
    return { size: ah.getSize() };
  },
  // Sequentially write real data; reports time per GB (dirty file-page throttling shows up here).
  fill({ fromMB, toMB, chunkMB }) {
    const chunk = new Uint8Array((chunkMB || 64) << 20); fillPattern(new Uint32Array(chunk.buffer), 7);
    const perGB = []; let t = now(), t0 = now();
    for (let mb = fromMB; mb < toMB; mb += chunkMB) {
      new DataView(chunk.buffer).setUint32(0, mb);
      const n = ah.write(chunk, { at: mb * 1048576 });
      if (n !== chunk.length) return { error: 'short write ' + n, atMB: mb };
      if ((mb + chunkMB) % 1024 === 0) { perGB.push(Math.round(now() - t)); postMessage({ progress: { wroteGB: (mb + chunkMB) / 1024, msThisGB: perGB[perGB.length - 1] } }); t = now(); }
    }
    return { totalMs: now() - t0, MBps: (toMB - fromMB) / ((now() - t0) / 1000), perGBms: perGB, size: ah.getSize() };
  },
  randio({ spanMB, size, n, write, offMB }) {
    const buf = new Uint8Array(size), lat = [], pages = Math.floor((spanMB << 20) / size);
    let x = 12345;
    for (let i = 0; i < n; i++) {
      x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
      const at = (offMB || 0) * 1048576 + ((x >>> 0) % pages) * size;
      const t = now();
      const got = write ? ah.write(buf, { at }) : ah.read(buf, { at });
      lat.push((now() - t) * 1000);
      if (got !== size) return { error: 'short io ' + got };
    }
    return { unit: 'us', size, write: !!write, ...stats(lat), MBps: (size * n / 1048576) / (lat.reduce((a, b) => a + b, 0) / 1e6) };
  },
  // Round trip with the app through the file: worker write()s a sequence number,
  // an app thread spinning on its mmap of the same file echoes it at respOff.
  pingpong({ n, reqOff, respOff }) {
    const w = new BigUint64Array(1), r = new BigUint64Array(1), wb = new Uint8Array(w.buffer), rb = new Uint8Array(r.buffer);
    const lat = []; let spins = 0, timeouts = 0;
    for (let i = 1; i <= n; i++) {
      w[0] = BigInt(i);
      const t = now();
      ah.write(wb, { at: reqOff });
      let k = 0;
      do { ah.read(rb, { at: respOff }); k++; } while (r[0] !== BigInt(i) && k < 2000000);
      if (r[0] !== BigInt(i)) timeouts++;
      spins += k; lat.push((now() - t) * 1000);
    }
    const total = lat.reduce((a, b) => a + b, 0);
    return { unit: 'us', ...stats(lat), avgFromTotal: total / n, avgReadsPerTrip: spins / n, timeouts };
  },
  // Syscall cost floor: one tiny read.
  tinyread({ n }) {
    const b = new Uint8Array(8), lat = [];
    for (let i = 0; i < n; i++) { const t = now(); ah.read(b, { at: 4096 }); lat.push((now() - t) * 1000); }
    return { unit: 'us', ...stats(lat) };
  },
  writeAt({ off, lenMB, seed }) {
    const u32 = new Uint32Array((lenMB << 20) / 4); fillPattern(u32, seed);
    const t = now(); ah.write(new Uint8Array(u32.buffer), { at: off }); const ms = now() - t;
    return { hash: fnv(u32), ms, MBps: lenMB / (ms / 1000) };
  },
  checkAt({ off, lenMB }) {
    const u8 = new Uint8Array(lenMB << 20);
    const t = now(); const got = ah.read(u8, { at: off }); const ms = now() - t;
    return { hash: fnv(new Uint32Array(u8.buffer)), got, ms, MBps: lenMB / (ms / 1000) };
  },
  // Demand-paged guest memory: spanGB of guest address space above 4 GB,
  // `frames` x 16 KB resident in wasm memory. backing 'file' pages to this
  // OPFS file (at fileOffMB); 'app' pages to the app's RAM via the shared file.
  async bigmem({ frames, spanGB, hotMB, hotPct, n, rounds, fileOffMB, direct, backing, ctrl, slot0, slot1 }) {
    const PAGE = Pager.PAGE, FB = Pager.FRAME_BASE, BASE = 0x7FF000000000n;
    const span = spanGB * 2 ** 30;
    const pagesNeeded = (FB + frames * PAGE) / 65536;
    if (!bigMem) bigMem = new WebAssembly.Memory({ initial: pagesNeeded, maximum: 65536 });
    else if (bigMem.buffer.byteLength / 65536 < pagesNeeded) bigMem.grow(pagesNeeded - bigMem.buffer.byteLength / 65536);
    const mem = bigMem;
    const store = backing === 'app' ? Pager.appBacking(ah, ctrl, slot0, slot1) : Pager.fileBacking(ah, (fileOffMB || 0) * 1048576);
    const pager = Pager.createPager({ mem, frames, baseVA: BASE, spanBytes: span, backing: store });
    const mod = new WebAssembly.Module(await (await fetch('bigmem.wasm')).arrayBuffer());
    const ex = new WebAssembly.Instance(mod, { env: { memory: mem }, e: { fault: pager.fault } }).exports;
    pager.attach(ex);
    const out = [];
    for (let r = 0; r < (rounds || 2); r++) {
      const s0 = { ...pager.stats }, t = now();
      const chk = ex.work(n, BigInt(1000 + r), BASE, BigInt(hotMB * 1048576), BigInt(span), hotPct);
      const ms = now() - t, d = (k) => pager.stats[k] - s0[k];
      out.push({ round: r, ms: Math.round(ms), nsPerAccess: +(ms * 1e6 / n).toFixed(1), pageIns: d('pageIns'), minor: d('minor'),
        writeBacks: d('writeBacks'), usPerPageIn: +(d('ioMs') * 1000 / Math.max(1, d('pageIns'))).toFixed(2), chk: String(chk) });
    }
    let directRes = null;
    if (direct) {   // same access pattern on a flat array in the (reused) frame area
      const dex = new WebAssembly.Instance(mod, { env: { memory: mem }, e: { fault() { throw new Error('x'); } } }).exports;
      dex.work_direct(n, 1000n, FB, BASE, BigInt(hotMB * 1048576), BigInt(direct * 1048576), hotPct);
      const t = now(); dex.work_direct(n, 1001n, FB, BASE, BigInt(hotMB * 1048576), BigInt(direct * 1048576), hotPct);
      directRes = { nsPerAccess: +((now() - t) * 1e6 / n).toFixed(1) };
    }
    return { backing: backing || 'file', residentMB: frames * PAGE >> 20, spanGB, hotMB, hotPct, n, rounds: out, direct: directRes };
  },
  // Every page of a spanGB guest space written once, then read back and verified.
  async bigfill({ frames, spanGB, backing, fileOffMB, ctrl, slot0, slot1, salt }) {
    const PAGE = Pager.PAGE, FB = Pager.FRAME_BASE, BASE = 0x7FF000000000n;
    const span = spanGB * 2 ** 30, npages = span / PAGE;
    const pagesNeeded = (FB + frames * PAGE) / 65536;
    if (!bigMem) bigMem = new WebAssembly.Memory({ initial: pagesNeeded, maximum: 65536 });
    else if (bigMem.buffer.byteLength / 65536 < pagesNeeded) bigMem.grow(pagesNeeded - bigMem.buffer.byteLength / 65536);
    const store = backing === 'app' ? Pager.appBacking(ah, ctrl, slot0, slot1) : Pager.fileBacking(ah, (fileOffMB || 0) * 1048576);
    const pager = Pager.createPager({ mem: bigMem, frames, baseVA: BASE, spanBytes: span, backing: store });
    const mod = new WebAssembly.Module(await (await fetch('bigmem.wasm')).arrayBuffer());
    const ex = new WebAssembly.Instance(mod, { env: { memory: bigMem }, e: { fault: pager.fault } }).exports;
    pager.attach(ex);
    const phase = (name, fn) => {
      const s0 = { ...pager.stats }, t = now(); const ret = fn(); const ms = now() - t, d = (k) => pager.stats[k] - s0[k];
      return { phase: name, ms: Math.round(ms), ret, pageIns: d('pageIns'), zeroFills: d('zeroFills'), writeBacks: d('writeBacks'),
        usPerFault: +(ms * 1000 / Math.max(1, d('faults'))).toFixed(2), effectiveGBps: +((span / 2 ** 30) / (ms / 1000)).toFixed(2) };
    };
    const fill = phase('fill', () => ex.seqfill(BASE, npages, salt || 77));
    postMessage({ progress: { bigfill: fill } });
    const check = phase('check', () => ex.seqcheck(BASE, npages, salt || 77));
    return { backing: backing || 'file', spanGB, residentMB: frames * PAGE >> 20, npages, fill, check, mismatches: check.ret };
  },
  close() { if (ah) { ah.flush(); ah.close(); ah = null; } return 'closed'; },
  async remove({ name }) {
    if (ah) { ah.close(); ah = null; }
    const root = await navigator.storage.getDirectory();
    await root.removeEntry(name || fileName);
    return 'removed';
  },
};

onmessage = async (e) => {
  const { id, op, args } = e.data;
  try { postMessage({ id, r: await H[op](args || {}) }); }
  catch (err) { postMessage({ id, error: String(err), stack: String(err && err.stack || '') }); }
};
