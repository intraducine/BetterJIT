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
