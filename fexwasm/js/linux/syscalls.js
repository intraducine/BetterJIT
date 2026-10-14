// The syscalls of js/linux/kernel.js. Each handler gets (thread, a0..a5) as
// BigInts and returns a result (number or BigInt; negative errno) or BLOCK,
// or throws KError.
'use strict';

const K = require('./kernel.js');
const { DspFile, MixerFile } = require('./oss.js');
const { NtsyncDevice } = require('./ntsync.js');
const { SYS, E, O, AT, PROT, MAP, CLONE, SIG, SA, S_IF } = require('./abi.js');
const { Kernel, Retry, Mm, HostFile, BufferFile, DevFile, PipeEnd, Pipe, UnixSocket, EventFd, EpollFile, WaitQueue, Process,
  KError, fail, BLOCK, EXIT_THREAD, REDIRECTED, normPath, pageUp, pageDown, addr, addr64, i32, u32, big, POLLIN, POLLOUT,
  POLLERR, POLLHUP, POLLNVAL, PAGE, LOW_RESERVED, ADDR_LIMIT, TB_SIZE, GLOBAL, KUSER } = K;
const R = Kernel.R;

const sys = [];
const def = (name, fn) => {
  if (SYS[name] === undefined) throw new Error('no syscall ' + name);
  sys[SYS[name]] = fn;
};

// --- helpers ----------------------------------------------------------------------
function timespecMs(dv, p) {
  return Number(dv.getBigInt64(p, true)) * 1000 + Number(dv.getBigInt64(p + 8, true)) / 1e6;
}
function writeTimespec(dv, p, ms) {
  const s = Math.floor(ms / 1000);
  dv.setBigInt64(p, BigInt(s), true);
  dv.setBigInt64(p + 8, BigInt(Math.floor((ms - s * 1000) * 1e6)), true);
}
// Realtime from the epoch; the monotonic clocks from the boot epoch that every
// worker shares (js/linux/thread.js answers clock_gettime itself).
function clockMs(k, clk) {
  const abs = performance.timeOrigin + performance.now();
  if (clk === 0 || clk === 5 || clk === 8) return abs; // REALTIME(_COARSE), REALTIME_ALARM
  if (clk === 2 || clk === 3) return performance.now() - k.t0; // process / thread CPU time: wall time since start
  return abs - k.bootEpoch; // MONOTONIC, _RAW, _COARSE, BOOTTIME
}
// Waits until deadline (ms, performance.now() based): BLOCK until then, then 0.
function sleepUntil(k, t, deadline) {
  if (performance.now() >= deadline) return 0;
  if (!t.timer || t.timer.dead) t.timer = k.addTimer(deadline - performance.now(), () => k.makeRunnable(t));
  return BLOCK;
}
function writeStat(dv, p, st) {
  const b = (v) => BigInt(v || 0);
  dv.setBigUint64(p, b(st.dev ?? 0x801n), true);
  dv.setBigUint64(p + 8, b(st.ino), true);
  dv.setBigUint64(p + 16, b(st.nlink ?? 1), true);
  dv.setUint32(p + 24, st.mode >>> 0, true);
  dv.setUint32(p + 28, st.uid ?? 0, true);
  dv.setUint32(p + 32, st.gid ?? 0, true);
  dv.setUint32(p + 36, 0, true);
  dv.setBigUint64(p + 40, b(st.rdev), true);
  dv.setBigInt64(p + 48, b(st.size), true);
  dv.setBigInt64(p + 56, b(st.blksize ?? 4096), true);
  dv.setBigInt64(p + 64, b(st.blocks ?? Math.ceil(Number(st.size || 0) / 512)), true);
  const ts = (o, ns) => {
    ns = b(ns);
    dv.setBigInt64(p + o, ns / 1000000000n, true);
    dv.setBigInt64(p + o + 8, ns % 1000000000n, true);
  };
  ts(72, st.atimeNs);
  ts(88, st.mtimeNs);
  ts(104, st.ctimeNs);
  for (let i = 120; i < 144; i += 8) dv.setBigUint64(p + i, 0n, true);
}
function writeStatx(dv, p, st, mask) {
  const b = (v) => BigInt(v || 0);
  new Uint8Array(dv.buffer, p, 256).fill(0);
  dv.setUint32(p, 0x7ff, true); // stx_mask: STATX_BASIC_STATS
  dv.setUint32(p + 4, 4096, true); // blksize
  dv.setBigUint64(p + 8, 0n, true); // attributes
  dv.setUint32(p + 16, Number(st.nlink ?? 1), true);
  dv.setUint32(p + 20, st.uid ?? 0, true);
  dv.setUint32(p + 24, st.gid ?? 0, true);
  dv.setUint16(p + 28, st.mode & 0xffff, true);
  dv.setBigUint64(p + 32, b(st.ino), true);
  dv.setBigUint64(p + 40, b(st.size), true);
  dv.setBigUint64(p + 48, b(st.blocks ?? Math.ceil(Number(st.size || 0) / 512)), true);
  const ts = (o, ns) => {
    ns = b(ns);
    dv.setBigInt64(p + o, ns / 1000000000n, true);
    dv.setUint32(p + o + 8, Number(ns % 1000000000n), true);
  };
  ts(64, st.atimeNs); // atime
  ts(80, st.ctimeNs); // btime
  ts(96, st.ctimeNs); // ctime
  ts(112, st.mtimeNs); // mtime
  const rdev = b(st.rdev), dev = b(st.dev ?? 0x801n);
  dv.setUint32(p + 128, Number((rdev >> 8n) & 0xfffn), true);
  dv.setUint32(p + 132, Number(rdev & 0xffn), true);
  dv.setUint32(p + 136, Number((dev >> 8n) & 0xfffn), true);
  dv.setUint32(p + 140, Number(dev & 0xffn), true);
}

// iovec array -> [{p, n}]
function iovecs(t, p, cnt) {
  const dv = t.proc.mm.dv, out = [];
  if (cnt < 0 || cnt > 1024) fail(E.INVAL);
  for (let i = 0; i < cnt; i++) out.push({ p: Number(dv.getBigUint64(p + 16 * i, true) & 0xffffffffn), n: Number(dv.getBigUint64(p + 16 * i + 8, true)) });
  return out;
}
function gather(k, t, iov) {
  const total = iov.reduce((s, v) => s + v.n, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const v of iov) {
    out.set(k.bytes(t, v.p, v.n), o);
    o += v.n;
  }
  return out;
}
function scatter(k, t, iov, data, n) {
  let o = 0;
  for (const v of iov) {
    if (o >= n) break;
    const m = Math.min(v.n, n - o);
    k.bytes(t, v.p, m).set(data.subarray(o, o + m));
    o += m;
  }
}

// Reads into guest memory through a bounce buffer (the host may not read into shared memory).
function readInto(k, t, p, n, fn) {
  k.checkRange(t, p, n);
  const tmp = new Uint8Array(Math.min(n, 1 << 24));
  const r = fn(tmp);
  if (r === BLOCK) return BLOCK;
  if (r > 0) t.proc.mm.u8.set(tmp.subarray(0, r), p);
  return r;
}

// --- memory -----------------------------------------------------------------------
function codeChanged(k, proc, start, end, wasExec, isExec) {
  if (wasExec) { k.host.uncode(proc.space, start, end - start); k.codeGone(proc, start, end); }
  if (isExec) {
    ensurePrivateSpace(k, proc);
    k.host.code(proc.space, start, proc.mm.u8.slice(start, end), k.abiAt(proc.mm, start));
  }
}
// A forked child shares its parent's translator space until it maps code of its own.
function ensurePrivateSpace(k, proc) {
  if (proc.mm === k.sharedMm || (k.spaceUsers.get(proc.space) || 1) <= 1) return;
  k.spaceRef(proc.space, -1);
  proc.space = k.nextSpace++;
  k.spaceUsers.set(proc.space, 1);
  for (const v of proc.mm.vmas) if (v.prot & PROT.EXEC) k.host.code(proc.space, v.start, proc.mm.u8.slice(v.start, v.end), k.abiFor(v.name));
}
function execRanges(mm, start, end, owner) {
  const out = [];
  for (const v of mm.vmas) {
    if (v.end <= start || v.start >= end || !(v.prot & PROT.EXEC) || v.owner !== owner) continue;
    out.push([Math.max(v.start, start), Math.min(v.end, end)]);
  }
  return out;
}

def('mmap', function (t, a0, a1, a2, a3, a4, a5) {
  const proc = t.proc, mm = proc.mm;
  let want = addr64(a0);
  const len = pageUp(Number(a1)), prot = u32(a2), flags = u32(a3), fd = i32(a4), off = Number(a5);
  if (!len || len > mm.limit) fail(E.INVAL);
  if (off % PAGE) fail(E.INVAL);
  const anon = !!(flags & MAP.ANONYMOUS);
  let file = null;
  if (!anon) {
    file = proc.file(fd);
    if (!(file instanceof HostFile) && !(file instanceof BufferFile) && !file.mmapBytes) fail(E.NODEV);
  }
  const owner = proc.image;
  // KUSER_SHARED_DATA in a shared address space: one page for every process
  if ((want === KUSER || want === KUSER + PAGE) && len === PAGE && mm === this.sharedMm) return mapKuser(this, mm, want, file, flags, off);
  let a;
  if (flags & (MAP.FIXED | MAP.FIXED_NOREPLACE)) {
    if (want % PAGE) fail(E.INVAL);
    if (want < LOW_RESERVED || want + len > mm.limit) fail(E.NOMEM);
    if ((flags & MAP.FIXED_NOREPLACE) && !(flags & MAP.FIXED) && !mm.isFree(want, want + len)) fail(E.EXIST);
    // (another process's mappings, in a shared address space, stay)
    if (mm.foreign(want, want + len, owner)) {
      if (this.host.traceExec) this.log(`[pid ${proc.pid}] mmap MAP_FIXED ${want.toString(16)}+${len.toString(16)} over another process's mappings`);
      fail(E.NOMEM);
    }
    a = want;
  } else {
    want = want === Infinity ? 0 : pageDown(want);
    a = want && mm.isFree(want, want + len) ? want : mm.findFree(len);
    if (a < 0) fail(E.NOMEM);
  }
  const old = execRanges(mm, a, a + len, owner);
  mm.ensure(a + len, {operation:'mmap',pid:proc.pid,tid:t.tid,space:proc.space,executable:proc.exe,
    requestedAddress:a,requestedLength:len,protection:prot,flags});
  mm.cut(a, a + len, owner);
  for (const [s, e] of old) k_uncode(this, proc, s, e);
  mm.zero(a, a + len);
  const vma = { start: a, end: a + len, prot, flags, name: anon ? '' : file.path || '', owner };
  const sf = !anon && (flags & MAP.TYPE) === MAP.SHARED ? this.sharedFile(file) : null;
  const sfp = !anon && !sf ? this.sharedFile(file, true) : null; // a private mapping of a shared file
  if (sf || sfp) {
    vma.file = { path: file.path, offset: off };
    if (sf) {
      vma.shared = sf;
      this.mapShared(mm, sf, a, len, off);
    } else {
      vma.sharedPriv = sfp;
      mm.u8.set(this.sharedBytes(sfp, off, len), a);
      sfp.mms.add(mm);
    }
    mm.markDirty(a, a + len);
  } else if (!anon) {
    vma.file = { path: file.path, offset: off };
    const u8 = mm.u8;
    if (file.mmapBytes) {
      const b = file.mmapBytes();
      u8.set(b.subarray(Math.min(off, b.length), Math.min(off + len, b.length)), a);
    } else {
      const tmp = new Uint8Array(len);
      const n = file instanceof HostFile ? file.vfs.pread(file.fd, tmp, off) : file.pread(this, t, tmp, off);
      u8.set(tmp.subarray(0, n), a);
    }
    mm.markDirty(a, a + len);
  } else if (prot & (PROT.WRITE | PROT.EXEC)) {
    mm.markDirty(a, a + len);
  }
  mm.insert(vma);
  if (prot & PROT.EXEC) codeChanged(this, proc, a, a + len, false, true);
  return a;
});
function k_uncode(k, proc, s, e) {
  k.host.uncode(proc.space, s, e - s);
  k.codeGone(proc, s, e);
}
// The shared pages at KUSER_SHARED_DATA (reserved when the shared memory is
// made): Wine allocates it, then maps the wineserver's section over it
// (MAP_SHARED); the first such mapping makes the page a view of the file.
// The next page has the syscall dispatcher pointer, patched to be the same
// for every process (Wine's signal_init_process); they each write it, and
// make it executable, with mprotect (which global pages take from anyone).
function mapKuser(k, mm, a, file, flags, off) {
  const v = mm.vmas.find((x) => x.owner === GLOBAL && x.start === a);
  if (file && (flags & MAP.TYPE) === MAP.SHARED && !v.shared) {
    const sf = k.sharedFile(file);
    if (sf) {
      Object.assign(v, { shared: sf, file: { path: file.path, offset: off }, flags, name: file.path });
      mm.version++;
      k.mapShared(mm, sf, a, PAGE, off);
      mm.markDirty(a, a + PAGE);
    }
  }
  return a;
}

