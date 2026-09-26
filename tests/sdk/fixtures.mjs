// Small deterministic Wasm fixtures, emitted here rather than shipping opaque binaries.
const text = s => [...new TextEncoder().encode(s)];
export const leb = n => { const out = []; do { let b = n & 127; n >>>= 7; if (n) b |= 128; out.push(b); } while (n); return out; };
const str = s => [...leb(text(s).length), ...text(s)];
const vec = xs => [...leb(xs.length), ...xs.flat()];
const sec = (id, body) => [id, ...leb(body.length), ...body];
const sig = (params, results) => [0x60, ...vec(params), ...vec(results)];
export function moduleBytes({params=[0x7f,0x7f], results=[0x7f], code=[0x20,0,0x20,1,0x6a], memory=false, privateMemory=false, call=false, badImport=false}={}) {
  const imports = [];
  if (memory) imports.push([...str('betterjit'), ...str('memory'), 2, 0, 1]);
  if (call) imports.push([...str(badImport ? 'danger' : 'betterjit'), ...str('call'), 0, 0]);
  const body = [0, ...code, 0x0b];
  return new Uint8Array([0,97,115,109,1,0,0,0,
    ...sec(1, vec(call ? [sig([0x7f,0x7f,0x7f,0x7f,0x7f],[0x7f]),sig(params,results)] : [sig(params,results)])),
    ...(imports.length ? sec(2, vec(imports)) : []),
    ...sec(3, vec([[call ? 1 : 0]])),
    ...(privateMemory ? sec(5, vec([[0,1]])) : []),
    ...sec(7, vec([[...str('run'),0,call ? 1 : 0]])),
    ...sec(10, vec([[...leb(body.length), ...body]]))]);
}
export const limits = {initialMemoryPages:16,maximumMemoryPages:4096,maximumModuleBytes:8*1024*1024,maximumModules:16,maximumTransferBytes:1024*1024,maximumPendingRequests:8,timeoutSeconds:2};
