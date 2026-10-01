// A guest-thread worker for the fexthreads suite (see fexthreads.js): runs
// guest threads on the shared memory until told to quit. Its code comes
// from the dump in `dir`, or with `shared` from the page, which compiles each
// module once for all workers (they then share the compiled code).
importScripts('fexruntime.js', 'fexthreads.js');
onmessage = async (e) => {
  const { mem, slot, threads, dir, shared } = e.data;
  const get = async (f) => new Uint8Array(await (await fetch(dir + '/' + f)).arrayBuffer());
  const cfg = await (await fetch(dir + '/config.json')).json();
  const [dispatcher, state] = await Promise.all(['dispatcher.wasm', 'state.bin'].map(get));
  let code;
  if (shared) {
    const req = FexThreads.requester((m) => postMessage(m));
    onmessage = (r) => req.onReply(r.data);
    code = { request: req.request };
  } else {
    const [ub, rb] = await Promise.all(['units.bin', 'regions.bin'].map(get));
    code = { units: FexThreads.parseUnits(ub), regions: FexThreads.parseRegions(rb) };
  }
  try {
    await FexThreads.workerLoop({ mem, slot, threads, cfg, ...code, dispatcher, state, now: () => performance.now(), post: (m) => postMessage(m) });
  } catch (err) {
    postMessage({ error: String(err && err.stack || err), slot });
  }
};
