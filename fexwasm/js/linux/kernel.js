// A Linux kernel for x86-64 guest processes whose code runs as FEX-translated
// wasm (js/linux/thread.js), so that Wine can run as an ordinary x86-64
// Linux program. It runs in one worker (the "kernel worker") and is
// synchronous: guest threads post syscalls into slots of a shared buffer and
// wait; the kernel handles them in its loop. A syscall that has to wait
// (a read on an empty pipe, wait4, poll...) parks its thread and is retried
// when something it waits on changes.
//
// Processes each own a WebAssembly.Memory (their address space, below 4 GB)
// that all their threads share. fork copies it; execve starts a new one.
//
// The host (tools/linuxrun.js on Node; the app on the device) provides:
//   host.vfs                     files (js/linux/vfs_node.js)
//   host.spawnThread(info)       start a worker for a guest thread
//   host.killThread(tid)         stop a thread's worker
//   host.code(space, addr, u8)   guest code became executable (translator)
//   host.uncode(space, addr, n)  and stopped being
//   host.dropSpace(space)        a process image is gone
//   host.write(fd, u8)           the console (fd 1 and 2 of the first process)
//   host.exit(code)              the first process exited
//   host.log(msg)
'use strict';

const { SYS, SYS_NAME, E, O, AT, PROT, MAP, CLONE, SIG, SA, S_IF, AUX } = require('./abi.js');
const ELF = require('./elf.js');

const PAGE = 4096;
const WASM_PAGE = 65536;
const LOW_RESERVED = 0x10000;       // CRC and CPUID tables of the dispatcher (absolute addresses)
const ADDR_LIMIT = 0xFFFF_0000;     // guest addresses stay below 4 GB (the wasm address)
const MMAP_BASE = 0x1000_0000;      // mmap placement starts here, bottom-up
const PIE_BASE = 0x0040_0000;       // where an ET_DYN program goes
const STACK_SIZE = 8 << 20;
const TB_SIZE = 0x20_0000;          // per-thread Sys area (CPUState, dispatcher tables)
const SLOT_BASE = 256, SLOT_SIZE = 128, MAX_SLOTS = 1024;
const INPUT_RING = 256;             // display input events the host can queue
const KSAB_SIZE = SLOT_BASE + SLOT_SIZE * MAX_SLOTS;
// slot state
const S_IDLE = 0, S_REQ = 1, S_DONE = 2, S_BUSY = 3;
// reply flags
const F_REDIRECT = 1, F_EXIT = 2;
// special requests from thread workers
const NR_FAULT = 0x10000;           // (signal, rip, si_code): the thread faulted
const NR_STARTED = 0x10001;         // the worker is up
const NR_SIGCHECK = 0x10002;        // (value): a futex wait in the worker saw a signal; value is its result
// slot words (int32 index from the slot base) the thread workers watch
const W_SIGPEND = 20;               // a signal is waiting for this thread
const W_FUTEX = 21;                 // the guest address the worker is futex-waiting on (0: none)
const W_OCCUPIED = 26;              // a worker may still use the slot: set here, cleared by the host when the worker is gone
const W_UNCODE = 27;                // code of its process went away: the worker drops what it translated there (codeGone)
const W_UNCODE_LO = 28, W_UNCODE_HI = 29; // (where: every range since it last looked, as one)
// syscalls that SA_RESTART restarts (Linux: -ERESTARTSYS)
const RESTARTABLE = new Set([0, 1, 16, 17, 18, 19, 20, 42, 43, 44, 45, 46, 47, 61, 72, 73, 247, 288, 295, 296]);

const BLOCK = Symbol('block');      // handler result: park the thread, retry the same call later
// Handler result: park the thread and retry with fn instead.
class Retry {
  constructor(fn) { this.fn = fn; }
}
const pageUp = (x) => Math.ceil(x / PAGE) * PAGE;
const pageDown = (x) => Math.floor(x / PAGE) * PAGE;
const big = (n) => BigInt(n);
const i32 = (b) => Number(BigInt.asIntN(32, b));
const u32 = (b) => Number(BigInt.asUintN(32, b));
// A guest pointer argument: guest addresses are below 4 GB, and a pointer
// above that can't be anything we mapped.
const addr = (b) => {
  const v = BigInt.asUintN(64, b);
  if (v >> 32n) fail(E.FAULT);
  return Number(v);
};
// An address argument that may legitimately be anywhere (mmap hints, munmap):
// the full value, or Infinity at or above 4 GB.
const addr64 = (b) => {
  const v = BigInt.asUintN(64, b);
  return v >> 32n ? Infinity : Number(v);
};
const errno = (e) => -e;

class KError extends Error {
  constructor(code) {
    super('errno ' + code);
    this.code = code;
  }
}
const fail = (code) => { throw new KError(code); };

// ---------------------------------------------------------------------------
// Things threads wait on.
class WaitQueue {
  constructor() { this.threads = new Set(); }
  add(t) { this.threads.add(t); t.waitingOn.add(this); }
  wake(kernel) {
    for (const t of this.threads) kernel.makeRunnable(t);
    this.threads.clear();
  }
}

// ---------------------------------------------------------------------------
// Address space: a shared WebAssembly.Memory and its mappings.
// Memories for address spaces. The engine budgets address space over all
// of them by their maximum size (Safari on the Mac: 15 of 4 GB, 23 of 2 GB,
// 39 of 1 GB), and frees one only when it collects it; so a process gets the
// size it needs, and memories are reused: a dead image's memory goes back to
// the pool (with its record of what may be nonzero, zeroed as it is mapped
// again) once its workers are gone.
// The owner of mappings every process of a shared memory has (KUSER_SHARED_DATA).
const GLOBAL = { global: true };
const KUSER = 0x7ffe_0000;

class MemoryPool {
  constructor() { this.free = []; }
  take(maxPages, initialPages) {
    const now = performance.now();
    const i = this.free.findIndex((e) => e.maxPages === maxPages && e.readyAt <= now);
    if (i >= 0) {
      const e = this.free.splice(i, 1)[0];
      const have = e.mem.buffer.byteLength / WASM_PAGE;
      if (have < initialPages) e.mem.grow(initialPages - have);
      return e;
    }
    return { mem: new WebAssembly.Memory({ initial: initialPages, maximum: maxPages, shared: true }), dirty: [], maxPages };
  }
  give(mem, dirty, maxPages) {
    this.free.push({ mem, dirty, maxPages, readyAt: performance.now() + 1500 });
    if (this.free.length > 6) this.free.shift(); // (the oldest is left to the collector)
  }
}
const memoryPool = new MemoryPool();

class Mm {
  constructor(maxPages, initialPages) {
    this.maxPages = maxPages;
    // guest addresses: below the memory's maximum (and 4 GB)
    this.limit = Math.min(ADDR_LIMIT, maxPages * WASM_PAGE - WASM_PAGE);
    const e = memoryPool.take(maxPages, initialPages || 16);
    this.mem = e.mem;
    // sorted, non-overlapping {start, end, prot, flags, name, file?, owner}.
    // owner: the process image that mapped it; several processes can share
    // one memory (a shared address space), each changing only its own
    // mappings. GLOBAL: mapped for every process (KUSER_SHARED_DATA).
    this.vmas = [];
    this.dirty = e.dirty; // sorted intervals [start, end) that may hold nonzero bytes (a reused memory's too)
    this.users = 0; // processes using it
    this.version = 0; // changes with the mapping list
    this.dirtyBytes = this.dirty.reduce((n, [a, b]) => n + (b - a), 0);
    this.peakDirty = this.dirtyBytes;
    this.peakSize = this.mem.buffer.byteLength;
    // pages mapped writable and executable, a bit each: code there can change
    // without a syscall (packers, JITs), so a thread brings the translator's
    // copy of such a page up to date before asking for a unit on it (thread_core.js)
    this.wx = new Uint8Array(new SharedArrayBuffer(1 << 17));
  }
  setWx(start, end, on) {
    for (let p = start >>> 12, e = (end + 4095) >>> 12; p < e; p++) {
      if (on) this.wx[p >>> 3] |= 1 << (p & 7);
      else this.wx[p >>> 3] &= ~(1 << (p & 7));
    }
  }
  rebuildWx() {
    this.wx.fill(0);
    for (const v of this.vmas) if ((v.prot & 6) === 6) this.setWx(v.start, v.end, true);
  }
  get u8() { return new Uint8Array(this.mem.buffer); }
  get dv() { return new DataView(this.mem.buffer); }
  ensure(end) {
    const have = this.mem.buffer.byteLength;
    if (end <= have) return;
    const pages = Math.ceil((end - have) / WASM_PAGE);
    this.mem.grow(pages);
    this.peakSize = this.mem.buffer.byteLength;
  }
  find(a) {
    // index of the vma containing a, or -1
    let lo = 0, hi = this.vmas.length - 1;
    while (lo <= hi) {
      const m = (lo + hi) >> 1, v = this.vmas[m];
      if (a < v.start) hi = m - 1;
      else if (a >= v.end) lo = m + 1;
      else return m;
    }
    return -1;
  }
  // Index of the first mapping that ends after a.
  lower(a) {
    const vs = this.vmas;
    let lo = 0, hi = vs.length;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (vs[m].end <= a) lo = m + 1;
      else hi = m;
    }
    return lo;
  }
  isFree(start, end) {
    if (start < LOW_RESERVED || end > this.limit || start >= end) return false;
    const i = this.lower(start);
    return i >= this.vmas.length || this.vmas[i].start >= end;
  }
  findFree(len, align) {
    align = align || PAGE;
    let a = Math.ceil(MMAP_BASE / align) * align;
    const vs = this.vmas;
    for (let i = this.lower(a); i < vs.length; i++) {
      const v = vs[i];
      if (v.start >= a + len) break;
      a = Math.ceil(v.end / align) * align;
    }
    return a + len <= this.limit ? a : -1;
  }
  // The first free aligned [a, a + len) inside [lo, hi), going up from
  // from (step > 0) or down (step < 0); -1 if none.
  findFreeIn(lo, hi, from, len, step) {
    lo = Math.max(lo, LOW_RESERVED);
    hi = Math.min(hi, this.limit);
    const vs = this.vmas, al = Math.abs(step);
    let a = from;
    if (step > 0) {
      for (let i = this.lower(a); a + len <= hi; i++) {
        if (i >= vs.length || vs[i].start >= a + len) return a >= lo ? a : -1;
        a = Math.ceil(vs[i].end / al) * al;
      }
    } else {
      while (a >= lo && a + len <= hi) {
        const i = this.lower(a);
        if (i >= vs.length || vs[i].start >= a + len) return a;
        // the lowest mapping in the way: go below it
        a = Math.floor((vs[i].start - len) / al) * al;
      }
    }
    return -1;
  }
  // Removes [start, end) from the mapping list, splitting mappings; only
  // owner's, if given.
  cut(start, end, owner) {
    const vs = this.vmas, i = this.lower(start);
    let j = i;
    const repl = [];
    for (; j < vs.length && vs[j].start < end; j++) {
      const v = vs[j];
      if (owner !== undefined && v.owner !== owner) { repl.push(v); continue; }
      if ((v.prot & 6) === 6) this.setWx(Math.max(v.start, start), Math.min(v.end, end), false);
      if (v.start < start) repl.push(Object.assign({}, v, { end: start }));
      if (v.end > end) {
        const r = Object.assign({}, v, { start: end });
        if (r.file) r.file = Object.assign({}, r.file, { offset: r.file.offset + (end - v.start) });
        repl.push(r);
      }
    }
    if (j > i) {
      vs.splice(i, j - i, ...repl);
      this.version++;
    }
  }
  insert(v) {
    this.cut(v.start, v.end, v.owner);
    this.vmas.splice(this.lower(v.start), 0, v);
    if ((v.prot & 6) === 6) this.setWx(v.start, v.end, true); // (PROT_WRITE | PROT_EXEC)
    if (typeof process !== 'undefined' && process.env.FEXWASM_TRACECODE && (v.prot & 4)) console.error(`[mm] ${v.start.toString(16)}-${v.end.toString(16)} prot ${v.prot} ${v.name || ''}`);
    if (Mm.traceExec && (v.prot & 4) && v.name) Mm.traceExec(v); // (host.traceMaps: for profiles)
    this.version++;
  }
  // Does [start, end) hold mappings that aren't owner's (nor global)?
  foreign(start, end, owner) {
    const vs = this.vmas;
    for (let i = this.lower(start); i < vs.length && vs[i].start < end; i++) {
      if (vs[i].owner !== owner && vs[i].owner !== GLOBAL) return true;
    }
    return false;
  }
  // Removes all of owner's mappings; returns them.
  removeOwner(owner) {
    const gone = this.vmas.filter((v) => v.owner === owner);
    for (const v of gone) if ((v.prot & 6) === 6) this.setWx(v.start, v.end, false);
    if (gone.length) {
      this.vmas = this.vmas.filter((v) => v.owner !== owner);
      this.version++;
    }
    return gone;
  }
  // The MAP_SHARED mappings (kept while the list doesn't change).
  sharedVmas() {
    if (this.sharedVer !== this.version) {
      this.sharedCache = this.vmas.filter((v) => v.shared);
      this.sharedVer = this.version;
    }
    return this.sharedCache;
  }
  // Index of the first dirty interval that ends at or after a.
  dirtyAt(a) {
    const d = this.dirty;
    let lo = 0, hi = d.length;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (d[m][1] < a) lo = m + 1;
      else hi = m;
    }
    return lo;
  }
  // Zeroes whatever in [start, end) may be nonzero, and marks it clean.
  zero(start, end) {
    const d = this.dirty, i = this.dirtyAt(start);
    let j = i, u8 = null;
    const repl = [];
    for (; j < d.length && d[j][0] < end; j++) {
      const [a, b] = d[j];
      if (b <= start) { repl.push(d[j]); continue; }
      (u8 || (u8 = this.u8)).fill(0, Math.max(a, start), Math.min(b, end));
      this.dirtyBytes -= Math.min(b, end) - Math.max(a, start);
      if (a < start) repl.push([a, start]);
      if (b > end) repl.push([end, b]);
    }
    if (j > i) d.splice(i, j - i, ...repl);
  }
  markDirty(start, end) {
    const d = this.dirty, i = this.dirtyAt(start);
    let j = i, s = start, e = end, removed = 0;
    for (; j < d.length && d[j][0] <= end; j++) {
      s = Math.min(s, d[j][0]);
      e = Math.max(e, d[j][1]);
      removed += d[j][1] - d[j][0];
    }
    d.splice(i, j - i, [s, e]);
    this.dirtyBytes += (e - s) - removed;
    // 64 KB chunks ever written (a wasm memory can't give pages back: these stay resident)
    const t = this.mem.touched || (this.mem.touched = { map: new Uint8Array(65536), n: 0 });
    for (let c = start >>> 16, ce = (end - 1) >>> 16; c <= ce; c++) if (!t.map[c]) { t.map[c] = 1; t.n++; }
    if (this.dirtyBytes > this.peakDirty) this.peakDirty = this.dirtyBytes;
  }
  // A copy for fork: the same mappings and the bytes of every mapping that may be nonzero.
  clone(owner, newOwner) {
    const m = new Mm(this.maxPages, Math.ceil(this.mem.buffer.byteLength / WASM_PAGE));
    const mine = this.vmas.filter((v) => v.owner === owner || v.owner === GLOBAL);
    m.vmas = mine.map((v) => Object.assign({}, v, { owner: v.owner === GLOBAL ? GLOBAL : newOwner }));
    // (a reused memory: what the parent has mapped but never wrote must read as zero)
    for (const v of mine) m.zero(v.start, v.end);
    const src = this.u8, dst = m.u8;
    for (const [a, b] of this.dirty) {
      for (const v of mine) {
        const lo = Math.max(a, v.start), hi = Math.min(b, v.end);
        if (lo < hi) { dst.set(src.subarray(lo, hi), lo); m.markDirty(lo, hi); }
      }
    }
    return m;
  }
  // Nothing uses this address space any more: its memory goes back to the pool.
  retire() {
    if (this.mem) memoryPool.give(this.mem, this.dirty, this.maxPages);
    this.mem = null;
  }
}