def('munmap', function (t, a0, a1) {
  const mm = t.proc.mm, a = addr64(a0), len = pageUp(Number(a1));
  if (a === Infinity) return 0; // nothing is mapped up there
  if (a % PAGE || !len) fail(E.INVAL);
  this.syncShared(t.proc);
  const owner = t.proc.image;
  for (const [s, e] of execRanges(mm, a, a + len, owner)) k_uncode(this, t.proc, s, e);
  mm.cut(a, a + len, owner);
  return 0;
});

def('mprotect', function (t, a0, a1, a2) {
  const mm = t.proc.mm, a = addr64(a0), len = pageUp(Number(a1)), prot = u32(a2);
  if (a === Infinity) fail(E.NOMEM);
  if (a % PAGE) fail(E.INVAL);
  if (!len) return 0;
  const end = a + len, owner = t.proc.image;
  // every page must be mapped (by this process)
  let cur = a;
  for (const v of mm.vmas) {
    if (v.owner !== owner && v.owner !== GLOBAL) continue;
    if (v.end <= cur) continue;
    if (v.start > cur) break;
    cur = v.end;
    if (cur >= end) break;
  }
  if (cur < end) fail(E.NOMEM);
  const pieces = [];
  for (const v of mm.vmas) {
    if (v.end <= a || v.start >= end || (v.owner !== owner && v.owner !== GLOBAL)) continue;
    pieces.push(Object.assign({}, v, { start: Math.max(v.start, a), end: Math.min(v.end, end) }));
  }
  for (const p of pieces) {
    const wasExec = !!(p.prot & PROT.EXEC), isExec = !!(prot & PROT.EXEC);
    const off = p.start - pieces[0].start;
    const np = Object.assign({}, p, { prot });
    if (np.file) np.file = Object.assign({}, np.file);
    mm.insert(np);
    // a private view of a shared file turning read-only: catch up with the file
    if (np.sharedPriv && (p.prot & PROT.WRITE) && !(prot & PROT.WRITE)) {
      mm.u8.set(this.sharedBytes(np.sharedPriv, np.file.offset, np.end - np.start), np.start);
    }
    if (prot & (PROT.WRITE | PROT.EXEC)) mm.markDirty(p.start, p.end);
    // executable code: (re)send it when it becomes executable or stops being writable
    if (wasExec && !isExec) k_uncode(this, t.proc, p.start, p.end);
    else if (isExec && (!wasExec || (p.prot & PROT.WRITE && !(prot & PROT.WRITE)))) codeChanged(this, t.proc, p.start, p.end, false, true);
    void off;
  }
  return 0;
});

def('brk', function (t, a0) {
  const proc = t.proc, mm = proc.mm, want = addr(a0);
  if (!want || want < proc.brkStart) return proc.brk;
  const oldEnd = pageUp(proc.brk), newEnd = pageUp(want);
  if (newEnd > oldEnd) {
    if (!mm.isFree(oldEnd, newEnd)) return proc.brk;
    mm.ensure(newEnd);
    mm.zero(oldEnd, newEnd);
    mm.insert({ start: oldEnd, end: newEnd, prot: PROT.READ | PROT.WRITE, flags: MAP.PRIVATE | MAP.ANONYMOUS, name: '[heap]', owner: proc.image });
    mm.markDirty(oldEnd, newEnd);
  } else if (newEnd < oldEnd) {
    mm.cut(newEnd, oldEnd, proc.image);
  }
  proc.brk = want;
  return want;
});

def('madvise', function (t, a0, a1, a2) {
  const a = addr64(a0), len = pageUp(Number(a1)), adv = i32(a2);
  if (a === Infinity) fail(E.NOMEM);
  if (adv === 4) { // MADV_DONTNEED: private anonymous pages read back as zero
    const mm = t.proc.mm;
    for (const v of mm.vmas) {
      if (v.end <= a || v.start >= a + len || v.file || (v.flags & MAP.TYPE) === MAP.SHARED || v.owner !== t.proc.image) continue;
      mm.zero(Math.max(v.start, a), Math.min(v.end, a + len));
      if (v.prot & PROT.WRITE) mm.markDirty(Math.max(v.start, a), Math.min(v.end, a + len));
    }
  }
  return 0;
});

def('mremap', function (t, a0, a1, a2, a3, a4) {
  const mm = t.proc.mm, old = addr(a0), oldLen = pageUp(Number(a1)), newLen = pageUp(Number(a2)), flags = u32(a3);
  const owner = t.proc.image;
  if (old % PAGE || !newLen) fail(E.INVAL);
  const v = mm.vmas.find((x) => x.start <= old && old < x.end && x.owner === owner);
  if (!v) fail(E.FAULT);
  if (newLen <= oldLen) {
    if (newLen < oldLen) mm.cut(old + newLen, old + oldLen, owner);
    return old;
  }
  if (!(flags & 2) && mm.isFree(old + oldLen, old + newLen)) { // grow in place
    mm.ensure(old + newLen);
    mm.zero(old + oldLen, old + newLen);
    mm.insert(Object.assign({}, v, { start: old + oldLen, end: old + newLen, file: undefined }));
    if (v.prot & PROT.WRITE) mm.markDirty(old + oldLen, old + newLen);
    return old;
  }
  if (!(flags & 1)) fail(E.NOMEM); // MREMAP_MAYMOVE
  const n = (flags & 2) ? addr(a4) : mm.findFree(newLen);
  if (n < 0) fail(E.NOMEM);
  if (mm.foreign(n, n + newLen, owner)) fail(E.NOMEM);
  mm.ensure(n + newLen);
  mm.cut(n, n + newLen, owner);
  mm.zero(n, n + newLen);
  const u8 = mm.u8;
  u8.copyWithin(n, old, old + oldLen);
  mm.markDirty(n, n + newLen);
  mm.insert(Object.assign({}, v, { start: n, end: n + newLen }));
  if (v.prot & PROT.EXEC) {
    k_uncode(this, t.proc, old, old + oldLen);
    codeChanged(this, t.proc, n, n + newLen, false, true);
  }
  mm.cut(old, old + oldLen, owner);
  return n;
});

// fexwasm display (Wine's dlls/win32u/wasmdrv.c): what windows show and
// where, for the host to compose (host.display(msg, transfer)), and input
// from the host (Kernel.inputSab).
// present(hwnd, {i32 x, y, w, h, surf_w, surf_h, stride, pad; u64 bits}):
// the dirty rectangle's pixels (32-bit BGRX), copied now.
sys[0x46574410] = function (t, a0, a1) {
  if (!this.host.display) return 0;
  const dv = t.proc.mm.dv, p = addr(a1), g = (o) => dv.getInt32(p + o, true);
  const sw = g(16), sh = g(20), stride = g(24), bits = Number(dv.getBigUint64(p + 32, true) & 0xffffffffn);
  const x = Math.max(0, g(0)), y = Math.max(0, g(4)), w = Math.min(g(8), sw - x), h = Math.min(g(12), sh - y);
  if (w <= 0 || h <= 0) return 0;
  this.checkRange(t, bits, stride * sh);
  this.displayWindow(u32(a0)).surface = { bits, sw, sh, stride };
  this.lastPresent = this.now();
  this.presentRect(t.proc.mm, u32(a0), bits, sw, sh, stride, x, y, w, h);
  return 0;
};
// (the kernel remembers each window's frame and surface: a restored system
// shows them again, see snapshot.js)
Kernel.prototype.displayWindow = function (hwnd) {
  let w = this.displayWindows.get(hwnd);
  if (!w) this.displayWindows.set(hwnd, (w = { frame: null, surface: null }));
  return w;
};
Kernel.prototype.presentRect = function (mm, hwnd, bits, sw, sh, stride, x, y, w, h) {
  const px = new Uint8Array(w * h * 4), u8 = mm.u8;
  for (let r = 0; r < h; r++) {
    const at = bits + (y + r) * stride + x * 4;
    px.set(u8.subarray(at, at + w * 4), r * w * 4);
  }
  this.host.display({ op: 'present', hwnd, x, y, w, h, sw, sh, px }, [px.buffer]);
};
// frame(hwnd, {i32 visible rect x, y, w, h, client x, y, w, h, visible; u32 swp flags; u64 insert after})
sys[0x46574411] = function (t, a0, a1) {
  if (!this.host.display) return 0;
  const dv = t.proc.mm.dv, p = addr(a1), g = (o) => dv.getInt32(p + o, true);
  const m = { op: 'frame', hwnd: u32(a0), v: [g(0), g(4), g(8), g(12)], c: [g(16), g(20), g(24), g(28)], visible: !!g(32),
    swp: g(36) >>> 0, after: Number(BigInt.asIntN(64, dv.getBigUint64(p + 40, true))) };
  const dw = this.displayWindow(m.hwnd);
  if (!(m.swp & 0x4)) dw.topmost = m.after === -1 ? true : m.after === -2 ? false : dw.topmost; // (SWP_NOZORDER; HWND_(NO)TOPMOST)
  dw.frame = m;
  this.host.display(m);
  return 0;
};
sys[0x46574412] = function (t, a0) {
  this.displayWindows.delete(u32(a0));
  if (this.host.display) this.host.display({ op: 'destroy', hwnd: u32(a0) });
  return 0;
};
// input(buf, max): events waiting, as {u32 type, i32 x, y, u32 flags, data}
sys[0x46574413] = function (t, a0, a1) {
  const r = this.input32, dv = t.proc.mm.dv, p = addr(a0), max = u32(a1);
  let n = 0;
  for (let rd = Atomics.load(r, 1), wr = Atomics.load(r, 0); rd !== wr && n < max; rd = (rd + 1) | 0, n++) {
    const e = 2 + (((rd % K.INPUT_RING) + K.INPUT_RING) % K.INPUT_RING) * 5;
    for (let i = 0; i < 5; i++) dv.setInt32(p + 20 * n + 4 * i, r[e + i], true);
    Atomics.store(r, 1, (rd + 1) | 0);
  }
  if (Atomics.load(r, 0) === Atomics.load(r, 1)) for (const f of this.inputFds) f.value = 0n; // (nothing more: not readable)
  if (n && this.host.traceInput) this.log(`[input] pid ${t.proc.pid} tid ${t.tid} took ${n} events`);
  return n;
};
// input_fd(eventfd): made readable while input waits (the driver's thread's queue fd)
sys[0x46574414] = function (t, a0) {
  const f = t.proc.file(i32(a0));
  if (!(f instanceof EventFd)) fail(E.INVAL);
  this.inputFds.add(f);
  if (this.host.traceInput) this.log(`[input] pid ${t.proc.pid} tid ${t.tid} gets input (fd ${i32(a0)})`);
  this.checkInput();
  return 0;
};

// fexwasm: the first free aligned range of len bytes in [lo, hi) from
// from, going up (step > 0) or down: for Wine in a shared address space,
// where it can't see what other processes have mapped (map_free_area)
sys[0x46574402] = function (t, a0, a1, a2, a3, a4) {
  const lo = addr64(a0), hi = Math.min(addr64(a1), ADDR_LIMIT), from = addr64(a2), len = pageUp(Number(a3)), step = Number(BigInt.asIntN(64, a4));
  if (!len || !step || lo === Infinity) return -E.NOMEM;
  const al = Math.abs(step);
  // (from above what we have: the highest start that fits)
  const f = from + len > hi ? (step > 0 ? -1 : Math.floor((hi - len) / al) * al) : from;
  if (f < 0) return -E.NOMEM;
  const a = t.proc.mm.findFreeIn(lo, hi, f, len, step);
  return a < 0 ? -E.NOMEM : a;
};

