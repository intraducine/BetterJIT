// A channel to the app: requests go through a file in the origin's private
// file system that the app maps: this worker writes a request into it,
// rings the app, and waits for the answer, with synchronous access (a round
// trip is some microseconds; a request to the app's loopback server costs
// hundreds). One per kind of request, each with its file and the app's
// handler for it: gpu (DXMT's native half, on Metal: guest threads'
// syscall 0x46574420), xlat (the translator: units for the thread workers),
// kern (the kernel's: guest files, code for the translator). Requests to xlat
// and kern start with a 32-byte header: u32 op, u32 space, u64 a, b, c.
//
// Requesters hand it requests through a mailbox (SharedArrayBuffer, i32):
// 0 lock, 1 state (0 idle, 1 request, 2 done), 2 request address, 3 length,
// 4 response address, 5 capacity, 6 result (the response's length, or
// -errno), 7 where: 0 guest memory (it starts with it: one WebAssembly.Memory
// for every process), 1 the mailbox's data buffer (a SharedArrayBuffer of
// its own, addresses relative to it); 15 ready (1 once the app has the
// file, -1 if it never will: requesters wait for it, or go without).
//
// The file and its protocol: chan_file.js.
'use strict';

importScripts('chan_file.js');

onmessage = async (e) => {
  const { mailbox, data, origin, name, kind, mem } = e.data;
  const mb = new Int32Array(mailbox);
  const log = (m) => postMessage({ op: 'log', m: `[${kind}] ` + m });
  let ch;
  try {
    ch = await openChanFile(name, kind, origin);
  } catch (err) {
    log(err.message);
    Atomics.store(mb, 15, -1);
    Atomics.notify(mb, 15);
    return;
  }
  log(`channel ready (${name})`);
  Atomics.store(mb, 15, 1);
  Atomics.notify(mb, 15);
  postMessage({ op: 'ready' });

  let lastWork = performance.now();
  for (;;) {
    // (waking a sleeping worker costs tens of microseconds: requests come
    // close together, so look for the next one for 2 ms)
    if (Atomics.load(mb, 1) !== 1) {
      if (performance.now() - lastWork < 2) continue;
      Atomics.wait(mb, 1, 0, 50);
      continue;
    }
    const u8 = new Uint8Array(mb[7] ? data : mem.buffer);
    mb[6] = ch.call(u8, mb[2] >>> 0, mb[3] >>> 0, mb[4] >>> 0, mb[5] >>> 0, 10000);
    Atomics.store(mb, 1, 2);
    Atomics.notify(mb, 1);
    lastWork = performance.now();
  }
};
