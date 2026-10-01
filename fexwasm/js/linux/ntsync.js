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
