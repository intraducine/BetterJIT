// A channel file: requests to the app through a file in the origin's private
// file system (OPFS) that the app maps. The requester writes a request into
// it, rings, and waits for the answer, with synchronous access (a round trip
// is some microseconds; a request to the app's loopback server costs
// hundreds). Used by the channel workers (chan_web.js) and by guest threads
// for their own GPU channels (thread_web.js).
//
// The file: 0 magic (text, 64 bytes); 64 u32 request seq, 68 u32 length;
// 128 u32 response seq, 132 i32 length (or -errno), 136 u32 ready (set by
// the app once it has mapped the file); 4096 the request; REQ_MAX + 4096
// the response.
'use strict';

const CHAN_REQ_MAX = 32 << 20, CHAN_RESP_MAX = 32 << 20, CHAN_FILE_SIZE = 4096 + CHAN_REQ_MAX + CHAN_RESP_MAX;

// -> {call(u8, req, len, resp, cap)} once the app has the file, or throws
async function openChanFile(name, kind, origin) {
  const root = await navigator.storage.getDirectory();
  const h = await (await root.getFileHandle(name, { create: true })).createSyncAccessHandle();
  h.truncate(CHAN_FILE_SIZE);
  const magic = `FEXWASM-CHAN-${kind}-${crypto.randomUUID()}`;
  const hdr = new Uint8Array(64);
  hdr.set(new TextEncoder().encode(magic));
  h.write(hdr, { at: 0 });
  h.write(new Uint8Array(96), { at: 64 }); // (seqs, lengths, ready: 0)
  h.flush();
  // the app finds the file by its magic and maps it
  const r = await fetch(`${origin}/chan/attach?kind=${kind}&magic=${encodeURIComponent(magic)}`);
  if (!r.ok) throw new Error(`the app didn't map the channel: ${r.status} ${await r.text()}`);
  const w = new Uint32Array(1), word = new Uint8Array(w.buffer), i = new Int32Array(1), iword = new Uint8Array(i.buffer);
  const read32 = (at) => { h.read(word, { at }); return w[0]; };
  for (let n = 0; !read32(136); n++) if (n > 1e6) throw new Error('the app never said ready');

  const nap = new Int32Array(new SharedArrayBuffer(4));
  let seq = 0, tmp = new Uint8Array(1 << 20);
  const copyOut = (src, at) => { // (a view of shared memory can't go to the file directly)
    for (let o = 0; o < src.length; o += tmp.length) {
      const n = Math.min(tmp.length, src.length - o);
      tmp.set(src.subarray(o, o + n));
      h.write(tmp.subarray(0, n), { at: at + o });
    }
  };
  const copyIn = (dst, at) => {
    for (let o = 0; o < dst.length; o += tmp.length) {
      const n = Math.min(tmp.length, dst.length - o);
      h.read(tmp.subarray(0, n), { at: at + o });
      dst.set(tmp.subarray(0, n), o);
    }
  };
  const stats = { n: 0, ms: 0, waitMs: 0 };
  return {
    stats, // (calls, ms in them, ms of that waiting for the app)
    // request [req, req + len) of u8 -> the response at resp (up to cap): its
    // length, or -errno. timeoutMs: -110 (ETIMEDOUT) after (0: never).
    call(u8, req, len, resp, cap, timeoutMs = 0) {
      if (len > CHAN_REQ_MAX) return -7; // E2BIG
      const c0 = performance.now();
      copyOut(u8.subarray(req, req + len), 4096);
      seq = (seq + 1) >>> 0;
      w[0] = len;
      h.write(word, { at: 68 });
      w[0] = seq;
      h.write(word, { at: 64 }); // (the doorbell, after the request)
      // the app answers with the same seq, in microseconds; calls that wait
      // (for the GPU, for a drawable) take longer: nap after 50 us, longer
      // the longer it takes (spinning heats the phone, which then slows down)
      let t0 = 0, napMs = 0.05;
      const w0 = performance.now();
      for (let n = 1; read32(128) !== seq; n++) {
        if ((n & 15) !== 0) continue;
        const t = performance.now();
        if (!t0) t0 = t;
        else if (t - t0 > 0.05) {
          if (timeoutMs && t - t0 > timeoutMs) return -110;
          Atomics.wait(nap, 0, 0, napMs);
          napMs = Math.min(0.5, napMs * 1.5);
        }
      }
      const w1 = performance.now();
      h.read(iword, { at: 132 });
      const result = i[0];
      if (result > 0) copyIn(u8.subarray(resp, resp + Math.min(result, cap)), 4096 + CHAN_REQ_MAX);
      stats.n++;
      stats.ms += performance.now() - c0;
      stats.waitMs += w1 - w0;
      return result;
    },
  };
}