// ---------------------------------------------------------------------------
// Open file descriptions.
let nextIno = 1n << 40n;
class File {
  constructor(kind) {
    this.kind = kind;
    this.refs = 0;
    this.flags = 0;
    this.pos = 0;
    this.ino = nextIno++;
  }
  read() { fail(E.INVAL); }
  write() { fail(E.INVAL); }
  pread() { fail(E.SPIPE); }
  pwrite() { fail(E.SPIPE); }
  seek() { fail(E.SPIPE); }
  stat() { return { mode: S_IF.CHR | 0o666, ino: this.ino, size: 0 }; }
  poll() { return 0x5; } // POLLIN | POLLOUT
  ioctl() { fail(E.NOTTY); }
  release() {}
  ref() { this.refs++; return this; }
  unref(k) { if (--this.refs === 0) this.release(k); }
}

const POLLIN = 1, POLLPRI = 2, POLLOUT = 4, POLLERR = 8, POLLHUP = 16, POLLNVAL = 32, POLLRDHUP = 0x2000;

class HostFile extends File {
  constructor(vfs, fd, path, flags, isDir) {
    super('file');
    this.vfs = vfs;
    this.fd = fd;
    this.path = path;
    this.flags = flags;
    this.isDir = isDir;
    this.dirents = null;
  }
  read(k, t, buf) {
    if (this.isDir) fail(E.ISDIR);
    const n = this.vfs.pread(this.fd, buf, this.pos);
    this.pos += n;
    return n;
  }
  write(k, t, buf) {
    if (this.isDir) fail(E.ISDIR);
    if (this.flags & O.APPEND) this.pos = Number(this.vfs.fstat(this.fd).size);
    const n = this.vfs.pwrite(this.fd, buf, this.pos);
    this.pos += n;
    return n;
  }
  pread(k, t, buf, off) { return this.vfs.pread(this.fd, buf, off); }
  pwrite(k, t, buf, off) { return this.vfs.pwrite(this.fd, buf, off); }
  seek(off, whence) {
    let p = whence === 0 ? off : whence === 1 ? this.pos + off : whence === 2 ? Number(this.vfs.fstat(this.fd).size) + off : -1;
    if (p < 0) fail(E.INVAL);
    this.pos = p;
    if (this.isDir && p === 0) this.dirents = null;
    return p;
  }
  stat() { return this.vfs.fstat(this.fd); }
  release() { this.vfs.close(this.fd); }
}

// Bytes produced once (synthetic /proc files).
class BufferFile extends File {
  constructor(bytes, mode) {
    super('buffer');
    this.bytes = bytes;
    this.mode = mode || (S_IF.REG | 0o444);
  }
  read(k, t, buf) {
    const n = Math.max(0, Math.min(buf.length, this.bytes.length - this.pos));
    buf.set(this.bytes.subarray(this.pos, this.pos + n));
    this.pos += n;
    return n;
  }
  pread(k, t, buf, off) {
    const n = Math.max(0, Math.min(buf.length, this.bytes.length - off));
    buf.set(this.bytes.subarray(off, off + n));
    return n;
  }
  seek(off, whence) {
    const p = whence === 0 ? off : whence === 1 ? this.pos + off : this.bytes.length + off;
    if (p < 0) fail(E.INVAL);
    return (this.pos = p);
  }
  stat() { return { mode: this.mode, ino: this.ino, size: this.bytes.length }; }
}

class DevFile extends File {
  constructor(name) { super('dev'); this.name = name; }
  read(k, t, buf) {
    if (this.name === 'null') return 0;
    if (this.name === 'zero') { buf.fill(0); return buf.length; }
    crypto.getRandomValues(buf.length > 65536 ? buf.subarray(0, 65536) : buf);
    return Math.min(buf.length, 65536);
  }
  write(k, t, buf) { return buf.length; }
  pread(k, t, buf) { return this.read(k, t, buf); }
  pwrite(k, t, buf) { return buf.length; }
  seek() { return 0; }
  stat() { return { mode: S_IF.CHR | 0o666, ino: this.ino, rdev: this.name === 'null' ? 0x103 : 0x105 }; }
}

// The host console.
class ConsoleFile extends File {
  constructor(fd) { super('console'); this.fd = fd; }
  read() { return 0; }
  write(k, t, buf) { k.host.write(this.fd, buf.slice()); return buf.length; }
  ioctl(k, t, req, arg) {
    if (req === 0x5413) { // TIOCGWINSZ
      const dv = t.proc.mm.dv;
      dv.setUint16(arg, 50, true); dv.setUint16(arg + 2, 160, true); dv.setUint32(arg + 4, 0, true);
      return 0;
    }
    if (req === 0x5401) { // TCGETS: a terminal
      t.proc.mm.u8.fill(0, arg, arg + 60);
      return 0;
    }
    fail(E.NOTTY);
  }
  stat() { return { mode: S_IF.CHR | 0o620, ino: this.ino, rdev: 0x8800 }; }
}

class Pipe {
  constructor() {
    this.chunks = [];
    this.size = 0;
    this.readers = 0;
    this.writers = 0;
    this.rq = new WaitQueue(); // readers waiting for data
    this.wq = new WaitQueue(); // writers waiting for room
    this.capacity = 65536;
  }
  take(buf) {
    let n = 0;
    while (n < buf.length && this.chunks.length) {
      const c = this.chunks[0], m = Math.min(c.length, buf.length - n);
      buf.set(c.subarray(0, m), n);
      n += m;
      if (m === c.length) this.chunks.shift();
      else this.chunks[0] = c.subarray(m);
    }
    this.size -= n;
    return n;
  }
}

class PipeEnd extends File {
  constructor(pipe, write) {
    super('pipe');
    this.pipe = pipe;
    this.isWrite = write;
    if (write) pipe.writers++;
    else pipe.readers++;
    this.flags = write ? O.WRONLY : 0;
  }
  read(k, t, buf) {
    const p = this.pipe;
    if (this.isWrite) fail(E.BADF);
    if (p.size === 0) {
      if (p.writers === 0) return 0;
      if (this.flags & O.NONBLOCK) fail(E.AGAIN);
      p.rq.add(t);
      return BLOCK;
    }
    const n = p.take(buf);
    p.wq.wake(k);
    k.pollChanged();
    return n;
  }
  write(k, t, buf) {
    const p = this.pipe;
    if (!this.isWrite) fail(E.BADF);
    if (p.readers === 0) { k.signalThread(t, SIG.PIPE); fail(E.PIPE); }
    const room = p.capacity - p.size;
    if (room <= 0 || (buf.length <= 4096 && room < buf.length)) {
      if (this.flags & O.NONBLOCK) fail(E.AGAIN);
      p.wq.add(t);
      return BLOCK;
    }
    const n = Math.min(room, buf.length);
    p.chunks.push(buf.slice(0, n));
    p.size += n;
    p.rq.wake(k);
    k.pollChanged();
    return n;
  }
  poll() {
    const p = this.pipe;
    if (this.isWrite) return (p.readers === 0 ? POLLERR : 0) | (p.size < p.capacity ? POLLOUT : 0);
    return (p.size ? POLLIN : 0) | (p.writers === 0 ? POLLHUP : 0);
  }
  ioctl(k, t, req, arg) {
    if (req === 0x541B) { t.proc.mm.dv.setInt32(arg, this.pipe.size, true); return 0; } // FIONREAD
    fail(E.NOTTY);
  }
  stat() { return { mode: S_IF.FIFO | 0o600, ino: this.ino, size: 0 }; }
  release(k) {
    const p = this.pipe;
    if (this.isWrite) p.writers--;
    else p.readers--;
    p.rq.wake(k);
    p.wq.wake(k);
    k.pollChanged();
  }
}

