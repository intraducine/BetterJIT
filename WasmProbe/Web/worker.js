// Worker side of the "synchronous call" tests.
function stats(arr) {
  const a = arr.slice().sort((x, y) => x - y), sum = a.reduce((p, c) => p + c, 0);
  const q = (f) => a[Math.min(a.length - 1, Math.floor(a.length * f))];
  return { n: a.length, avg: sum / a.length, min: a[0], p50: q(0.5), p90: q(0.9), p99: q(0.99), max: a[a.length - 1] };
}
onmessage = (e) => {
  const d = e.data;
  try {
    if (d.test === 'syncxhr') {
      const lat = [];
      for (let i = 0; i < d.n; i++) {
        const t = performance.now();
        const x = new XMLHttpRequest(); x.open('POST', 'rpc', false); x.send('x');
        if (x.status !== 200) throw new Error('status ' + x.status);
        lat.push((performance.now() - t) * 1000);
      }
      postMessage(stats(lat));
    } else if (d.test === 'syncxhr-bulk') {
      const out = {};
      for (const size of [1 << 20, 8 << 20]) {
        const t = performance.now();
        const x = new XMLHttpRequest(); x.open('GET', 'blob?n=' + size, false); x.responseType = 'arraybuffer'; x.send();
        const ms = performance.now() - t;
        out['get_' + size] = { ms, got: x.response ? x.response.byteLength : -1, MBps: (size / 1048576) / (ms / 1000) };
        const body = new Uint8Array(size);
        const t2 = performance.now();
        const y = new XMLHttpRequest(); y.open('POST', 'sink', false); y.send(body);
        const ms2 = performance.now() - t2;
        out['post_' + size] = { ms: ms2, native: y.responseText, MBps: (size / 1048576) / (ms2 / 1000) };
      }
      postMessage(out);
    } else if (d.test === 'kernel') {
      // Instantiate bench.wasm in this worker and run one kernel; report wall time.
      const inst = new WebAssembly.Instance(new WebAssembly.Module(d.bytes), {});
      inst.exports['k_' + d.kernel](1000);
      const t = performance.now();
      const chk = inst.exports['k_' + d.kernel](d.n) >>> 0;
      postMessage({ ms: performance.now() - t, chk, start: t + performance.timeOrigin });
    } else if (d.test === 'atomics') {
      const i32 = new Int32Array(d.sab), lat = [];
      for (let i = 0; i < d.n; i++) {
        const t = performance.now();
        Atomics.store(i32, 0, 0);
        postMessage({ req: i, native: d.native });
        Atomics.wait(i32, 0, 0, 5000);
        lat.push((performance.now() - t) * 1000);
      }
      postMessage(stats(lat));
    }
  } catch (err) {
    postMessage({ error: String(err) });
  }
};