def('msync', () => 0);
def('mincore', function (t, a0, a1, a2) {
  const n = pageUp(Number(a1)) / PAGE;
  this.bytes(t, addr(a2), n).fill(1);
  return 0;
});
def('mlock', () => 0);
def('munlock', () => 0);
def('membarrier', (t, a0) => (i32(a0) === 0 ? 0 : 0));

// --- identity and system information ---------------------------------------------------------
def('getpid', (t) => t.proc.pid);
def('gettid', (t) => t.tid);
def('getppid', (t) => t.proc.ppid);
def('getuid', function () { return this.uid(); });
def('geteuid', function () { return this.uid(); });
def('getgid', function () { return this.gid(); });
def('getegid', function () { return this.gid(); });
def('getresuid', function (t, a0, a1, a2) {
  const dv = t.proc.mm.dv;
  for (const p of [a0, a1, a2]) dv.setUint32(addr(p), this.uid(), true);
  return 0;
});
def('getresgid', function (t, a0, a1, a2) {
  const dv = t.proc.mm.dv;
  for (const p of [a0, a1, a2]) dv.setUint32(addr(p), this.gid(), true);
  return 0;
});
for (const n of ['setuid', 'setgid', 'setreuid', 'setregid', 'setresuid', 'setresgid', 'setgroups']) def(n, () => 0);
def('getgroups', () => 0);
def('getpgrp', (t) => t.proc.pgid);
def('getpgid', function (t, a0) {
  const pid = i32(a0), p = pid ? this.procs.get(pid) : t.proc;
  if (!p) fail(E.SRCH);
  return p.pgid;
});
def('setpgid', function (t, a0, a1) {
  const pid = i32(a0), pg = i32(a1), p = pid ? this.procs.get(pid) : t.proc;
  if (!p) fail(E.SRCH);
  p.pgid = pg || p.pid;
  return 0;
});
def('getsid', function (t, a0) {
  const pid = i32(a0), p = pid ? this.procs.get(pid) : t.proc;
  if (!p) fail(E.SRCH);
  return p.sid;
});
def('setsid', (t) => {
  t.proc.sid = t.proc.pgid = t.proc.pid;
  return t.proc.pid;
});
def('umask', (t, a0) => {
  const o = t.proc.umask;
  t.proc.umask = u32(a0) & 0o777;
  return o;
});
def('uname', function (t, a0) {
  const u8 = this.bytes(t, addr(a0), 390);
  u8.fill(0);
  const put = (i, s) => u8.set(new TextEncoder().encode(s), i * 65);
  put(0, 'Linux');
  put(1, this.host.hostname || 'madeira');
  put(2, '6.6.0-fexwasm');
  put(3, '#1 SMP');
  put(4, 'x86_64');
  put(5, '(none)');
  return 0;
});
def('sysinfo', function (t, a0) {
  const dv = t.proc.mm.dv, p = addr(a0);
  new Uint8Array(dv.buffer, p, 112).fill(0);
  dv.setBigInt64(p, BigInt(Math.floor((performance.now() + 1e6) / 1000)), true); // uptime
  const total = BigInt(this.host.totalRam || 8 * 2 ** 30);
  dv.setBigUint64(p + 32, total, true); // totalram
  dv.setBigUint64(p + 40, total / 2n, true); // freeram
  dv.setUint16(p + 80, this.procs.size, true); // procs
  dv.setUint32(p + 104, 1, true); // mem_unit
  return 0;
});
function rlimit(proc, r) {
  const d = { 3: [8n << 20n, -1n], 7: [1024n, 4096n] }[r] || [-1n, -1n]; // STACK, NOFILE
  return proc.rlimits.get(r) || d;
}
def('getrlimit', function (t, a0, a1) {
  const [cur, max] = rlimit(t.proc, i32(a0)), dv = t.proc.mm.dv, p = addr(a1);
  dv.setBigInt64(p, cur, true);
  dv.setBigInt64(p + 8, max, true);
  return 0;
});
def('setrlimit', function (t, a0, a1) {
  const dv = t.proc.mm.dv, p = addr(a1);
  t.proc.rlimits.set(i32(a0), [dv.getBigInt64(p, true), dv.getBigInt64(p + 8, true)]);
  return 0;
});
def('prlimit64', function (t, a0, a1, a2, a3) {
  const pid = i32(a0), p = pid ? this.procs.get(pid) : t.proc;
  if (!p) fail(E.SRCH);
  const r = i32(a1), dv = t.proc.mm.dv;
  const old = rlimit(p, r);
  if (addr(a2)) p.rlimits.set(r, [dv.getBigInt64(addr(a2), true), dv.getBigInt64(addr(a2) + 8, true)]);
  if (addr(a3)) {
    dv.setBigInt64(addr(a3), old[0], true);
    dv.setBigInt64(addr(a3) + 8, old[1], true);
  }
  return 0;
});
def('getrusage', function (t, a0, a1) {
  const dv = t.proc.mm.dv, p = addr(a1);
  new Uint8Array(dv.buffer, p, 144).fill(0);
  const ms = performance.now() - this.t0;
  dv.setBigInt64(p, BigInt(Math.floor(ms / 1000)), true);
  dv.setBigInt64(p + 8, BigInt(Math.floor((ms % 1000) * 1000)), true);
  return 0;
});
def('times', function (t, a0) {
  const ticks = BigInt(Math.floor((performance.now() - this.t0) / 10));
  if (addr(a0)) {
    const dv = t.proc.mm.dv, p = addr(a0);
    dv.setBigInt64(p, ticks, true);
    for (let i = 8; i < 32; i += 8) dv.setBigInt64(p + i, 0n, true);
  }
  return ticks;
});
def('getrandom', function (t, a0, a1) {
  const n = Math.min(Number(a1), 1 << 20), b = new Uint8Array(n);
  for (let o = 0; o < n; o += 65536) crypto.getRandomValues(b.subarray(o, Math.min(n, o + 65536)));
  this.bytes(t, addr(a0), n).set(b);
  return n;
});
def('prctl', function (t, a0, a1) {
  const op = i32(a0);
  if (op === 15) { t.name = this.str(t, addr(a1), 16); return 0; } // PR_SET_NAME
  if (op === 16) { this.bytes(t, addr(a1), 16).fill(0); this.bytes(t, addr(a1), 16).set(new TextEncoder().encode((t.name || 'thread').slice(0, 15))); return 0; }
  if (op === 38 || op === 4 || op === 1 || op === 36 || op === 0x59616d61) return 0; // NO_NEW_PRIVS, SET_DUMPABLE, SET_PDEATHSIG, CHILD_SUBREAPER, SET_PTRACER
  if (op === 3) return 1; // GET_DUMPABLE
  fail(E.INVAL);
});
def('arch_prctl', function (t, a0, a1) {
  const c = this.cpu(t), code = i32(a0);
  if (code === 0x1002) { c.setFs(BigInt.asUintN(64, a1)); return 0; } // ARCH_SET_FS
  if (code === 0x1001) { c.setGs(BigInt.asUintN(64, a1)); return 0; } // ARCH_SET_GS
  if (code === 0x1003) { t.proc.mm.dv.setBigUint64(addr(a1), c.fs(), true); return 0; }
  if (code === 0x1004) { t.proc.mm.dv.setBigUint64(addr(a1), c.gs(), true); return 0; }
  fail(E.INVAL);
});
def('set_tid_address', (t, a0) => {
  t.clearTid = addr(a0);
  return t.tid;
});
def('set_robust_list', (t, a0) => { t.robustList = addr(a0); return 0; });
def('get_robust_list', () => fail(E.PERM));
def('rseq', () => fail(E.NOSYS));
def('sched_yield', () => 0);
def('sched_getaffinity', function (t, a0, a1, a2) {
  const n = Number(a1), cpus = this.host.cpus || 4;
  if (n < 8) fail(E.INVAL);
  const b = this.bytes(t, addr(a2), 8);
  b.fill(0);
  for (let i = 0; i < cpus; i++) b[i >> 3] |= 1 << (i & 7);
  return 8;
});
def('sched_setaffinity', () => 0);
def('sched_getscheduler', () => 0);
def('sched_setscheduler', () => 0);
def('sched_getparam', function (t, a0, a1) { t.proc.mm.dv.setInt32(addr(a1), 0, true); return 0; });
def('sched_setparam', () => 0);
def('sched_get_priority_max', () => 0);
def('sched_get_priority_min', () => 0);
def('getpriority', () => 20);
def('setpriority', () => 0);
def('capget', function (t, a0, a1) {
  if (addr(a1)) this.bytes(t, addr(a1), 24).fill(0);
  return 0;
});
def('personality', () => 0);
def('getcpu', function (t, a0, a1) {
  if (addr(a0)) t.proc.mm.dv.setUint32(addr(a0), 0, true);
  if (addr(a1)) t.proc.mm.dv.setUint32(addr(a1), 0, true);
  return 0;
});

// --- time ---------------------------------------------------------------------------------
def('clock_gettime', function (t, a0, a1) {
  writeTimespec(t.proc.mm.dv, addr(a1), clockMs(this, i32(a0)));
  return 0;
});
def('clock_getres', function (t, a0, a1) {
  if (addr(a1)) writeTimespec(t.proc.mm.dv, addr(a1), 0.000001);
  return 0;
});
def('gettimeofday', function (t, a0) {
  if (addr(a0)) {
    const ms = clockMs(this, 0), dv = t.proc.mm.dv, s = Math.floor(ms / 1000);
    dv.setBigInt64(addr(a0), BigInt(s), true);
    dv.setBigInt64(addr(a0) + 8, BigInt(Math.floor((ms - s * 1000) * 1000)), true);
  }
  return 0;
});
def('time', function (t, a0) {
  const s = BigInt(Math.floor(clockMs(this, 0) / 1000));
  if (addr(a0)) t.proc.mm.dv.setBigInt64(addr(a0), s, true);
  return s;
});
def('nanosleep', function (t, a0) {
  if (t.sleepUntil === undefined) t.sleepUntil = performance.now() + timespecMs(t.proc.mm.dv, addr(a0));
  const r = sleepUntil(this, t, t.sleepUntil);
  if (r !== BLOCK) t.sleepUntil = undefined;
  return r;
});
def('clock_nanosleep', function (t, a0, a1, a2) {
  if (t.sleepUntil === undefined) {
    const ms = timespecMs(t.proc.mm.dv, addr(a2)), clk = i32(a0);
    t.sleepUntil = i32(a1) & 1 ? performance.now() + (ms - clockMs(this, clk)) : performance.now() + ms; // TIMER_ABSTIME
  }
  const r = sleepUntil(this, t, t.sleepUntil);
  if (r !== BLOCK) t.sleepUntil = undefined;
  return r;
});