// AF_UNIX stream and datagram sockets (Wine's server connection and fd passing).
class UnixSocket extends File {
  constructor(type) {
    super('socket');
    this.type = type & 0xf; // 1 stream, 2 dgram, 5 seqpacket
    this.flags = type & O.NONBLOCK;
    this.peer = null;
    this.queue = []; // {data: Uint8Array, files: File[]}
    this.queued = 0;
    this.rq = new WaitQueue();
    this.wq = new WaitQueue();
    this.listening = false;
    this.backlog = [];
    this.acceptQ = new WaitQueue();
    this.path = null;
    this.shutRd = false;
    this.shutWr = false;
    this.peerGone = false;
  }
  poll() {
    let m = 0;
    if (this.listening) return this.backlog.length ? POLLIN : 0;
    if (this.queue.length || this.peerGone || this.shutRd) m |= POLLIN;
    if (this.peerGone) m |= POLLHUP | POLLRDHUP;
    if (this.peer && !this.peerGone && this.peer.queued < 256 * 1024) m |= POLLOUT;
    return m;
  }
  // Sends data (and files) to the peer.
  send(k, t, data, files) {
    if (!this.peer || this.peerGone) {
      if (this.type === 1 || this.type === 5) { if (this.peerGone) { k.signalThread(t, SIG.PIPE); fail(E.PIPE); } fail(E.NOTCONN); }
      fail(E.DESTADDRREQ);
    }
    const p = this.peer;
    if (p.queued > 256 * 1024) {
      if (this.flags & O.NONBLOCK) fail(E.AGAIN);
      p.wq.add(t);
      return BLOCK;
    }
    for (const f of files) f.ref();
    p.queue.push({ data: data.slice(), files });
    p.queued += data.length;
    p.rq.wake(k);
    k.pollChanged();
    return data.length;
  }
  // -> {n, files} or BLOCK; fills buf.
  recv(k, t, buf, peek, nonblock) {
    if (!this.queue.length) {
      if (this.peerGone || this.shutRd) return { n: 0, files: [] };
      if ((this.flags & O.NONBLOCK) || nonblock) fail(E.AGAIN);
      this.rq.add(t);
      return BLOCK;
    }
    let n = 0;
    const files = [];
    if (this.type === 1) {
      // stream: fill from several messages, but files only come with the first
      while (n < buf.length && this.queue.length) {
        const m = this.queue[0];
        if (n > 0 && m.files.length) break;
        const c = Math.min(m.data.length, buf.length - n);
        buf.set(m.data.subarray(0, c), n);
        n += c;
        if (m.files.length) { files.push(...m.files); if (!peek) m.files = []; }
        if (peek) break;
        if (c === m.data.length) this.queue.shift();
        else m.data = m.data.subarray(c);
        this.queued -= c;
      }
    } else {
      const m = peek ? this.queue[0] : this.queue.shift();
      n = Math.min(m.data.length, buf.length);
      buf.set(m.data.subarray(0, n));
      files.push(...m.files);
      if (!peek) this.queued -= m.data.length;
    }
    if (this.peer) this.peer.wq.wake(k);
    this.wq.wake(k);
    k.pollChanged();
    return { n, files, peeked: peek };
  }
  read(k, t, buf) {
    const r = this.recv(k, t, buf, false, false);
    if (r === BLOCK) return BLOCK;
    for (const f of r.files) f.unref(k); // plain read drops passed files
    return r.n;
  }
  write(k, t, buf) { return this.send(k, t, buf, []); }
  stat() { return { mode: S_IF.SOCK | 0o777, ino: this.ino, size: 0 }; }
  release(k) {
    if (this.peer) {
      this.peer.peerGone = true;
      this.peer.rq.wake(k);
      this.peer.wq.wake(k);
      this.peer.peer = null;
    }
    for (const m of this.queue) for (const f of m.files) f.unref(k);
    this.queue = [];
    if (this.path && k.unixNames.get(this.path) === this) k.unixNames.delete(this.path);
    for (const s of this.backlog) s.unref(k);
    k.pollChanged();
  }
}

class EventFd extends File {
  constructor(v, flags) {
    super('eventfd');
    this.value = BigInt(v);
    this.semaphore = !!(flags & 1);
    this.flags = flags & O.NONBLOCK;
    this.q = new WaitQueue();
  }
  read(k, t, buf) {
    if (buf.length < 8) fail(E.INVAL);
    if (this.value === 0n) {
      if (this.flags & O.NONBLOCK) fail(E.AGAIN);
      this.q.add(t);
      return BLOCK;
    }
    const v = this.semaphore ? 1n : this.value;
    this.value -= v;
    new DataView(buf.buffer, buf.byteOffset, 8).setBigUint64(0, v, true);
    this.q.wake(k);
    k.pollChanged();
    return 8;
  }
  write(k, t, buf) {
    if (buf.length < 8) fail(E.INVAL);
    this.value += new DataView(buf.buffer, buf.byteOffset, 8).getBigUint64(0, true);
    this.q.wake(k);
    k.pollChanged();
    return 8;
  }
  poll() { return (this.value > 0n ? POLLIN : 0) | POLLOUT; }
}

class EpollFile extends File {
  constructor() {
    super('epoll');
    this.watch = new Map(); // fd -> {file, events, data}
  }
}

// ---------------------------------------------------------------------------
class Thread {
  constructor(proc, tid, slot, tb) {
    this.proc = proc;
    this.tid = tid;
    this.slot = slot;
    this.tb = tb;
    this.sigmask = 0n;
    this.pending = 0n;
    this.clearTid = 0;
    this.retry = null;      // a parked syscall: () -> result | BLOCK
    this.waitingOn = new Set();
    this.timer = null;
    this.dead = false;
    this.inSyscall = false;
    this.robustList = 0;
    this.altstack = null;
  }
}

class Process {
  constructor(k, pid, ppid) {
    this.k = k;
    this.pid = pid;
    this.ppid = ppid;
    this.pgid = pid;
    this.sid = pid;
    this.mm = null;
    this.space = 0;
    this.fds = new Map(); // fd -> {file, cloexec}
    this.cwd = '/';
    this.umask = 0o22;
    this.actions = new Array(65).fill(null).map(() => ({ handler: 0n, flags: 0n, restorer: 0n, mask: 0n }));
    this.threads = new Map();
    this.children = new Set();
    this.zombie = false;
    this.exitStatus = 0;
    this.childWait = new WaitQueue();
    this.exe = '';
    this.argv = [];
    this.vforkParent = null; // the thread waiting for this vfork child to exec or exit
    this.rlimits = new Map();
  }
  allocFd(file, min, cloexec) {
    let fd = min || 0;
    while (this.fds.has(fd)) fd++;
    if (fd >= 65536) fail(E.MFILE);
    this.fds.set(fd, { file: file.ref(), cloexec: !!cloexec });
    return fd;
  }
  file(fd) {
    const e = this.fds.get(fd);
    if (!e) fail(E.BADF);
    return e.file;
  }
  closeFd(fd) {
    const e = this.fds.get(fd);
    if (!e) fail(E.BADF);
    this.fds.delete(fd);
    this.k.releaseLocks(this, e.file);
    e.file.unref(this.k);
  }
}

// ---------------------------------------------------------------------------
class Kernel {
  constructor(host, cfg) {
    this.host = host;
    this.cfg = cfg;               // the translator's /xlat/config
    this.vfs = host.vfs;
    this.ksab = new SharedArrayBuffer(KSAB_SIZE);
    this.k32 = new Int32Array(this.ksab);
    this.k64 = new BigInt64Array(this.ksab);
    this.procs = new Map();
    this.threads = new Map();     // tid -> Thread
    this.slots = new Array(MAX_SLOTS).fill(null);
    this.nextPid = 100;
    this.nextSpace = 1;
    this.runnable = [];
    this.timers = [];             // {at, fn}
    this.unixNames = new Map();   // bound AF_UNIX path -> listening socket
    this.locks = new Map();       // "dev:ino" -> [{proc, start, end, type}]
    this.lockQ = new WaitQueue();
    this.pollQ = new WaitQueue(); // threads in poll/epoll/select
    this.pollDirty = false;
    this.t0 = performance.now();
    this.stats = { syscalls: 0, byNr: new Map(), msByNr: new Map(), syncMs: 0, handlerMs: 0, idleMs: 0 };
    this.trace = !!host.trace;
    this.initProc = null;
    this.spaceUsers = new Map();
    this.sharedFiles = new Map();
    // Input for the guest's display driver (syscalls.js, fexwasm display):
    // the host writes {type, x, y, flags, data} events (i32) into a ring
    // (i32 0: written, 1: read, then INPUT_RING entries) and rings the
    // doorbell; while any wait, the drivers' eventfds are readable.
    this.inputSab = new SharedArrayBuffer(8 + INPUT_RING * 20);
    this.input32 = new Int32Array(this.inputSab);
    this.inputFds = new Set();
    this.displayWindows = new Map(); // hwnd -> {frame (the last message), surface {bits, sw, sh, stride}}
  }
  // New input in the ring: the display drivers' eventfds become readable.
  checkInput() {
    if (!this.inputFds.size || Atomics.load(this.input32, 0) === Atomics.load(this.input32, 1)) return;
    for (const f of this.inputFds) {
      if (f.refs <= 0) { this.inputFds.delete(f); continue; }
      if (f.value === 0n) { f.value = 1n; f.q.wake(this); this.pollChanged(); }
    }
  }

  now() { return performance.now(); }
  log(m) { this.host.log(m); }
  // How the translator may treat code mapped from this file (see
  // fexwasm_map_code_abi): 1, compiled code that keeps the Win64 calling
  // convention, for the files named in host.win64 (basenames, comma
  // separated: a game's own code, DXMT's; not packed or hand-written code,
  // which may pass flags or registers across calls: CODEX's UPX stub).
  abiFor(name) {
    if (!name || !this.host.win64) return 0;
    if (!this.win64Names) this.win64Names = new Set(this.host.win64.toLowerCase().split(',').map((x) => x.trim()).filter(Boolean));
    return this.win64Names.has(name.split('/').pop().toLowerCase()) ? 1 : 0;
  }
  abiAt(mm, addr) {
    const v = mm.vmas.find((x) => addr >= x.start && addr < x.end);
    return v ? this.abiFor(v.name) : 0;
  }
  // (host.traceMaps: every executable file mapping, to put names on a profile's addresses)
  traceMaps() { Mm.traceExec = (v) => this.log(`[mm] ${v.start.toString(16)}-${v.end.toString(16)} ${v.name}`); }

  // --- scheduling ------------------------------------------------------------
  makeRunnable(t) {
    if (t.retry && !t.queued) {
      t.queued = true;
      this.runnable.push(t);
    }
  }
  pollChanged() { this.pollDirty = true; }
  addTimer(ms, fn) {
    const tm = { at: this.now() + ms, fn, dead: false };
    this.timers.push(tm);
    return tm;
  }

