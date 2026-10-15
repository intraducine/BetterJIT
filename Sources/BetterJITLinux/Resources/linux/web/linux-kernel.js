(function (G) {
"use strict";
const defs = {};
defs['./abi.js'] = function (module, exports, require) {
// x86-64 Linux ABI constants for the guest kernel (js/linux/kernel.js).
'use strict';

const SYS = {
  read: 0, write: 1, open: 2, close: 3, stat: 4, fstat: 5, lstat: 6, poll: 7, lseek: 8, mmap: 9, mprotect: 10, munmap: 11,
  brk: 12, rt_sigaction: 13, rt_sigprocmask: 14, rt_sigreturn: 15, ioctl: 16, pread64: 17, pwrite64: 18, readv: 19,
  writev: 20, access: 21, pipe: 22, select: 23, sched_yield: 24, mremap: 25, msync: 26, mincore: 27, madvise: 28,
  dup: 32, dup2: 33, pause: 34, nanosleep: 35, getitimer: 36, alarm: 37, setitimer: 38, getpid: 39, sendfile: 40,
  socket: 41, connect: 42, accept: 43, sendto: 44, recvfrom: 45, sendmsg: 46, recvmsg: 47, shutdown: 48, bind: 49,
  listen: 50, getsockname: 51, getpeername: 52, socketpair: 53, setsockopt: 54, getsockopt: 55, clone: 56, fork: 57,
  vfork: 58, execve: 59, exit: 60, wait4: 61, kill: 62, uname: 63, fcntl: 72, flock: 73, fsync: 74, fdatasync: 75,
  truncate: 76, ftruncate: 77, getdents: 78, getcwd: 79, chdir: 80, fchdir: 81, rename: 82, mkdir: 83, rmdir: 84,
  creat: 85, link: 86, unlink: 87, symlink: 88, readlink: 89, chmod: 90, fchmod: 91, chown: 92, fchown: 93, lchown: 94,
  umask: 95, gettimeofday: 96, getrlimit: 97, getrusage: 98, sysinfo: 99, times: 100, getuid: 102, getgid: 104,
  setuid: 105, setgid: 106, geteuid: 107, getegid: 108, setpgid: 109, getppid: 110, getpgrp: 111, setsid: 112,
  setreuid: 113, setregid: 114, getgroups: 115, setgroups: 116, setresuid: 117, getresuid: 118, setresgid: 119,
  getresgid: 120, getpgid: 121, getsid: 124, capget: 125, rt_sigpending: 127, rt_sigtimedwait: 128,
  rt_sigqueueinfo: 129, rt_sigsuspend: 130, sigaltstack: 131, utime: 132, mknod: 133, personality: 135, statfs: 137,
  fstatfs: 138, getpriority: 140, setpriority: 141, sched_setparam: 142, sched_getparam: 143, sched_setscheduler: 144,
  sched_getscheduler: 145, sched_get_priority_max: 146, sched_get_priority_min: 147, mlock: 149, munlock: 150,
  prctl: 157, arch_prctl: 158, setrlimit: 160, sync: 162, gettid: 186, readahead: 187, getxattr: 191, lgetxattr: 192,
  fgetxattr: 193, tkill: 200, time: 201, futex: 202, sched_setaffinity: 203, sched_getaffinity: 204,
  epoll_create: 213, getdents64: 217, set_tid_address: 218, restart_syscall: 219, fadvise64: 221, timer_create: 222,
  timer_settime: 223, timer_gettime: 224, timer_getoverrun: 225, timer_delete: 226, clock_settime: 227,
  clock_gettime: 228, clock_getres: 229, clock_nanosleep: 230, exit_group: 231, epoll_wait: 232, epoll_ctl: 233,
  tgkill: 234, utimes: 235, waitid: 247, inotify_init: 253, openat: 257, mkdirat: 258, mknodat: 259, fchownat: 260,
  newfstatat: 262, unlinkat: 263, renameat: 264, linkat: 265, symlinkat: 266, readlinkat: 267, fchmodat: 268,
  faccessat: 269, pselect6: 270, ppoll: 271, set_robust_list: 273, get_robust_list: 274, utimensat: 280,
  epoll_pwait: 281, signalfd: 282, timerfd_create: 283, eventfd: 284, fallocate: 285, timerfd_settime: 286,
  timerfd_gettime: 287, accept4: 288, signalfd4: 289, eventfd2: 290, epoll_create1: 291, dup3: 292, pipe2: 293,
  inotify_init1: 294, preadv: 295, pwritev: 296, rt_tgsigqueueinfo: 297, recvmmsg: 299, prlimit64: 302,
  sendmmsg: 307, getcpu: 309, renameat2: 316, getrandom: 318, memfd_create: 319, execveat: 322, membarrier: 324,
  copy_file_range: 326, preadv2: 327, pwritev2: 328, statx: 332, rseq: 334, pidfd_open: 434, clone3: 435,
  close_range: 436, openat2: 437, faccessat2: 439, epoll_pwait2: 441,
};
const SYS_NAME = Object.fromEntries(Object.entries(SYS).map(([k, v]) => [v, k]));

const E = {
  PERM: 1, NOENT: 2, SRCH: 3, INTR: 4, IO: 5, NXIO: 6, E2BIG: 7, NOEXEC: 8, BADF: 9, CHILD: 10, AGAIN: 11, NOMEM: 12,
  ACCES: 13, FAULT: 14, BUSY: 16, EXIST: 17, XDEV: 18, NODEV: 19, NOTDIR: 20, ISDIR: 21, INVAL: 22, NFILE: 23,
  MFILE: 24, NOTTY: 25, FBIG: 27, NOSPC: 28, SPIPE: 29, ROFS: 30, MLINK: 31, PIPE: 32, RANGE: 34, DEADLK: 35,
  NAMETOOLONG: 36, NOLCK: 37, NOSYS: 38, NOTEMPTY: 39, LOOP: 40, NODATA: 61, OVERFLOW: 75, NOTSOCK: 88,
  DESTADDRREQ: 89, MSGSIZE: 90, PROTOTYPE: 91, NOPROTOOPT: 92, PROTONOSUPPORT: 93, OPNOTSUPP: 95, AFNOSUPPORT: 97,
  ADDRINUSE: 98, ADDRNOTAVAIL: 99, CONNABORTED: 103, CONNRESET: 104, NOBUFS: 105, ISCONN: 106, NOTCONN: 107,
  TIMEDOUT: 110, CONNREFUSED: 111, ALREADY: 114, INPROGRESS: 115,
};

const O = {
  ACCMODE: 3, WRONLY: 1, RDWR: 2, CREAT: 0x40, EXCL: 0x80, NOCTTY: 0x100, TRUNC: 0x200, APPEND: 0x400,
  NONBLOCK: 0x800, DIRECTORY: 0x10000, NOFOLLOW: 0x20000, CLOEXEC: 0x80000, PATH: 0x200000, TMPFILE: 0x400000,
};
const AT = { FDCWD: -100, SYMLINK_NOFOLLOW: 0x100, REMOVEDIR: 0x200, SYMLINK_FOLLOW: 0x400, EMPTY_PATH: 0x1000 };
const PROT = { READ: 1, WRITE: 2, EXEC: 4 };
const MAP = { SHARED: 1, PRIVATE: 2, TYPE: 0xf, FIXED: 0x10, ANONYMOUS: 0x20, GROWSDOWN: 0x100, NORESERVE: 0x4000,
  POPULATE: 0x8000, STACK: 0x20000, FIXED_NOREPLACE: 0x100000 };
const CLONE = { VM: 0x100, FS: 0x200, FILES: 0x400, SIGHAND: 0x800, PIDFD: 0x1000, VFORK: 0x4000, PARENT: 0x8000,
  THREAD: 0x10000, SYSVSEM: 0x40000, SETTLS: 0x80000, PARENT_SETTID: 0x100000, CHILD_CLEARTID: 0x200000,
  CHILD_SETTID: 0x1000000 };
const SIG = { HUP: 1, INT: 2, QUIT: 3, ILL: 4, TRAP: 5, ABRT: 6, BUS: 7, FPE: 8, KILL: 9, USR1: 10, SEGV: 11, USR2: 12,
  PIPE: 13, ALRM: 14, TERM: 15, CHLD: 17, CONT: 18, STOP: 19, TSTP: 20, WINCH: 28, IO: 29, SYS: 31 };
const SA = { SIGINFO: 4, ONSTACK: 0x08000000, RESTART: 0x10000000, NODEFER: 0x40000000, RESETHAND: 0x80000000,
  RESTORER: 0x04000000 };
const S_IF = { MT: 0o170000, SOCK: 0o140000, LNK: 0o120000, REG: 0o100000, BLK: 0o060000, DIR: 0o040000,
  CHR: 0o020000, FIFO: 0o010000 };
const AUX = { NULL: 0, PHDR: 3, PHENT: 4, PHNUM: 5, PAGESZ: 6, BASE: 7, FLAGS: 8, ENTRY: 9, UID: 11, EUID: 12, GID: 13,
  EGID: 14, PLATFORM: 15, HWCAP: 16, CLKTCK: 17, SECURE: 23, RANDOM: 25, HWCAP2: 26, EXECFN: 31, MINSIGSTKSZ: 51 };

module.exports = { SYS, SYS_NAME, E, O, AT, PROT, MAP, CLONE, SIG, SA, S_IF, AUX };

};
defs['./elf.js'] = function (module, exports, require) {
// ELF64 x86-64 parsing for execve (js/linux/kernel.js maps the segments).
'use strict';

const PT_LOAD = 1, PT_INTERP = 3, PT_PHDR = 6, PT_GNU_STACK = 0x6474e551;

// -> { type: 'exec'|'dyn', entry, phoff, phentsize, phnum, phdrs: [{type, flags, offset, vaddr, filesz, memsz, align}],
//      interp: string|null, minVaddr, maxVaddr } or null if not an x86-64 ELF64.
function parse(bytes) {
  if (bytes.length < 64 || bytes[0] !== 0x7f || bytes[1] !== 0x45 || bytes[2] !== 0x4c || bytes[3] !== 0x46) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes[4] !== 2 || bytes[5] !== 1 || dv.getUint16(18, true) !== 62) return null; // ELFCLASS64, LSB, EM_X86_64
  const etype = dv.getUint16(16, true);
  const e = {
    type: etype === 2 ? 'exec' : etype === 3 ? 'dyn' : null,
    entry: Number(dv.getBigUint64(24, true)),
    phoff: Number(dv.getBigUint64(32, true)),
    phentsize: dv.getUint16(54, true),
    phnum: dv.getUint16(56, true),
    phdrs: [],
    interp: null,
    minVaddr: Infinity,
    maxVaddr: 0,
  };
  if (!e.type) return null;
  for (let i = 0; i < e.phnum; i++) {
    const o = e.phoff + i * e.phentsize;
    if (o + 56 > bytes.length) return null;
    const p = {
      type: dv.getUint32(o, true),
      flags: dv.getUint32(o + 4, true),
      offset: Number(dv.getBigUint64(o + 8, true)),
      vaddr: Number(dv.getBigUint64(o + 16, true)),
      filesz: Number(dv.getBigUint64(o + 32, true)),
      memsz: Number(dv.getBigUint64(o + 40, true)),
      align: Number(dv.getBigUint64(o + 48, true)),
    };
    e.phdrs.push(p);
    if (p.type === PT_LOAD) {
      e.minVaddr = Math.min(e.minVaddr, p.vaddr);
      e.maxVaddr = Math.max(e.maxVaddr, p.vaddr + p.memsz);
    } else if (p.type === PT_INTERP) {
      let s = '';
      for (let k = p.offset; k < p.offset + p.filesz && bytes[k]; k++) s += String.fromCharCode(bytes[k]);
      e.interp = s;
    }
  }
  return e;
}

module.exports = { parse, PT_LOAD, PT_INTERP, PT_PHDR, PT_GNU_STACK };

};
defs['./kernel.js'] = function (module, exports, require) {
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
// Memories for address spaces. Constructors and growth can be refused while
// other memories remain live; these events do not establish an engine/OS quota.
// Retired memories can be reused after quarantine, carrying the record of bytes
// that may be nonzero so new mappings clear them. Dropping a reference does not
// establish immediate engine collection or release of physical memory.
// The owner of mappings every process of a shared memory has (KUSER_SHARED_DATA).
const GLOBAL = { global: true };
const KUSER = 0x7ffe_0000;

class MemoryPool {
  constructor() { this.free = []; }
  emit(event) {
    try { this.diagnostic?.({...event, pool:this.free.map(e => ({maximumPages:e.maxPages,
      currentBytes:e.mem.buffer.byteLength, ready:e.readyAt<=performance.now()}))}); } catch {}
  }
  take(maxPages, initialPages, context={}) {
    const started=performance.now();
    // A staged image can know that it will need a high guest address later.
    // Prefer a fitting retired reservation before binding any worker to it.
    // Do not force an eager grow or change the immutable maximum.
    if(context.reuseEnd) {
      const fitting=e=>e.maxPages===maxPages&&e.mem.buffer.byteLength>=context.reuseEnd;
      if(!this.free.some(e=>fitting(e)&&e.readyAt<=performance.now())) {
        const pending=this.free.filter(e=>fitting(e)&&e.readyAt>performance.now())
          .sort((a,b)=>a.readyAt-b.readyAt)[0];
        if(pending)this.waitUntil(pending.readyAt,started+1500);
      }
    }
    context={...context,poolWaitMilliseconds:performance.now()-started};
    // An engine can exhaust its reservation budget while a reusable memory
    // is still quarantined. Keep the existing 1.5 s safety delay and limits;
    // after allocation failure, wait only for an already retired candidate.
    try { return this.takeReady(maxPages, initialPages, context); }
    catch (error) {
      if (!(error instanceof RangeError)) throw error;
      const pending = this.free.filter(e => e.maxPages === maxPages && e.readyAt > performance.now())
        .sort((a,b) => a.readyAt-b.readyAt)[0];
      if (pending) {
        this.waitUntil(pending.readyAt,started+1500);
        context.poolWaitMilliseconds=performance.now()-started;
        try { return this.takeReady(maxPages, initialPages, context); }
        catch (retry) { if (!(retry instanceof RangeError)) throw retry; }
      }
      fail(E.NOMEM);
    }
  }
  waitUntil(readyAt,deadline) {
    const until=Math.min(readyAt,deadline);
    const word=new Int32Array(new SharedArrayBuffer(4));
    while(performance.now()<until)Atomics.wait(word,0,0,until-performance.now());
  }
  takeReady(maxPages, initialPages, context={}) {
    // Maximum sizes are immutable. Memories from another image-size class
    // cannot satisfy this allocation; retaining them only keeps reservations
    // and old backing buffers alive. Dropping our reference never reuses or
    // clears a buffer a terminating worker may still own.
    const discarded=this.free.filter(e=>e.maxPages!==maxPages).map(e=>({
      maximumPages:e.maxPages,currentBytes:e.mem.buffer.byteLength}));
    if (discarded.length) {
      this.free=this.free.filter(e=>e.maxPages===maxPages);
      this.emit({event:'pool-pruned',stage:'retention',reason:'incompatible immutable maximum',
        requestedMaximumPages:maxPages,discarded,...context});
    }
    const now = performance.now();
    const needed=Math.max(initialPages*WASM_PAGE,context.inheritedEnd||0,context.reuseEnd||0);
    let i=-1;
    for(let n=0;n<this.free.length;n++) {
      const e=this.free[n];if(e.maxPages!==maxPages||e.readyAt>now)continue;
      if(i<0){i=n;continue;}
      const size=e.mem.buffer.byteLength,chosen=this.free[i].mem.buffer.byteLength;
      if((size>=needed&&chosen<needed)||(size>=needed&&chosen>=needed&&size<chosen)||
         (size<needed&&chosen<needed&&size>chosen))i=n;
    }
    if (i >= 0) {
      const e = this.free.splice(i, 1)[0];
      const have = e.mem.buffer.byteLength / WASM_PAGE;
      if (have < initialPages) {
        try { e.mem.grow(initialPages - have); }
        catch (error) {
          this.free.push(e);
          this.emit({event:'failed',stage:'reuse-grow',maximumPages:maxPages,initialPages,
            currentBytes:e.mem.buffer.byteLength,errorName:error.name,errorMessage:String(error.message).slice(0,256),...context});
          throw error;
        }
      }
      return this.recordSelection(e,context,{source:'pool',maximumPages:maxPages,
        initialPages,selectedBytes:e.mem.buffer.byteLength,selectionEnd:needed});
    }
    try {
      const mem=new WebAssembly.Memory({ initial: initialPages, maximum: maxPages, shared: true });
      return this.recordSelection({mem,dirty:[],maxPages},context,{source:'constructor',maximumPages:maxPages,
        initialPages,selectedBytes:mem.buffer.byteLength,selectionEnd:needed});
    } catch (error) {
      this.emit({event:'failed',stage:'construct',maximumPages:maxPages,initialPages,
        errorName:error.name,errorMessage:String(error.message).slice(0,256),...context});
      throw error;
    }
  }
  recordSelection(entry,context,details) {
    // Keep only plain metadata, never extra references to pooled buffers.
    // A later failure must retain its selection even if success sampling ended.
    const selection={...details,poolWaitMilliseconds:context.poolWaitMilliseconds||0,
      remainingPool:this.free.map(e=>({maximumPages:e.maxPages,currentBytes:e.mem.buffer.byteLength,
        ready:e.readyAt<=performance.now()}))};
    this.emit({event:'memory-selected',stage:'selection',...details,...context});
    return {...entry,selection};
  }
  give(mem, dirty, maxPages) {
    // Keep compatible reservations for simultaneous fork/exec demand. A
    // discarded reservation may remain charged until engine collection; one
    // spare cannot serve both children of a pipe when construction is refused.
    this.free.push({ mem, dirty, maxPages, readyAt: performance.now() + 1500 });
    if (this.free.length > 6) this.free.shift(); // (the oldest is left to the collector)
  }
}
const memoryPool = new MemoryPool();

class Mm {
  constructor(maxPages, initialPages, allocationContext={}) {
    this.maxPages = maxPages;
    // guest addresses: below the memory's maximum (and 4 GB)
    this.limit = Math.min(ADDR_LIMIT, maxPages * WASM_PAGE - WASM_PAGE);
    const e = memoryPool.take(maxPages, initialPages || 16, allocationContext);
    this.allocationContext={...allocationContext,selection:e.selection};
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
  ensure(end, operationContext={}) {
    const have = this.mem.buffer.byteLength;
    if (end <= have) return;
    const pages = Math.ceil((end - have) / WASM_PAGE);
    try { this.mem.grow(pages); }
    catch (error) {
      memoryPool.emit({event:'failed',stage:'grow',maximumPages:this.maxPages,currentBytes:have,
        requestedEnd:end,additionalPages:pages,errorName:error.name,errorMessage:String(error.message).slice(0,256),...this.allocationContext,...operationContext});
      if (error instanceof RangeError) fail(E.NOMEM); throw error;
    }
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
    // 64 KB chunks ever written; tracking writes does not measure OS residency.
    const t = this.mem.touched || (this.mem.touched = { map: new Uint8Array(65536), n: 0 });
    for (let c = start >>> 16, ce = (end - 1) >>> 16; c <= ce; c++) if (!t.map[c]) { t.map[c] = 1; t.n++; }
    if (this.dirtyBytes > this.peakDirty) this.peakDirty = this.dirtyBytes;
  }
  // A copy for fork: the same mappings and the bytes of every mapping that may be nonzero.
  clone(owner, newOwner, context={}) {
    const mine = this.vmas.filter((v) => v.owner === owner || v.owner === GLOBAL);
    const inheritedEnd=mine.reduce((end,v)=>Math.max(end,v.end),0);
    const allocationContext={purpose:'fork',parentBytes:this.mem.buffer.byteLength,
      inheritedMappedBytes:mine.reduce((sum,v)=>sum+v.end-v.start,0),inheritedEnd,
      parentTrackedDirtyBytes:this.dirtyBytes,...context};
    // Do not eagerly construct the child's entire grown parent buffer. Grow
    // for inherited mappings, then copy their dirty bytes. Unmapped tail bytes
    // are not a fork mapping. Guest maxima and mapping/ownership stay unchanged.
    const m = new Mm(this.maxPages, Math.min(16,this.mem.buffer.byteLength/WASM_PAGE),allocationContext);
    try {
    m.ensure(inheritedEnd);
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
    memoryPool.emit({event:'fork-prepared',stage:'copy',maximumPages:m.maxPages,
      childBytes:m.mem.buffer.byteLength,copiedTrackedBytes:m.dirtyBytes,...allocationContext});
    return m;
    } catch (error) { m.retire(); throw error; }
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
  constructor(fd, terminal=true) { super('console'); this.fd = fd; this.terminal=terminal; this.flags = fd === 0 ? 0 : O.WRONLY; }
  read() { return 0; }
  write(k, t, buf) { k.host.write(this.fd, buf.slice()); return buf.length; }
  ioctl(k, t, req, arg) {
    if (!this.terminal) fail(E.NOTTY);
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
  stat() { return { mode: this.terminal ? S_IF.CHR | 0o620 : S_IF.FIFO | 0o600, ino: this.ino, rdev: this.terminal ? 0x8800 : 0 }; }
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
    let allocationSuccesses=0,allocationFailures=0,allocationRetentions=0;
    const failedOperations=new Set();
    memoryPool.diagnostic=event=>{
      if(event.event==='failed'){
        // Preserve the first failure for each process/operation. One allocator's
        // range-search retries must not consume the entire diagnostic budget.
        const key=[event.stage,event.pid,event.space,event.operation,event.purpose,event.parentPid,event.maximumPages].join('/');
        if(failedOperations.has(key)||allocationFailures>=16)return;
        failedOperations.add(key);allocationFailures++;
      }
      else if(event.event==='pool-pruned'){if(allocationRetentions++>=16)return;}
      else if(allocationSuccesses++>=16)return;
      const memories=new Set();
      const live=[];
      for(const p of this.procs.values())if(p.mm?.mem&&!memories.has(p.mm.mem)){
        memories.add(p.mm.mem);live.push({pid:p.pid,space:p.space,maximumPages:p.mm.maxPages,
          currentBytes:p.mm.mem.buffer.byteLength,trackedDirtyBytes:p.mm.dirtyBytes,users:p.mm.users});
      }
      this.log('[memory-allocation] '+JSON.stringify({...event,live,
        scope:'current kernel worker only; linear sizes/dirty tracking are not OS resident memory'}));
    };
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
      let did = this.serviceRequests();
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

  serviceRequests() {
    let did = false;
    for(let i=0;i<MAX_SLOTS;i++) {
      const t=this.slots[i];if(!t)continue;
      const base=(SLOT_BASE+i*SLOT_SIZE)>>2;
      // W_OCCUPIED is cleared only by the host after worker termination. A
      // failed worker cannot send an EXIT exchange; cancel its broker state
      // here before allowing slot reuse, without touching abandoned CPU state.
      if(t.sparse&&!Atomics.load(this.k32,base+W_OCCUPIED)) {
        this.retireSparseWorker(t,t.sparse.token.generation);did=true;continue;
      }
      if(Atomics.compareExchange(this.k32,base,S_REQ,S_BUSY)!==S_REQ)continue;
      // Before syscall counters, freeze hooks, syncShared, attempt or signals.
      if(t.sparse) this.sparseRequest(t);
      else this.request(t);
      did=true;
    }
    return did;
  }

  // Explicit host-created process/thread entries. Guest storage belongs to a
  // process; every thread has its own fixed internal memory. No ELF/clone/exec
  // or legacy Mm/thread-block allocator is implied by these bounded APIs.
  createSparseProcess({space,entryRip,plans,parentPid=0}) {
    if([...this.procs.values()].some(p=>p.mm?.guest===space))throw new Error('Sparse process address spaces must be independent');
    const pid=this.newTid(),proc=new Process(this,pid,parentPid);
    proc.space=this.nextSpace++;proc.mm={guest:space,sparse:true};
    const made=this.allocateSparseThread(proc,{entryRip,plans},pid);
    this.procs.set(pid,proc);this.procs.get(parentPid)?.children.add(pid);return made;
  }
  createSparseThread(proc,{entryRip,plans}) {
    if(this.procs.get(proc.pid)!==proc||!proc.mm?.sparse||proc.zombie)throw new Error('Live owned sparse process required');
    return this.allocateSparseThread(proc,{entryRip,plans},this.newTid());
  }
  allocateSparseThread(proc,{entryRip,plans},tid) {
    const B=globalThis.BetterJITGuestMemoryBroker;
    if(this.cfg.guestMemory!=='broker1'||!B||this.cfg.memoryABI!==B.ABI.version||this.cfg.stepABI!==B.ABI.stepVersion||
       this.cfg.coverageVersion!==B.ABI.coverageVersion||this.cfg.memPages!==B.ABI.internalPages||
       this.cfg.memMaxPages!==B.ABI.internalPages||this.cfg.threadBase!==B.ABI.threadBase||
       this.cfg.regArgs!==0||this.cfg.callsViaDispatcher!==false||this.cfg.maxInstructions!==1||this.cfg.shared!==true||
       this.cfg.checkpoint?.cpu?.offset!==this.cfg.ctx||this.cfg.checkpoint?.cpu?.size!==this.cfg.stateSize||
       this.cfg.checkpoint?.cpu?.ripOffset!==this.cfg.ripOff)
      throw new Error('Incompatible broker step configuration');
    if(this.freezing)throw new Error('Sparse snapshots are unsupported');
    if(this.threads.size>=B.ABI.maximumThreads)throw new Error('Sparse internal thread capacity exhausted');
    const space=proc.mm.guest;
    if(space.stats().virtualLimit>(1n<<47n))throw new Error('Broker1 requires the low canonical x86 user address window');
    const approved=new Map();
    for(const p of plans) {
      if(p.status!==0||typeof p.rip!=='bigint'||p.rip<0n||p.rip>=(1n<<64n)||
         !Number.isInteger(p.length)||p.length<1||p.length>15||p.nextRip!==p.rip+BigInt(p.length)||
         !(p.instruction instanceof Uint8Array)||p.instruction.length!==p.length||approved.has(p.rip)||
         !(([0,5].includes(p.operation)&&p.width===0)||([1,2].includes(p.operation)&&[1,2,4,8].includes(p.width))||
           ([3,4].includes(p.operation)&&[4,8].includes(p.width))))
        throw new Error('Invalid admitted instruction metadata');
      const actual=space.executableSnapshot(p.rip,p.length);
      if(!actual.every((x,i)=>x===p.instruction[i]))throw new Error('Executable bytes differ from the compiled step');
      approved.set(p.rip,Object.freeze({...p,instruction:p.instruction.slice()}));
    }
    if(!approved.has(entryRip)||!(this.host.state instanceof Uint8Array)||this.host.state.length!==this.cfg.stateSize)
      throw new Error('Sparse entry/state is unavailable');
    const memory=B.createInternalMemory(),view=new DataView(memory.buffer),slot=this.allocSlot(),t=new Thread(proc,tid,slot,B.ABI.threadBase);
    const state=new Uint8Array(memory.buffer,t.tb+this.cfg.ctx,this.cfg.stateSize);state.set(this.host.state);
    view.setBigUint64(t.tb+this.cfg.ctx+this.cfg.ripOff,entryRip,true);
    this.sparseBroker??=new B.GuestMemoryBroker();
    const token=this.sparseBroker.register(slot,{space,memory,checkpointLayout:this.cfg.checkpoint});
    t.sparse={token,memory,view,plans:approved,boundarySequence:0,active:null,steps:0,last:null,parked:null,syscalls:0};
    // Compatibility diagnostics may inspect the primary context; sparse paths
    // always use the authenticated thread's own view, never this alias.
    if(!proc.mm.mem){proc.mm.mem=memory;proc.mm.dv=view;}
    this.threads.set(tid,t);this.slots[slot]=t;proc.threads.set(tid,t);
    new Int32Array(this.ksab,SLOT_BASE+slot*SLOT_SIZE,SLOT_SIZE>>2).fill(0);
    Atomics.store(this.k32,((SLOT_BASE+slot*SLOT_SIZE)>>2)+W_OCCUPIED,1);
    return {proc,thread:t,worker:{pid:proc.pid,tid,tb:t.tb,mem:memory,space:proc.space,slot,ksab:this.ksab,
      lease:token.generation,cfg:this.cfg}};
  }

  sparseRequest(t) {
    const B=globalThis.BetterJITGuestMemoryBroker,s=t.sparse;
    const b64=(SLOT_BASE+t.slot*SLOT_SIZE)>>3,b32=b64*2;
    const nr=Number(this.k64[b64+1]),lease=BigInt.asUintN(64,this.k64[b64+2]),seq=this.k64[b64+3];
    const view=s.view,scratch=t.tb+B.ABI.scratchOffset;
    // The slot supplies t/space/token. Check the mailbox lease before scratch.
    if(this.slots[t.slot]!==t||t.dead||lease!==s.token.generation)throw new Error('Stale sparse thread request');
    let result=0n;
    if(nr===B.ABI.memoryRequest) {
      if(seq<1n||seq>0xffffffffn)throw new Error('Invalid memory request sequence');
      const r=this.sparseBroker.dispatch(s.token,{lease,sequence:Number(seq)});
      if(!r.accepted)throw new Error('Rejected sparse memory transport: '+r.reason);
      result=BigInt(r.status);
    } else if(nr===B.ABI.instructionBoundary) {
      if(seq!==BigInt(s.boundarySequence)+1n||seq>0xffffffffn)throw new Error('Invalid boundary sequence');
      s.boundarySequence=Number(seq);
      const phase=Number(this.k64[b64+4]);
      if(phase===1) {
        // Signal frame/snapshot semantics are not implemented for this fixture.
        // Refuse at this safe boundary; never deliver while Wasm locals live.
        if(this.freezing||t.pending||t.proc.pending)throw new Error('Sparse signals/snapshots are unsupported');
        const rip=view.getBigUint64(t.tb+this.cfg.ctx+this.cfg.ripOff,true),plan=s.plans.get(rip);
        if(!plan)throw new Error('No admitted sparse instruction at '+rip.toString(16));
        const code=t.proc.mm.guest.executableSnapshot(rip,plan.length);
        if(!code.every((x,i)=>x===plan.instruction[i]))throw new Error('Sparse executable bytes changed');
        const generation=this.sparseBroker.beginInstruction(s.token,{rip,operation:plan.operation,width:plan.width});
        s.active=plan;
        view.setBigUint64(scratch+B.FIELD.checkpoint,generation,true);
        view.setBigUint64(scratch+B.FIELD.checkpointRip,rip,true);
      } else if(phase===2) {
        if(!s.active)throw new Error('Sparse finish without an instruction');
        let status=Number(this.k64[b64+5]);
        if(status===B.STEP.SYSCALL&&!this.sparseFutexSupported(t))status=B.STEP.UNSUPPORTED;
        s.last=this.sparseBroker.finishInstruction(s.token,{status,nextRip:s.active.nextRip});
        s.active=null;s.steps++;
        if(status===B.STEP.SYSCALL) {
          s.syscalls++;
          const completed=this.sparseFutex(t,lease,seq);
          if(!completed.parked)this.completeSparseSyscall(t,lease,seq,completed.result);
          return;
        }
        result=BigInt(status);
        this.host.sparseStep?.(t,s.last);
      } else if(phase===3) {
        if(s.active||s.parked)throw new Error('Sparse exit during an instruction or parked syscall');
        const status=Number(this.k64[b64+5]);
        if(![0,1,2].includes(status))throw new Error('Invalid sparse terminal status');
        s.terminalStatus=status;t.proc.exitStatus=status;
        this.sparseBroker.unregister(s.token);t.dead=true;t.proc.zombie=[...t.proc.threads.values()].every(th=>th.dead);
        // Host worker termination must acknowledge W_OCCUPIED separately.
        this.host.sparseExit?.(t,s.last);
      } else throw new Error('Unsupported sparse instruction boundary');
    } else throw new Error('Unsupported sparse syscall/request '+nr);
    // Deliberately bypass reply(): it computes pending signals and redirect
    // flags. This route only completes transport after typed scratch output.
    this.completeSparseTransport(t,lease,seq,result,true);
  }

  ownsSparseTransport(t,lease,seq,allowDead=false) {
    if(this.slots[t.slot]!==t||(!allowDead&&t.dead)||t.sparse.token.generation!==lease)return false;
    const b=(SLOT_BASE+t.slot*SLOT_SIZE)>>3;
    const state=Atomics.load(this.k32,b*2);
    return Atomics.load(this.k32,b*2+W_OCCUPIED)!==0&&[S_BUSY,globalThis.BetterJITGuestMemoryBroker.ABI.parkedState].includes(state)&&
      BigInt.asUintN(64,this.k64[b+2])===lease&&this.k64[b+3]===seq;
  }
  retireSparseWorker(t,lease) {
    if(this.slots[t.slot]!==t||!t.sparse||t.sparse.token.generation!==lease)return false;
    const base=(SLOT_BASE+t.slot*SLOT_SIZE)>>2;
    if(Atomics.load(this.k32,base+W_OCCUPIED))return false;
    const failed=!t.dead;
    this.sparseBroker.unregister(t.sparse.token);t.sparse.active=null;t.sparse.parked=null;t.sparse.retired=true;t.dead=true;
    if(failed){t.sparse.terminalStatus=2;t.proc.exitStatus=2;}
    t.proc.zombie=[...t.proc.threads.values()].every(th=>th.dead);
    this.slots[t.slot]=null;Atomics.store(this.k32,base,S_IDLE);
    this.host.sparseWorkerRetired?.(t,{failed});return true;
  }
  completeSparseTransport(t,lease,seq,result,allowDead=false) {
    if(!this.ownsSparseTransport(t,lease,seq,allowDead))return false;
    const b=(SLOT_BASE+t.slot*SLOT_SIZE)>>3;
    this.k64[b+8]=result;this.k32[b*2+1]=0;Atomics.store(this.k32,b*2,S_DONE);Atomics.notify(this.k32,b*2);return true;
  }
  sparseFutexSupported(t) {
    const v=t.sparse.view,g=t.tb+this.cfg.ctx+this.cfg.gregsOff;
    const op=Number(v.getBigUint64(g+6*8,true)&0xffffffffn);
    return v.getBigUint64(g,true)===202n&&[0,1,128,129].includes(op);
  }
  completeSparseSyscall(t,lease,seq,result) {
    if(!this.ownsSparseTransport(t,lease,seq))return false;
    const v=t.sparse.view,g=t.tb+this.cfg.ctx+this.cfg.gregsOff;
    v.setBigUint64(g,BigInt.asUintN(64,result),true);
    t.sparse.last=Object.freeze({...t.sparse.last,status:0,syscall:true,result});
    this.host.sparseStep?.(t,t.sparse.last);
    return this.completeSparseTransport(t,lease,seq,0n);
  }
  sparseFutex(t,lease,seq) {
    const B=globalThis.BetterJITGuestMemoryBroker,s=t.sparse,v=s.view,g=t.tb+this.cfg.ctx+this.cfg.gregsOff,
      reg=i=>v.getBigUint64(g+i*8,true),address=reg(7),opf=Number(reg(6)&0xffffffffn),priv=!!(opf&128),op=opf&0x7f;
    const immediate=result=>({parked:false,result});
    try {
      if(op===1) {
        const count=Number(BigInt.asIntN(32,reg(2)));if(count<0)return immediate(-22n);
        return immediate(BigInt(this.sparseBroker.wakeFutex(s.token,{address,count,private:priv})));
      }
      if(t.pending)return immediate(-4n);
      let timeout=Infinity;const pointer=reg(10);
      if(pointer) {
        const bytes=t.proc.mm.guest.read(pointer,16),time=new DataView(bytes.buffer,bytes.byteOffset,16),
          sec=time.getBigInt64(0,true),ns=time.getBigInt64(8,true);
        if(sec<0n||ns<0n||ns>=1000000000n)return immediate(-22n);
        timeout=Number(sec)*1000+Number(ns)/1e6;
      }
      let timer;
      const wait=this.sparseBroker.waitFutex(s.token,{address,expected:reg(2),private:priv},
        result=>this.completeSparseSyscall(t,lease,seq,result),()=>{if(timer)timer.dead=true;s.parked=null;});
      if(!wait.parked)return wait;
      s.parked=wait.handle;
      if(timeout!==Infinity)timer=this.addTimer(timeout,()=>this.sparseBroker.cancelFutex(wait.handle,-110n));
      const base=(SLOT_BASE+t.slot*SLOT_SIZE)>>2;
      Atomics.store(this.k32,base,B.ABI.parkedState);Atomics.notify(this.k32,base);
      this.host.sparseFutexQueued?.(t,{address,private:priv});
      return wait;
    } catch(error) {
      if(error instanceof globalThis.BetterJITGuestMemory.MemoryFault)return immediate(error.reason==='alignment'?-22n:-14n);
      throw error;
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
    if(t.sparse||this.cfg?.guestMemory==='broker1')throw new Error('Sparse requests cannot enter syscall dispatch');
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
    if(t.proc.mm?.sparse&&(!t.sparse||this.threads.get(t.tid)!==t||this.slots[t.slot]!==t||t.dead))
      throw new Error('Authenticated live sparse thread CPU required');
    const dv = t.sparse?t.sparse.view:t.proc.mm.dv, c = t.tb + this.cfg.ctx, g = c + this.cfg.gregsOff;
    return {
      get: (r) => dv.getBigUint64(g + 8 * r, true),
      set: (r, v) => dv.setBigUint64(g + 8 * r, BigInt.asUintN(64, BigInt(v)), true),
      rip: () => dv.getBigUint64(c + this.cfg.ripOff, true),
      setRip: (v) => dv.setBigUint64(c + this.cfg.ripOff, BigInt(v), true),
      setFs: (v) => dv.setBigUint64(c + this.cfg.fsOff, BigInt(v), true),
      fs: () => dv.getBigUint64(c + this.cfg.fsOff, true),
      setGs: (v) => dv.setBigUint64(c + this.cfg.gsOff, BigInt(v), true),
      gs: () => dv.getBigUint64(c + this.cfg.gsOff, true),
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
    mm.ensure(a + TB_SIZE);
    mm.zero(a, a + TB_SIZE);
    mm.insert({ start: a, end: a + TB_SIZE, prot: PROT.READ | PROT.WRITE, flags: MAP.PRIVATE | MAP.ANONYMOUS, name: '[fexwasm thread]', kernel: true, owner });
    // all of it: the dispatcher writes its tables here too, and a reused
    // memory must not show the next thread another thread's tables
    mm.markDirty(a, a + TB_SIZE);
    return a;
  }

  // Starts a thread's worker. The CPUState at tb must be ready (rip included).
  startThread(proc, tid, tb) {
    if(this.cfg?.guestMemory==='broker1')throw new Error('Sparse threads require independent internal allocation');
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
    if(this.cfg?.guestMemory==='broker1')throw new Error('Sparse ELF/syscall boot is not implemented');
    // Direct loading is an explicitly requested session policy. Wine clears
    // WINELOADERNOEXEC during initialization, but its later Wine children still
    // need the same policy when exec_wineloader names the native preloader.
    this.directWineLoader = envp.includes('WINELOADERNOEXEC=1');
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
    const env = (name) => envp.find((e) => e.startsWith(name + '='))?.slice(name.length + 1);
    const prefix = env('WINEPREFIX') || (env('HOME') || '/home/user') + '/.wine';
    let prefixExists = false;
    try { prefixExists = (this.vfs.stat(prefix).mode & S_IF.MT) === S_IF.DIR; } catch (e) { if (!(e instanceof KError) || e.code !== E.NOENT) throw e; }
    // A fresh stock Wine prefix is created by the client, not wineserver.
    // Prestarting the server before bootstrap makes it fail its chdir and
    // terminates the session without ever executing the requested command.
    if (this.host.sharedSpace && prefixExists && /\/wine(64)?$/.test(argv[0]) && !envp.some((e) => e.startsWith('WINE_NOSERVERFIRST='))) {
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
    const con = [0,1,2].map(fd=>new ConsoleFile(fd,this.host.standardIO !== 'captured'));
    for (let i = 0; i < 3; i++) p.fds.set(i, { file: con[i].ref(), cloexec: false });
    p.cwd = this.host.cwd || '/';
    const img = this.loadImage(p, path, argv, envp);
    this.installImage(p, img, null);
    return p;
  }

  // Reads an executable (following #! scripts) and builds its new address space.
  // -> {mm, rip, rsp, space, exe, argv}
  loadImage(proc, path, argv, envp, depth) {
    if (this.directWineLoader && /\/wine(64)?-preloader$/.test(path) &&
        argv.length > 1 && /\/wine(64)?$/.test(argv[1])) {
      const directEnv = envp.filter((e) => !e.startsWith('WINELOADERNOEXEC=')).concat('WINELOADERNOEXEC=1');
      this.log(`[wine] direct loader: ${path} -> ${argv[1]}`);
      return this.loadImage(proc, argv[1], argv.slice(1), directEnv, depth);
    }
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
    // memory (engines can limit concurrent large reservations), owned by a
    // token of its own. A device's limit is not inferred from physical RAM.
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
      const maximumPages=this.memPagesFor(path,elf);
      // Only the opted-in adapted Wine loader: its fixed shared-user-data
      // mapping is known before exec. This is a reuse preference, not a new
      // mapping, larger maximum, or replacement of an active worker's memory.
      const reuseEnd=envp.includes('BETTERJIT_WINE_SPAWN=1')&&/\/wine(64)?$/.test(path)
        ? Math.min(KUSER+2*PAGE,maximumPages*WASM_PAGE-WASM_PAGE) : 0;
      mm = new Mm(maximumPages, 256, {purpose:'exec',pid:proc.pid,space:this.nextSpace,executable:path,reuseEnd});
      space = this.nextSpace++;
    }
    try {
      return this.loadInto(mm, owner, space, path, bytes, elf, argv, envp);
    } catch (e) {
      mm.removeOwner(owner); // (a shared memory keeps everyone else's mappings)
      // A failed staged image has no worker or process owner. Return its
      // separate memory to the existing bounded pool instead of orphaning it.
      if (!this.host.sharedSpace) mm.retire();
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
    if(t.sparse)throw new Error('Sparse retirement requires an explicit step boundary');
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
    if(proc.mm?.sparse)throw new Error('Sparse retirement requires an explicit step boundary');
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
    if(proc.mm?.sparse)return this.signalProcess(proc,sig);
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
    if(proc.mm?.sparse) {
      const t=[...proc.threads.values()].find(t=>!t.dead);
      if(t)this.signalThread(t,sig,info);
      return;
    }
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
    if(t.sparse) {
      if(proc.zombie||t.dead||!sig)return;
      t.pending|=1n<<BigInt(sig-1);
      (t.sigInfo||(t.sigInfo=new Map())).set(sig,info||{code:0,pid:0});
      // No default kill/frame/redirect path while guest Wasm locals may live.
      // The next explicit BEGIN boundary refuses unsupported signal handling.
      if(t.sparse.parked)this.sparseBroker.cancelFutex(t.sparse.parked,-4n);
      return;
    }
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
    if(t.sparse)return;
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
    if(t.sparse)throw new Error('Sparse signal frames are unsupported');
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

module.exports = { Kernel, Retry, Mm, MemoryPool, GLOBAL, KUSER, File, HostFile, BufferFile, DevFile, ConsoleFile, PipeEnd, Pipe, UnixSocket, EventFd, EpollFile, WaitQueue,
  Thread, Process, KError, fail, BLOCK, EXIT_THREAD, REDIRECTED, normPath, pageUp, pageDown, addr, i32, u32, big,
  addr64, POLLIN, POLLOUT, POLLERR, POLLHUP, POLLNVAL, POLLPRI, POLLRDHUP, PAGE, LOW_RESERVED, ADDR_LIMIT, MMAP_BASE, TB_SIZE,
  SLOT_BASE, SLOT_SIZE, INPUT_RING, S_IDLE, S_REQ, S_DONE, S_BUSY, F_REDIRECT, F_EXIT, NR_FAULT, NR_STARTED, NR_SIGCHECK, W_SIGPEND, W_FUTEX, W_OCCUPIED };

};
defs['./oss.js'] = function (module, exports, require) {
// Sound for Wine's OSS driver (wineoss.so, built against build/oss4's
// sys/soundcard.h): /dev/dsp plays what's written to it as time passes, and
// /dev/mixer says what's there. What the driver counts on is the clock:
// written sound drains from a small buffer at its rate, and the driver's
// position (a game's audio clock: FMOD's, which Thumper's intro waits on)
// follows it. The sound itself goes to host.audio when the host plays it.
'use strict';

const { File, fail, POLLOUT } = require('./kernel.js');
const { E } = require('./abi.js');

const AFMT_U8 = 0x8, AFMT_S16_LE = 0x10, AFMT_S32_LE = 0x1000, AFMT_FLOAT = 0x4000, AFMT_S24_LE = 0x8000;
const FORMATS = AFMT_U8 | AFMT_S16_LE | AFMT_S32_LE | AFMT_FLOAT | AFMT_S24_LE;
const BYTES = { [AFMT_U8]: 1, [AFMT_S16_LE]: 2, [AFMT_S32_LE]: 4, [AFMT_FLOAT]: 4, [AFMT_S24_LE]: 4 };
const PCM_CAP_OUTPUT = 0x20000;

// ioctls (_IO* 'P' for the device, 'M' the mixer, 'X' OSS 4's information)
const SNDCTL_DSP_RESET = 0x5000 /* (and HALT) */, SNDCTL_DSP_SYNC = 0x5001, SNDCTL_DSP_SPEED = 0xc0045002, SNDCTL_DSP_SETFMT = 0xc0045005,
  SNDCTL_DSP_CHANNELS = 0xc0045006, SNDCTL_DSP_GETOSPACE = 0x8010500c, SNDCTL_DSP_GETISPACE = 0x8010500d,
  SNDCTL_SYSINFO = 0x84e05801, SNDCTL_AUDIOINFO = 0xc49c5807, SNDCTL_ENGINEINFO = 0xc49c580c;
const AUDIOINFO_SIZE = 1180, SYSINFO_SIZE = 1248;

const FRAG = 2048, FRAGS = 16; // (32 KB: about 170 ms of 48 kHz stereo 16-bit)

function putString(u8, at, s, max) {
  const b = new TextEncoder().encode(s);
  u8.set(b.subarray(0, max - 1), at);
  u8[at + Math.min(b.length, max - 1)] = 0;
}

// oss_audioinfo for the one device (offsets: build/oss4/include/sys/soundcard.h)
function audioInfo(t, p) {
  const u8 = t.proc.mm.u8, dv = t.proc.mm.dv;
  u8.fill(0, p, p + AUDIOINFO_SIZE);
  dv.setInt32(p, 0, true); // dev
  putString(u8, p + 4, 'Madeira', 64); // name
  dv.setInt32(p + 72, -1, true); // pid
  dv.setInt32(p + 76, PCM_CAP_OUTPUT, true); // caps
  dv.setInt32(p + 84, FORMATS, true); // oformats
  dv.setInt32(p + 172, 1, true); // enabled
  dv.setInt32(p + 180, 8000, true); // min_rate
  dv.setInt32(p + 184, 192000, true); // max_rate
  dv.setInt32(p + 188, 1, true); // min_channels
  dv.setInt32(p + 192, 8, true); // max_channels
  putString(u8, p + 404, '/dev/dsp', 32); // devnode
  return 0;
}

class DspFile extends File {
  constructor() {
    super('dsp');
    this.fmt = AFMT_S16_LE;
    this.channels = 2;
    this.rate = 48000;
    this.queued = 0; // bytes written that haven't played yet
    this.at = performance.now();
  }
  get bytesPerMs() { return (this.rate * this.channels * BYTES[this.fmt]) / 1000; }
  drain() {
    const now = performance.now();
    this.queued = Math.max(0, this.queued - (now - this.at) * this.bytesPerMs);
    this.at = now;
  }
  free() {
    this.drain();
    return Math.max(0, Math.floor(FRAG * FRAGS - this.queued));
  }
  write(k, t, buf) {
    const n = Math.min(buf.length, this.free());
    if (n === 0) fail(E.AGAIN);
    this.queued += n;
    if (k.host.audio) k.host.audio({ fmt: this.fmt, channels: this.channels, rate: this.rate }, buf.subarray(0, n));
    return n;
  }
  read() { fail(E.INVAL); }
  poll() { return this.free() > 0 ? POLLOUT : 0; }
  ioctl(k, t, req, arg) {
    const dv = t.proc.mm.dv;
    switch (req) {
      case SNDCTL_DSP_SETFMT: {
        const want = dv.getInt32(arg, true);
        if (BYTES[want]) this.fmt = want;
        dv.setInt32(arg, this.fmt, true);
        return 0;
      }
      case SNDCTL_DSP_CHANNELS:
        this.channels = Math.max(1, Math.min(8, dv.getInt32(arg, true)));
        dv.setInt32(arg, this.channels, true);
        return 0;
      case SNDCTL_DSP_SPEED:
        this.rate = Math.max(8000, Math.min(192000, dv.getInt32(arg, true)));
        dv.setInt32(arg, this.rate, true);
        return 0;
      case SNDCTL_DSP_GETOSPACE: { // audio_buf_info: fragments, fragstotal, fragsize, bytes
        const free = this.free();
        dv.setInt32(arg, Math.floor(free / FRAG), true);
        dv.setInt32(arg + 4, FRAGS, true);
        dv.setInt32(arg + 8, FRAG, true);
        dv.setInt32(arg + 12, free, true);
        return 0;
      }
      case SNDCTL_DSP_RESET:
        this.queued = 0;
        this.at = performance.now();
        return 0;
      case SNDCTL_DSP_SYNC:
        return 0;
      case SNDCTL_ENGINEINFO:
      case SNDCTL_AUDIOINFO:
        return audioInfo(t, arg);
      case SNDCTL_DSP_GETISPACE:
      default:
        fail(E.INVAL);
    }
  }
  stat() { return { mode: 0o20666, ino: this.ino, rdev: 0x0e03 }; } // (S_IFCHR; OSS's major 14)
}

class MixerFile extends File {
  constructor() { super('mixer'); }
  read() { fail(E.INVAL); }
  write() { fail(E.INVAL); }
  ioctl(k, t, req, arg) {
    const u8 = t.proc.mm.u8, dv = t.proc.mm.dv;
    if (req === SNDCTL_SYSINFO) {
      u8.fill(0, arg, arg + SYSINFO_SIZE);
      putString(u8, arg, 'Madeira', 32); // product
      putString(u8, arg + 32, '4.2', 32); // version
      dv.setInt32(arg + 64, 0x040200, true); // versionnum
      dv.setInt32(arg + 196, 1, true); // numaudios
      dv.setInt32(arg + 244, 1, true); // nummixers
      dv.setInt32(arg + 280, 1, true); // numcards
      dv.setInt32(arg + 284, 1, true); // numaudioengines
      return 0;
    }
    if (req === SNDCTL_AUDIOINFO || req === SNDCTL_ENGINEINFO) return audioInfo(t, arg);
    // SOUND_MIXER_READ_x (_IOR('M', x, int)): full volume; WRITE_x: taken
    if ((req & 0xffffff00) === 0x80044d00) { dv.setInt32(arg, 100 | (100 << 8), true); return 0; }
    if ((req & 0xffffff00) === 0xc0044d00) return 0;
    fail(E.INVAL);
  }
  stat() { return { mode: 0o20666, ino: this.ino, rdev: 0x0e00 }; }
}

module.exports = { DspFile, MixerFile };

};
defs['./ntsync.js'] = function (module, exports, require) {
// /dev/ntsync: Windows' synchronization objects in the kernel, as Linux's
// ntsync driver has them (include/uapi/linux/ntsync.h; build/sysroot's
// linux/ntsync.h). Wine 11 uses it for "in-process" synchronization: the
// wineserver makes an object per event, mutex and semaphore and hands each
// client a descriptor for it, and every wait, set and release after that is
// one ioctl here instead of a request to the wineserver (a round trip through
// two more threads, ~0.45 ms on the phone; games poll WaitForSingleObject(h, 0)
// every frame).
//
// A signal, release or unlock hands the object to its waiters right away, in
// the order they came (pulse included: it has to reach them before it is
// reset); a waiter that gets it is marked done, and its retried syscall only
// reports what it got.
'use strict';

const { File, fail, BLOCK, KError } = require('./kernel.js');
const { E } = require('./abi.js');

const EOWNERDEAD = 130;
const NTSYNC_IOC_CREATE_SEM = 0x40084e80, NTSYNC_IOC_SEM_RELEASE = 0xc0044e81, NTSYNC_IOC_WAIT_ANY = 0xc0284e82,
  NTSYNC_IOC_WAIT_ALL = 0xc0284e83, NTSYNC_IOC_CREATE_MUTEX = 0x40084e84, NTSYNC_IOC_MUTEX_UNLOCK = 0xc0084e85,
  NTSYNC_IOC_MUTEX_KILL = 0x40044e86, NTSYNC_IOC_CREATE_EVENT = 0x40084e87, NTSYNC_IOC_EVENT_SET = 0x80044e88,
  NTSYNC_IOC_EVENT_RESET = 0x80044e89, NTSYNC_IOC_EVENT_PULSE = 0x80044e8a, NTSYNC_IOC_SEM_READ = 0x80084e8b,
  NTSYNC_IOC_MUTEX_READ = 0x80084e8c, NTSYNC_IOC_EVENT_READ = 0x80084e8d;
const NTSYNC_WAIT_REALTIME = 1, NTSYNC_MAX_WAIT_COUNT = 64;
const SEM = 1, MUTEX = 2, EVENT = 3;

// The threads waiting on an object, first come first served (the kernel's
// unblock() takes a thread out of every .threads it waits in).
class Waiters {
  constructor() { this.threads = new Set(); }
  add(t) { this.threads.add(t); t.waitingOn.add(this); }
}

class NtsyncObj extends File {
  // sem: a = count, b = max; mutex: a = owner (0: free), b = recursion count; event: a = manual, b = signaled
  constructor(type, a, b) {
    super('ntsync');
    this.type = type;
    this.a = a >>> 0;
    this.b = b >>> 0;
    this.ownerdead = false;
    this.q = new Waiters();
  }
  ready(owner) {
    if (this.type === SEM) return this.a > 0;
    if (this.type === MUTEX) return this.a === 0 || this.a === owner;
    return this.b !== 0;
  }
  take(w) {
    if (this.type === SEM) this.a--;
    else if (this.type === MUTEX) {
      if (this.ownerdead) { w.ownerdead = true; this.ownerdead = false; }
      this.a = w.owner;
      this.b++;
    } else if (!this.a) this.b = 0; // (an auto-reset event is consumed; a manual one stays set)
  }
  // Its state rose: its waiters get it while it lasts, in order.
  wake(k) {
    for (const t of this.q.threads) {
      const w = t.ntWait;
      if (!w || w.done || !tryWait(w)) continue;
      k.unblock(t); // (off every queue; the retry reports w)
      t.retry = w.fn;
      // (it has what it waited for: a signal now waits until its ioctl
      // returns, instead of interrupting it and losing what it took)
      t.noInterrupt = true;
      k.makeRunnable(t);
    }
  }
  ioctl(k, t, req, p) {
    const dv = t.proc.mm.dv;
    switch (req) {
      case NTSYNC_IOC_SEM_RELEASE: {
        if (this.type !== SEM) fail(E.INVAL);
        const n = dv.getUint32(p, true), prev = this.a;
        if (prev + n > this.b) fail(E.OVERFLOW);
        this.a = prev + n;
        dv.setUint32(p, prev, true);
        this.wake(k);
        return 0;
      }
      case NTSYNC_IOC_SEM_READ:
        if (this.type !== SEM) fail(E.INVAL);
        dv.setUint32(p, this.a, true);
        dv.setUint32(p + 4, this.b, true);
        return 0;
      case NTSYNC_IOC_MUTEX_UNLOCK: {
        if (this.type !== MUTEX) fail(E.INVAL);
        const owner = dv.getUint32(p, true);
        if (!owner) fail(E.INVAL);
        if (this.a !== owner) fail(E.PERM);
        dv.setUint32(p + 4, this.b, true);
        if (--this.b === 0) { this.a = 0; this.wake(k); }
        return 0;
      }
      case NTSYNC_IOC_MUTEX_KILL: {
        if (this.type !== MUTEX) fail(E.INVAL);
        const owner = dv.getUint32(p, true);
        if (!owner) fail(E.INVAL);
        if (this.a !== owner) fail(E.PERM);
        this.ownerdead = true;
        this.a = this.b = 0;
        this.wake(k);
        return 0;
      }
      case NTSYNC_IOC_MUTEX_READ:
        if (this.type !== MUTEX) fail(E.INVAL);
        dv.setUint32(p, this.a, true);
        dv.setUint32(p + 4, this.b, true);
        if (this.ownerdead) fail(EOWNERDEAD);
        return 0;
      case NTSYNC_IOC_EVENT_SET:
      case NTSYNC_IOC_EVENT_PULSE: {
        if (this.type !== EVENT) fail(E.INVAL);
        const prev = this.b;
        this.b = 1;
        this.wake(k);
        if (req === NTSYNC_IOC_EVENT_PULSE) this.b = 0;
        dv.setUint32(p, prev, true);
        return 0;
      }
      case NTSYNC_IOC_EVENT_RESET: {
        if (this.type !== EVENT) fail(E.INVAL);
        const prev = this.b;
        this.b = 0;
        dv.setUint32(p, prev, true);
        return 0;
      }
      case NTSYNC_IOC_EVENT_READ:
        if (this.type !== EVENT) fail(E.INVAL);
        dv.setUint32(p, this.a, true);
        dv.setUint32(p + 4, this.b, true);
        return 0;
      default:
        fail(E.NOTTY);
    }
  }
  stat() { return { mode: 0o20666, ino: this.ino, rdev: 0 }; }
}

// Can the wait be satisfied now? Then it takes what it waits for.
function tryWait(w) {
  if (w.done) return true;
  if (w.all) {
    if (w.objs.length && w.objs.every((o) => o.ready(w.owner))) {
      // (the same object twice in a wait-all is refused when the wait starts)
      for (const o of w.objs) o.take(w);
      w.index = 0;
      w.done = true;
      return true;
    }
  } else {
    for (let i = 0; i < w.objs.length; i++) {
      if (w.objs[i].ready(w.owner)) {
        w.objs[i].take(w);
        w.index = i;
        w.done = true;
        return true;
      }
    }
  }
  if (w.alert && w.alert.ready(w.owner)) {
    w.alert.take(w);
    w.index = w.objs.length;
    w.done = true;
    return true;
  }
  return false;
}

class NtsyncDevice extends File {
  constructor() { super('ntsync-device'); }
  ioctl(k, t, req, p) {
    const dv = t.proc.mm.dv;
    k.stats.ntsync = (k.stats.ntsync || 0) + 1;
    switch (req) {
      case NTSYNC_IOC_CREATE_SEM: {
        const count = dv.getUint32(p, true), max = dv.getUint32(p + 4, true);
        if (count > max) fail(E.INVAL);
        return t.proc.allocFd(new NtsyncObj(SEM, count, max), 0, true);
      }
      case NTSYNC_IOC_CREATE_MUTEX: {
        const owner = dv.getUint32(p, true), count = dv.getUint32(p + 4, true);
        if (!owner !== !count) fail(E.INVAL);
        return t.proc.allocFd(new NtsyncObj(MUTEX, owner, count), 0, true);
      }
      case NTSYNC_IOC_CREATE_EVENT:
        return t.proc.allocFd(new NtsyncObj(EVENT, dv.getUint32(p, true) ? 1 : 0, dv.getUint32(p + 4, true) ? 1 : 0), 0, true);
      case NTSYNC_IOC_WAIT_ANY:
      case NTSYNC_IOC_WAIT_ALL:
        return wait(k, t, p, req === NTSYNC_IOC_WAIT_ALL);
      default:
        fail(E.NOTTY);
    }
  }
  stat() { return { mode: 0o20666, ino: this.ino, rdev: 0x0a7d }; }
}

// struct ntsync_wait_args: u64 timeout (ns, absolute; ~0: none), u64 objs (an
// array of int fds), u32 count, u32 index (out), u32 flags, u32 owner, u32 alert, u32 pad
function wait(k, t, p, all) {
  const dv = t.proc.mm.dv;
  let w = t.ntWait;
  if (!w || w.nsys !== t.nsys) {
    // a new wait (not the retry of a parked one)
    const count = dv.getUint32(p + 16, true);
    if (count > NTSYNC_MAX_WAIT_COUNT) fail(E.INVAL);
    const objsAt = Number(dv.getBigUint64(p + 8, true) & 0xffffffffn), objs = [];
    for (let i = 0; i < count; i++) {
      const f = t.proc.file(dv.getInt32(objsAt + 4 * i, true));
      if (!(f instanceof NtsyncObj)) fail(E.INVAL);
      if (all && objs.includes(f)) fail(E.INVAL);
      objs.push(f);
    }
    const alertFd = dv.getUint32(p + 32, true);
    let alert = null;
    if (alertFd) {
      alert = t.proc.file(alertFd);
      if (!(alert instanceof NtsyncObj)) fail(E.INVAL);
    }
    const timeout = dv.getBigUint64(p, true), flags = dv.getUint32(p + 24, true);
    // (the deadline on this worker's clock: monotonic time counts from the boot epoch, as the threads' clock_gettime has it)
    const deadline = timeout === 0xffffffffffffffffn ? Infinity
      : Number(timeout) / 1e6 + (flags & NTSYNC_WAIT_REALTIME ? 0 : k.bootEpoch || 0) - performance.timeOrigin;
    w = t.ntWait = { nsys: t.nsys, objs, all, alert, owner: dv.getUint32(p + 28, true), deadline, done: false, index: -1, ownerdead: false, fn: null };
    w.fn = () => wait(k, t, p, all);
    for (const o of objs) o.refs++; // (they outlive a close during the wait)
    if (alert) alert.refs++;
  }
  if (!w.done) tryWait(w);
  if (!w.done && performance.now() < w.deadline) {
    for (const o of w.objs) o.q.add(t);
    if (w.alert) w.alert.q.add(t);
    if (w.deadline !== Infinity && (!t.timer || t.timer.dead)) t.timer = k.addTimer(w.deadline - performance.now(), () => k.makeRunnable(t));
    return BLOCK;
  }
  // over: what it got, or the time ran out
  t.ntWait = null;
  for (const o of w.objs) o.unref(k);
  if (w.alert) w.alert.unref(k);
  if (!w.done) fail(E.TIMEDOUT);
  dv.setUint32(p + 20, w.index, true);
  if (w.ownerdead) fail(EOWNERDEAD);
  return 0;
}

module.exports = { NtsyncDevice, NtsyncObj };

};
defs['./syscalls.js'] = function (module, exports, require) {
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
    child.mm = proc.mm.clone(proc.image, child.image,{parentPid:proc.pid,parentSpace:proc.space});
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

};
defs['./snapshot.js'] = function (module, exports, require) {
// Freezing the guest system, to save it and start it again later (a booted
// Wine desktop comes back in seconds instead of a boot).
//
// Freezing stops every thread at a syscall boundary, where the backend
// keeps a thread's whole state in its CPUState (SyscallFullState), and
// rewinds it to its syscall instruction: RIP back to it (the syscall put the
// return address in RCX; `syscall` is 2 bytes) and RAX the syscall number
// again. A thread blocked in the kernel is taken off what it waits on; one
// running guest code, or futex-waiting in its worker, is told to come to the
// kernel (W_SIGPEND) and is parked there. Nothing the kernel does for a
// blocked syscall happens before it would return, so a rewound syscall runs
// again as if for the first time: when the system thaws (the kernel answers
// F_REDIRECT: the worker starts over from CPUState), or in a restored system.
// (A vfork parent waits for its child to exec: that one isn't rewound, the
// freeze waits for it.)
'use strict';

const K = require('./kernel.js');
const { Kernel, Mm, Process, HostFile, BufferFile, DevFile, PipeEnd, Pipe, UnixSocket, EventFd, EpollFile, GLOBAL, PAGE, TB_SIZE,
  NR_STARTED, NR_SIGCHECK, NR_FAULT, SLOT_BASE, SLOT_SIZE, W_SIGPEND, W_FUTEX, F_REDIRECT } = K;
const R = Kernel.R;
const SYS_RT_SIGSUSPEND = 130;
const DISPATCH_AREA = 0x2_0000; // a thread block's dispatcher tables start here (empty in a restored system)

// Freezes the system: done(null) once every thread is parked, or
// done(reason) after timeoutMs (the system then thaws again).
Kernel.prototype.freeze = function (timeoutMs, done) {
  if([...this.threads.values()].some(t=>t.sparse))return done('Sparse snapshots are unsupported');
  if (this.freezing) return done('already freezing');
  this.freezing = { done, timer: this.addTimer(timeoutMs, () => this.freezeTimedOut()) };
  for (const t of this.threads.values()) this.freezeThread(t);
  this.checkFrozen();
};

// A thread: parked now if it is blocked in the kernel, else told to come.
Kernel.prototype.freezeThread = function (t) {
  if (t.frozen || t.dead) return;
  if (t.retry) {
    if (t.noInterrupt) return; // (a vfork parent: its syscall can't run again)
    this.unblock(t);
    this.parkFrozen(t, t.nr);
    return;
  }
  const b32 = (SLOT_BASE + t.slot * SLOT_SIZE) >> 2;
  Atomics.store(this.k32, b32 + W_SIGPEND, 1);
  const fa = Atomics.load(this.k32, b32 + W_FUTEX);
  if (fa && t.proc.mm) Atomics.notify(new Int32Array(t.proc.mm.mem.buffer), fa >>> 2);
};

// While freezing, a request (Kernel.request calls this first): true if the
// thread was parked instead of served.
Kernel.prototype.freezeRequest = function (t, nr) {
  if (!this.freezing || nr === NR_STARTED || nr === NR_FAULT) return false;
  // NR_SIGCHECK: from a syscall the worker does itself (a futex wait): the
  // slot says which (see thread_core.js)
  const real = nr === NR_SIGCHECK ? this.k32[((SLOT_BASE + t.slot * SLOT_SIZE) >> 2) + 22] : nr;
  this.parkFrozen(t, real);
  this.checkFrozen();
  return true;
};

Kernel.prototype.parkFrozen = function (t, nr) {
  // (rt_sigsuspend runs again with the mask it replaces)
  if (nr === SYS_RT_SIGSUSPEND && t.suspendMask !== undefined) {
    t.sigmask = t.suspendMask;
    t.suspendMask = undefined;
  }
  const c = this.cpu(t);
  c.setRip(c.get(R.RCX) - 2n);
  c.set(R.RAX, nr);
  t.frozen = true;
  t.inSyscall = false;
};

Kernel.prototype.checkFrozen = function () {
  const f = this.freezing;
  if (!f || f.frozen) return;
  for (const t of this.threads.values()) if (!t.dead && !t.frozen) return;
  f.frozen = true;
  f.timer.dead = true;
  f.done(null);
};

Kernel.prototype.freezeTimedOut = function () {
  const f = this.freezing;
  if (!f || f.frozen) return;
  const left = [...this.threads.values()].filter((t) => !t.dead && !t.frozen).map((t) => `${t.tid} (pid ${t.proc.pid})`);
  this.thaw();
  f.done(`threads that didn't stop: ${left.join(', ')}`);
};

// Lets every parked thread go on: it runs its syscall again.
Kernel.prototype.thaw = function () {
  this.freezing = null;
  for (const t of this.threads.values()) {
    if (!t.frozen) continue;
    t.frozen = false;
    if (t.awaiting) this.reply(t, 0n, F_REDIRECT);
  }
};

// --- saving ------------------------------------------------------------------
// A frozen system as {header (JSON-able), blobs: [Uint8Array], pages}: the
// kernel's objects, the file system's (host.vfs.save), the bytes they hold
// (blobs), and guest memory: the non-zero pages of what is mapped, as runs
// [[start, count], ...] and their bytes (pages.runs, pages.bytes(i)).
// One shared memory only (host.sharedSpace; no forked process in the middle
// of its fork).
const big2s = (v) => (typeof v === 'bigint' ? { $b: v.toString() } : v);
const s2big = (v) => (v && typeof v === 'object' && '$b' in v ? BigInt(v.$b) : v);
const reviver = (k, v) => s2big(v);

Kernel.prototype.snapshot = function () {
  if (!this.freezing || !this.freezing.frozen) throw new Error('snapshot: the system is not frozen');
  const mm = this.sharedMm;
  for (const p of this.procs.values()) {
    if (!p.zombie && p.mm !== mm) throw new Error(`snapshot: pid ${p.pid} has a memory of its own`);
  }
  if (this.onListen) throw new Error('snapshot: still starting up');
  const blobs = [];
  const addBlob = (b) => (blobs.push(b.slice()), blobs.length - 1);
  // (address ranges set aside for a moment: free now)
  for (const v of mm.vmas.filter((v) => v.owner && v.owner.quarantine)) mm.removeOwner(v.owner);

  // owners of mappings (process images) and files, by id
  const owners = new Map([[GLOBAL, 'G']]);
  const ownerId = (o) => {
    if (!o) return null;
    if (!owners.has(o)) owners.set(o, { id: owners.size, image: o.image, forkOf: o.forkOf });
    return owners.get(o) === 'G' ? 'G' : owners.get(o).id;
  };
  const files = new Map(), fileRecs = [], pipes = new Map(), pipeRecs = [];
  const fileId = (f) => {
    if (!f) return null;
    if (files.has(f)) return files.get(f);
    const id = fileRecs.length;
    files.set(f, id);
    fileRecs.push(null);
    const r = { kind: f.kind, refs: f.refs, flags: f.flags, pos: f.pos, ino: big2s(f.ino), lockKey: f.lockKey };
    if (f instanceof HostFile) Object.assign(r, { type: 'host', fd: f.fd, path: f.path, isDir: f.isDir, memfd: f.memfd });
    else if (f instanceof BufferFile) Object.assign(r, { type: 'buffer', bytes: addBlob(f.bytes), mode: f.mode });
    else if (f instanceof DevFile) Object.assign(r, { type: 'dev', name: f.name });
    else if (f instanceof PipeEnd) {
      if (!pipes.has(f.pipe)) {
        pipes.set(f.pipe, pipeRecs.length);
        const p = f.pipe;
        pipeRecs.push({ chunks: p.chunks.map(addBlob), size: p.size, readers: p.readers, writers: p.writers, capacity: p.capacity });
      }
      Object.assign(r, { type: 'pipe', pipe: pipes.get(f.pipe), isWrite: f.isWrite });
    } else if (f instanceof UnixSocket) {
      Object.assign(r, { type: 'socket', stype: f.type, listening: f.listening, path: f.path, shutRd: f.shutRd, shutWr: f.shutWr,
        peerGone: f.peerGone, queued: f.queued });
      fileRecs[id] = r; // (before the peer, which points back)
      r.peer = fileId(f.peer);
      r.queue = f.queue.map((m) => ({ data: addBlob(m.data), files: m.files.map(fileId) }));
      r.backlog = f.backlog.map(fileId);
    } else if (f instanceof EventFd) Object.assign(r, { type: 'eventfd', value: big2s(f.value), semaphore: f.semaphore });
    else if (f instanceof EpollFile) {
      fileRecs[id] = r;
      Object.assign(r, { type: 'epoll', watch: [...f.watch].map(([fd, w]) => [fd, fileId(w.file), big2s(w.events), big2s(w.data)]) });
    } else if (f.kind === 'console') Object.assign(r, { type: 'console', fd: f.fd, terminal: f.terminal });
    else throw new Error('snapshot: a file of kind ' + f.kind);
    fileRecs[id] = r;
    return id;
  };

  const procs = [...this.procs.values()].map((p) => ({
    pid: p.pid, ppid: p.ppid, pgid: p.pgid, sid: p.sid, space: p.space, image: ownerId(p.image), ownsImage: p.ownsImage,
    brkStart: p.brkStart, brk: p.brk, cwd: p.cwd, umask: p.umask, zombie: p.zombie, exitStatus: p.exitStatus, exe: p.exe, argv: p.argv,
    fds: [...p.fds].map(([fd, e]) => [fd, fileId(e.file), e.cloexec]),
    actions: p.actions.map((a) => ({ handler: big2s(a.handler), flags: big2s(a.flags), restorer: big2s(a.restorer), mask: big2s(a.mask) })),
    children: [...p.children], rlimits: [...p.rlimits].map(([k, v]) => [k, big2s(v)]), dirtyLog: p.dirtyLog, lastFullSync: 0,
    hasMm: !!p.mm,
  }));
  const threads = [...this.threads.values()].filter((t) => !t.dead).map((t) => ({
    tid: t.tid, pid: t.proc.pid, tb: t.tb, sigmask: big2s(t.sigmask), pending: big2s(t.pending), clearTid: t.clearTid,
    robustList: t.robustList, altstack: t.altstack && { sp: big2s(t.altstack.sp), flags: t.altstack.flags, size: big2s(t.altstack.size) },
    name: t.name, sigInfo: t.sigInfo ? [...t.sigInfo] : null,
  }));
  const shared = [...this.sharedFiles.values()].map((sf) => ({ key: sf.key, file: fileId(sf.file), data: addBlob(sf.data) }));
  const vmas = mm.vmas.map((v) => ({
    start: v.start, end: v.end, prot: v.prot, flags: v.flags, name: v.name, kernel: v.kernel, owner: ownerId(v.owner),
    file: v.file, shared: v.shared ? v.shared.key : undefined, sharedPriv: v.sharedPriv ? v.sharedPriv.key : undefined,
  }));
  const locks = [...this.locks].map(([key, ls]) => [key, ls.map((l) => ({
    owner: l.owner instanceof Process ? { pid: l.owner.pid } : { file: fileId(l.owner) }, pid: l.proc.pid, start: l.start,
    end: l.end === Infinity ? null : l.end, type: l.type }))]);
  const unixNames = [...this.unixNames].map(([path, s]) => [path, fileId(s)]);
  const inputFds = [...this.inputFds].filter((f) => f.refs > 0).map(fileId);
  const vfs = this.vfs.save(addBlob);

  // guest memory: the non-zero pages of what is mapped (a thread block's
  // dispatcher tables start over empty)
  const skip = threads.map((t) => [t.tb + DISPATCH_AREA, t.tb + TB_SIZE]);
  const u32 = new Uint32Array(mm.mem.buffer), runs = [];
  let words = 0;
  for (const [a, b] of mm.dirty) {
    // (addresses go past 2 GB: no 32-bit signed bit operations on them)
    for (let pg = a - (a % PAGE); pg < b; pg += PAGE) {
      if (skip.some(([s, e]) => pg >= s && pg < e) || mm.find(pg) < 0) continue;
      let nz = false;
      for (let i = pg / 4, e = (pg + PAGE) / 4; i < e; i++) if (u32[i]) { nz = true; break; }
      if (!nz) continue;
      const last = runs[runs.length - 1];
      if (last && last[0] + last[1] * PAGE === pg) last[1]++;
      else runs.push([pg, 1]);
      words++;
    }
  }
  const header = {
    version: 1, monotonicMs: performance.timeOrigin + performance.now() - this.bootEpoch,
    nextPid: this.nextPid, nextSpace: this.nextSpace, initPid: this.initProc && this.initProc.pid,
    spaceUsers: [...this.spaceUsers], owners: [...owners.values()].filter((o) => o !== 'G'),
    mm: { maxPages: mm.maxPages, size: mm.mem.buffer.byteLength, space: mm.space, users: mm.users, shared: mm.shared, vmas, dirty: mm.dirty },
    files: fileRecs, pipes: pipeRecs, procs, threads, shared, locks, unixNames, inputFds, vfs, display: [...this.displayWindows],
    memory: { runs, pages: words },
  };
  const u8 = mm.u8;
  return { header, blobs, runs, bytes: (i) => u8.subarray(runs[i][0], runs[i][0] + runs[i][1] * PAGE) };
};

// --- restoring -----------------------------------------------------------------
// A kernel for the system in snap ({header, blob(i), loadRuns(u8, runs)}):
// its memory, objects and files; its threads start (rewound to their
// syscalls) once the translator has the code (host.code).
Kernel.restore = function (host, cfg, snap) {
  const h = snap.header;
  if (h.version !== 1) throw new Error('snapshot version ' + h.version);
  if (!host.vfs) host.vfs = host.loadVfs(h.vfs, snap.blob);
  const k = new Kernel(host, cfg);
  k.bootEpoch = performance.timeOrigin + performance.now() - h.monotonicMs; // (monotonic time goes on from where it was)
  k.nextPid = h.nextPid;
  k.nextSpace = h.nextSpace;
  k.spaceUsers = new Map(h.spaceUsers);

  // memory
  const mm = new Mm(h.mm.maxPages, Math.ceil(h.mm.size / 65536));
  mm.ensure(h.mm.size);
  mm.zero(0, h.mm.size); // (a reused memory)
  snap.loadRuns(mm.u8, h.memory.runs);
  mm.space = h.mm.space;
  mm.users = h.mm.users;
  mm.shared = h.mm.shared;
  for (const [a, b] of h.mm.dirty) mm.markDirty(a, b);
  k.sharedMm = mm;
  const owners = new Map([['G', GLOBAL]]);
  for (const o of h.owners) owners.set(o.id, { image: o.image, forkOf: o.forkOf });

  // files
  const files = h.files.map(() => null);
  const pipes = h.pipes.map((p) => Object.assign(new Pipe(), { chunks: p.chunks.map(snap.blob), size: p.size, readers: p.readers,
    writers: p.writers, capacity: p.capacity }));
  h.files.forEach((r, id) => {
    let f;
    switch (r.type) {
      case 'host': f = new HostFile(k.vfs, r.fd, r.path, r.flags, r.isDir); if (r.memfd !== undefined) f.memfd = r.memfd; break;
      case 'buffer': f = new BufferFile(snap.blob(r.bytes), r.mode); break;
      case 'dev': f = new DevFile(r.name); break;
      case 'console': f = new K.ConsoleFile(r.fd, r.terminal !== false); break;
      case 'pipe': {
        const p = pipes[r.pipe], rd = p.readers, wr = p.writers;
        f = new PipeEnd(p, r.isWrite);
        p.readers = rd; // (the constructor counted this end again)
        p.writers = wr;
        break;
      }
      case 'socket': f = new UnixSocket(r.stype); break;
      case 'eventfd': f = new EventFd(0, 0); f.value = s2big(r.value); f.semaphore = r.semaphore; break;
      case 'epoll': f = new EpollFile(); break;
      default: throw new Error('restore: a file of type ' + r.type);
    }
    Object.assign(f, { refs: r.refs, flags: r.flags, pos: r.pos, ino: s2big(r.ino) });
    if (r.lockKey !== undefined) f.lockKey = r.lockKey;
    files[id] = f;
  });
  h.files.forEach((r, id) => {
    const f = files[id];
    if (r.type === 'socket') {
      Object.assign(f, { listening: r.listening, path: r.path, shutRd: r.shutRd, shutWr: r.shutWr, peerGone: r.peerGone, queued: r.queued,
        peer: r.peer === null ? null : files[r.peer], queue: r.queue.map((m) => ({ data: snap.blob(m.data), files: m.files.map((x) => files[x]) })),
        backlog: r.backlog.map((x) => files[x]) });
    } else if (r.type === 'epoll') {
      for (const [fd, fid, events, data] of r.watch) f.watch.set(fd, { file: files[fid], events: s2big(events), data: s2big(data) });
    }
  });
  for (const sfr of h.shared) {
    const sf = { key: sfr.key, file: files[sfr.file], data: snap.blob(sfr.data), mms: new Set([mm]) };
    k.sharedFiles.set(sf.key, sf);
  }
  mm.vmas = h.mm.vmas.map((v) => ({
    start: v.start, end: v.end, prot: v.prot, flags: v.flags, name: v.name, kernel: v.kernel, owner: owners.get(v.owner),
    file: v.file, shared: v.shared !== undefined ? k.sharedFiles.get(v.shared) : undefined,
    sharedPriv: v.sharedPriv !== undefined ? k.sharedFiles.get(v.sharedPriv) : undefined,
  }));
  mm.rebuildWx();
  mm.version++;
  for (const [path, id] of h.unixNames) k.unixNames.set(path, files[id]);
  for (const id of h.inputFds || []) k.inputFds.add(files[id]);

  // processes and threads
  for (const r of h.procs) {
    const p = new Process(k, r.pid, r.ppid);
    Object.assign(p, { pgid: r.pgid, sid: r.sid, space: r.space, image: r.image === null ? null : owners.get(r.image), ownsImage: r.ownsImage,
      brkStart: r.brkStart, brk: r.brk, cwd: r.cwd, umask: r.umask, zombie: r.zombie, exitStatus: r.exitStatus, exe: r.exe, argv: r.argv,
      dirtyLog: r.dirtyLog, lastFullSync: 0, mm: r.hasMm ? mm : null });
    for (const [fd, id, cloexec] of r.fds) p.fds.set(fd, { file: files[id], cloexec });
    p.actions = r.actions.map((a) => ({ handler: s2big(a.handler), flags: s2big(a.flags), restorer: s2big(a.restorer), mask: s2big(a.mask) }));
    p.children = new Set(r.children);
    p.rlimits = new Map(r.rlimits.map(([key, v]) => [key, s2big(v)]));
    k.procs.set(p.pid, p);
  }
  k.initProc = h.initPid ? k.procs.get(h.initPid) : null;
  for (const [key, ls] of h.locks) {
    k.locks.set(key, ls.map((l) => ({ owner: l.owner.pid !== undefined ? k.procs.get(l.owner.pid) : files[l.owner.file], proc: k.procs.get(l.pid),
      start: l.start, end: l.end === null ? Infinity : l.end, type: l.type })));
  }
  // the windows as they were (the display host starts with none)
  for (const [hwnd, w] of h.display || []) {
    k.displayWindows.set(hwnd, w);
    if (!host.display) continue;
    if (w.frame) host.display(Object.assign({}, w.frame, { swp: 0, after: w.topmost ? -1 : 0 })); // (in the order saved: bottom first)
    const sf = w.surface;
    if (sf) k.presentRect(mm, hwnd, sf.bits, sf.sw, sf.sh, sf.stride, 0, 0, sf.sw, sf.sh);
  }
  // the translator gets every process's code again, then the threads start
  for (const v of mm.vmas) if (v.prot & 4) host.code(mm.space, v.start, mm.u8.slice(v.start, v.end), k.abiFor(v.name));
  for (const r of h.threads) {
    const p = k.procs.get(r.pid);
    mm.u8.fill(0, r.tb + DISPATCH_AREA, r.tb + TB_SIZE);
    const t = k.startThread(p, r.tid, r.tb);
    Object.assign(t, { sigmask: s2big(r.sigmask), pending: s2big(r.pending), clearTid: r.clearTid, robustList: r.robustList, name: r.name,
      altstack: r.altstack && { sp: s2big(r.altstack.sp), flags: r.altstack.flags, size: s2big(r.altstack.size) },
      sigInfo: r.sigInfo ? new Map(r.sigInfo) : undefined });
  }
  return k;
};

// A snapshot as one stream: "FXSN", u32 version, u32 header length, header
// (JSON), u32 blob count, blob lengths (u32), blobs, then the memory runs'
// bytes (their places are in the header).
function writeSnapshot(snap, write) {
  const enc = new TextEncoder();
  const hdr = enc.encode(JSON.stringify(snap.header, (key, v) => big2s(v)));
  const u32 = (v) => new Uint8Array(new Uint32Array([v]).buffer);
  write(enc.encode('FXSN'));
  write(u32(1));
  write(u32(hdr.length));
  write(hdr);
  write(u32(snap.blobs.length));
  write(new Uint8Array(new Uint32Array(snap.blobs.map((b) => b.length)).buffer));
  let total = 0;
  for (const b of snap.blobs) { write(b); total += b.length; }
  for (let i = 0; i < snap.runs.length; i++) { const b = snap.bytes(i); write(b); total += b.length; }
  return total;
}
// read(n, into?) reads the next n bytes (into a view, when given).
function readSnapshot(read) {
  const u32 = () => new DataView(read(4).slice().buffer).getUint32(0, true);
  const magic = new TextDecoder().decode(read(4));
  if (magic !== 'FXSN' || u32() !== 1) throw new Error('not a snapshot');
  const header = JSON.parse(new TextDecoder().decode(read(u32())), reviver);
  const n = u32();
  const lens = new Uint32Array(read(4 * n).slice().buffer);
  const blobs = [];
  for (let i = 0; i < n; i++) blobs.push(read(lens[i]).slice());
  return {
    header,
    blob: (i) => blobs[i],
    loadRuns: (u8, runs) => { for (const [a, c] of runs) read(c * PAGE, u8.subarray(a, a + c * PAGE)); },
  };
}

module.exports = { writeSnapshot, readSnapshot };

};
defs['./vfs_web.js'] = function (module, exports, require) {
// Guest files in a page: an in-memory tree built from an index the host
// serves (every path with its type, mode, size and time; links with their
// targets), whose file contents are fetched on first use (a synchronous
// request from the kernel worker) and then kept. Writes stay in memory.
// Same interface as js/linux/vfs_node.js.
'use strict';

const { E, O, S_IF } = require('./abi.js');
const { KError } = require('./kernel.js');

const fail = (c) => { throw new KError(c); };
const SOCKET_MARK = 'fexwasm:socket';
const BIG_FILE = 64 << 10; // (bigger: read in ranges, not held; see pread: a game reads its data once)

class WebVfs {
  // index: [[path, type 'd'|'f'|'l', mode, size, mtimeMs, target?], ...]
  // fetchFile(path) -> Uint8Array (synchronous)
  constructor(index, fetchFile, uid, gid) {
    this.nodes = new Map();
    this.fetchFile = fetchFile;
    this.uid = uid;
    this.gid = gid;
    this.nextIno = 2n;
    this.fds = new Map();
    this.nextFd = 3;
    this.removed = new Set(); // paths of the index the guest removed or moved away (see save)
    this.fetched = { files: 0, ranges: 0, bytes: 0, ms: 0 };
    this.add('/', 'd', 0o755, 0, Date.now());
    for (const [p, type, mode, size, mtime, target] of index) this.add(p, type, mode, size, mtime, target);
  }
  add(p, type, mode, size, mtimeMs, target) {
    if (this.nodes.has(p)) return this.nodes.get(p);
    const parent = p === '/' ? null : p.slice(0, p.lastIndexOf('/')) || '/';
    if (parent && !this.nodes.has(parent)) this.add(parent, 'd', 0o755, 0, mtimeMs);
    const n = {
      type, mode: mode & 0o7777, size, ino: this.nextIno++, mtimeNs: BigInt(Math.floor(mtimeMs * 1e6)), target,
      data: type === 'f' && size === 0 ? new Uint8Array(0) : null, remote: type === 'f' && size > 0, children: type === 'd' ? new Set() : null, nlink: 1,
      src: p, // where its contents come from (it may be renamed before they are fetched)
    };
    this.nodes.set(p, n);
    if (parent) this.nodes.get(parent).children.add(p.slice(p.lastIndexOf('/') + 1));
    return n;
  }
  // The bytes of a file node (fetched once).
  bytes(p, n) {
    if (n.data === null && n.remote) {
      const t0 = performance.now();
      n.data = this.fetchFile(n.src || p);
      n.size = n.data.length;
      n.remote = false;
      this.fetched.files++;
      this.fetched.bytes += n.data.length;
      this.fetched.ms += performance.now() - t0;
    }
    return n.data || (n.data = new Uint8Array(0));
  }
  resolve(g, follow) {
    let parts = g.split('/').filter((x) => x && x !== '.');
    let out = [];
    for (let hops = 0, i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (part === '..') { out.pop(); continue; }
      const cur = '/' + [...out, part].join('/');
      const last = i === parts.length - 1;
      const n = this.nodes.get(cur);
      if ((last && !follow) || !n || n.type !== 'l' || n.target === SOCKET_MARK) { out.push(part); continue; }
      if (++hops > 40) fail(E.LOOP);
      let target = n.target;
      if (target.startsWith('/')) out = [];
      parts = [...target.split('/').filter((x) => x && x !== '.'), ...parts.slice(i + 1)];
      i = -1;
    }
    return '/' + out.join('/');
  }
  node(g, follow) {
    const r = this.resolve(g, follow);
    const n = this.nodes.get(r);
    if (!n) {
      const parent = r.slice(0, r.lastIndexOf('/')) || '/';
      const pn = this.nodes.get(parent);
      fail(pn && pn.type !== 'd' ? E.NOTDIR : E.NOENT);
    }
    return [r, n];
  }
  conv(n) {
    const mode = n.type === 'd' ? S_IF.DIR : n.type === 'l' ? (n.target === SOCKET_MARK ? S_IF.SOCK : S_IF.LNK) : S_IF.REG;
    const size = n.type === 'l' ? (n.target === SOCKET_MARK ? 0 : n.target.length) : n.type === 'd' ? 4096 : n.used ?? (n.data ? n.data.length : n.size);
    return {
      dev: 0x801n, ino: n.ino, mode: mode | n.mode, nlink: n.type === 'd' ? 2 : n.nlink, uid: this.uid, gid: this.gid, rdev: 0n,
      size: BigInt(size), blksize: 4096n, blocks: BigInt(Math.ceil(size / 512)), atimeNs: n.mtimeNs, mtimeNs: n.mtimeNs, ctimeNs: n.mtimeNs,
    };
  }
  stat(g, follow = true) {
    return this.conv(this.node(g, follow)[1]);
  }
  open(g, flags, mode) {
    let r = this.resolve(g, !(flags & O.NOFOLLOW));
    let n = this.nodes.get(r);
    if (n && (flags & O.CREAT) && (flags & O.EXCL)) fail(E.EXIST);
    if (!n) {
      if (!(flags & O.CREAT)) this.node(r, true); // ENOENT / ENOTDIR
      const parent = r.slice(0, r.lastIndexOf('/')) || '/';
      const pn = this.nodes.get(parent);
      if (!pn || pn.type !== 'd') fail(pn ? E.NOTDIR : E.NOENT);
      n = this.add(r, 'f', mode, 0, Date.now());
      n.data = new Uint8Array(0);
      n.dirty = true;
    }
    if (n.type === 'l' && n.target !== SOCKET_MARK) fail(E.LOOP);
    const isDir = n.type === 'd';
    if ((flags & O.DIRECTORY) && !isDir) fail(E.NOTDIR);
    if (isDir && (flags & O.ACCMODE) !== 0) fail(E.ISDIR);
    if ((flags & O.TRUNC) && !isDir && (flags & O.ACCMODE)) { n.data = new Uint8Array(0); n.remote = false; n.size = 0; n.used = undefined; n.dirty = true; }
    const fd = this.nextFd++;
    this.fds.set(fd, { n, path: r });
    return { fd, isDir, key: `web:${n.ino}`, path: r };
  }
  file(fd) {
    const f = this.fds.get(fd);
    if (!f) fail(E.BADF);
    return f;
  }
  pread(fd, buf, pos) {
    const f = this.file(fd);
    if (f.n.type === 'd') fail(E.ISDIR);
    // a big file the guest hasn't written (a game's data): just the bytes
    // asked for, each time (holding whole files would double the memory
    // they take in the guest), when the host can (fetchFile.range)
    const n = f.n;
    if (n.data === null && n.remote && n.size > BIG_FILE && this.fetchFile.range) {
      const len = Math.max(0, Math.min(buf.length, n.size - pos));
      if (len > 0) {
        const t0 = performance.now();
        this.fetchFile.range(n.src || f.path, pos, len, buf);
        this.fetched.ranges++;
        this.fetched.bytes += len;
        this.fetched.ms += performance.now() - t0;
      }
      return len;
    }
    const d = this.bytes(f.path, f.n);
    const len = Math.max(0, Math.min(buf.length, (f.n.used ?? d.length) - pos));
    if (len > 0) buf.set(d.subarray(pos, pos + len));
    return len;
  }
  pwrite(fd, buf, pos) {
    const f = this.file(fd);
    const d = this.bytes(f.path, f.n);
    const used = f.n.used ?? d.length;
    const end = pos + buf.length;
    if (end > d.length) {
      const nd = new Uint8Array(Math.max(end, d.length * 2, 4096));
      nd.set(d.subarray(0, used));
      f.n.data = nd;
    }
    f.n.data.set(buf, pos);
    f.n.used = Math.max(used, end);
    f.n.dirty = true; // (a snapshot keeps its contents; see save)
    f.n.mtimeNs = BigInt(Date.now()) * 1000000n;
    return buf.length;
  }
  fstat(fd) {
    const f = this.file(fd);
    const st = this.conv(f.n);
    if (f.n.used !== undefined) st.size = BigInt(f.n.used);
    return st;
  }
  close(fd) { this.fds.delete(fd); }
  // (files written through pwrite keep a capacity: data.length >= used)
  contents(n) {
    const d = n.data || new Uint8Array(0);
    return n.used !== undefined ? d.subarray(0, n.used) : d;
  }
  readdir(g) {
    const [r, n] = this.node(g, true);
    if (n.type !== 'd') fail(E.NOTDIR);
    return [...n.children].map((name) => {
      const c = this.nodes.get((r === '/' ? '' : r) + '/' + name);
      return { name, ino: c.ino, type: c.type === 'd' ? 4 : c.type === 'l' ? (c.target === SOCKET_MARK ? 12 : 10) : 8 };
    });
  }
  readlink(g) {
    const [, n] = this.node(g, false);
    if (n.type !== 'l' || n.target === SOCKET_MARK) fail(E.INVAL);
    return n.target;
  }
  readFile(g) {
    const [r, n] = this.node(g, true);
    if (n.type !== 'f') fail(n.type === 'd' ? E.ISDIR : E.INVAL);
    this.bytes(r, n);
    return this.contents(n);
  }
  detach(r) {
    const n = this.nodes.get(r);
    if (n && n.src === r) this.removed.add(r);
    const parent = r.slice(0, r.lastIndexOf('/')) || '/';
    const pn = this.nodes.get(parent);
    if (pn) pn.children.delete(r.slice(r.lastIndexOf('/') + 1));
    this.nodes.delete(r);
  }
  mkdir(g, mode) {
    const r = this.resolve(g, false);
    if (this.nodes.has(r)) fail(E.EXIST);
    const parent = r.slice(0, r.lastIndexOf('/')) || '/';
    const pn = this.nodes.get(parent);
    if (!pn) fail(E.NOENT);
    if (pn.type !== 'd') fail(E.NOTDIR);
    this.add(r, 'd', mode, 0, Date.now());
  }
  rmdir(g) {
    const [r, n] = this.node(g, false);
    if (n.type !== 'd') fail(E.NOTDIR);
    if (n.children.size) fail(E.NOTEMPTY);
    this.detach(r);
  }
  unlink(g) {
    const [r, n] = this.node(g, false);
    if (n.type === 'd') fail(E.ISDIR);
    this.detach(r);
  }
  rename(a, b) {
    const [ra, na] = this.node(a, false);
    const rb = this.resolve(b, false);
    const nb = this.nodes.get(rb);
    if (nb && nb.type === 'd' && na.type !== 'd') fail(E.ISDIR);
    if (nb && nb.type === 'd' && nb.children.size) fail(E.NOTEMPTY);
    if (nb) this.detach(rb);
    const parent = rb.slice(0, rb.lastIndexOf('/')) || '/';
    const pn = this.nodes.get(parent);
    if (!pn || pn.type !== 'd') fail(E.NOENT);
    // move the node and everything below it
    const moved = [...this.nodes.keys()].filter((k) => k === ra || k.startsWith(ra + '/'));
    this.detach(ra);
    for (const k of moved) {
      const n = k === ra ? na : this.nodes.get(k);
      if (k !== ra) this.nodes.delete(k);
      this.nodes.set(rb + k.slice(ra.length), n);
    }
    pn.children.add(rb.slice(rb.lastIndexOf('/') + 1));
  }
  link(a, b) {
    const [ra, na] = this.node(a, true);
    const rb = this.resolve(b, false);
    if (this.nodes.has(rb)) fail(E.EXIST);
    this.bytes(ra, na);
    na.nlink++;
    this.nodes.set(rb, na);
    const parent = rb.slice(0, rb.lastIndexOf('/')) || '/';
    this.nodes.get(parent).children.add(rb.slice(rb.lastIndexOf('/') + 1));
  }
  symlink(target, g) {
    const r = this.resolve(g, false);
    if (this.nodes.has(r)) fail(E.EXIST);
    this.add(r, 'l', 0o777, target.length, Date.now(), target);
  }
  chmod(g, mode) { this.node(g, true)[1].mode = mode & 0o7777; }
  truncate(g, len) {
    const [r, n] = this.node(g, true);
    this.bytes(r, n);
    this.resize(n, len);
  }
  ftruncate(fd, len) {
    const f = this.file(fd);
    this.bytes(f.path, f.n);
    this.resize(f.n, len);
  }
  resize(n, len) {
    const d = this.contents(n);
    const nd = new Uint8Array(len);
    nd.set(d.subarray(0, Math.min(len, d.length)));
    n.data = nd;
    n.used = undefined;
    n.dirty = true;
  }
  utimes(g, at, mt) {
    const [, n] = this.node(g, true);
    if (mt !== null && mt !== undefined) n.mtimeNs = BigInt(Math.floor(mt * 1e9));
  }
  tmpfile() {
    const n = { type: 'f', mode: 0o600, size: 0, ino: this.nextIno++, mtimeNs: BigInt(Date.now()) * 1000000n, data: new Uint8Array(0), nlink: 0, dirty: true };
    const fd = this.nextFd++;
    this.fds.set(fd, { n, path: null });
    return { fd };
  }
  mksock(g) {
    const r = this.resolve(g, false);
    if (this.nodes.has(r)) fail(E.ADDRINUSE);
    this.add(r, 'l', 0o777, 0, Date.now(), SOCKET_MARK);
  }
}

// For a snapshot (js/linux/snapshot.js): the tree and the open files.
// Contents the guest changed go into blobs (addBlob(bytes) -> index); the
// rest is fetched again when read.
WebVfs.prototype.save = function (addBlob) {
  const ids = new Map(), nodes = [];
  const idOf = (n) => {
    let id = ids.get(n);
    if (id !== undefined) return id;
    ids.set(n, (id = nodes.length));
    const keep = n.type === 'f' && n.data && (n.dirty || !n.src);
    nodes.push({
      type: n.type, mode: n.mode, size: n.size, ino: String(n.ino), mtimeNs: String(n.mtimeNs), target: n.target, nlink: n.nlink,
      src: n.src, used: keep ? n.used : undefined, children: n.children ? [...n.children] : null,
      data: keep ? addBlob(n.data) : n.type === 'f' && n.data && n.data.length === 0 ? -2 : -1, // -2: empty; -1: fetch it
      remote: n.type === 'f' && !keep && !(n.data && n.data.length === 0),
    });
    return id;
  };
  const paths = [...this.nodes].map(([p, n]) => [p, idOf(n)]);
  const fds = [...this.fds].map(([fd, f]) => [fd, idOf(f.n), f.path]);
  return { nodes, paths, fds, nextIno: String(this.nextIno), nextFd: this.nextFd, removed: [...this.removed] };
};
// index (optional): the host's files now. The guest's changes (what it
// wrote, made, moved or removed) go over them, so files the host got since
// the snapshot (a game installed) are there too; a file on both keeps its
// inode number.
WebVfs.load = function (state, blob, fetchFile, uid, gid, index) {
  if (index) return mergeLoad(state, blob, fetchFile, uid, gid, index);
  const v = new WebVfs([], fetchFile, uid, gid);
  v.nodes.clear();
  const objs = state.nodes.map((s) => ({
    type: s.type, mode: s.mode, size: s.size, ino: BigInt(s.ino), mtimeNs: BigInt(s.mtimeNs), target: s.target, nlink: s.nlink, src: s.src,
    used: s.used, children: s.children ? new Set(s.children) : null, remote: s.remote,
    data: s.data >= 0 ? blob(s.data) : s.data === -2 ? new Uint8Array(0) : null, dirty: s.data >= 0,
  }));
  for (const [p, id] of state.paths) v.nodes.set(p, objs[id]);
  for (const [fd, id, path] of state.fds) v.fds.set(fd, { n: objs[id], path });
  v.nextIno = BigInt(state.nextIno);
  v.nextFd = state.nextFd;
  for (const p of state.removed || []) v.removed.add(p);
  return v;
};

function mergeLoad(state, blob, fetchFile, uid, gid, index) {
  const v = new WebVfs(index, fetchFile, uid, gid);
  // (new inode numbers after the snapshot's; files on both get theirs back)
  let next = BigInt(state.nextIno);
  for (const n of v.nodes.values()) n.ino = next++;
  for (const p of state.removed || []) {
    if (v.nodes.has(p)) v.detach(p);
    v.removed.add(p);
  }
  const objs = state.nodes.map((s) => ({
    type: s.type, mode: s.mode, size: s.size, ino: BigInt(s.ino), mtimeNs: BigInt(s.mtimeNs), target: s.target, nlink: s.nlink, src: s.src,
    used: s.used, children: s.children ? new Set(s.children) : null, remote: s.remote,
    data: s.data >= 0 ? blob(s.data) : s.data === -2 ? new Uint8Array(0) : null, dirty: s.data >= 0,
  }));
  const chosen = new Map(); // snapshot node id -> the node object it is now
  const paths = [...state.paths].sort((a, b) => a[0].length - b[0].length); // (parents first)
  for (const [p, id] of paths) {
    const o = objs[id], have = v.nodes.get(p);
    const guestMade = o.dirty || !o.src || o.src !== p || o.type === 'l';
    if (have && have.type === o.type && !guestMade) {
      have.ino = o.ino; // the same file
      if (have.children && o.children) for (const c of o.children) have.children.add(c);
      chosen.set(id, have);
      continue;
    }
    if (have && have.type === 'd' && o.type === 'd') { // (a directory the guest made that the host has too)
      for (const c of o.children || []) have.children.add(c);
      chosen.set(id, have);
      continue;
    }
    const parent = p === '/' ? null : p.slice(0, p.lastIndexOf('/')) || '/';
    if (parent && !v.nodes.has(parent)) v.add(parent, 'd', 0o755, 0, Date.now());
    if (o.children && have && have.children) for (const c of have.children) o.children.add(c);
    v.nodes.set(p, chosen.get(id) || o);
    chosen.set(id, chosen.get(id) || o);
    if (parent) v.nodes.get(parent).children.add(p.slice(p.lastIndexOf('/') + 1));
  }
  for (const [fd, id, path] of state.fds) v.fds.set(fd, { n: chosen.get(id) || objs[id], path });
  v.nextIno = next > BigInt(state.nextIno) ? next : BigInt(state.nextIno);
  v.nextFd = state.nextFd;
  return v;
}

module.exports = { WebVfs };

};
const cache = {};
function require(name) {
  if (cache[name]) return cache[name].exports;
  if (!defs[name]) throw new Error('no module ' + name);
  const m = (cache[name] = { exports: {} });
  defs[name](m, m.exports, require);
  return m.exports;
}
G.LinuxBundle = { require };
})(self);