// --- signals (actions and masks; delivery is TODO) ---------------------------------------------
def('rt_sigaction', function (t, a0, a1, a2) {
  const sig = i32(a0), dv = t.proc.mm.dv;
  if (sig < 1 || sig > 64 || ((sig === SIG.KILL || sig === SIG.STOP) && addr(a1))) fail(E.INVAL);
  const a = t.proc.actions[sig];
  if (addr(a2)) {
    const p = addr(a2);
    dv.setBigUint64(p, a.handler, true);
    dv.setBigUint64(p + 8, a.flags, true);
    dv.setBigUint64(p + 16, a.restorer, true);
    dv.setBigUint64(p + 24, a.mask, true);
  }
  if (addr(a1)) {
    const p = addr(a1);
    t.proc.actions[sig] = { handler: dv.getBigUint64(p, true), flags: dv.getBigUint64(p + 8, true), restorer: dv.getBigUint64(p + 16, true), mask: dv.getBigUint64(p + 24, true) };
  }
  return 0;
});
def('rt_sigprocmask', function (t, a0, a1, a2) {
  const how = i32(a0), dv = t.proc.mm.dv;
  const old = t.sigmask;
  if (addr(a1)) {
    const s = dv.getBigUint64(addr(a1), true) & ~((1n << 8n) | (1n << 18n)); // not KILL, STOP
    t.sigmask = how === 0 ? old | s : how === 1 ? old & ~s : how === 2 ? s : fail(E.INVAL);
  }
  if (addr(a2)) dv.setBigUint64(addr(a2), old, true);
  return 0;
});
def('rt_sigpending', function (t, a0) {
  t.proc.mm.dv.setBigUint64(addr(a0), t.pending, true);
  return 0;
});
def('sigaltstack', function (t, a0, a1) {
  const dv = t.proc.mm.dv;
  if (addr(a1)) {
    const p = addr(a1), s = t.altstack || { sp: 0n, flags: 2, size: 0n }; // SS_DISABLE
    dv.setBigUint64(p, s.sp, true);
    dv.setInt32(p + 8, s.flags, true);
    dv.setBigUint64(p + 16, s.size, true);
  }
  if (addr(a0)) {
    const p = addr(a0);
    t.altstack = { sp: dv.getBigUint64(p, true), flags: dv.getInt32(p + 8, true), size: dv.getBigUint64(p + 16, true) };
  }
  return 0;
});
def('rt_sigsuspend', function (t, a0) {
  t.suspendMask = t.sigmask;
  t.sigmask = t.proc.mm.dv.getBigUint64(addr(a0), true) & ~((1n << 8n) | (1n << 18n));
  return this.pendingFor(t) ? -E.INTR : new Retry(() => BLOCK); // a signal interrupts it (kick)
});
def('pause', () => new Retry(() => BLOCK));
def('rt_sigreturn', function (t) { return this.sigreturn(t); });
def('rt_sigtimedwait', function (t, a0, a1, a2) {
  if (!addr(a2)) return BLOCK;
  if (t.sleepUntil === undefined) t.sleepUntil = performance.now() + timespecMs(t.proc.mm.dv, addr(a2));
  const r = sleepUntil(this, t, t.sleepUntil);
  if (r === BLOCK) return r;
  t.sleepUntil = undefined;
  fail(E.AGAIN);
});
def('kill', function (t, a0, a1) {
  const info = { code: 0, pid: t.proc.pid };
  const pid = i32(a0), sig = i32(a1);
  let targets;
  if (pid > 0) targets = [this.procs.get(pid)].filter(Boolean);
  else if (pid === 0) targets = [...this.procs.values()].filter((p) => p.pgid === t.proc.pgid);
  else if (pid === -1) targets = [...this.procs.values()].filter((p) => p.pid > 1 && p !== t.proc);
  else targets = [...this.procs.values()].filter((p) => p.pgid === -pid);
  targets = targets.filter((p) => !p.zombie);
  if (!targets.length) fail(E.SRCH);
  if (sig) for (const p of targets) this.signalProcess(p, sig, info);
  return 0;
});
def('tgkill', function (t, a0, a1, a2) {
  const th = this.threads.get(i32(a1));
  if (!th || (i32(a0) > 0 && th.proc.pid !== i32(a0))) fail(E.SRCH);
  if (i32(a2)) this.signalThread(th, i32(a2), { code: -6, pid: t.proc.pid }); // SI_TKILL
  return 0;
});
def('tkill', function (t, a0, a1) {
  const th = this.threads.get(i32(a0));
  if (!th) fail(E.SRCH);
  if (i32(a1)) this.signalThread(th, i32(a1), { code: -6, pid: t.proc.pid });
  return 0;
});

// --- processes and threads ---------------------------------------------------------------------
function copyThreadState(k, fromMm, fromTb, toMm, toTb) {
  const n = k.cfg.ctx + k.cfg.stateSize;
  const src = fromMm.u8.slice(fromTb, fromTb + n);
  const dst = toMm.u8;
  dst.fill(0, toTb, toTb + n);
  dst.set(src.subarray(0x40, 0x58), toTb + 0x40); // lazy flag state
  dst.set(src.subarray(0x70, 0x74), toTb + 0x70); // rounding mode
  dst.set(src.subarray(k.cfg.ctx), toTb + k.cfg.ctx);
}

function doClone(k, t, flags, newsp, ptid, ctid, tls) {
  const proc = t.proc;
  const parentCpu = k.cpu(t);
  const nextRip = parentCpu.get(R.RCX); // the syscall instruction put the return RIP in RCX
  if (flags & CLONE.THREAD) {
    if (!(flags & CLONE.VM) || !(flags & CLONE.SIGHAND)) fail(E.INVAL);
    const tid = k.newTid();
    const mm = proc.mm;
    const tb = k.allocTb(mm, proc.image);
    copyThreadState(k, mm, t.tb, mm, tb);
    const c = k.cpu({ proc, tb });
    c.set(R.RAX, 0);
    if (newsp) c.set(R.RSP, newsp);
    if (flags & CLONE.SETTLS) c.setFs(tls);
    c.setRip(nextRip);
    if (flags & CLONE.PARENT_SETTID) mm.dv.setInt32(ptid, tid, true);
    if (flags & CLONE.CHILD_SETTID) mm.dv.setInt32(ctid, tid, true);
    const nt = k.startThread(proc, tid, tb);
    if (flags & CLONE.CHILD_CLEARTID) nt.clearTid = ctid;
    nt.sigmask = t.sigmask;
    return tid;
  }
  // a new process
  const child = new Process(k, k.nextPid++, (flags & CLONE.PARENT) ? proc.ppid : proc.pid);
  child.pgid = proc.pgid;
  child.sid = proc.sid;
  child.cwd = proc.cwd;
  child.umask = proc.umask;
  child.exe = proc.exe;
  child.argv = proc.argv;
  child.actions = proc.actions.map((a) => Object.assign({}, a));
  child.rlimits = new Map(proc.rlimits);
  child.brkStart = proc.brkStart;
  child.brk = proc.brk;
  let tb;
  // Check worker capacity before allocating an image. No process or file
  // reference is published until all of its guest state has been prepared.
  k.allocSlot();
  try {
  if (flags & CLONE.VM) {
    // vfork / posix_spawn: the child runs in our memory (and image) until it execs or exits
    child.mm = proc.mm;
    child.mm.users++;
    child.image = proc.image;
    child.ownsImage = false;
    tb = k.allocTb(child.mm, proc.image);
    copyThreadState(k, proc.mm, t.tb, child.mm, tb);
    child.space = proc.space;
    k.spaceRef(proc.space, 1);
  } else {
    // a copy of our mappings (only ours, in a shared address space) in a memory of its own
    child.image = { image: proc.exe, forkOf: proc.pid };
    child.ownsImage = true;
    child.mm = proc.mm.clone(proc.image, child.image);
    child.mm.users = 1;
    // only the calling thread lives on in the child
    for (const v of child.mm.vmas.filter((v) => v.kernel && v.start !== t.tb)) child.mm.cut(v.start, v.end);
    tb = t.tb;
    // its worker starts with empty dispatcher tables
    child.mm.u8.fill(0, tb + 0x2_0000, tb + TB_SIZE);
    if (proc.mm === k.sharedMm) {
      // (the shared memory's translator space has everyone's code, and changes with it)
      child.space = k.nextSpace++;
      k.spaceUsers.set(child.space, 1);
      for (const v of child.mm.vmas) if (v.prot & PROT.EXEC) k.host.code(child.space, v.start, child.mm.u8.slice(v.start, v.end), k.abiFor(v.name));
    } else {
      child.space = proc.space;
      k.spaceRef(proc.space, 1);
    }
  }
  const c = k.cpu({ proc: child, tb });
  c.set(R.RAX, 0);
  if (newsp) c.set(R.RSP, newsp);
  if (flags & CLONE.SETTLS) c.setFs(tls);
  c.setRip(nextRip);
  if (flags & CLONE.PARENT_SETTID) proc.mm.dv.setInt32(ptid, child.pid, true);
  if (flags & CLONE.CHILD_SETTID) child.mm.dv.setInt32(ctid, child.pid, true);
  } catch (error) {
    if (child.mm) {
      if ((flags & CLONE.VM) && tb) child.mm.cut(tb, tb + TB_SIZE, child.image);
      k.releaseImage(child);
    }
    if (error instanceof KError && error.code === E.NOMEM)
      k.log?.(`[pid ${proc.pid}] fork: memory allocation failed; no child created`);
    throw error;
  }
  for (const [fd, e] of proc.fds) child.fds.set(fd, { file: e.file.ref(), cloexec: e.cloexec });
  k.procs.set(child.pid, child);
  proc.children.add(child.pid);
  const nt = k.startThread(child, child.pid, tb);
  if (flags & CLONE.CHILD_CLEARTID) nt.clearTid = ctid;
  nt.sigmask = t.sigmask;
  if (flags & CLONE.VFORK) {
    child.vforkParent = t;
    return { vfork: child, pid: child.pid };
  }
  return child.pid;
}

def('clone', function (t, a0, a1, a2, a3, a4) {
  // x86-64: clone(flags, newsp, parent_tid, child_tid, tls)
  const r = doClone(this, t, Number(BigInt.asUintN(64, a0) & 0xffffffffn), addr(a1), addr(a2), addr(a3), BigInt.asUintN(64, a4));
  if (typeof r === 'object') return vforkWait(this, t, r.vfork, r.pid);
  return r;
});
function vforkWait(k, t, child, pid) {
  // parked until the child execs or exits (both clear vforkParent and wake us)
  const check = () => (child.vforkParent === t && !child.zombie ? BLOCK : pid);
  if (check() !== BLOCK) return pid;
  t.noInterrupt = true; // signals wait until the child has exec'd or exited
  return new Retry(check);
}
def('fork', function (t) { return doClone(this, t, SIG.CHLD, 0, 0, 0, 0n); });
def('vfork', function (t) {
  const r = doClone(this, t, CLONE.VM | CLONE.VFORK | SIG.CHLD, 0, 0, 0, 0n);
  return typeof r === 'object' ? vforkWait(this, t, r.vfork, r.pid) : r;
});

def('execve', function (t, a0, a1, a2) {
  const path = this.path(t, AT.FDCWD, addr(a0));
  const argv = this.strArray(t, addr(a1)), envp = this.strArray(t, addr(a2));
  return doExec(this, t, path, argv, envp);
});
def('execveat', function (t, a0, a1, a2, a3, a4) {
  const path = this.path(t, i32(a0), addr(a1));
  return doExec(this, t, path, this.strArray(t, addr(a2)), this.strArray(t, addr(a3)));
});
function doExec(k, t, path, argv, envp) {
  const proc = t.proc;
  const img = k.loadImage(proc, path, argv, envp); // errors return to the caller
  if (k.host.traceExec) k.log(`[${((performance.now() - k.t0) / 1000).toFixed(2)}s] [pid ${proc.pid}] execve ${path} ${JSON.stringify(argv.slice(1, 3))} (space ${img.space})`);
  // the other threads go away
  for (const o of [...proc.threads.values()]) if (o !== t) killThreadQuietly(k, o);
  for (const [fd, e] of [...proc.fds]) if (e.cloexec) proc.closeFd(fd);
  for (const a of proc.actions) if (a.handler > 1n) { a.handler = 0n; a.flags = 0n; a.mask = 0n; }
  // this thread's worker ends; a new one starts in the new image
  killThreadQuietly(k, t);
  if (proc.vforkParent) { k.makeRunnable(proc.vforkParent); proc.vforkParent = null; }
  // (the new image first: in a shared memory, the old one's going must not free the memory)
  const old = { mm: proc.mm, image: proc.image, ownsImage: proc.ownsImage, space: proc.space };
  const next = k.installImage(proc, img, t.tid);
  // exec replaces the image and caught dispositions, not the calling thread's
  // blocked signal set (including POSIX_SPAWN_SETSIGMASK selected by libc).
  next.sigmask = t.sigmask;
  k.releaseImage(old);
  return EXIT_THREAD;
}
function killThreadQuietly(k, o) {
  o.dead = true;
  for (const q of o.waitingOn) q.threads.delete(o);
  o.waitingOn.clear();
  o.retry = null;
  if (o.timer) o.timer.dead = true;
  k.slots[o.slot] = null;
  k.threads.delete(o.tid);
  o.proc.threads.delete(o.tid);
  k.freeTb(o);
  const b32 = (K.SLOT_BASE + o.slot * K.SLOT_SIZE) >> 2;
  k.k32[b32 + 1] = K.F_EXIT;
  Atomics.store(k.k32, b32, K.S_DONE);
  Atomics.notify(k.k32, b32);
  k.host.killThread(o.tid);
}

def('exit', function (t, a0) {
  this.exitThread(t, (i32(a0) & 0xff) << 8);
  return EXIT_THREAD;
});
def('exit_group', function (t, a0) {
  this.exitProcess(t.proc, (i32(a0) & 0xff) << 8);
  return EXIT_THREAD;
});