  // The kernel loop: runs until the first process exits and nothing is left.
  run() {
    const k32 = this.k32;
    for (;;) {
      const seen = Atomics.load(k32, 0);
      let did = false;
      for (let i = 0; i < MAX_SLOTS; i++) {
        const t = this.slots[i];
        if (!t) continue;
        const base = (SLOT_BASE + i * SLOT_SIZE) >> 2;
        if (Atomics.load(k32, base) === S_REQ) {
          Atomics.store(k32, base, S_BUSY);
          this.request(t);
          did = true;
        }
      }
      this.checkInput();
      // parked syscalls whose wait may be over
      while (this.runnable.length || this.pollDirty) {
        if (this.pollDirty) {
          this.pollDirty = false;
          this.pollQ.wake(this);
        }
        const r = this.runnable;
        this.runnable = [];
        for (const t of r) {
          t.queued = false;
          if (t.retry && !t.dead) this.attempt(t, t.retry);
        }
        did = true;
      }
      // timers
      const now = this.now();
      let next = Infinity;
      if (this.timers.length) {
        const due = [];
        this.timers = this.timers.filter((tm) => {
          if (tm.dead) return false;
          if (tm.at <= now) { due.push(tm); return false; }
          next = Math.min(next, tm.at);
          return true;
        });
        for (const tm of due) tm.fn();
        if (due.length) continue;
      }
      if (this.done) return this.exitCode;
      if (this.dumpFlag && Atomics.exchange(this.dumpFlag, 0, 0)) this.dump();
      if (did) { this.lastWork = now; continue; }
      const w0 = performance.now();
      // (host.spinMs: soon after work, watch for the next request instead of
      // sleeping: a thread's syscalls and the wineserver's come in bursts, and
      // waking a sleeping worker costs tens of microseconds on the phone)
      const spin = this.host.spinMs || 0;
      if (spin && w0 - (this.lastWork || 0) < 50 * spin) {
        const until = Math.min(w0 + spin, next);
        while (Atomics.load(k32, 0) === seen && performance.now() < until);
        if (Atomics.load(k32, 0) !== seen) { this.stats.idleMs += performance.now() - w0; continue; }
      }
      Atomics.wait(k32, 0, seen, next === Infinity ? 1000 : Math.max(0, next - now));
      this.stats.idleMs += performance.now() - w0;
    }
  }

  // --- MAP_SHARED file mappings --------------------------------------------------
  // Processes have separate memories, so a shared mapping is a copy in each
  // mapper, kept coherent through the kernel: the canonical bytes live here
  // (and in the file); when a process that has shared mappings writable makes
  // a syscall, the pages it changed go to the file and to every other mapping.
  // (Wine: the wineserver writes KUSER_SHARED_DATA and the session memory;
  // clients map them read-only.)
  // (Linux also shows file changes to MAP_PRIVATE mappings in the pages the
  // process hasn't written, and Wine counts on it: it maps read-only views of
  // sections, the session memory included, MAP_PRIVATE. Private mappings of a
  // file that has shared ones get the updates while they are read-only.)
  sharedFile(file, lookupOnly) {
    if (!(file instanceof HostFile)) return null;
    const st = file.stat();
    const key = `${st.dev}:${st.ino}`;
    let sf = this.sharedFiles.get(key);
    if (!sf && lookupOnly) return null;
    if (!sf) {
      sf = { key, file: file.ref(), data: new Uint8Array(0), mms: new Set() };
      this.sharedFiles.set(key, sf);
    }
    return sf;
  }
  // Canonical bytes [off, off + len) of sf, loaded from the file as needed.
  sharedBytes(sf, off, len) {
    if (sf.data.length < off + len) {
      const d = new Uint8Array(pageUp(off + len));
      d.set(sf.data);
      const tmp = new Uint8Array(d.length - sf.data.length);
      const n = sf.file.vfs.pread(sf.file.fd, tmp, sf.data.length);
      d.set(tmp.subarray(0, n), sf.data.length);
      sf.data = d;
    }
    return sf.data.subarray(off, off + len);
  }
  // A new shared mapping of sf at [start, start + len) (file offset off) in mm.
  mapShared(mm, sf, start, len, off) {
    if (this.host.traceShm) this.log(`[shm] map ${sf.key} off ${off.toString(16)} len ${len.toString(16)} at ${start.toString(16)}`);
    mm.u8.set(this.sharedBytes(sf, off, len), start);
    sf.mms.add(mm);
    mm.shared = true;
  }
  // Sends what mm changed in [a, a + n) (inside shared mapping v) to the
  // canonical bytes, the file and every other mapping of it: only the 32-bit
  // words that differ from the canonical bytes, so that two processes
  // writing different fields of one page don't undo each other's writes.
  pushShared(mm, v, a, n, toFile) {
    const sf = v.shared;
    const lo = a - (a % 4), hi = a + n + ((4 - ((a + n) % 4)) % 4); // (past 2 GB: no signed bit operations)
    const off = v.file.offset + (lo - v.start);
    const canon = this.sharedBytes(sf, off, hi - lo);
    const mine = new Int32Array(mm.mem.buffer, lo, (hi - lo) >> 2), theirs = new Int32Array(canon.buffer, canon.byteOffset, (hi - lo) >> 2);
    for (let i = 0; i < mine.length; i++) {
      if (mine[i] === theirs[i]) continue;
      let j = i + 1;
      while (j < mine.length && mine[j] !== theirs[j]) j++;
      const ra = lo + 4 * i, fo = off + 4 * i, bytes = mm.u8.slice(ra, lo + 4 * j);
      canon.set(bytes, 4 * i);
      if (toFile) sf.file.vfs.pwrite(sf.file.fd, bytes, fo);
      for (const om of sf.mms) {
        for (const w of om.vmas) {
          if ((w.shared !== sf && (w.sharedPriv !== sf || w.prot & PROT.WRITE)) || (om === mm && w === v)) continue;
          const l2 = Math.max(w.file.offset, fo), h2 = Math.min(w.file.offset + (w.end - w.start), fo + bytes.length);
          if (l2 < h2) om.u8.set(bytes.subarray(l2 - fo, h2 - fo), w.start + (l2 - w.file.offset));
        }
      }
      if (this.host.traceShm) this.log(`[shm] ${mm === this.initProc?.mm ? 'init' : 'pid'} wrote ${sf.key} off ${fo.toString(16)} (${bytes.length} bytes)`);
      i = j;
    }
  }
  syncShared(proc) {
    const mm = proc.mm;
    if (!mm || !mm.shared) return;
    // A process that logs its writes (the wineserver, patched: see
    // shared_mark_dirty) needs only those copied; a full comparison now and
    // then catches anything unlogged.
    const log = proc.dirtyLog;
    if (log) {
      const dv = mm.dv, count = dv.getUint32(log.addr, true), overflow = dv.getUint32(log.addr + 4, true);
      const now = performance.now();
      dv.setUint32(log.addr, 0, true);
      dv.setUint32(log.addr + 4, 0, true);
      if (!overflow && now - (proc.lastFullSync || 0) < 2000) {
        for (let i = 0; i < Math.min(count, log.cap); i++) {
          const a = Number(dv.getBigUint64(log.addr + 8 + 16 * i, true) & 0xffffffffn), n = Number(dv.getBigUint64(log.addr + 16 + 16 * i, true));
          for (const v of mm.sharedVmas()) {
            if (v.owner !== proc.image || v.end <= a || v.start >= a + n) continue;
            const lo = Math.max(v.start, a), hi = Math.min(v.end, a + n);
            this.pushShared(mm, v, lo, hi - lo);
          }
        }
        return;
      }
      proc.lastFullSync = now;
    }
    let any = false;
    for (const v of mm.sharedVmas()) {
      if (v.owner !== proc.image) continue;
      any = true;
      if (!(v.prot & PROT.WRITE)) continue;
      const sf = v.shared, off = v.file.offset, len = v.end - v.start;
      const canon = this.sharedBytes(sf, off, len);
      const mine = new Int32Array(mm.mem.buffer, v.start, len >> 2), theirs = new Int32Array(canon.buffer, canon.byteOffset, len >> 2);
      for (let pg = 0; pg < len; pg += PAGE) {
        let diff = false;
        for (let i = pg >> 2, e = (pg + PAGE) >> 2; i < e; i++) if (mine[i] !== theirs[i]) { diff = true; break; }
        if (diff) this.pushShared(mm, v, v.start + pg, PAGE, true);
      }
    }
    if (!any && mm !== this.sharedMm) mm.shared = false;
  }

