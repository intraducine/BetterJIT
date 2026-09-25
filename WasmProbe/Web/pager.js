// Software demand pager for bigmem.wasm. The page table lives in wasm memory
// (page -> host frame address, 0 = not present), so resident accesses never
// leave wasm. JS runs only for page-ins and CLOCK second-chance remaps.
//
// backing.swap(outPage, outView, inPage, inView) writes back `outView` (if
// outPage >= 0) and fills `inView` with page `inPage`; returns bytes read.
(function (G) {
  'use strict';
  const PAGE_SHIFT = 14, PAGE = 1 << PAGE_SHIFT, FRAME_BASE = 16 << 20, PT_BASE = 8 << 20;

  function createPager({ mem, frames, baseVA, spanBytes, backing }) {
    const nPages = Math.ceil(spanBytes / PAGE);
    if (PT_BASE + nPages * 4 > FRAME_BASE) throw new Error('span too large for page-table area');
    const pageFrame = new Int32Array(nPages);             // resident frame + 1, even while unmapped for CLOCK
    const frameToPage = new Int32Array(frames).fill(-1);
    const referenced = new Uint8Array(frames);
    const onBacking = new Uint8Array(nPages);             // page has ever been written back
    let pt = null, dirty = null, hand = 0;
    const stats = { faults: 0, minor: 0, pageIns: 0, writeBacks: 0, zeroFills: 0, ioMs: 0 };

    function attach(ex) {
      pt = new Uint32Array(mem.buffer, PT_BASE, nPages);
      pt.fill(0);
      dirty = new Uint8Array(mem.buffer, ex.dirty_addr(), frames);
      dirty.fill(0);   // the memory may be reused from an earlier run
      ex.setup(PT_BASE, nPages, BigInt(baseVA));
    }
    const frameView = (f) => new Uint8Array(mem.buffer, FRAME_BASE + f * PAGE, PAGE);

    function fault(page) {
      stats.faults++;
      let f = pageFrame[page] - 1;
      if (f >= 0) { stats.minor++; }                         // still resident, just unmapped by CLOCK
      else {
        for (;;) {                                           // CLOCK victim selection
          f = hand; hand = (hand + 1) % frames;
          const p = frameToPage[f];
          if (p < 0 || !referenced[f]) break;
          referenced[f] = 0; pt[p] = 0;                      // second chance: unmap, re-reference on next touch
        }
        const old = frameToPage[f], t0 = performance.now();
        let outPage = -1;
        if (old >= 0) { pt[old] = 0; pageFrame[old] = 0; if (dirty[f]) { outPage = old; dirty[f] = 0; stats.writeBacks++; } }
        const needIn = onBacking[page] === 1;               // never written back: demand-zero, no I/O
        let got = 0;
        if (outPage >= 0 || needIn) got = backing.swap(outPage, outPage >= 0 ? frameView(f) : null, needIn ? page : -1, frameView(f));
        if (outPage >= 0) onBacking[outPage] = 1;
        if (!needIn) { frameView(f).fill(0); stats.zeroFills++; }
        else if (got < PAGE) frameView(f).fill(0, Math.max(0, got));
        stats.ioMs += performance.now() - t0; if (needIn) stats.pageIns++;
        pageFrame[page] = f + 1; frameToPage[f] = page;
      }
      referenced[f] = 1;
      pt[page] = FRAME_BASE + f * PAGE;
    }
    return { fault, attach, stats, PAGE };
  }

  // Backing store: a file through a sync access handle (OPFS).
  function fileBacking(ah, baseOff) {
    return {
      swap(outPage, outView, inPage, inView) {
        if (outPage >= 0) ah.write(outView, { at: baseOff + outPage * PAGE });
        return inPage >= 0 ? ah.read(inView, { at: baseOff + inPage * PAGE }) : 0;
      },
    };
  }

  // Backing store: the app process's RAM, reached through a file both processes
  // share (the app maps it). Layout (offsets into the file):
  //   ctrl+0  u64 request seq   ctrl+8 u32 op (1 = write back, 2 = read)   ctrl+12 u32 outPage   ctrl+16 u32 inPage
  //   ctrl+64 u64 response seq  slot0 = page going out, slot1 = page coming in
  function appBacking(ah, ctrl, slot0, slot1) {
    const req = new DataView(new ArrayBuffer(24)), reqU8 = new Uint8Array(req.buffer);
    const resp = new BigUint64Array(1), respU8 = new Uint8Array(resp.buffer);
    let seq = 0n;
    return {
      swap(outPage, outView, inPage, inView) {
        if (outPage >= 0) ah.write(outView, { at: slot0 });
        seq++;
        req.setUint32(8, (outPage >= 0 ? 1 : 0) | (inPage >= 0 ? 2 : 0), true);
        req.setUint32(12, Math.max(0, outPage), true);
        req.setUint32(16, Math.max(0, inPage), true);
        req.setBigUint64(0, seq, true);
        ah.write(reqU8.subarray(8), { at: ctrl + 8 });      // op + pages first,
        ah.write(reqU8.subarray(0, 8), { at: ctrl });       // then the sequence number publishes them
        let k = 0;
        do { ah.read(respU8, { at: ctrl + 64 }); } while (resp[0] !== seq && ++k < 50000000);
        if (resp[0] !== seq) throw new Error('app pager did not answer');
        return inPage >= 0 ? ah.read(inView, { at: slot1 }) : 0;
      },
    };
  }

  G.Pager = { createPager, fileBacking, appBacking, PAGE_SHIFT, PAGE, FRAME_BASE, PT_BASE };
})(typeof globalThis !== 'undefined' ? globalThis : this);
