// A guest thread's Web Worker: js/linux/thread_core.js.
'use strict';

importScripts('../../runtime.js', '../thread_core.js', 'chan_file.js');

// This thread's GPU channel (DXMT's calls), opened on its first: a file of
// its own, since calls block (for the GPU, a drawable) and some belong to
// their native thread, which the app gives each file.
const gpuOpen = (tid, origin, kind) => openChanFile(`gpu-${tid}`, kind || 'gpu', origin);

// Units come from the page, compiled once for every worker (see UnitCache).
const pending = new Map();
let nextId = 1;
const unitBroker = (space, rip) => new Promise((res) => {
  const id = nextId++;
  pending.set(id, res);
  postMessage({ op: 'unit', id, space, rip });
});
// (with the translator's channel: the worker has the bytes, the page the module)
// (a timer runs while a reply is due: the page's reply otherwise sometimes
// waited a second to be seen, though here in time -- the worker's run loop
// sleeping until its next timer)
let waiting = 0, nudge = null;
const due = (on) => {
  waiting += on ? 1 : -1;
  if (waiting && !nudge) nudge = setInterval(() => {}, 4);
  else if (!waiting && nudge) { clearInterval(nudge); nudge = null; }
};
const moduleFor = (key, code) => new Promise((res) => {
  const id = nextId++;
  due(true);
  pending.set(id, (m) => { due(false); res(m && m.module); });
  postMessage({ op: 'module', id, key, code, sent: performance.timeOrigin + performance.now() }, [code.buffer]);
});
onmessage = (e) => {
  if (e.data.op === 'unit') {
    // (a reply that took long to get here)
    if (e.data.replied && performance.timeOrigin + performance.now() - e.data.replied > 100)
      postMessage({ op: 'log', m: `[worker] a module's reply took ${(performance.timeOrigin + performance.now() - e.data.replied).toFixed(0)} ms to arrive` });
    const res = pending.get(e.data.id);
    pending.delete(e.data.id);
    res(e.data.module ? e.data : null);
    return;
  }
  FexLinuxThread.runThread({ data: e.data, post: (m) => postMessage(m), unitBroker, moduleFor, gpuOpen }).then(
    () => postMessage({ op: 'done' }),
    (err) => { postMessage({ op: 'log', m: `[tid ${e.data.tid}] ${err && err.stack ? err.stack : err}` }); postMessage({ op: 'done' }); });
};