function reapable(k, t, pid) {
  const proc = t.proc;
  const kids = [...proc.children].map((c) => k.procs.get(c)).filter(Boolean);
  const match = kids.filter((c) => pid === -1 || (pid > 0 ? c.pid === pid : pid === 0 ? c.pgid === proc.pgid : c.pgid === -pid));
  return match;
}
def('wait4', function (t, a0, a1, a2, a3) {
  const pid = i32(a0), opts = i32(a2);
  const match = reapable(this, t, pid);
  if (!match.length) fail(E.CHILD);
  const z = match.find((c) => c.zombie);
  if (!z) {
    if (opts & 1) return 0; // WNOHANG
    t.proc.childWait.add(t);
    return BLOCK;
  }
  if (addr(a1)) t.proc.mm.dv.setInt32(addr(a1), z.exitStatus, true);
  if (addr(a3)) this.bytes(t, addr(a3), 144).fill(0);
  t.proc.children.delete(z.pid);
  this.procs.delete(z.pid);
  return z.pid;
});
def('waitid', function (t, a0, a1, a2, a3) {
  const idtype = i32(a0), id = i32(a1), opts = i32(a3);
  const pid = idtype === 0 ? -1 : idtype === 1 ? id : -id;
  const match = reapable(this, t, pid);
  if (!match.length) fail(E.CHILD);
  const z = match.find((c) => c.zombie);
  const p = addr(a2);
  if (!z) {
    if (opts & 1) { if (p) this.bytes(t, p, 128).fill(0); return 0; }
    t.proc.childWait.add(t);
    return BLOCK;
  }
  if (p) {
    const dv = t.proc.mm.dv;
    this.bytes(t, p, 128).fill(0);
    dv.setInt32(p, SIG.CHLD, true);
    const sig = z.exitStatus & 0x7f;
    dv.setInt32(p + 8, sig ? 2 : 1, true); // CLD_KILLED / CLD_EXITED
    dv.setInt32(p + 16, z.pid, true);
    dv.setInt32(p + 20, this.uid(), true);
    dv.setInt32(p + 24, sig || (z.exitStatus >> 8) & 0xff, true);
  }
  if (!(opts & 0x01000000)) { // WNOWAIT
    t.proc.children.delete(z.pid);
    this.procs.delete(z.pid);
  }
  return 0;
});

// --- file descriptors ----------------------------------------------------------------------------
const specialFiles = {
  '/dev/null': () => new DevFile('null'),
  '/dev/zero': () => new DevFile('zero'),
  '/dev/urandom': () => new DevFile('urandom'),
  '/dev/random': () => new DevFile('urandom'),
  '/dev/dsp': () => new DspFile(), // (oss.js: sound for Wine's OSS driver)
  '/dev/mixer': () => new MixerFile(),
  '/dev/ntsync': () => new NtsyncDevice(), // (ntsync.js: Wine's in-process synchronization)
};

function procFile(k, t, path) {
  const m = /^\/proc\/(self|thread-self|\d+)(?:\/task\/\d+)?\/(.*)$/.exec(path);
  const enc = (s) => new TextEncoder().encode(s);
  if (path === '/proc/cpuinfo') {
    let s = '';
    for (let i = 0; i < (k.host.cpus || 4); i++) {
      s += `processor\t: ${i}\nvendor_id\t: GenuineIntel\ncpu family\t: 6\nmodel\t\t: 158\nmodel name\t: fexwasm x86-64\nstepping\t: 10\ncpu MHz\t\t: 3000.000\n` +
        `flags\t\t: fpu vme de pse tsc msr pae mce cx8 apic sep mtrr pge mca cmov pat pse36 clflush mmx fxsr sse sse2 ht syscall nx lm constant_tsc rep_good nopl pni pclmulqdq ssse3 cx16 sse4_1 sse4_2 popcnt aes xsave avx f16c rdrand hypervisor lahf_lm abm\n\n`;
    }
    return new BufferFile(enc(s));
  }
  if (path === '/proc/meminfo') {
    const kb = (k.host.totalRam || 8 * 2 ** 30) / 1024;
    return new BufferFile(enc(`MemTotal:       ${kb} kB\nMemFree:        ${kb / 2} kB\nMemAvailable:   ${kb / 2} kB\nBuffers:               0 kB\nCached:                0 kB\nSwapTotal:             0 kB\nSwapFree:              0 kB\n`));
  }
  if (path === '/proc/stat') return new BufferFile(enc('cpu  100 0 100 10000 0 0 0 0 0 0\nbtime 1700000000\n'));
  if (path === '/proc/uptime') return new BufferFile(enc(`${((performance.now() + 1e6) / 1000).toFixed(2)} 0.00\n`));
  if (path === '/proc/sys/kernel/pid_max') return new BufferFile(enc('4194304\n'));
  if (path === '/proc/sys/vm/mmap_min_addr') return new BufferFile(enc('65536\n'));
  if (!m) return null;
  const proc = m[1] === 'self' || m[1] === 'thread-self' ? t.proc : k.procs.get(Number(m[1]));
  if (!proc) fail(E.NOENT);
  const what = m[2];
  if (what === 'maps') {
    let s = '';
    for (const v of proc.mm.vmas) {
      if (v.owner !== proc.image && v.owner !== GLOBAL) continue;
      const h = (x) => x.toString(16).padStart(8, '0');
      const perm = (v.prot & 1 ? 'r' : '-') + (v.prot & 2 ? 'w' : '-') + (v.prot & 4 ? 'x' : '-') + ((v.flags & MAP.TYPE) === MAP.SHARED ? 's' : 'p');
      s += `${h(v.start)}-${h(v.end)} ${perm} ${h(v.file ? v.file.offset : 0)} 00:00 0 ${v.name || ''}\n`;
    }
    return new BufferFile(enc(s));
  }
  if (what === 'cmdline') return new BufferFile(enc(proc.argv.join('\0') + '\0'));
  if (what === 'stat') return new BufferFile(enc(`${proc.pid} (${(proc.exe.split('/').pop() || '').slice(0, 15)}) R ${proc.ppid} ${proc.pgid} ${proc.sid} 0 -1 0 0 0 0 0 0 0 0 0 20 0 ${proc.threads.size} 0 0 0 0\n`));
  if (what === 'status') return new BufferFile(enc(`Name:\t${proc.exe.split('/').pop()}\nPid:\t${proc.pid}\nPPid:\t${proc.ppid}\nUid:\t${k.uid()}\t${k.uid()}\t${k.uid()}\t${k.uid()}\nThreads:\t${proc.threads.size}\n`));
  if (what === 'environ') return new BufferFile(new Uint8Array(0));
  if (what === 'auxv') return new BufferFile(new Uint8Array(16));
  if (what === 'mounts' || what === 'mountinfo') return new BufferFile(enc('rootfs / rootfs rw 0 0\n'));
  fail(E.NOENT);
}
function procLink(k, t, path) {
  const m = /^\/proc\/(self|thread-self|\d+)(?:\/task\/\d+)?\/(exe|cwd|fd\/(\d+))$/.exec(path);
  if (!m) return null;
  const proc = m[1] === 'self' || m[1] === 'thread-self' ? t.proc : k.procs.get(Number(m[1]));
  if (!proc) fail(E.NOENT);
  if (m[2] === 'exe') return proc.exe;
  if (m[2] === 'cwd') return proc.cwd;
  const f = proc.file(Number(m[3]));
  return f.path || `${f.kind}:[${f.ino}]`;
}

function openFile(k, t, path, flags, mode) {
  if (specialFiles[path]) return specialFiles[path]();
  if (path.startsWith('/proc/')) {
    const link = procLink(k, t, path);
    if (link !== null) {
      if (link.startsWith('/')) return openFile(k, t, link, flags, mode);
      const m = /fd\/(\d+)$/.exec(path);
      if (m) return t.proc.file(Number(m[1]));
      fail(E.NOENT);
    }
    const f = procFile(k, t, path);
    if (f) return f;
  }
  if (path === '/proc' || path === '/proc/self' || path === '/dev' || path === '/sys') fail(E.NOENT);
  if (path.startsWith('/sys/')) fail(E.NOENT);
  const r = k.vfs.open(path, flags, mode & ~t.proc.umask);
  const f = new HostFile(k.vfs, r.fd, path, flags & ~(O.CREAT | O.EXCL | O.TRUNC | O.NOCTTY), r.isDir);
  f.lockKey = r.key;
  return f;
}

def('open', function (t, a0, a1, a2) { return sys[SYS.openat].call(this, t, BigInt(AT.FDCWD), a0, a1, a2); });
def('creat', function (t, a0, a1) { return sys[SYS.openat].call(this, t, BigInt(AT.FDCWD), a0, BigInt(O.CREAT | O.WRONLY | O.TRUNC), a1); });
def('openat', function (t, a0, a1, a2, a3) {
  const path = this.path(t, i32(a0), addr(a1)), flags = i32(a2), mode = i32(a3);
  const f = openFile(this, t, path, flags, mode);
  return t.proc.allocFd(f, 0, flags & O.CLOEXEC);
});
def('openat2', function (t, a0, a1, a2) {
  const dv = t.proc.mm.dv, p = addr(a2);
  return sys[SYS.openat].call(this, t, a0, a1, dv.getBigUint64(p, true), dv.getBigUint64(p + 8, true));
});
def('close', (t, a0) => { t.proc.closeFd(i32(a0)); return 0; });
def('close_range', function (t, a0, a1, a2) {
  const lo = u32(a0), hi = u32(a1), fl = u32(a2);
  for (const fd of [...t.proc.fds.keys()]) {
    if (fd < lo || fd > hi) continue;
    if (fl & 4) t.proc.fds.get(fd).cloexec = true; // CLOSE_RANGE_CLOEXEC
    else t.proc.closeFd(fd);
  }
  return 0;
});
def('dup', (t, a0) => t.proc.allocFd(t.proc.file(i32(a0)), 0, false));
def('dup2', function (t, a0, a1) {
  const o = i32(a0), n = i32(a1);
  const f = t.proc.file(o);
  if (o === n) return n;
  if (t.proc.fds.has(n)) t.proc.closeFd(n);
  t.proc.fds.set(n, { file: f.ref(), cloexec: false });
  return n;
});
def('dup3', function (t, a0, a1, a2) {
  const o = i32(a0), n = i32(a1);
  if (o === n) fail(E.INVAL);
  const f = t.proc.file(o);
  if (t.proc.fds.has(n)) t.proc.closeFd(n);
  t.proc.fds.set(n, { file: f.ref(), cloexec: !!(i32(a2) & O.CLOEXEC) });
  return n;
});
def('fcntl', function (t, a0, a1, a2) {
  const fd = i32(a0), cmd = i32(a1), proc = t.proc;
  const e = proc.fds.get(fd);
  if (!e) fail(E.BADF);
  const f = e.file;
  switch (cmd) {
    case 0: return proc.allocFd(f, i32(a2), false); // F_DUPFD
    case 1030: return proc.allocFd(f, i32(a2), true); // F_DUPFD_CLOEXEC
    case 1: return e.cloexec ? 1 : 0; // F_GETFD
    case 2: e.cloexec = !!(i32(a2) & 1); return 0;
    case 3: return f.flags | (f.isWrite === undefined ? 0 : 0); // F_GETFL
    case 4: f.flags = (f.flags & ~(O.APPEND | O.NONBLOCK)) | (i32(a2) & (O.APPEND | O.NONBLOCK)); this.pollChanged(); return 0;
    case 5: case 6: case 7: case 36: case 37: case 38: return recordLock(this, t, f, cmd, addr(a2));
    case 8: case 9: case 10: case 11: case 15: case 16: return 0; // SETOWN, GETOWN, SETSIG, GETSIG, SETOWN_EX, GETOWN_EX
    case 1031: case 1032: return 65536; // pipe size
    case 1033: return 0; // F_ADD_SEALS
    case 1034: return 0;
    default: fail(E.INVAL);
  }
});
// struct flock { short type; short whence; off_t start; off_t len; pid_t pid; }
function recordLock(k, t, f, cmd, p) {
  const dv = t.proc.mm.dv;
  const type = dv.getInt16(p, true), whence = dv.getInt16(p + 2, true);
  let start = Number(dv.getBigInt64(p + 8, true));
  const len = Number(dv.getBigInt64(p + 16, true));
  if (whence === 1) start += f.pos || 0;
  if (whence === 2) start += Number(f.stat().size || 0);
  const end = len === 0 ? Infinity : start + len;
  const key = f.lockKey || (f.lockKey = 'f' + f.ino);
  const locks = k.locks.get(key) || [];
  const ofd = cmd >= 36;
  const owner = ofd ? f : t.proc;
  const conflict = locks.find((l) => l.owner !== owner && l.start < end && start < l.end && (type === 1 || l.type === 1));
  if (cmd === 5 || cmd === 36) { // GETLK
    if (conflict) {
      dv.setInt16(p, conflict.type, true);
      dv.setInt16(p + 2, 0, true);
      dv.setBigInt64(p + 8, BigInt(conflict.start), true);
      dv.setBigInt64(p + 16, BigInt(conflict.end === Infinity ? 0 : conflict.end - conflict.start), true);
      dv.setInt32(p + 24, ofd ? -1 : conflict.owner.pid, true);
    } else dv.setInt16(p, 2, true); // F_UNLCK
    return 0;
  }
  if (type !== 2 && conflict) {
    if (cmd === 6 || cmd === 37) fail(E.AGAIN);
    k.lockQ.add(t);
    return BLOCK;
  }
  // remove our own overlapping ranges, then add
  const out = [];
  for (const l of locks) {
    if (l.owner !== owner || l.end <= start || l.start >= end) { out.push(l); continue; }
    if (l.start < start) out.push(Object.assign({}, l, { end: start }));
    if (l.end > end) out.push(Object.assign({}, l, { start: end }));
  }
  if (type !== 2) out.push({ owner, proc: t.proc, start, end, type });
  k.locks.set(key, out);
  k.lockQ.wake(k);
  return 0;
}
def('flock', () => 0);

