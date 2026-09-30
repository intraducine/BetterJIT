self.onmessage = async ({data}) => {
  try {
    if (data?.kind === 'atomics') {
      const view = new Int32Array(data.buffer);
      for (let i = 0; i < data.iterations; i++) Atomics.add(view, 0, 1);
      postMessage({ok:true,value:Atomics.load(view,0)});
      return;
    }
    if (data?.kind === 'module') {
      const instance = await WebAssembly.instantiate(data.module, {});
      postMessage({ok:true,value:instance.exports.run()});
      return;
    }
    postMessage({ok:false,error:'unknown'});
  } catch {
    postMessage({ok:false,error:'worker-failed'});
  }
};