  // How much guest memory there is: the shared memory's size, and the most
  // of it that has held data (the rest was never touched).
  memInfo() {
    const mm = this.sharedMm || this.lastSharedMm;
    if (!mm) return '';
    const touched = mm.mem && mm.mem.touched ? mm.mem.touched.n * 65536 : 0;
    return `${(mm.dirtyBytes / 1e6).toFixed(0)} MB in use (at most ${(mm.peakDirty / 1e6).toFixed(0)}), ${(touched / 1e6).toFixed(0)} MB ever written`;
  }
  // Every process and thread, and the syscall each is parked in (debugging).
  // With trackrip, threads running guest code get their RIP sampled.
  dump() {
    const running = [];
    for (const p of this.procs.values()) for (const t of p.threads.values()) if (!t.retry && !t.inSyscall && p.mm) running.push(t);
    const hist = new Map();
    for (let i = 0; i < 400; i++) {
      for (const t of running) {
        const r = this.cpu(t).rip();
        const h = hist.get(t) || new Map();
        h.set(r, (h.get(r) || 0) + 1);
        hist.set(t, h);
      }
      const until = performance.now() + 2;
      while (performance.now() < until);
    }
    for (const p of this.procs.values()) {
      if (!p.mm) continue;
      const sh = p.mm.vmas.filter((v) => v.shared || v.sharedPriv).map((v) => `${v.start.toString(16)}-${v.end.toString(16)} prot ${v.prot} ${v.shared ? 'shared' : 'private'} ${(v.shared || v.sharedPriv).key}`);
      if (sh.length) this.log(`  pid ${p.pid} shared file mappings: ${sh.join('; ')}`);
    }
    for (const [t, h] of hist) {
      // replay the dispatcher's probe for the RIP it is stuck on
      const [rip] = [...h].sort((a, b) => b[1] - a[1])[0];
      const dv = t.proc.mm.dv, bits = this.cfg.dispatchBits, mask = (1 << bits) - 1, base = t.tb + this.cfg.dispatchBase;
      const r32 = Number(rip & 0xffffffffn);
      let hh = Math.imul(r32, 0x9E3779B1) >>> (32 - bits), steps = 0, found = 'none';
      for (; steps < (1 << bits); steps++, hh = (hh + 1) & mask) {
        const r = dv.getUint32(base + 64 * hh, true);
        if (r === r32) { found = `hit idx ${dv.getUint32(base + 64 * hh + 4, true)} count ${dv.getUint32(base + 64 * hh + 8, true)}`; break; }
        if (r === 0) { found = 'empty'; break; }
      }
      this.log(`  tid ${t.tid} probe for 0x${r32.toString(16)}: ${found} after ${steps} steps`);
      const top = [...h].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([r, n]) => `0x${r.toString(16)}:${n}`).join(' ');
      this.log(`  tid ${t.tid} rip samples: ${top}`);
    }
    for (const p of this.procs.values()) {
      this.log(`  pid ${p.pid} ppid ${p.ppid} ${p.zombie ? 'zombie' : ''} ${p.argv.join(' ').slice(0, 120)}`);
      for (const t of p.threads.values()) {
        const call = `${SYS_NAME[t.nr] || t.nr}(${(t.args || []).slice(0, 4).map((x) => '0x' + BigInt.asUintN(64, x).toString(16)).join(', ')})`;
        let what = t.retry ? `blocked in ${call}` : t.inSyscall ? 'in a syscall' : `running guest code (last syscall ${call})`;
        // (an ntsync wait: on what, and how each stands; see ntsync.js)
        const w = t.ntWait;
        if (w) {
          const st = (o) => `${o.type === 1 ? 'sem' : o.type === 2 ? 'mutex' : 'event'}#${o.ino}(${o.a},${o.b}${o.ownerdead ? ',dead' : ''})`;
          what += `; ntsync wait-${w.all ? 'all' : 'any'} owner ${w.owner} on ${w.objs.map(st).join(' ')}${w.alert ? ' alert ' + st(w.alert) : ''}${w.done ? ' DONE' : ''} deadline ${w.deadline === Infinity ? 'none' : (w.deadline - performance.now()).toFixed(0) + ' ms'}`;
        }
        // (a futex wait: the address)
        const fw = Atomics.load(this.k32, ((SLOT_BASE + t.slot * SLOT_SIZE) >> 2) + W_FUTEX);
        if (fw) what += `; futex wait on 0x${(fw >>> 0).toString(16)}`;
        // (dumpStacks: what on its stack points into code, as module+offset)
        if (this.host.dumpStacks && p.mm && (w || fw || t.retry)) {
          const dv = p.mm.dv, sp = Number(this.cpu(t).get(4) & 0xffffffffn), exec = p.mm.vmas.filter((v) => v.prot & 4 && v.name);
          // (a module's base: the lowest mapping of the same file by the same owner below it)
          const baseOf = (v) => p.mm.vmas.reduce((m, x) => (x.name === v.name && x.owner === v.owner && x.start <= v.start && v.start - x.start < 0x4000000 ? Math.min(m, x.start) : m), v.start);
          const hits = [];
          for (let o = 0; o < 0x2000 && hits.length < 24 && sp + o + 8 <= p.mm.limit; o += 8) {
            const a = Number(dv.getBigUint64(sp + o, true));
            const v = exec.find((x) => a >= x.start && a < x.end);
            if (v) hits.push(`${v.name.split('/').pop()}+${(a - baseOf(v)).toString(16)}`);
          }
          what += `\n        stack: ${hits.join(' ')}`;
        }
        let used = 0, zeroRip = 0;
        if (p.mm) {
          const dv = p.mm.dv, base = t.tb + this.cfg.dispatchBase;
          for (let h = 0; h < 1 << this.cfg.dispatchBits; h++) {
            const r = dv.getUint32(base + 64 * h, true);
            if (r) used++;
          }
        }
        const rip = p.mm ? this.cpu(t).rip() : 0n;
        const sb = (SLOT_BASE + t.slot * SLOT_SIZE) >> 2;
        this.log(`      worker: last syscall ${this.k32[sb + 22]} (a0 0x${(this.k32[sb + 25] >>> 0).toString(16)}, a1 0x${(this.k32[sb + 24] >>> 0).toString(16)}), ${this.k32[sb + 23]} in all; mask 0x${t.sigmask.toString(16)} pending 0x${t.pending.toString(16)}`);
        this.log(`    tid ${t.tid}: ${what}; ${t.nsys || 0} syscalls; dispatch table ${used}/${1 << this.cfg.dispatchBits}; rip 0x${rip.toString(16)}`);
      }
    }
  }

  // Code of proc was unmapped: its threads drop their translations (the
  // same addresses may hold other code next: a DLL unloaded and another
  // loaded where it was), each when a syscall of its returns.
  codeGone(proc, lo, hi) {
    if (typeof process !== 'undefined' && process.env.FEXWASM_NOCODEGONE) return; // (debugging)
    const who = [];
    for (const t of this.threads.values()) {
      if (t.proc !== proc || t.slot === undefined) continue;
      const w = (SLOT_BASE + t.slot * SLOT_SIZE) >> 2, k = this.k32;
      if (!Atomics.load(k, w + W_UNCODE)) { k[w + W_UNCODE_LO] = lo; k[w + W_UNCODE_HI] = hi; }
      else { k[w + W_UNCODE_LO] = Math.min(k[w + W_UNCODE_LO] >>> 0, lo); k[w + W_UNCODE_HI] = Math.max(k[w + W_UNCODE_HI] >>> 0, hi); }
      Atomics.store(k, w + W_UNCODE, 1);
      who.push(t.tid);
    }
    if (this.host.traceCode || (typeof process !== 'undefined' && process.env.FEXWASM_TRACECODE))
      this.log(`[kernel] code gone in pid ${proc.pid} at ${lo.toString(16)}-${hi.toString(16)}: threads ${who.join(' ')}`);
  }

  // A request from thread t's slot.
  request(t) {
    t.awaiting = true; // exactly one reply per request
    const base = (SLOT_BASE + t.slot * SLOT_SIZE) >> 3;
    const nr = Number(this.k64[base + 1]);
    const a = [];
    for (let i = 0; i < 6; i++) a.push(this.k64[base + 2 + i]);
    this.stats.syscalls++;
    this.stats.byNr.set(nr, (this.stats.byNr.get(nr) || 0) + 1);
    if (this.freezing && this.freezeRequest(t, nr)) return; // (snapshot.js)
    if (nr === NR_STARTED) return this.reply(t, 0n);
    if (nr === NR_SIGCHECK) return this.attempt(t, () => a[0]);
    if (nr === NR_FAULT) {
      this.log(`[pid ${t.proc.pid} tid ${t.tid}] fatal: signal ${Number(a[0])} at rip 0x${a[1].toString(16)} (${Number(a[2])})`);
      // (its registers, and the stack around rsp: text shows as text)
      if (t.proc.mm) {
        const c = this.cpu(t), names = ['rax', 'rcx', 'rdx', 'rbx', 'rsp', 'rbp', 'rsi', 'rdi', 'r8', 'r9', 'r10', 'r11', 'r12', 'r13', 'r14', 'r15'];
        this.log('  ' + names.map((n, i) => `${n} ${c.get(i).toString(16)}`).join(' '));
        const sp = Number(c.get(4) & 0xffffffffn), u8 = t.proc.mm.u8;
        for (let o = -64; o < 192; o += 32) {
          const b = u8.subarray(sp + o, sp + o + 32);
          this.log(`  ${(sp + o).toString(16)}: ${[...b].map((x) => x.toString(16).padStart(2, '0')).join('')}  ${[...b].map((x) => (x >= 32 && x < 127 ? String.fromCharCode(x) : '.')).join('')}`);
        }
      }
      // FEXWASM_PEEK=addr:len,...: dump guest memory of a dying process (debugging)
      for (const spec of (this.host.peek || '').split(',').filter(Boolean)) {
        const [pa, pl] = spec.split(':').map((x) => parseInt(x, 16));
        const b = t.proc.mm.u8.subarray(pa, pa + (pl || 64));
        let line = '';
        for (let i = 0; i < b.length; i++) line += (i % 16 ? ' ' : `\n  ${(pa + i).toString(16)}:`) + b[i].toString(16).padStart(2, '0');
        this.log(`[pid ${t.proc.pid}] peek ${spec}${line}`);
      }
      this.killProcess(t.proc, Number(a[0]));
      return;
    }
    if (t.proc.mm && t.proc.mm.shared) {
      const s0 = performance.now();
      this.syncShared(t.proc);
      this.stats.syncMs += performance.now() - s0;
    }
    t.nr = nr;
    t.args = a;
    t.nsys = (t.nsys || 0) + 1;
    const h = this.sys[nr];
    if (!h) {
      if (this.trace || !this.warned?.has(nr)) {
        (this.warned || (this.warned = new Set())).add(nr);
        this.log(`[pid ${t.proc.pid}] unimplemented syscall ${nr} (${SYS_NAME[nr] || '?'})`);
      }
      return this.reply(t, big(-E.NOSYS));
    }
    t.inSyscall = true;
    const fn = () => h.call(this, t, ...a);
    const h0 = performance.now();
    if (this.trace) t.traceName = `${SYS_NAME[nr] || nr}(${a.slice(0, h.length - 1).map((x) => '0x' + BigInt.asUintN(64, x).toString(16)).join(', ')})`;
    this.attempt(t, fn);
    const dt = performance.now() - h0;
    this.stats.handlerMs += dt;
    this.stats.msByNr.set(nr, (this.stats.msByNr.get(nr) || 0) + dt);
  }

  attempt(t, fn) {
    let r;
    try {
      r = fn();
    } catch (e) {
      if (e instanceof KError) r = big(-e.code);
      else if (e === EXIT_THREAD) return;
      else {
        this.log(`[pid ${t.proc.pid} tid ${t.tid}] kernel error in ${t.traceName || 'syscall'}: ${e.stack || e}`);
        r = big(-E.INVAL);
      }
    }
    if (r === BLOCK || r instanceof Retry) {
      t.retry = r === BLOCK ? fn : r.fn;
      // A signal that came while it ran guest code, before this syscall (its
      // kick found nothing parked): Linux doesn't go to sleep with one to
      // deliver, and nothing else would interrupt this wait for it. (Wine's
      // SIGUSR1 carries system APCs: an ntsync wait that parked on top of one
      // waited forever for an I/O completion only the APC brings.)
      if (!t.noInterrupt && this.pendingActive(t)) this.kick(t);
      return;
    }
    if (r === EXIT_THREAD) return;
    this.unblock(t);
    if (r === REDIRECTED) {
      if (this.pendingFor(t)) return this.deliver(t, null, false);
      return this.reply(t, 0n, F_REDIRECT);
    }
    if (typeof r === 'number') r = big(r);
    if (this.trace) this.log(`[${t.tid}] ${t.traceName} = ${r < 0n && r > -4096n ? 'E' + -r : '0x' + BigInt.asUintN(64, r).toString(16)}`);
    if (this.pendingFor(t)) return this.deliver(t, r, false);
    this.reply(t, r);
  }

  // Takes a parked thread off whatever it waits on.
  unblock(t) {
    t.retry = null;
    t.noInterrupt = false;
    for (const q of t.waitingOn) q.threads.delete(t);
    t.waitingOn.clear();
    if (t.timer) { t.timer.dead = true; t.timer = null; }
    t.sleepUntil = undefined;
    t.pollDeadline = undefined;
  }

  reply(t, result, flags) {
    if (t.dead) return;
    if (!t.awaiting) {
      this.log(`[kernel] BUG: a second reply to tid ${t.tid} (${SYS_NAME[t.nr] || t.nr}): ${new Error().stack.split('\n').slice(2, 6).join(' <- ')}`);
      return;
    }
    t.awaiting = false;
    t.inSyscall = false;
    const b64 = (SLOT_BASE + t.slot * SLOT_SIZE) >> 3, b32 = (SLOT_BASE + t.slot * SLOT_SIZE) >> 2;
    this.k64[b64 + 8] = result;
    this.k32[b32 + 1] = flags || 0;
    // the worker's "signal waiting" flag: deliverable ones only (pending and
    // not blocked); while the system freezes, always (snapshot.js)
    Atomics.store(this.k32, b32 + W_SIGPEND, this.freezing || this.pendingFor(t) ? 1 : 0);
    Atomics.store(this.k32, b32, S_DONE);
    Atomics.notify(this.k32, b32);
  }

  // --- guest memory helpers ----------------------------------------------------
  str(t, p, max) {
    const u8 = t.proc.mm.u8;
    let e = p;
    const lim = Math.min(u8.length, p + (max || 4096));
    while (e < lim && u8[e]) e++;
    if (e >= lim) fail(p >= u8.length ? E.FAULT : E.NAMETOOLONG);
    return new TextDecoder().decode(u8.subarray(p, e));
  }
  strArray(t, p) {
    const out = [];
    if (!p) return out;
    const dv = t.proc.mm.dv;
    for (let i = 0; ; i++) {
      const q = Number(dv.getBigUint64(p + 8 * i, true));
      if (!q) break;
      out.push(this.str(t, q, 1 << 20));
    }
    return out;
  }
  checkRange(t, p, n) {
    if (p + n > t.proc.mm.mem.buffer.byteLength) fail(E.FAULT);
  }
  bytes(t, p, n) {
    this.checkRange(t, p, n);
    return new Uint8Array(t.proc.mm.mem.buffer, p, n);
  }
  path(t, dirfd, p) {
    const s = this.str(t, p);
    return this.resolvePath(t.proc, dirfd, s);
  }
  resolvePath(proc, dirfd, s) {
    if (s.startsWith('/')) return normPath(s);
    let base = proc.cwd;
    if (dirfd !== AT.FDCWD) {
      const f = proc.file(dirfd);
      if (!f.path) fail(E.NOTDIR);
      base = f.path;
    }
    return normPath(base + '/' + s);
  }

  // --- CPU state -----------------------------------------------------------------
  cpu(t) {
    const dv = t.proc.mm.dv, c = t.tb + this.cfg.ctx, g = c + this.cfg.gregsOff;
    return {
      get: (r) => dv.getBigUint64(g + 8 * r, true),
      set: (r, v) => dv.setBigUint64(g + 8 * r, BigInt.asUintN(64, BigInt(v)), true),
      rip: () => dv.getBigUint64(c + this.cfg.ripOff, true),
      setRip: (v) => dv.setBigUint64(c + this.cfg.ripOff, BigInt(v), true),
      setFs: (v) => dv.setBigUint64(c + this.cfg.fsOff, BigInt(v), true),
      fs: () => dv.getBigUint64(c + this.cfg.fsOff, true),
      setGs: (v) => dv.setBigUint64(c + this.cfg.gsOff, BigInt(v), true),
    };
  }
  // GPR indices (FEX order = x86 encoding order)
  static get R() { return { RAX: 0, RCX: 1, RDX: 2, RBX: 3, RSP: 4, RBP: 5, RSI: 6, RDI: 7, R8: 8, R9: 9, R10: 10, R11: 11 }; }

  // --- processes and threads ---------------------------------------------------------
  // A slot no thread and no worker uses. (A dead thread's worker can still
  // wake up for a moment; its slot stays taken until the host says the
  // worker is gone.)
  allocSlot() {
    for (let i = 0; i < MAX_SLOTS; i++) {
      if (!this.slots[i] && !Atomics.load(this.k32, ((SLOT_BASE + i * SLOT_SIZE) >> 2) + W_OCCUPIED)) return i;
    }
    fail(E.AGAIN);
  }
  newTid() { return this.nextPid++; }

  // A thread block (Sys area + CPUState) in mm.
  allocTb(mm, owner) {
    const a = mm.findFree(TB_SIZE, 0x10000);
    if (a < 0) fail(E.NOMEM);
    mm.zero(a, a + TB_SIZE);
    mm.insert({ start: a, end: a + TB_SIZE, prot: PROT.READ | PROT.WRITE, flags: MAP.PRIVATE | MAP.ANONYMOUS, name: '[fexwasm thread]', kernel: true, owner });
    mm.ensure(a + TB_SIZE);
    // all of it: the dispatcher writes its tables here too, and a reused
    // memory must not show the next thread another thread's tables
    mm.markDirty(a, a + TB_SIZE);
    return a;
  }

  // Starts a thread's worker. The CPUState at tb must be ready (rip included).
  startThread(proc, tid, tb) {
    const slot = this.allocSlot();
    const t = new Thread(proc, tid, slot, tb);
    this.slots[slot] = t;
    this.threads.set(tid, t);
    proc.threads.set(tid, t);
    const b32 = (SLOT_BASE + slot * SLOT_SIZE) >> 2;
    new Int32Array(this.ksab, SLOT_BASE + slot * SLOT_SIZE, SLOT_SIZE >> 2).fill(0);
    Atomics.store(this.k32, b32, S_IDLE);
    Atomics.store(this.k32, b32 + W_OCCUPIED, 1);
    this.host.spawnThread({ pid: proc.pid, tid, tb, mem: proc.mm.mem, wx: proc.mm.wx.buffer, space: proc.space, slot, ksab: this.ksab, bootEpoch: this.bootEpoch });
    return t;
  }

  // Starts the run: argv with envp. Wine, in a shared address space, gets
  // its wineserver started first (in the foreground: no fork), and starts
  // once the server listens; a Wine process started by a client (fork
  // and exec, or posix_spawn) needs no reservations of the address space
  // that others would get in the way of (WINE_SHARED_ADDRESS_SPACE).
  // What Wine processes get besides their environment: one address space
  // (host.sharedSpace), and a display driver (host.display: its size).
  wineEnv(envp) {
    const add = [];
    if (this.host.sharedSpace && !envp.some((e) => e.startsWith('WINE_SHARED_ADDRESS_SPACE='))) add.push('WINE_SHARED_ADDRESS_SPACE=1');
    if (this.host.display && !envp.some((e) => e.startsWith('WINE_WASM_DISPLAY='))) add.push(`WINE_WASM_DISPLAY=${this.host.displaySize || '1024x768'}`);
    return envp.concat(add);
  }
  boot(argv, envp) {
    // host.freezeTest: freeze the system that many seconds in, and thaw it a second later (snapshot.js)
    if (this.host.freezeTest) {
      this.addTimer(this.host.freezeTest * 1000, () => {
        const t0 = this.now();
        this.freeze(5000, (err) => {
          const n = [...this.threads.values()].filter((t) => t.frozen).length;
          this.log(`[freeze] ${err ? 'failed: ' + err : `${n} threads frozen in ${(this.now() - t0).toFixed(0)} ms`}`);
          if (!err) this.addTimer(1000, () => { this.thaw(); this.log('[freeze] thawed'); });
        });
      });
    }
    // host.memLog: every that many seconds, log how much guest memory is in use
    if (this.host.memLog) {
      const tick = () => {
        let procs = 0, threads = 0;
        for (const p of this.procs.values()) if (!p.zombie) { procs++; threads += p.threads.size; }
        this.log(`[mem] ${((performance.now() - this.t0) / 1000).toFixed(0)}s guest ${this.memInfo()}; ${procs} processes, ${threads} threads`);
        if (!this.done) this.addTimer(this.host.memLog * 1000, tick);
      };
      this.addTimer(this.host.memLog * 1000, tick);
    }
    envp = this.wineEnv(envp);
    if (this.host.sharedSpace && /\/wine(64)?$/.test(argv[0]) && !envp.some((e) => e.startsWith('WINE_NOSERVERFIRST='))) {
      const server = argv[0].replace(/[^/]+$/, 'wineserver');
      this.onListen = () => {
        this.onListen = null;
        this.spawnInit(argv[0], argv, envp);
      };
      this.spawnInit(server, [server, '-f'], envp);
      return;
    }
    this.spawnInit(argv[0], argv, envp);
  }
  // An initial process: execs path with argv/envp. (The run ends when the
  // last one started this way, and all the rest, are gone.)
  spawnInit(path, argv, envp) {
    const p = new Process(this, this.nextPid++, 1);
    this.procs.set(p.pid, p);
    this.initProc = p;
    const con = [new ConsoleFile(0), new ConsoleFile(1), new ConsoleFile(2)];
    for (let i = 0; i < 3; i++) p.fds.set(i, { file: con[i].ref(), cloexec: false });
    p.cwd = this.host.cwd || '/';
    const img = this.loadImage(p, path, argv, envp);
    this.installImage(p, img, null);
    return p;
  }

  // Reads an executable (following #! scripts) and builds its new address space.
  // -> {mm, rip, rsp, space, exe, argv}
  loadImage(proc, path, argv, envp, depth) {
    const st = this.vfs.stat(path); // throws ENOENT etc.
    if ((st.mode & S_IF.MT) !== S_IF.REG) fail(E.ACCES);
    const bytes = this.vfs.readFile(path);
    if (bytes[0] === 0x23 && bytes[1] === 0x21) { // #!
      if ((depth || 0) > 4) fail(E.LOOP);
      let e = 2;
      while (e < bytes.length && bytes[e] !== 10) e++;
      const line = new TextDecoder().decode(bytes.subarray(2, e)).trim();
      const sp = line.search(/\s/);
      const interp = sp < 0 ? line : line.slice(0, sp), arg = sp < 0 ? null : line.slice(sp).trim();
      return this.loadImage(proc, interp, [interp, ...(arg ? [arg] : []), path, ...argv.slice(1)], envp, (depth || 0) + 1);
    }
    const elf = ELF.parse(bytes);
    if (!elf) fail(E.NOEXEC);
    // Shared address space (host.sharedSpace): every image goes into one
    // memory (the engine allows only a few large ones: iOS WebContent 3 of
    // 4 GB, 4 of 2 GB), owned by a token of its own.
    const owner = { image: path };
    let mm, space;
    if (this.host.sharedSpace) {
      if (!this.sharedMm) {
        const m = this.sharedMm = new Mm(65536, 256);
        m.space = this.nextSpace++;
        // KUSER_SHARED_DATA's page and the one after it (Wine's syscall
        // dispatcher pointer), the same for everyone (see mapKuser)
        m.ensure(KUSER + 2 * PAGE);
        m.zero(KUSER, KUSER + 2 * PAGE);
        m.insert({ start: KUSER, end: KUSER + PAGE, prot: PROT.READ, flags: MAP.PRIVATE | MAP.ANONYMOUS, name: '[kuser]', owner: GLOBAL });
        m.insert({ start: KUSER + PAGE, end: KUSER + 2 * PAGE, prot: PROT.READ | PROT.WRITE, flags: MAP.PRIVATE | MAP.ANONYMOUS, name: '[kuser+1]', owner: GLOBAL });
      }
      mm = this.sharedMm;
      space = mm.space;
    } else {
      mm = new Mm(this.memPagesFor(path, elf), 256);
      space = this.nextSpace++;
    }
    try {
      return this.loadInto(mm, owner, space, path, bytes, elf, argv, envp);
    } catch (e) {
      mm.removeOwner(owner); // (a shared memory keeps everyone else's mappings)
      throw e;
    }
  }
  loadInto(mm, owner, space, path, bytes, elf, argv, envp) {
    const exec = []; // executable segments to hand to the translator: [addr, Uint8Array]
    const mapElf = (e, fileBytes, base) => {
      for (const ph of e.phdrs) {
        if (ph.type !== ELF.PT_LOAD) continue;
        const va = base + ph.vaddr, start = pageDown(va), end = pageUp(va + ph.memsz);
        const prot = (ph.flags & 4 ? PROT.READ : 0) | (ph.flags & 2 ? PROT.WRITE : 0) | (ph.flags & 1 ? PROT.EXEC : 0);
        if (start < LOW_RESERVED || end > mm.limit || mm.foreign(start, end, owner)) fail(E.NOMEM);
        mm.ensure(end);
        mm.zero(start, end);
        const u8 = mm.u8;
        u8.set(fileBytes.subarray(ph.offset, ph.offset + ph.filesz), va);
        mm.insert({ start, end, prot, flags: MAP.PRIVATE, name: path, file: { path, offset: ph.offset - (va - start) }, owner });
        mm.markDirty(start, end);
        if (prot & PROT.EXEC) exec.push([start, end]);
      }
    };
    let base = 0;
    if (elf.type === 'dyn') {
      const span = pageUp(elf.maxVaddr) - pageDown(elf.minVaddr);
      const at = mm.isFree(PIE_BASE, PIE_BASE + span) ? PIE_BASE : mm.findFree(span, 0x10000);
      if (at < 0) fail(E.NOMEM);
      base = at - pageDown(elf.minVaddr);
    }
    mapElf(elf, bytes, base);
    let phdr = 0;
    for (const ph of elf.phdrs) if (ph.type === ELF.PT_PHDR) phdr = base + ph.vaddr;
    if (!phdr) {
      for (const ph of elf.phdrs) {
        if (ph.type === ELF.PT_LOAD && elf.phoff >= ph.offset && elf.phoff < ph.offset + ph.filesz) phdr = base + ph.vaddr + (elf.phoff - ph.offset);
      }
    }
    const brk = pageUp(base + elf.maxVaddr);
    let entry = base + elf.entry, interpBase = 0;
    if (elf.interp) {
      const ib = this.vfs.readFile(elf.interp);
      const ie = ELF.parse(ib);
      if (!ie || ie.type !== 'dyn') fail(E.NOEXEC);
      const span = pageUp(ie.maxVaddr) - pageDown(ie.minVaddr);
      interpBase = mm.findFree(span, 0x10000);
      if (interpBase < 0) fail(E.NOMEM);
      interpBase -= pageDown(ie.minVaddr);
      mapElf(ie, ib, interpBase);
      entry = interpBase + ie.entry;
    }
    // stack
    const stackLo = mm.findFree(STACK_SIZE + PAGE, 0x10000);
    if (stackLo < 0) fail(E.NOMEM);
    const stackHi = stackLo + PAGE + STACK_SIZE;
    mm.ensure(stackHi);
    mm.zero(stackLo, stackHi);
    mm.insert({ start: stackLo, end: stackLo + PAGE, prot: 0, flags: MAP.PRIVATE | MAP.ANONYMOUS, name: '[stack guard]', owner });
    mm.insert({ start: stackLo + PAGE, end: stackHi, prot: PROT.READ | PROT.WRITE, flags: MAP.PRIVATE | MAP.ANONYMOUS | MAP.GROWSDOWN, name: '[stack]', owner });
    mm.markDirty(stackLo + PAGE, stackHi);
    const rsp = this.buildStack(mm, stackHi, argv, envp, path, {
      [AUX.PHDR]: phdr, [AUX.PHENT]: elf.phentsize, [AUX.PHNUM]: elf.phnum, [AUX.PAGESZ]: PAGE, [AUX.BASE]: interpBase,
      [AUX.FLAGS]: 0, [AUX.ENTRY]: base + elf.entry, [AUX.UID]: this.uid(), [AUX.EUID]: this.uid(), [AUX.GID]: this.gid(),
      [AUX.EGID]: this.gid(), [AUX.HWCAP]: 0x178bfbff, [AUX.CLKTCK]: 100, [AUX.SECURE]: 0, [AUX.MINSIGSTKSZ]: 4096,
    });
    return { mm, owner, brk, rip: entry, rsp, space, exec, exe: this.vfs.resolve ? this.vfs.resolve(path, true) : path, argv };
  }

  // Wasm pages of address space for a program: Windows processes need 2 GB
  // (KUSER_SHARED_DATA is at 0x7ffe0000), the wineserver and other Linux
  // programs less. host.memPolicy: [[regexp, pages], ...] first.
  memPagesFor(path, elf) {
    for (const [re, pages] of this.host.memPolicy || []) if (new RegExp(re).test(path)) return pages;
    if (/\/wineserver$/.test(path)) return 8192; // 512 MB
    if (/\/wine(64)?$|\/x86_64-unix\/wine$/.test(path)) return 32768; // 2 GB
    return 16384; // 1 GB
  }

  buildStack(mm, top, argv, envp, execfn, aux) {
    const u8 = mm.u8, dv = mm.dv, enc = new TextEncoder();
    let sp = top;
    const put = (s) => {
      const b = enc.encode(s + '\0');
      sp -= b.length;
      u8.set(b, sp);
      return sp;
    };
    const execfnP = put(execfn);
    const platP = put('x86_64');
    const envP = envp.map(put).reverse().reverse();
    const argP = argv.map(put);
    sp -= 16;
    const randP = sp;
    u8.set(crypto.getRandomValues(new Uint8Array(16)), randP); // (not on shared memory: JavaScriptCore refuses)
    sp &= ~15;
    const auxv = Object.entries(aux).map(([k, v]) => [Number(k), v]);
    auxv.push([AUX.RANDOM, randP], [AUX.EXECFN, execfnP], [AUX.PLATFORM, platP], [AUX.NULL, 0]);
    const words = 1 + argP.length + 1 + envP.length + 1 + 2 * auxv.length;
    sp -= 8 * words;
    sp &= ~15;
    let p = sp;
    const w = (v) => { dv.setBigUint64(p, BigInt(v), true); p += 8; };
    w(argP.length);
    for (const a of argP) w(a);
    w(0);
    for (const e of envP) w(e);
    w(0);
    for (const [k, v] of auxv) { w(k); w(v); }
    return sp;
  }

  // Makes img the process's image and starts its first thread (with tid, or a new one).
  installImage(proc, img, tid) {
    proc.mm = img.mm;
    proc.mm.users++;
    proc.image = img.owner;
    proc.ownsImage = true;
    proc.brkStart = proc.brk = img.brk;
    proc.space = img.space;
    this.spaceRef(img.space, 1);
    proc.exe = img.exe;
    proc.argv = img.argv;
    for (const [a, b] of img.exec) this.host.code(proc.space, a, proc.mm.u8.slice(a, b));
    const tb = this.allocTb(proc.mm, proc.image);
    const u8 = proc.mm.u8;
    u8.set(this.host.state, tb + this.cfg.ctx);
    tid = tid || proc.pid;
    const t = { proc, tb };
    const c = this.cpu(t);
    c.set(Kernel.R.RSP, img.rsp);
    c.setRip(img.rip);
    return this.startThread(proc, tid, tb);
  }

  exitThread(t, status) {
    if (t.dead) return;
    t.dead = true;
    const proc = t.proc;
    if (t.clearTid) {
      const mm = proc.mm;
      if (mm && t.clearTid + 4 <= mm.mem.buffer.byteLength) {
        const a32 = new Int32Array(mm.mem.buffer);
        Atomics.store(a32, t.clearTid >>> 2, 0);
        Atomics.notify(a32, t.clearTid >>> 2, 1);
      }
    }
    for (const q of t.waitingOn) q.threads.delete(t);
    t.waitingOn.clear();
    t.retry = null;
    if (t.timer) t.timer.dead = true;
    this.slots[t.slot] = null;
    this.threads.delete(t.tid);
    proc.threads.delete(t.tid);
    this.freeTb(t);
    // its worker: stop it (it may be running guest code, or waiting on its slot)
    const b32 = (SLOT_BASE + t.slot * SLOT_SIZE) >> 2;
    this.k32[b32 + 1] = F_EXIT;
    Atomics.store(this.k32, b32, S_DONE);
    Atomics.notify(this.k32, b32);
    this.host.killThread(t.tid);
    if (proc.threads.size === 0 && !proc.zombie) this.exitProcess(proc, status);
  }

  // All threads gone: the process becomes a zombie for its parent.
  exitProcess(proc, status) {
    if (proc.zombie) return;
    this.syncShared(proc);
    if (this.host.traceExec) this.log(`[${((performance.now() - this.t0) / 1000).toFixed(2)}s] [pid ${proc.pid}] exit ${status} (${(proc.argv[1] || proc.argv[0] || '').slice(0, 60)})`);
    proc.zombie = true;
    proc.exitStatus = status;
    for (const t of [...proc.threads.values()]) this.exitThread(t, status);
    for (const fd of [...proc.fds.keys()]) proc.closeFd(fd);
    this.releaseImage(proc);
    if (proc.vforkParent) { this.makeRunnable(proc.vforkParent); proc.vforkParent = null; }
    // orphans go to init
    for (const c of proc.children) {
      const cp = this.procs.get(c);
      if (cp) cp.ppid = 1;
    }
    const parent = this.procs.get(proc.ppid);
    if (parent && !parent.zombie) {
      parent.childWait.wake(this);
      this.signalProcess(parent, SIG.CHLD);
    } else {
      this.procs.delete(proc.pid);
    }
    if (proc === this.initProc) {
      const code = status & 0x7f ? 128 + (status & 0x7f) : (status >> 8) & 0xff;
      this.log(`[pid ${proc.pid}] exited with ${status & 0x7f ? 'signal ' + (status & 0x7f) : 'status ' + code}`);
      this.exitCode = code;
      this.initExited = this.now();
    }
    // the run ends when the first process and everything else it started are gone
    // (the wineserver saves the registry as it exits), or 30 s after the first
    if (this.initExited !== undefined && !this.done) {
      const live = [...this.procs.values()].filter((p) => !p.zombie);
      if (!live.length) this.host.exit(this.exitCode, this);
      else if (!this.exitTimer) this.exitTimer = this.addTimer(30000, () => {
        this.log(`[kernel] still running 30 s after the first process: ${live.map((p) => p.pid + ' ' + (p.argv[1] || p.argv[0])).join(', ')}`);
        this.host.exit(this.exitCode, this);
      });
    }
  }
  // Address ranges given up in a memory others still use stay taken for a
  // moment: a worker being stopped may still be writing to them.
  quarantine(mm, vmas) {
    if (!vmas.length) return;
    const q = { quarantine: true };
    for (const v of vmas) mm.insert({ start: v.start, end: v.end, prot: 0, flags: MAP.PRIVATE | MAP.ANONYMOUS, name: '[released]', owner: q });
    this.addTimer(1500, () => mm.removeOwner(q));
  }
  // A thread's Sys area goes when the thread does.
  freeTb(t) {
    const mm = t.proc.mm;
    if (!mm || !t.tb) return;
    const v = mm.vmas.find((x) => x.start === t.tb && x.kernel);
    if (!v) return;
    mm.cut(v.start, v.end, v.owner);
    this.quarantine(mm, [v]);
  }
  // Translator spaces are shared by a forked child until it maps code of its own.
  spaceRef(space, d) {
    const n = (this.spaceUsers.get(space) || 0) + d;
    if (n > 0) this.spaceUsers.set(space, n);
    else {
      this.spaceUsers.delete(space);
      this.host.dropSpace(space);
    }
  }
  // The process lets go of its address space and translator space (exit, execve).
  // proc: a process, or what a process that execs had ({mm, image, ownsImage, space}).
  releaseImage(proc) {
    const mm = proc.mm;
    if (mm) {
      // the image's own mappings go (a shared memory keeps everyone else's;
      // a vfork child's image is its parent's)
      const gone = proc.ownsImage ? mm.removeOwner(proc.image) : [];
      if (--mm.users === 0) {
        for (const sf of this.sharedFiles.values()) sf.mms.delete(mm);
        if (mm === this.sharedMm) { this.sharedMm = null; this.lastSharedMm = mm; }
        mm.retire();
      } else {
        if (proc.space) for (const v of gone) if (v.prot & PROT.EXEC) this.host.uncode(proc.space, v.start, v.end - v.start);
        this.quarantine(mm, gone);
      }
      proc.mm = null;
      proc.image = null;
    }
    if (proc.space) {
      this.spaceRef(proc.space, -1);
      proc.space = 0;
    }
  }
  killProcess(proc, sig) {
    this.exitProcess(proc, sig & 0x7f);
  }

  // --- signals ---------------------------------------------------------------------
  // Delivered as Linux does on the way back from a syscall: a thread parked in
  // one is interrupted (the syscall restarts or fails with EINTR); a thread
  // running guest code takes it at its next syscall, and one waiting on a
  // futex in its worker is woken to ask (NR_SIGCHECK).
  sigAction(proc, sig) { return proc.actions[sig]; }
  sigIgnored(proc, sig) {
    const h = proc.actions[sig].handler;
    return h === 1n || (h === 0n && (sig === SIG.CHLD || sig === SIG.WINCH || sig === SIG.CONT || sig === SIG.URG || sig === SIG.STOP || sig === SIG.TSTP || sig === 21 || sig === 22));
  }
  // Is a signal pending for t that its handler (or default action) acts on?
  pendingActive(t) {
    let p = this.pendingFor(t);
    for (let sig = 1; p; sig++, p >>= 1n) if ((p & 1n) && !this.sigIgnored(t.proc, sig)) return true;
    return false;
  }
  pendingFor(t) {
    const p = t.pending & ~t.sigmask;
    return p ? p : 0n;
  }
  signalProcess(proc, sig, info) {
    if (proc.zombie || !sig) return;
    if (this.sigIgnored(proc, sig)) return;
    if (proc.actions[sig].handler === 0n || sig === SIG.KILL) {
      this.log(`[pid ${proc.pid}] killed by signal ${sig}`);
      this.killProcess(proc, sig);
      return;
    }
    const bit = 1n << BigInt(sig - 1);
    const ts = [...proc.threads.values()];
    const t = ts.find((x) => !(x.sigmask & bit) && x.retry) || ts.find((x) => !(x.sigmask & bit)) || ts[0];
    if (t) this.signalThread(t, sig, info);
  }
  signalThread(t, sig, info) {
    const proc = t.proc;
    if (proc.zombie || !sig || this.sigIgnored(proc, sig)) return;
    if (proc.actions[sig].handler === 0n || sig === SIG.KILL) {
      this.log(`[pid ${proc.pid}] killed by signal ${sig}`);
      this.killProcess(proc, sig);
      return;
    }
    const bit = 1n << BigInt(sig - 1);
    t.pending |= bit;
    (t.sigInfo || (t.sigInfo = new Map())).set(sig, info || { code: 0, pid: 0 });
    if (this.host.traceSig) this.log(`[sig] ${sig} -> tid ${t.tid}: ${t.sigmask & bit ? 'masked' : t.retry ? (t.noInterrupt ? 'parked, not interruptible' : 'parked: interrupt') : 'running: flag'} (in ${SYS_NAME[t.nr] || t.nr}${t.ntWait ? ', ntsync wait' + (t.ntWait.done ? ' done' : '') : ''})`);
    if (t.sigmask & bit) return;
    this.kick(t);
  }
  // Tells t there is a signal: interrupts its syscall, or flags its worker.
  kick(t) {
    const b32 = (SLOT_BASE + t.slot * SLOT_SIZE) >> 2;
    Atomics.store(this.k32, b32 + W_SIGPEND, 1);
    const fa = Atomics.load(this.k32, b32 + W_FUTEX);
    if (fa && t.proc.mm) Atomics.notify(new Int32Array(t.proc.mm.mem.buffer), fa >>> 2);
    if (t.retry && !t.dead && !t.noInterrupt) {
      const sig = lowestSig(this.pendingFor(t));
      const restart = RESTARTABLE.has(t.nr) && (t.proc.actions[sig].flags & BigInt(SA.RESTART)) !== 0n;
      this.unblock(t);
      this.deliver(t, restart ? null : big(-E.INTR), restart);
    }
  }
  // Builds a signal frame for the lowest deliverable signal and sends t to its
  // handler. result: the interrupted syscall's result (null: restart it, or
  // for REDIRECTED: the context in CPUState is already where to resume).
  deliver(t, result, restart) {
    const proc = t.proc, mm = proc.mm, dv = mm.dv, c = this.cpu(t), R = Kernel.R;
    const b32 = (SLOT_BASE + t.slot * SLOT_SIZE) >> 2;
    let sig;
    for (;;) {
      const p = this.pendingFor(t);
      if (!p) { Atomics.store(this.k32, b32 + W_SIGPEND, 0); return result === null && !restart ? this.reply(t, 0n, F_REDIRECT) : this.reply(t, result ?? 0n); }
      sig = lowestSig(p);
      t.pending &= ~(1n << BigInt(sig - 1));
      if (!this.sigIgnored(proc, sig)) break;
    }
    const act = proc.actions[sig], flags = Number(act.flags);
    const info = (t.sigInfo && t.sigInfo.get(sig)) || { code: 0, pid: 0 };
    if (this.host.traceSig) this.log(`[sig] ${sig} delivered to tid ${t.tid} (${restart ? 'restart ' : ''}${SYS_NAME[t.nr] || t.nr}, result ${result}), handler 0x${act.handler.toString(16)} flags 0x${act.flags.toString(16)}`);
    // the context to return to
    const rcx = c.get(R.RCX);
    let rip, rax;
    if (restart) { rip = rcx - 2n; rax = BigInt(t.nr); } // back to the syscall instruction, number in RAX
    else if (result === null) { rip = c.rip(); rax = c.get(R.RAX); } // a context set up already (rt_sigreturn, execve)
    else { rip = rcx; rax = BigInt.asUintN(64, result); }
    const oldMask = t.suspendMask !== undefined ? t.suspendMask : t.sigmask;
    t.suspendMask = undefined;
    // stack: below the red zone, or the alternate stack
    let sp = Number(c.get(R.RSP) & 0xffffffffn) - 128;
    const alt = t.altstack;
    if ((flags & SA.ONSTACK) && alt && !(alt.flags & 2)) {
      const lo = Number(alt.sp), hi = lo + Number(alt.size);
      if (!(sp > lo && sp <= hi)) sp = hi;
    }
    sp = (sp - 512) & ~63;
    const fp = sp; // FXSAVE area
    const ctx = t.tb + this.cfg.ctx;
    new Uint8Array(dv.buffer, fp, 512).fill(0);
    dv.setUint16(fp, 0x37f, true);
    dv.setUint32(fp + 24, dv.getUint32(ctx + this.cfg.mxcsrOff, true), true);
    dv.setUint32(fp + 28, 0xffff, true);
    new Uint8Array(dv.buffer, fp + 160, 256).set(new Uint8Array(dv.buffer, ctx + this.cfg.xmmOff, 256));
    sp = (sp - 128) & ~15;
    const si = sp;
    new Uint8Array(dv.buffer, si, 128).fill(0);
    dv.setInt32(si, sig, true);
    dv.setInt32(si + 8, info.code || 0, true);
    dv.setInt32(si + 16, info.pid || 0, true);
    dv.setInt32(si + 20, this.uid(), true);
    sp = (sp - 936) & ~15;
    const uc = sp;
    new Uint8Array(dv.buffer, uc, 936).fill(0);
    if (alt) { dv.setBigUint64(uc + 16, alt.sp, true); dv.setInt32(uc + 24, alt.flags, true); dv.setBigUint64(uc + 32, alt.size, true); }
    const g = uc + 40;
    const order = [8, 9, 10, 11, 12, 13, 14, 15, R.RDI, R.RSI, R.RBP, R.RBX, R.RDX, R.RAX, R.RCX, R.RSP];
    order.forEach((r, i) => dv.setBigUint64(g + 8 * i, r === R.RAX ? rax : c.get(r), true));
    dv.setBigUint64(g + 8 * 16, rip, true);
    dv.setBigUint64(g + 8 * 17, 0x202n, true);
    dv.setBigUint64(g + 8 * 18, 0x33n, true); // csgsfs: cs
    dv.setBigUint64(g + 8 * 23, BigInt(fp), true); // fpregs
    // the lazy flag state and NZCV in reserved1, so rt_sigreturn gives them back
    new Uint8Array(dv.buffer, uc + 232, 24).set(new Uint8Array(dv.buffer, t.tb + 0x40, 24));
    dv.setUint32(uc + 256, dv.getUint32(t.tb + this.cfg.nzcvAddr, true), true);
    dv.setBigUint64(uc + 296, oldMask, true);
    // return address: the restorer (SA_RESTORER; musl always gives one)
    sp -= 8;
    if ((sp + 8) % 16) sp -= 8; // entry as after a call: (rsp + 8) % 16 == 0
    dv.setBigUint64(sp, act.restorer, true);
    t.sigmask = oldMask | act.mask | ((flags & SA.NODEFER) ? 0n : 1n << BigInt(sig - 1));
    t.sigmask &= ~((1n << 8n) | (1n << 18n));
    if (flags & SA.RESETHAND) proc.actions[sig] = { handler: 0n, flags: 0n, restorer: 0n, mask: 0n };
    c.set(R.RSP, sp);
    c.set(R.RDI, sig);
    c.set(R.RSI, si);
    c.set(R.RDX, uc);
    c.set(R.RAX, 0);
    c.setRip(act.handler);
    Atomics.store(this.k32, b32 + W_SIGPEND, this.pendingFor(t) ? 1 : 0);
    if (this.trace) this.log(`[${t.tid}] signal ${sig} -> handler 0x${act.handler.toString(16)} (resume 0x${rip.toString(16)})`);
    this.reply(t, 0n, F_REDIRECT);
  }
  // rt_sigreturn: the context at RSP (the restorer runs with RSP just past the return address).
  sigreturn(t) {
    const mm = t.proc.mm, dv = mm.dv, c = this.cpu(t), R = Kernel.R;
    const uc = Number(c.get(R.RSP) & 0xffffffffn);
    const g = uc + 40;
    const order = [8, 9, 10, 11, 12, 13, 14, 15, R.RDI, R.RSI, R.RBP, R.RBX, R.RDX, R.RAX, R.RCX, R.RSP];
    order.forEach((r, i) => c.set(r, dv.getBigUint64(g + 8 * i, true)));
    c.setRip(dv.getBigUint64(g + 8 * 16, true));
    const fp = Number(dv.getBigUint64(g + 8 * 23, true) & 0xffffffffn);
    const ctx = t.tb + this.cfg.ctx;
    if (fp) {
      new Uint8Array(dv.buffer, ctx + this.cfg.xmmOff, 256).set(new Uint8Array(dv.buffer, fp + 160, 256));
      dv.setUint32(ctx + this.cfg.mxcsrOff, dv.getUint32(fp + 24, true), true);
    }
    new Uint8Array(dv.buffer, t.tb + 0x40, 24).set(new Uint8Array(dv.buffer, uc + 232, 24));
    dv.setUint32(t.tb + this.cfg.nzcvAddr, dv.getUint32(uc + 256, true), true);
    t.sigmask = dv.getBigUint64(uc + 296, true) & ~((1n << 8n) | (1n << 18n));
    return REDIRECTED;
  }

  uid() { return this.host.uid ?? 1000; }
  gid() { return this.host.gid ?? 1000; }

  // Advisory record locks (fcntl F_SETLK), per file.
  releaseLocks(proc, file) {
    if (!file.lockKey) return;
    const l = this.locks.get(file.lockKey);
    if (!l) return;
    const rest = l.filter((x) => x.proc !== proc);
    if (rest.length !== l.length) {
      this.locks.set(file.lockKey, rest);
      this.lockQ.wake(this);
    }
  }
}