def('ioctl', function (t, a0, a1, a2) {
  const f = t.proc.file(i32(a0)), req = u32(a1);
  if (req === 0x5421) { // FIONBIO
    const on = t.proc.mm.dv.getInt32(addr(a2), true);
    f.flags = on ? f.flags | O.NONBLOCK : f.flags & ~O.NONBLOCK;
    return 0;
  }
  if (req === 0x5451) { t.proc.fds.get(i32(a0)).cloexec = true; return 0; } // FIOCLEX
  if (req === 0x5450) { t.proc.fds.get(i32(a0)).cloexec = false; return 0; } // FIONCLEX
  return f.ioctl(this, t, req, addr(a2));
});

def('read', function (t, a0, a1, a2) {
  const f = t.proc.file(i32(a0)), p = addr(a1), n = Number(a2);
  if (f.isDir) fail(E.ISDIR);
  return readInto(this, t, p, n, (buf) => f.read(this, t, buf));
});
def('write', function (t, a0, a1, a2) {
  const f = t.proc.file(i32(a0)), n = Number(a2);
  return f.write(this, t, this.bytes(t, addr(a1), n).slice());
});
def('pread64', function (t, a0, a1, a2, a3) {
  const f = t.proc.file(i32(a0));
  return readInto(this, t, addr(a1), Number(a2), (buf) => f.pread(this, t, buf, Number(a3)));
});
def('pwrite64', function (t, a0, a1, a2, a3) {
  const f = t.proc.file(i32(a0));
  return f.pwrite(this, t, this.bytes(t, addr(a1), Number(a2)).slice(), Number(a3));
});
def('readv', function (t, a0, a1, a2) {
  const f = t.proc.file(i32(a0)), iov = iovecs(t, addr(a1), i32(a2));
  const total = iov.reduce((s, v) => s + v.n, 0), buf = new Uint8Array(total);
  const r = f.read(this, t, buf);
  if (r === BLOCK) return r;
  scatter(this, t, iov, buf, r);
  return r;
});
def('writev', function (t, a0, a1, a2) {
  const f = t.proc.file(i32(a0)), iov = iovecs(t, addr(a1), i32(a2));
  return f.write(this, t, gather(this, t, iov));
});
def('preadv', function (t, a0, a1, a2, a3) {
  const f = t.proc.file(i32(a0)), iov = iovecs(t, addr(a1), i32(a2));
  const buf = new Uint8Array(iov.reduce((s, v) => s + v.n, 0));
  const r = f.pread(this, t, buf, Number(a3));
  scatter(this, t, iov, buf, r);
  return r;
});
def('pwritev', function (t, a0, a1, a2, a3) {
  const f = t.proc.file(i32(a0)), iov = iovecs(t, addr(a1), i32(a2));
  return f.pwrite(this, t, gather(this, t, iov), Number(a3));
});
def('lseek', function (t, a0, a1, a2) {
  return t.proc.file(i32(a0)).seek(Number(BigInt.asIntN(64, a1)), i32(a2));
});
def('sendfile', function (t, a0, a1, a2, a3) {
  const out = t.proc.file(i32(a0)), inf = t.proc.file(i32(a1)), n = Math.min(Number(a3), 1 << 20);
  if (n < 0) fail(E.INVAL);
  if ((inf.flags & O.ACCMODE) === O.WRONLY || (out.flags & O.ACCMODE) === 0) fail(E.BADF);
  if (out.flags & O.APPEND) fail(E.INVAL);
  if (inf.kind !== 'file' && inf.kind !== 'buffer') fail(E.INVAL);
  const ptr = addr(a2), dv = t.proc.mm.dv;
  const off = ptr ? Number(dv.getBigInt64(ptr, true)) : inf.pos;
  if (!Number.isSafeInteger(off) || off < 0) fail(E.INVAL);
  // A pipe cannot accept more than its capacity. Bound read-ahead so large
  // guest sendfile counts do not repeatedly fetch/allocate megabyte buffers.
  const chunk = out.kind === 'pipe' ? Math.min(n, out.pipe.capacity) : n;
  const buf = new Uint8Array(chunk);
  // Pipes may accept only part of a read, or block. Commit the input offset
  // only after the output accepted bytes; otherwise retries lose file data.
  const r = inf.pread(this, t, buf, off);
  if (r === BLOCK || r <= 0) return r;
  const written = out.write(this, t, buf.subarray(0, r));
  if (written !== BLOCK && written > 0) {
    if (ptr) dv.setBigInt64(ptr, BigInt(off + written), true);
    else inf.pos = off + written;
  }
  return written;
});

