// The kernel worker on Node (tools/linuxrun.js starts it): the kernel's loop,
// with the host services it needs from the main thread (thread workers,
// translator requests, the console) passed as messages. Translator requests
// that must finish before the syscall returns wait on a shared word.
'use strict';

const { workerData, parentPort } = require('worker_threads');
const { Kernel } = require('./kernel.js');
require('./syscalls.js');
require('./snapshot.js');
const { NodeVfs } = require('./vfs_node.js');
const { WebVfs } = require('./vfs_web.js');
const { writeSnapshot, readSnapshot } = require('./snapshot.js');
const fs = require('fs');
const linuxMounts = require('../../tools/linuxmounts.js');
// FEXWASM_WEBVFS=1: the page's in-memory file system (writes stay in memory),
// as snapshots need; FEXWASM_SNAPSHOT=file with FEXWASM_SNAPSHOT_AT=seconds:
// save the system then (FEXWASM_SNAPSHOT_EXIT=1: and stop); FEXWASM_RESTORE=file:
// start from a saved system instead of argv.
const E = process.env;
const webVfs = () => new WebVfs(linuxMounts.index(mounts).entries, (p) => new Uint8Array(fs.readFileSync(linuxMounts.hostOf(mounts, p))),
  process.getuid(), process.getgid());

const { cfg, state, mounts, argv, env, bridge, cwd, trace, bootEpoch, traceExec, display } = workerData;
const b32 = new Int32Array(bridge);
function call(msg, transfer) {
  Atomics.store(b32, 0, 0);
  parentPort.postMessage(msg, transfer || []);
  while (Atomics.load(b32, 0) === 0) Atomics.wait(b32, 0, 0);
  return b32[1];
}

let kernel;
const host = {
  vfs: E.FEXWASM_RESTORE ? null : E.FEXWASM_WEBVFS || E.FEXWASM_SNAPSHOT ? webVfs() : new NodeVfs(mounts),
  loadVfs: (state, blob) => WebVfs.load(state, blob, (p) => new Uint8Array(fs.readFileSync(linuxMounts.hostOf(mounts, p))), process.getuid(),
    process.getgid(), linuxMounts.index(mounts).entries), // (with the host's files as they are now)
  state: new Uint8Array(state),
  uid: process.getuid(),
  gid: process.getgid(),
  cpus: 4,
  cwd,
  trace,
  traceExec,
  peek: process.env.FEXWASM_PEEK,
  dumpStacks: !!process.env.FEXWASM_DUMPSTACKS,
  traceSig: !!process.env.FEXWASM_TRACESIG,
  win64: process.env.FEXWASM_WIN64,
  traceShm: !!process.env.FEXWASM_SHMTRACE,
  sharedSpace: !process.env.FEXWASM_SEPARATE, // every process in one memory
  memLog: Number(process.env.FEXWASM_MEMLOG || 0),
  freezeTest: Number(process.env.FEXWASM_FREEZETEST || 0),
  // (display: the guest's windows go to the main thread's compositor)
  display: display ? (msg, transfer) => parentPort.postMessage({ op: 'display', msg }, transfer || []) : null,
  displaySize: display,
  traceInput: !!process.env.FEXWASM_TRACEINPUT,
  spawnThread: (info) => parentPort.postMessage(Object.assign({ op: 'spawn' }, info)),
  killThread: (tid) => parentPort.postMessage({ op: 'kill', tid }),
  code: (space, addr, bytes, abi = 0) => call({ op: 'code', space, addr, bytes, abi }, [bytes.buffer]),
  uncode: (space, addr, size) => call({ op: 'uncode', space, addr, size }),
  dropSpace: (space) => call({ op: 'drop', space }),
  write: (fd, bytes) => parentPort.postMessage({ op: 'write', fd, bytes }, [bytes.buffer]),
  exit: (code, k) => {
    k.done = true;
    const byNr = [...k.stats.byNr].sort((a, b) => b[1] - a[1]).slice(0, 12);
    const msByNr = [...k.stats.msByNr].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([n, ms]) => [n, Math.round(ms)]);
    parentPort.postMessage({ op: 'exit', code, memInfo: k.memInfo(), syscalls: k.stats.syscalls, byNr, msByNr, syncMs: Math.round(k.stats.syncMs), handlerMs: Math.round(k.stats.handlerMs), idleMs: Math.round(k.stats.idleMs) });
  },
  log: (m) => parentPort.postMessage({ op: 'log', m }),
};
function snapshotLater(k) {
  k.addTimer(Number(E.FEXWASM_SNAPSHOT_AT || 30) * 1000, () => {
    const t0 = performance.now();
    k.freeze(5000, (err) => {
      if (err) return k.log(`[snapshot] no: ${err}`);
      const t1 = performance.now();
      const snap = k.snapshot();
      const fd = fs.openSync(E.FEXWASM_SNAPSHOT, 'w');
      const bytes = writeSnapshot(snap, (b) => fs.writeSync(fd, b));
      fs.closeSync(fd);
      k.log(`[snapshot] ${k.threads.size} threads frozen in ${(t1 - t0).toFixed(0)} ms; saved ${(fs.statSync(E.FEXWASM_SNAPSHOT).size / 1e6).toFixed(1)} MB ` +
        `(${snap.header.memory.pages} memory pages, ${(bytes / 1e6).toFixed(1)} MB of data) in ${(performance.now() - t1).toFixed(0)} ms`);
      if (E.FEXWASM_SNAPSHOT_EXIT) return host.exit(0, k);
      k.thaw();
    });
  });
}
function restore() {
  const t0 = performance.now();
  const fd = fs.openSync(E.FEXWASM_RESTORE, 'r');
  let pos = 0;
  const read = (n, into) => {
    const b = into || new Uint8Array(n);
    for (let o = 0; o < n;) o += fs.readSync(fd, b, o, n - o, pos + o);
    pos += n;
    return b;
  };
  const snap = readSnapshot(read);
  const k = Kernel.restore(host, cfg, snap);
  fs.closeSync(fd);
  k.log(`[restore] ${k.procs.size} processes, ${k.threads.size} threads in ${(performance.now() - t0).toFixed(0)} ms`);
  // FEXWASM_RESTORE_RUN='["prog", "arg", ...]': a program to start in the restored system (with argv's environment)
  if (E.FEXWASM_RESTORE_RUN) {
    const run = JSON.parse(E.FEXWASM_RESTORE_RUN);
    k.spawnInit(run[0], run, k.wineEnv(env));
  }
  return k;
}
try {
  if (E.FEXWASM_RESTORE) {
    kernel = restore();
  } else {
    kernel = new Kernel(host, cfg);
    kernel.bootEpoch = bootEpoch;
    if (E.FEXWASM_SNAPSHOT) snapshotLater(kernel);
    kernel.boot(argv, env);
  }
  // the main thread asks for a dump of all threads through a flag (the loop can't take messages)
  kernel.dumpFlag = new Int32Array(bridge, 8, 1);
  parentPort.postMessage({ op: 'input', ksab: kernel.ksab, inputSab: kernel.inputSab }); // (for the display's input)
  kernel.run();
} catch (e) {
  parentPort.postMessage({ op: 'log', m: 'kernel: ' + (e.stack || e) });
  parentPort.postMessage({ op: 'exit', code: 127 });
}