const EXIT_THREAD = Symbol('exit thread');
const lowestSig = (m) => { let s = 1; while (!(m & 1n)) { m >>= 1n; s++; } return s; };
const REDIRECTED = Symbol('redirected');

function normPath(p) {
  const out = [];
  for (const s of p.split('/')) {
    if (!s || s === '.') continue;
    if (s === '..') out.pop();
    else out.push(s);
  }
  return '/' + out.join('/');
}

module.exports = { Kernel, Retry, Mm, GLOBAL, KUSER, File, HostFile, BufferFile, DevFile, ConsoleFile, PipeEnd, Pipe, UnixSocket, EventFd, EpollFile, WaitQueue,
  Thread, Process, KError, fail, BLOCK, EXIT_THREAD, REDIRECTED, normPath, pageUp, pageDown, addr, i32, u32, big,
  addr64, POLLIN, POLLOUT, POLLERR, POLLHUP, POLLNVAL, POLLPRI, POLLRDHUP, PAGE, LOW_RESERVED, ADDR_LIMIT, MMAP_BASE, TB_SIZE,
  SLOT_BASE, SLOT_SIZE, INPUT_RING, S_IDLE, S_REQ, S_DONE, S_BUSY, F_REDIRECT, F_EXIT, NR_FAULT, NR_STARTED, NR_SIGCHECK, W_SIGPEND, W_FUTEX, W_OCCUPIED };