// --- file system ---------------------------------------------------------------------------------
function statPath(k, t, path, follow) {
  if (specialFiles[path]) return specialFiles[path]().stat();
  if (path.startsWith('/proc/')) {
    const link = procLink(k, t, path);
    if (link !== null) {
      if (!follow) return { mode: S_IF.LNK | 0o777, ino: 1n, size: link.length };
      if (link.startsWith('/')) return statPath(k, t, link, true);
      return t.proc.file(Number(/fd\/(\d+)$/.exec(path)[1])).stat();
    }
    const f = procFile(k, t, path);
    if (f) return f.stat();
  }
  if (path === '/proc' || path === '/proc/self' || path === '/dev') return { mode: S_IF.DIR | 0o555, ino: 2n, size: 0, nlink: 2 };
  if (path.startsWith('/sys/')) fail(E.NOENT);
  return k.vfs.stat(path, follow);
}
def('stat', function (t, a0, a1) { writeStat(t.proc.mm.dv, addr(a1), statPath(this, t, this.path(t, AT.FDCWD, addr(a0)), true)); return 0; });
def('lstat', function (t, a0, a1) { writeStat(t.proc.mm.dv, addr(a1), statPath(this, t, this.path(t, AT.FDCWD, addr(a0)), false)); return 0; });
def('fstat', function (t, a0, a1) { writeStat(t.proc.mm.dv, addr(a1), t.proc.file(i32(a0)).stat()); return 0; });
def('newfstatat', function (t, a0, a1, a2, a3) {
  const flags = i32(a3), dirfd = i32(a0);
  const s = this.str(t, addr(a1));
  let st;
  if (!s && (flags & AT.EMPTY_PATH)) st = dirfd === AT.FDCWD ? this.vfs.stat(t.proc.cwd, true) : t.proc.file(dirfd).stat();
  else st = statPath(this, t, this.resolvePath(t.proc, dirfd, s), !(flags & AT.SYMLINK_NOFOLLOW));
  writeStat(t.proc.mm.dv, addr(a2), st);
  return 0;
});
def('statx', function (t, a0, a1, a2, a3, a4) {
  const flags = i32(a2), dirfd = i32(a0);
  const s = this.str(t, addr(a1));
  let st;
  if (!s && (flags & AT.EMPTY_PATH)) st = dirfd === AT.FDCWD ? this.vfs.stat(t.proc.cwd, true) : t.proc.file(dirfd).stat();
  else st = statPath(this, t, this.resolvePath(t.proc, dirfd, s), !(flags & AT.SYMLINK_NOFOLLOW));
  writeStatx(t.proc.mm.dv, addr(a4), st, u32(a3));
  return 0;
});
function doAccess(k, t, dirfd, p, mode, flags) {
  const path = k.resolvePath(t.proc, dirfd, k.str(t, p));
  const st = statPath(k, t, path, !(flags & AT.SYMLINK_NOFOLLOW));
  if (mode & 2 && k.vfs.readOnly && k.vfs.readOnly(path)) fail(E.ROFS);
  void st;
  return 0;
}
def('access', function (t, a0, a1) { return doAccess(this, t, AT.FDCWD, addr(a0), i32(a1), 0); });
def('faccessat', function (t, a0, a1, a2) { return doAccess(this, t, i32(a0), addr(a1), i32(a2), 0); });
def('faccessat2', function (t, a0, a1, a2, a3) { return doAccess(this, t, i32(a0), addr(a1), i32(a2), i32(a3)); });
def('getcwd', function (t, a0, a1) {
  const b = new TextEncoder().encode(t.proc.cwd + '\0');
  if (b.length > Number(a1)) fail(E.RANGE);
  this.bytes(t, addr(a0), b.length).set(b);
  return b.length;
});
def('chdir', function (t, a0) {
  const path = this.path(t, AT.FDCWD, addr(a0));
  const st = statPath(this, t, path, true);
  if ((st.mode & S_IF.MT) !== S_IF.DIR) fail(E.NOTDIR);
  t.proc.cwd = path;
  return 0;
});
def('fchdir', function (t, a0) {
  const f = t.proc.file(i32(a0));
  if (!f.isDir) fail(E.NOTDIR);
  t.proc.cwd = f.path;
  return 0;
});
def('getdents64', function (t, a0, a1, a2) {
  const f = t.proc.file(i32(a0));
  if (!f.isDir) fail(E.NOTDIR);
  if (!f.dirents) f.dirents = [{ name: '.', ino: 1n, type: 4 }, { name: '..', ino: 1n, type: 4 }, ...this.vfs.readdir(f.path)];
  const n = Number(a1), out = this.bytes(t, addr(a1), 0) && null;
  void out;
  const cap = Number(a2), buf = new Uint8Array(cap), dv = new DataView(buf.buffer);
  let o = 0;
  const enc = new TextEncoder();
  while (f.pos < f.dirents.length) {
    const d = f.dirents[f.pos], name = enc.encode(d.name);
    const reclen = (19 + name.length + 1 + 7) & ~7;
    if (o + reclen > cap) break;
    dv.setBigUint64(o, BigInt(d.ino || 1), true);
    dv.setBigInt64(o + 8, BigInt(f.pos + 1), true);
    dv.setUint16(o + 16, reclen, true);
    buf[o + 18] = d.type;
    buf.set(name, o + 19);
    buf[o + 19 + name.length] = 0;
    o += reclen;
    f.pos++;
  }
  if (o === 0 && f.pos < f.dirents.length) fail(E.INVAL);
  this.bytes(t, addr(a1), o).set(buf.subarray(0, o));
  void n;
  return o;
});
def('mkdir', function (t, a0, a1) { this.vfs.mkdir(this.path(t, AT.FDCWD, addr(a0)), i32(a1) & ~t.proc.umask); return 0; });
def('mkdirat', function (t, a0, a1, a2) { this.vfs.mkdir(this.path(t, i32(a0), addr(a1)), i32(a2) & ~t.proc.umask); return 0; });
def('rmdir', function (t, a0) { this.vfs.rmdir(this.path(t, AT.FDCWD, addr(a0))); return 0; });
def('unlink', function (t, a0) { this.vfs.unlink(this.path(t, AT.FDCWD, addr(a0))); return 0; });
def('unlinkat', function (t, a0, a1, a2) {
  const p = this.path(t, i32(a0), addr(a1));
  if (i32(a2) & AT.REMOVEDIR) this.vfs.rmdir(p);
  else this.vfs.unlink(p);
  return 0;
});
def('rename', function (t, a0, a1) { this.vfs.rename(this.path(t, AT.FDCWD, addr(a0)), this.path(t, AT.FDCWD, addr(a1))); return 0; });
def('renameat', function (t, a0, a1, a2, a3) { this.vfs.rename(this.path(t, i32(a0), addr(a1)), this.path(t, i32(a2), addr(a3))); return 0; });
def('renameat2', function (t, a0, a1, a2, a3, a4) {
  const from = this.path(t, i32(a0), addr(a1)), to = this.path(t, i32(a2), addr(a3));
  if (i32(a4) & 1) { // RENAME_NOREPLACE
    let exists = true;
    try { this.vfs.stat(to, false); } catch (e) { exists = false; }
    if (exists) fail(E.EXIST);
  }
  this.vfs.rename(from, to);
  return 0;
});
def('link', function (t, a0, a1) { this.vfs.link(this.path(t, AT.FDCWD, addr(a0)), this.path(t, AT.FDCWD, addr(a1))); return 0; });
def('linkat', function (t, a0, a1, a2, a3) { this.vfs.link(this.path(t, i32(a0), addr(a1)), this.path(t, i32(a2), addr(a3))); return 0; });
def('symlink', function (t, a0, a1) { this.vfs.symlink(this.str(t, addr(a0)), this.path(t, AT.FDCWD, addr(a1))); return 0; });
def('symlinkat', function (t, a0, a1, a2) { this.vfs.symlink(this.str(t, addr(a0)), this.path(t, i32(a1), addr(a2))); return 0; });
function doReadlink(k, t, path, p, n) {
  if (path === '/proc/self') return putLink(k, t, String(t.proc.pid), p, n);
  if (path === '/proc/thread-self') return putLink(k, t, `${t.proc.pid}/task/${t.tid}`, p, n);
  if (/^\/(proc|dev|sys)(\/\d+(\/task(\/\d+)?)?)?$/.test(path)) fail(E.INVAL); // directories, not links
  let target = path.startsWith('/proc/') ? procLink(k, t, path) : null;
  if (target === null) target = k.vfs.readlink(path);
  return putLink(k, t, target, p, n);
}
function putLink(k, t, target, p, n) {
  const b = new TextEncoder().encode(target);
  const m = Math.min(b.length, n);
  k.bytes(t, p, m).set(b.subarray(0, m));
  return m;
}
def('readlink', function (t, a0, a1, a2) { return doReadlink(this, t, this.path(t, AT.FDCWD, addr(a0)), addr(a1), Number(a2)); });
def('readlinkat', function (t, a0, a1, a2, a3) { return doReadlink(this, t, this.path(t, i32(a0), addr(a1)), addr(a2), Number(a3)); });
def('chmod', function (t, a0, a1) { this.vfs.chmod(this.path(t, AT.FDCWD, addr(a0)), i32(a1)); return 0; });
def('fchmod', function (t, a0, a1) { const f = t.proc.file(i32(a0)); if (f.path) this.vfs.chmod(f.path, i32(a1)); return 0; });
def('fchmodat', function (t, a0, a1, a2) { this.vfs.chmod(this.path(t, i32(a0), addr(a1)), i32(a2)); return 0; });
for (const n of ['chown', 'fchown', 'lchown', 'fchownat']) def(n, () => 0);
def('utimensat', function (t, a0, a1, a2) {
  let path;
  if (!addr(a1)) path = t.proc.file(i32(a0)).path;
  else path = this.path(t, i32(a0), addr(a1));
  if (path) {
    const now = Date.now() / 1000;
    let at = now, mt = now;
    if (addr(a2)) {
      const dv = t.proc.mm.dv, p = addr(a2);
      const rd = (o) => {
        const ns = Number(dv.getBigInt64(p + o + 8, true));
        if (ns === 0x3fffffff) return now; // UTIME_NOW
        if (ns === 0x3ffffffe) return null; // UTIME_OMIT
        return Number(dv.getBigInt64(p + o, true)) + ns / 1e9;
      };
      at = rd(0);
      mt = rd(16);
    }
    this.vfs.utimes(path, at, mt);
  }
  return 0;
});
def('utimes', () => 0);
def('utime', () => 0);
def('truncate', function (t, a0, a1) { this.vfs.truncate(this.path(t, AT.FDCWD, addr(a0)), Number(a1)); return 0; });
def('ftruncate', function (t, a0, a1) {
  const f = t.proc.file(i32(a0));
  if (!(f instanceof HostFile)) { if (f.truncate) return f.truncate(Number(a1)); fail(E.INVAL); }
  this.vfs.ftruncate(f.fd, Number(a1));
  return 0;
});
def('fallocate', function (t, a0, a1, a2, a3) {
  const f = t.proc.file(i32(a0));
  if (f instanceof HostFile && !i32(a1)) {
    const end = Number(a2) + Number(a3);
    if (Number(f.stat().size) < end) this.vfs.ftruncate(f.fd, end);
  }
  return 0;
});
for (const n of ['fsync', 'fdatasync', 'sync', 'fadvise64', 'readahead']) def(n, () => 0);
function writeStatfs(dv, p) {
  new Uint8Array(dv.buffer, p, 120).fill(0);
  dv.setBigInt64(p, 0xEF53n, true); // f_type: ext4
  dv.setBigInt64(p + 8, 4096n, true); // bsize
  dv.setBigUint64(p + 16, 1n << 24n, true); // blocks
  dv.setBigUint64(p + 24, 1n << 23n, true); // bfree
  dv.setBigUint64(p + 32, 1n << 23n, true); // bavail
  dv.setBigUint64(p + 40, 1n << 20n, true); // files
  dv.setBigUint64(p + 48, 1n << 19n, true); // ffree
  dv.setBigInt64(p + 64, 255n, true); // namelen
  dv.setBigInt64(p + 72, 4096n, true); // frsize
}
def('statfs', function (t, a0, a1) { writeStatfs(t.proc.mm.dv, addr(a1)); return 0; });
def('fstatfs', function (t, a0, a1) { t.proc.file(i32(a0)); writeStatfs(t.proc.mm.dv, addr(a1)); return 0; });
def('getxattr', () => fail(E.NODATA));
def('lgetxattr', () => fail(E.NODATA));
def('fgetxattr', () => fail(E.NODATA));

def('memfd_create', function (t, a0, a1) {
  const name = this.str(t, addr(a0));
  const r = this.vfs.tmpfile();
  const f = new HostFile(this.vfs, r.fd, null, O.RDWR, false);
  f.memfd = name;
  return t.proc.allocFd(f, 0, u32(a1) & 1);
});

// --- pipes, eventfd -------------------------------------------------------------------------------
function makePipe(k, t, p, flags) {
  const pipe = new Pipe();
  const r = new PipeEnd(pipe, false), w = new PipeEnd(pipe, true);
  r.flags |= flags & O.NONBLOCK;
  w.flags |= flags & O.NONBLOCK;
  const fr = t.proc.allocFd(r, 0, flags & O.CLOEXEC), fw = t.proc.allocFd(w, 0, flags & O.CLOEXEC);
  const dv = t.proc.mm.dv;
  dv.setInt32(p, fr, true);
  dv.setInt32(p + 4, fw, true);
  return 0;
}
def('pipe', function (t, a0) { return makePipe(this, t, addr(a0), 0); });
def('pipe2', function (t, a0, a1) { return makePipe(this, t, addr(a0), i32(a1)); });
def('eventfd', function (t, a0) { return t.proc.allocFd(new EventFd(u32(a0), 0), 0, false); });
def('eventfd2', function (t, a0, a1) { const fl = i32(a1); return t.proc.allocFd(new EventFd(u32(a0), fl), 0, fl & O.CLOEXEC); });

