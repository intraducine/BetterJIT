// The kernel worker in a page (js/linux/web/linux_main.js starts it): the
// kernel's loop, with the file tree in memory (js/linux/vfs_web.js, contents
// fetched synchronously on first use) and the translator reached with
// synchronous requests for code it must see before a syscall returns.
// Needs the kernel bundle (tools/webserve.js serves it as linux-kernel.js).
'use strict';

importScripts('linux-kernel.js');
const { Kernel } = LinuxBundle.require('./kernel.js');
LinuxBundle.require('./syscalls.js');
const { writeSnapshot, readSnapshot } = LinuxBundle.require('./snapshot.js');
const { WebVfs } = LinuxBundle.require('./vfs_web.js');

function syncRequest(method, url, body) {
  const x = new XMLHttpRequest();
  x.open(method, url, false);
  x.responseType = 'arraybuffer';
  x.send(body || null);
  if (x.status !== 200) throw new Error(`${method} ${url}: ${x.status}`);
  return new Uint8Array(x.response);
}

// A snapshot file in the origin's private file system (OPFS), read and
// written synchronously (the kernel's loop can't await).
async function opfsFile(name, create) {
  const root = await navigator.storage.getDirectory();
  const h = await (await root.getFileHandle(name, { create })).createSyncAccessHandle();
  let pos = 0, tmp = null;
  // (a view of shared memory, the guest's, may not go to the file directly)
  const viaTmp = (b, fn) => {
    for (let o = 0; o < b.length; o += 1 << 24) {
      const n = Math.min(1 << 24, b.length - o);
      if (!tmp || tmp.length < n) tmp = new Uint8Array(1 << 24);
      fn(tmp.subarray(0, n), o, n);
    }
  };
  const shared = (b) => typeof SharedArrayBuffer !== 'undefined' && b.buffer instanceof SharedArrayBuffer;
  return {
    write(b) {
      if (shared(b)) viaTmp(b, (t, o, n) => { t.set(b.subarray(o, o + n)); h.write(t, { at: pos + o }); });
      else h.write(b, { at: pos });
      pos += b.length;
    },
    read(n, into) {
      const b = into || new Uint8Array(n);
      if (shared(b)) viaTmp(b, (t, o, m) => { h.read(t, { at: pos + o }); b.set(t, o); });
      else h.read(b, { at: pos });
      pos += n;
      return b;
    },
    truncate() { h.truncate(0); pos = 0; },
    size: () => h.getSize(),
    close: () => h.close(),
  };
}

// The kern channel to the app (web/chan_web.js; the kernel is its only
// requester): kcall(op, space, a, b, c, bytes) sends the 32-byte header and
// bytes, and waits (the app answers in microseconds) -> the result: the
// response's length (at data + 4096) or -errno. null: no channel.
function kernChannel(ch) {
  if (!ch) return null;
  const mb = new Int32Array(ch.mailbox), u8 = new Uint8Array(ch.data), dv = new DataView(ch.data);
  let ok = null;
  const call = (op, space, a, b, c, bytes) => {
    dv.setUint32(0, op, true);
    dv.setUint32(4, space, true);
    dv.setBigUint64(8, BigInt(a), true);
    dv.setBigUint64(16, BigInt(b), true);
    dv.setBigUint64(24, BigInt(c), true);
    if (bytes) u8.set(bytes, 32);
    mb[2] = 0; mb[3] = 32 + (bytes ? bytes.length : 0); mb[4] = 4096; mb[5] = u8.length - 4096; mb[7] = 1;
    Atomics.store(mb, 1, 1);
    Atomics.notify(mb, 1);
    for (let n = 0; Atomics.load(mb, 1) !== 2; n++) if ((n & 1023) === 1023) Atomics.wait(mb, 1, 1, 1);
    const r = mb[6];
    Atomics.store(mb, 1, 0);
    return r;
  };
  return {
    u8, dv, max: u8.length - 4096 - 32,
    // (waits for the app to map the file the first time, up to 5 s)
    ready() {
      if (ok === null) {
        if (Atomics.load(mb, 15) === 0) Atomics.wait(mb, 15, 0, 5000);
        ok = Atomics.load(mb, 15) === 1;
      }
      return ok;
    },
    call,
  };
}

