// Memory probe (linux_main.js probeWorkers): a worker like a guest thread's
// (the same scripts), holding what it is sent: instances of a module that
// imports the shared memory, as units do.
'use strict';
importScripts('../../runtime.js', '../thread_core.js', 'chan_file.js');
const held = [];
onmessage = (e) => {
  if (e.data.op === 'bench') { // (linux_main.js probeCpu: the same loop timed here)
    const f = new WebAssembly.Instance(e.data.mod).exports.run;
    f(1000);
    const t0 = performance.now();
    const r = f(e.data.n);
    postMessage({ op: 'bench', ms: performance.now() - t0, r });
    return;
  }
  const { mem, mod, count } = e.data;
  for (let i = 0; i < count; i++) held.push(new WebAssembly.Instance(mod, { e: { mem, tb: 0 } }).exports.run);
  postMessage({ op: 'held', n: held.length });
};