// --- sockets (AF_UNIX) --------------------------------------------------------------------------------
def('socket', function (t, a0, a1, a2) {
  const domain = i32(a0), type = i32(a1);
  if (domain !== 1) fail(E.AFNOSUPPORT); // AF_UNIX only
  const s = new UnixSocket(type);
  return t.proc.allocFd(s, 0, type & O.CLOEXEC);
});
def('socketpair', function (t, a0, a1, a2, a3) {
  if (i32(a0) !== 1) fail(E.AFNOSUPPORT);
  const type = i32(a1);
  const a = new UnixSocket(type), b = new UnixSocket(type);
  a.peer = b;
  b.peer = a;
  const fa = t.proc.allocFd(a, 0, type & O.CLOEXEC), fb = t.proc.allocFd(b, 0, type & O.CLOEXEC);
  const dv = t.proc.mm.dv;
  dv.setInt32(addr(a3), fa, true);
  dv.setInt32(addr(a3) + 4, fb, true);
  return 0;
});
function sockaddrPath(k, t, p, len) {
  const dv = t.proc.mm.dv;
  if (dv.getUint16(p, true) !== 1) fail(E.AFNOSUPPORT);
  const u8 = k.bytes(t, p + 2, len - 2);
  if (u8[0] === 0) return '@' + new TextDecoder().decode(u8.subarray(1)); // abstract
  let e = 0;
  while (e < u8.length && u8[e]) e++;
  return k.resolvePath(t.proc, AT.FDCWD, new TextDecoder().decode(u8.subarray(0, e)));
}
function sock(t, fd) {
  const s = t.proc.file(fd);
  if (!(s instanceof UnixSocket)) fail(E.NOTSOCK);
  return s;
}
def('bind', function (t, a0, a1, a2) {
  const s = sock(t, i32(a0)), path = sockaddrPath(this, t, addr(a1), i32(a2));
  if (this.unixNames.has(path)) fail(E.ADDRINUSE);
  if (!path.startsWith('@')) this.vfs.mksock(path); // the socket file exists in the file system
  s.path = path;
  this.unixNames.set(path, s);
  return 0;
});
def('listen', function (t, a0) {
  const s = sock(t, i32(a0));
  s.listening = true;
  if (this.onListen) this.onListen(t.proc);
  return 0;
});
def('connect', function (t, a0, a1, a2) {
  const s = sock(t, i32(a0)), path = sockaddrPath(this, t, addr(a1), i32(a2));
  const l = this.unixNames.get(path);
  if (!l || !l.listening) {
    if (!path.startsWith('@')) this.vfs.stat(path, true); // ENOENT if no file
    fail(E.CONNREFUSED);
  }
  const server = new UnixSocket(s.type);
  server.peer = s;
  s.peer = server;
  server.path = null;
  l.backlog.push(server.ref());
  l.acceptQ.wake(this);
  this.pollChanged();
  return 0;
});
function doAccept(k, t, fd, p, lp, flags) {
  const l = sock(t, fd);
  if (!l.listening) fail(E.INVAL);
  if (!l.backlog.length) {
    if (l.flags & O.NONBLOCK) fail(E.AGAIN);
    l.acceptQ.add(t);
    return BLOCK;
  }
  const s = l.backlog.shift();
  s.flags |= flags & O.NONBLOCK;
  const nfd = t.proc.allocFd(s, 0, flags & O.CLOEXEC);
  s.unref(k); // the backlog's reference
  if (lp) t.proc.mm.dv.setInt32(lp, 2, true);
  if (p) t.proc.mm.dv.setUint16(p, 1, true);
  k.pollChanged();
  return nfd;
}
def('accept', function (t, a0, a1, a2) { return doAccept(this, t, i32(a0), addr(a1), addr(a2), 0); });
def('accept4', function (t, a0, a1, a2, a3) { return doAccept(this, t, i32(a0), addr(a1), addr(a2), i32(a3)); });
def('shutdown', function (t, a0, a1) {
  const s = sock(t, i32(a0)), how = i32(a1);
  if (how === 0 || how === 2) s.shutRd = true;
  if ((how === 1 || how === 2) && s.peer) { s.peer.peerGone = true; s.peer.rq.wake(this); }
  s.rq.wake(this);
  this.pollChanged();
  return 0;
});
def('getsockname', function (t, a0, a1, a2) {
  const s = sock(t, i32(a0)), dv = t.proc.mm.dv;
  const b = new TextEncoder().encode(s.path && !s.path.startsWith('@') ? s.path : '');
  const len = 2 + b.length + 1;
  if (addr(a1)) {
    dv.setUint16(addr(a1), 1, true);
    this.bytes(t, addr(a1) + 2, b.length + 1).set([...b, 0]);
  }
  if (addr(a2)) dv.setInt32(addr(a2), len, true);
  return 0;
});
def('getpeername', function (t, a0, a1, a2) {
  const s = sock(t, i32(a0));
  if (!s.peer) fail(E.NOTCONN);
  const dv = t.proc.mm.dv;
  if (addr(a1)) dv.setUint16(addr(a1), 1, true);
  if (addr(a2)) dv.setInt32(addr(a2), 2, true);
  return 0;
});
def('setsockopt', () => 0);
def('getsockopt', function (t, a0, a1, a2, a3, a4) {
  const s = sock(t, i32(a0)), level = i32(a1), opt = i32(a2), dv = t.proc.mm.dv;
  let v = 0;
  if (level === 1) {
    if (opt === 3) v = s.type; // SO_TYPE
    else if (opt === 4) v = 0; // SO_ERROR
    else if (opt === 7 || opt === 8) v = 262144; // SNDBUF / RCVBUF
    else if (opt === 17) { // SO_PEERCRED: pid, uid, gid
      dv.setInt32(addr(a3), t.proc.pid, true);
      dv.setInt32(addr(a3) + 4, this.uid(), true);
      dv.setInt32(addr(a3) + 8, this.gid(), true);
      dv.setInt32(addr(a4), 12, true);
      return 0;
    }
  }
  dv.setInt32(addr(a3), v, true);
  dv.setInt32(addr(a4), 4, true);
  return 0;
});
// struct msghdr { void* name; u32 namelen; iovec* iov; size_t iovlen; void* control; size_t controllen; int flags; }
def('sendmsg', function (t, a0, a1, a2) {
  const s = sock(t, i32(a0)), dv = t.proc.mm.dv, m = addr(a1);
  const iov = iovecs(t, Number(dv.getBigUint64(m + 16, true) & 0xffffffffn), Number(dv.getBigUint64(m + 24, true)));
  const data = gather(this, t, iov);
  const cp = Number(dv.getBigUint64(m + 32, true) & 0xffffffffn), clen = Number(dv.getBigUint64(m + 40, true));
  const files = [];
  for (let o = 0; cp && o + 16 <= clen;) {
    const len = Number(dv.getBigUint64(cp + o, true)), level = dv.getInt32(cp + o + 8, true), type = dv.getInt32(cp + o + 12, true);
    if (len < 16) break;
    if (level === 1 && type === 1) { // SCM_RIGHTS
      for (let q = 16; q + 4 <= len; q += 4) files.push(t.proc.file(dv.getInt32(cp + o + q, true)));
    }
    o += (len + 7) & ~7;
  }
  return s.send(this, t, data, files);
});
def('sendto', function (t, a0, a1, a2) {
  const s = sock(t, i32(a0));
  return s.send(this, t, this.bytes(t, addr(a1), Number(a2)).slice(), []);
});
def('recvmsg', function (t, a0, a1, a2) {
  const s = sock(t, i32(a0)), dv = t.proc.mm.dv, m = addr(a1), flags = i32(a2);
  const iov = iovecs(t, Number(dv.getBigUint64(m + 16, true) & 0xffffffffn), Number(dv.getBigUint64(m + 24, true)));
  const buf = new Uint8Array(iov.reduce((a, v) => a + v.n, 0));
  const r = s.recv(this, t, buf, !!(flags & 2), !!(flags & 0x40)); // MSG_PEEK, MSG_DONTWAIT
  if (r === BLOCK) return r;
  scatter(this, t, iov, buf, r.n);
  const cp = Number(dv.getBigUint64(m + 32, true) & 0xffffffffn), clen = Number(dv.getBigUint64(m + 40, true));
  let used = 0, mflags = 0;
  if (r.files.length) {
    const need = 16 + 4 * r.files.length;
    if (cp && clen >= need) {
      dv.setBigUint64(cp, BigInt(need), true);
      dv.setInt32(cp + 8, 1, true);
      dv.setInt32(cp + 12, 1, true);
      r.files.forEach((f, i) => dv.setInt32(cp + 16 + 4 * i, t.proc.allocFd(f, 0, !!(flags & 0x40000000)), true)); // MSG_CMSG_CLOEXEC
      used = (need + 7) & ~7;
    } else mflags |= 8; // MSG_CTRUNC
    if (!r.peeked) for (const f of r.files) f.unref(this);
  }
  dv.setBigUint64(m + 40, BigInt(used), true);
  dv.setInt32(m + 48, mflags, true);
  if (addr(dv.getBigUint64(m, true))) dv.setUint32(m + 8, 0, true);
  return r.n;
});
def('recvfrom', function (t, a0, a1, a2, a3, a4, a5) {
  const s = sock(t, i32(a0));
  const n = Number(a2), buf = new Uint8Array(n);
  const r = s.recv(this, t, buf, !!(i32(a3) & 2), !!(i32(a3) & 0x40));
  if (r === BLOCK) return r;
  this.bytes(t, addr(a1), r.n).set(buf.subarray(0, r.n));
  for (const f of r.files) f.unref(this);
  if (addr(a5)) t.proc.mm.dv.setInt32(addr(a5), 0, true);
  return r.n;
});

// --- poll, select, epoll --------------------------------------------------------------------------------
function pollDeadline(t, ms) {
  if (ms < 0) return Infinity;
  if (t.pollDeadline === undefined) t.pollDeadline = performance.now() + ms;
  return t.pollDeadline;
}
function pollBlock(k, t, deadline) {
  if (performance.now() >= deadline) { t.pollDeadline = undefined; return 0; }
  k.pollQ.add(t);
  if (deadline !== Infinity && (!t.timer || t.timer.dead)) t.timer = k.addTimer(deadline - performance.now(), () => k.makeRunnable(t));
  return BLOCK;
}
function doPoll(k, t, p, n, ms) {
  const dv = t.proc.mm.dv;
  let ready = 0;
  for (let i = 0; i < n; i++) {
    const e = p + 8 * i, fd = dv.getInt32(e, true), want = dv.getInt16(e + 4, true);
    let rev = 0;
    if (fd >= 0) {
      const ent = t.proc.fds.get(fd);
      rev = ent ? ent.file.poll() & (want | POLLERR | POLLHUP | POLLNVAL) : POLLNVAL;
    }
    dv.setInt16(e + 6, rev, true);
    if (rev) ready++;
  }
  if (ready) { t.pollDeadline = undefined; return ready; }
  const r = pollBlock(k, t, pollDeadline(t, ms));
  return r;
}
def('poll', function (t, a0, a1, a2) { return doPoll(this, t, addr(a0), u32(a1), i32(a2)); });
def('ppoll', function (t, a0, a1, a2) {
  const ms = addr(a2) ? timespecMs(t.proc.mm.dv, addr(a2)) : -1;
  return doPoll(this, t, addr(a0), u32(a1), ms);
});
function doSelect(k, t, n, rp, wp, ep, ms) {
  const dv = t.proc.mm.dv, words = Math.ceil(n / 64);
  const get = (p) => (p ? Array.from({ length: words }, (_, i) => dv.getBigUint64(p + 8 * i, true)) : null);
  const rs = get(rp), ws = get(wp);
  const ro = new Array(words).fill(0n), wo = new Array(words).fill(0n);
  let ready = 0;
  for (let fd = 0; fd < n; fd++) {
    const w = fd >> 6, b = 1n << BigInt(fd & 63);
    const wantR = rs && rs[w] & b, wantW = ws && ws[w] & b;
    if (!wantR && !wantW) continue;
    const ent = t.proc.fds.get(fd);
    if (!ent) fail(E.BADF);
    const ev = ent.file.poll();
    if (wantR && ev & (POLLIN | POLLHUP | POLLERR)) { ro[w] |= b; ready++; }
    if (wantW && ev & (POLLOUT | POLLERR)) { wo[w] |= b; ready++; }
  }
  if (!ready) {
    const r = pollBlock(k, t, pollDeadline(t, ms));
    if (r === BLOCK) return r;
  }
  t.pollDeadline = undefined;
  const put = (p, v) => { if (p) v.forEach((x, i) => dv.setBigUint64(p + 8 * i, x, true)); };
  put(rp, ro);
  put(wp, wo);
  if (ep) put(ep, new Array(words).fill(0n));
  return ready;
}
def('select', function (t, a0, a1, a2, a3, a4) {
  let ms = -1;
  if (addr(a4)) { const dv = t.proc.mm.dv; ms = Number(dv.getBigInt64(addr(a4), true)) * 1000 + Number(dv.getBigInt64(addr(a4) + 8, true)) / 1000; }
  return doSelect(this, t, i32(a0), addr(a1), addr(a2), addr(a3), ms);
});
def('pselect6', function (t, a0, a1, a2, a3, a4) {
  const ms = addr(a4) ? timespecMs(t.proc.mm.dv, addr(a4)) : -1;
  return doSelect(this, t, i32(a0), addr(a1), addr(a2), addr(a3), ms);
});
def('epoll_create', (t) => t.proc.allocFd(new EpollFile(), 0, false));
def('epoll_create1', (t, a0) => t.proc.allocFd(new EpollFile(), 0, i32(a0) & O.CLOEXEC));
def('epoll_ctl', function (t, a0, a1, a2, a3) {
  const ep = t.proc.file(i32(a0));
  if (!(ep instanceof EpollFile)) fail(E.INVAL);
  const op = i32(a1), fd = i32(a2), dv = t.proc.mm.dv;
  const f = t.proc.file(fd);
  if (op === 2) { if (!ep.watch.delete(fd)) fail(E.NOENT); return 0; } // DEL
  const events = dv.getUint32(addr(a3), true), data = dv.getBigUint64(addr(a3) + 4, true);
  if (op === 1 && ep.watch.has(fd)) fail(E.EXIST);
  if (op === 3 && !ep.watch.has(fd)) fail(E.NOENT);
  ep.watch.set(fd, { file: f, events, data });
  this.pollChanged();
  return 0;
});
function doEpollWait(k, t, epfd, p, max, ms) {
  const ep = t.proc.file(epfd);
  if (!(ep instanceof EpollFile)) fail(E.INVAL);
  const dv = t.proc.mm.dv;
  let n = 0;
  for (const [fd, w] of ep.watch) {
    if (n >= max) break;
    const ent = t.proc.fds.get(fd);
    if (!ent || ent.file !== w.file) { ep.watch.delete(fd); continue; }
    const ev = w.file.poll() & (w.events | POLLERR | POLLHUP);
    if (!ev || w.disabled) continue;
    dv.setUint32(p + 12 * n, ev, true);
    dv.setBigUint64(p + 12 * n + 4, w.data, true);
    n++;
    if (w.events & (1 << 30)) w.disabled = true; // EPOLLONESHOT
  }
  if (n) { t.pollDeadline = undefined; return n; }
  return pollBlock(k, t, pollDeadline(t, ms));
}
def('epoll_wait', function (t, a0, a1, a2, a3) { return doEpollWait(this, t, i32(a0), addr(a1), i32(a2), i32(a3)); });
def('epoll_pwait', function (t, a0, a1, a2, a3) { return doEpollWait(this, t, i32(a0), addr(a1), i32(a2), i32(a3)); });
def('epoll_pwait2', function (t, a0, a1, a2, a3) {
  const ms = addr(a3) ? timespecMs(t.proc.mm.dv, addr(a3)) : -1;
  return doEpollWait(this, t, i32(a0), addr(a1), i32(a2), ms);
});

// futex in the kernel is a fallback: threads do it themselves (js/linux/thread.js).
def('futex', function (t, a0, a1, a2) {
  const op = i32(a1) & 0x7f, p = addr(a0), a32 = new Int32Array(t.proc.mm.mem.buffer);
  if (op === 1 || op === 10) return Atomics.notify(a32, p >>> 2, u32(a2));
  if (op === 0 || op === 9) return Atomics.load(a32, p >>> 2) !== i32(a2) ? -E.AGAIN : 0; // (the thread waits itself)
  fail(E.NOSYS);
});

// A process (the patched wineserver) registers a log of its writes to shared
// mappings: struct { u32 count, overflow; u64 ranges[cap][2] } (see syncShared).
sys[0x46574401] = function (t, a0, a1) {
  t.proc.dirtyLog = { addr: addr(a0), cap: u32(a1) };
  return 0;
};

Kernel.prototype.sys = sys;
module.exports = { sys, writeStat };