onmessage = async (e) => {
  const d = e.data;
  const post = (m, t) => postMessage(m, t || []);
  const kern = kernChannel(d.kernChan);
  const enc = new TextEncoder();
  // (how long the kernel waits for the app: logged every 5 s while it does)
  const kstats = { code: [0, 0, 0], uncode: [0, 0, 0], file: [0, 0, 0] };
  let kstatsAt = 0;
  const timed = (what, bytes, f) => {
    const t0 = performance.now(), r = f(), t = performance.now(), s = kstats[what];
    s[0]++; s[1] += t - t0; s[2] += bytes(r);
    if (t - kstatsAt > 5000) {
      kstatsAt = t;
      post({ op: 'log', m: `[kern] ${kern && kern.ready() ? 'channel' : 'http'}: ` + Object.entries(kstats).map(([k, [n, ms, b]]) =>
        `${k} ${n} (${(b / 1e6).toFixed(1)} MB, ${ms.toFixed(0)} ms)`).join(', ') });
    }
    return r;
  };
  // op 3: the file's size, then its bytes from a (as many as fit)
  function kernFile(p) {
    const path = enc.encode(p);
    let out = null;
    for (let off = 0; ;) {
      const r = kern.call(3, 0, off, 0, 0, path);
      if (r < 8) throw new Error(`${p}: ${r}`);
      const size = Number(kern.dv.getBigUint64(4096, true)), n = r - 8;
      if (!out) out = new Uint8Array(size);
      out.set(kern.u8.subarray(4104, 4104 + n), off);
      off += n;
      if (off >= size) return out;
      if (!n) throw new Error(`${p}: short`);
    }
  }
  const fetchFile = (p) => timed('file', (b) => b.length, () => (kern && kern.ready() ? kernFile(p)
    : syncRequest('GET', `${d.fsBase}/fs/file?p=${encodeURIComponent(p)}`)));
  // [off, off + len) of a file into `into` (op 3 with b: at most that many)
  fetchFile.range = kern ? (p, off, len, into) => timed('file', () => len, () => {
    if (!kern.ready()) { into.set(syncRequest('GET', `${d.fsBase}/fs/file?p=${encodeURIComponent(p)}&off=${off}&len=${len}`)); return; }
    const path = enc.encode(p);
    for (let got = 0; got < len;) {
      const r = kern.call(3, 0, off + got, len - got, 0, path);
      if (r < 8) throw new Error(`${p}: ${r}`);
      const n = Math.min(r - 8, len - got);
      if (n <= 0) break;
      into.set(kern.u8.subarray(4104, 4104 + n), got);
      got += n;
    }
  }) : null;
  // d.snapshot (a name) with d.snapshotAt (seconds): save the system then
  // (d.snapshotExit: and stop); d.restore: start from a saved one instead of
  // argv (d.run: then start that program in it); d.auto (a name): restore
  // it if there is one, else boot and save it at d.snapshotAt, going on.
  let snapFile = null;
  if (d.auto) {
    try {
      snapFile = await opfsFile(d.auto, false);
      if (snapFile.size() > 0) d.restore = d.auto;
      else snapFile.close();
    } catch (err) { /* none yet */ }
    if (!d.restore) {
      d.snapshot = d.auto;
      d.snapshotExit = false;
    }
  }
  try {
    if (d.restore && !snapFile) snapFile = await opfsFile(d.restore, false);
    else if (d.snapshot) snapFile = await opfsFile(d.snapshot, true);
  } catch (err) {
    post({ op: 'log', m: `[snapshot] ${d.restore ? 'no saved system ' + d.restore : 'no file'}: ${err}` });
    post({ op: 'exit', code: 126 });
    return;
  }
  const vfs = d.restore ? null : new WebVfs(d.index, fetchFile, d.uid, d.gid);
  let kernel;
  const host = {
    vfs,
    loadVfs: (state, blob) => WebVfs.load(state, blob, fetchFile, d.uid, d.gid, d.index), // (with the host's files as they are now)
    state: new Uint8Array(d.state),
    uid: d.uid,
    gid: d.gid,
    cpus: d.cpus || 4,
    cwd: d.cwd || '/',
    trace: d.trace,
    traceExec: d.traceExec,
    traceShm: d.traceShm,
    traceCode: d.traceCode,
    spinMs: d.spinMs || 0,
    traceMaps: d.traceMaps,
    win64: d.win64,
    peek: d.peek, // (addr:len,... to dump when a process dies)
    sharedSpace: d.sharedSpace !== false, // every process in one memory
    memLog: d.memLog || 0,
    display: d.display ? (msg, transfer) => post({ op: 'display', msg }, transfer) : null,
    displaySize: d.display,
    spawnThread: (info) => post(Object.assign({ op: 'spawn' }, info)),
    killThread: (tid) => post({ op: 'kill', tid }),
    // (through the kern channel: op 2 code, in pieces; 4 uncode; 5 drop)
    code: (space, addr, bytes, abi = 0) => timed('code', () => bytes.length, () => {
      if (kern && kern.ready()) {
        for (let off = 0; off < bytes.length || off === 0; off += kern.max) {
          const r = kern.call(2, space | (abi << 24), addr, bytes.length, off, bytes.subarray(off, off + kern.max));
          if (r < 0) throw new Error(`code ${addr.toString(16)}: ${r}`);
          if (!bytes.length) break;
        }
      } else syncRequest('POST', `${d.xlat}/xlat/code?space=${space}&addr=${addr.toString(16)}&abi=${abi}`, bytes);
      return 0;
    }),
    uncode: (space, addr, size) => timed('uncode', () => 0, () => {
      if (kern && kern.ready()) kern.call(4, space, addr, size, 0);
      else syncRequest('GET', `${d.xlat}/xlat/uncode?space=${space}&addr=${addr.toString(16)}&size=${size.toString(16)}`);
      return 0;
    }),
    dropSpace: (space) => timed('uncode', () => 0, () => {
      if (kern && kern.ready()) kern.call(5, space, 0, 0, 0);
      else syncRequest('GET', `${d.xlat}/xlat/drop?space=${space}`);
      return 0;
    }),
    write: (fd, bytes) => post({ op: 'write', fd, bytes }, [bytes.buffer]),
    exit: (code, k) => {
      k.done = true;
      const byNr = [...k.stats.byNr].sort((a, b) => b[1] - a[1]).slice(0, 12);
      post({ op: 'exit', code, syscalls: k.stats.syscalls, byNr, syncMs: Math.round(k.stats.syncMs), handlerMs: Math.round(k.stats.handlerMs),
        idleMs: Math.round(k.stats.idleMs), fetched: k.vfs.fetched });
    },
    log: (m) => post({ op: 'log', m }),
  };
  const now = () => performance.now();
  // (at snapshotAt, or once the screen has been still for 2 s after it, up to 20 s)
  function snapshotLater(k, waited = 0) {
    k.addTimer(waited ? 1000 : Number(d.snapshotAt || 30) * 1000, () => {
      if (k.host.display && k.lastPresent && now() - k.lastPresent < 2000 && waited < 20) return snapshotLater(k, waited + 1);
      const t0 = now();
      k.freeze(5000, (err) => {
        if (err) return k.log(`[snapshot] no: ${err}`);
        const t1 = now();
        const snap = k.snapshot();
        snapFile.truncate();
        const bytes = writeSnapshot(snap, (b) => snapFile.write(b));
        k.log(`[snapshot] ${k.threads.size} threads frozen in ${(t1 - t0).toFixed(0)} ms; saved ${(snapFile.size() / 1e6).toFixed(1)} MB ` +
          `(${snap.header.memory.pages} memory pages, ${(bytes / 1e6).toFixed(1)} MB of data) in ${(now() - t1).toFixed(0)} ms`);
        snapFile.close();
        if (d.snapshotExit) return host.exit(0, k);
        k.thaw();
      });
    });
  }
  try {
    if (d.restore) {
      const t0 = now();
      kernel = Kernel.restore(host, d.cfg, readSnapshot((n, into) => snapFile.read(n, into)));
      snapFile.close();
      kernel.log(`[restore] ${kernel.procs.size} processes, ${kernel.threads.size} threads in ${(now() - t0).toFixed(0)} ms`);
      if (d.run) kernel.spawnInit(d.run[0], d.run, kernel.wineEnv(d.env));
    } else {
      kernel = new Kernel(host, d.cfg);
      if (host.traceMaps) kernel.traceMaps();
      kernel.bootEpoch = d.bootEpoch;
      if (d.snapshot) snapshotLater(kernel);
    }
    kernel.dumpFlag = new Int32Array(d.bridge, 8, 1);
    post({ op: 'ksab', ksab: kernel.ksab, inputSab: kernel.inputSab });
    if (!d.restore) kernel.boot(d.argv, d.env);
    kernel.run();
  } catch (err) {
    post({ op: 'log', m: 'kernel: ' + (err.stack || err) });
    post({ op: 'exit', code: 127 });
  }
};
