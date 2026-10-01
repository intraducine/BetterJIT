// The page side of live translation: guest code comes from a translator (the
// app's native FEX + wasm backend, or tools/fexserve on the Mac) over HTTP as
// the guest runs, instead of from a dump. Needs fexruntime.js (runtime.js)
// and JSPI (regions are fetched while the hot unit's wasm stack waits).
//   const live = await FexLive.connect(base, fetchImpl, wsUrl)
// With wsUrl, unit and region requests go over a WebSocket (the app's loopback
// server; about 0.1 ms per round trip against ~0.6 ms for HTTP).
//   const rt = live.runtime(mem, extra)   -> FexRuntime in async mode
//   await live.call(rt, mem, entry, arg)  -> RAX (low 32 bits)
(function (G) {
  'use strict';

  async function connect(base, fetchImpl, wsUrl) {
    const get = async (path, init) => {
      const r = await (fetchImpl || fetch)(base + path, init);
      if (!r.ok) throw new Error(path + ': ' + r.status);
      return r;
    };
    const bytes = async (path, init) => new Uint8Array(await (await get(path, init)).arrayBuffer());
    const cfg = await (await get('/xlat/config')).json();
    const dispatcher = await bytes('/xlat/dispatcher');
    const state = await bytes('/xlat/state');
    const stats = { unitRequests: 0, regionRequests: 0, requestMs: 0, compileMs: 0, bytes: 0, transport: wsUrl ? 'ws' : 'http' };
    const now = () => performance.now();
    // WebSocket requests: [op u8][id u32][payload] -> [id u32][body].
    let ws = null, nextId = 1;
    const pending = new Map();
    if (wsUrl) {
      ws = new WebSocket(wsUrl);
      ws.binaryType = 'arraybuffer';
      await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('translator socket')); });
      ws.onmessage = (e) => {
        const id = new DataView(e.data).getUint32(0, true), p = pending.get(id);
        pending.delete(id);
        if (p) p(new Uint8Array(e.data, 4));
      };
    }
    const wsRequest = (op, payload) => new Promise((res) => {
      const id = nextId++, msg = new Uint8Array(5 + payload.byteLength);
      msg[0] = op;
      new DataView(msg.buffer).setUint32(1, id, true);
      msg.set(new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength), 5);
      pending.set(id, res);
      ws.send(msg);
    });

    async function unit(rip) {
      const t0 = now();
      const b = ws ? await wsRequest(0x10, new Uint32Array([rip])) : await bytes('/xlat/unit?rip=' + rip);
      stats.requestMs += now() - t0;
      stats.unitRequests++;
      if (b.length < 4) return null;
      const slot = new DataView(b.buffer, b.byteOffset, 4).getUint32(0, true);
      const t1 = now();
      const module = new WebAssembly.Module(b.slice(4));
      stats.compileMs += now() - t1;
      stats.bytes += b.length - 4;
      return { module, bytes: b.length - 4, slot };
    }

    // [n, rips..., m, (rip, k, successors...)..., c, (ret, k, targets...)...]
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
      const t0 = now();
      const b = ws ? await wsRequest(0x11, new Uint32Array(words)) : await bytes('/xlat/region', { method: 'POST', body: new Uint32Array(words) });
      stats.requestMs += now() - t0;
      stats.regionRequests++;
      if (b.length === 0) return null;
      const t1 = now();
      const module = new WebAssembly.Module(b);
      stats.compileMs += now() - t1;
      stats.bytes += b.length;
      return { module, bytes: b.length };
    }

    return {
      cfg, stats,
      translatorStats: async () => (await get('/xlat/stats')).json(),
      runtime(mem, extra) {
        return FexRuntime.createRuntime(Object.assign({
          mem, now, dispatcher,
          translateAsync: unit,
          translateRegionAsync: region,
          hotAddr: cfg.hotAddr, hotThreshold: cfg.hotThreshold,
          dispatchBase: cfg.dispatchBase, dispatchBits: cfg.dispatchBits,
          slotTagBase: cfg.slotTagBase, slotTagCount: cfg.slotTagCount,
          unitCounterBase: cfg.unitCounterBase, unitCounterBits: cfg.unitCounterBits,
          callSiteBase: cfg.callSiteBase, callSiteBits: cfg.callSiteBits,
        }, cfg.threadBase >= 0 ? { threadBase: cfg.threadBase } : {}, extra || {}));
      },
      // Runs guest function entry(arg) on the kernel stack until it returns.
      async call(rt, mem, entry, arg) {
        const u8 = new Uint8Array(mem.buffer), dv = new DataView(mem.buffer);
        const tb = cfg.threadBase >= 0 ? cfg.threadBase : 0, G = tb + cfg.ctx + cfg.gregsOff;
        const W = BigInt(cfg.windowHi) << 32n, win64 = cfg.guestAbi === 'win64';
        u8.set(state, tb + cfg.ctx);
        const ret = cfg.stackTop - (win64 ? 0x48 : 8);
        dv.setBigUint64(G + (win64 ? 1 : 7) * 8, BigInt(arg), true);
        dv.setBigUint64(ret, W + BigInt(cfg.halt), true);
        dv.setBigUint64(G + 4 * 8, W + BigInt(ret), true);
        await rt.runAsync(entry, cfg.halt);
        return Number(dv.getBigUint64(G, true) & 0xffffffffn);
      },
    };
  }

  G.FexLive = { connect };
})(globalThis);
