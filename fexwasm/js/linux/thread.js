// A guest thread's worker on Node (tools/linuxrun.js): js/linux/thread_core.js.
'use strict';

const { workerData, parentPort, threadId } = require('worker_threads');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
for (const f of ['../runtime.js', 'thread_core.js']) vm.runInThisContext(fs.readFileSync(path.join(__dirname, f), 'utf8'));

// Units come from the main thread, compiled once for every worker (see UnitCache).
const pending = new Map();
let nextId = 1;
parentPort.on('message', (m) => {
  if (m.op !== 'unit') return;
  const res = pending.get(m.id);
  pending.delete(m.id);
  res(m.module ? m : null);
});
FexLinuxThread.runThread({
  data: workerData,
  post: (m) => parentPort.postMessage(m),
  unitBroker: (space, rip) => new Promise((res) => {
    const id = nextId++;
    pending.set(id, res);
    parentPort.postMessage({ op: 'unit', id, space, rip });
  }),
  threadMap: process.env.FEXWASM_THREADMAP ? threadId : 0,
  dumpDir: process.env.FEXWASM_DUMP_TRAPS,
  dump: (name, b) => fs.writeFileSync(path.join(process.env.FEXWASM_DUMP_TRAPS, name), b),
});
