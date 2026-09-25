'use strict';
(() => {
  const base = new URL('.', location.href).href.replace(/\/$/, '');
  let busy = false;
  const emit = record => {
    const text = JSON.stringify(record);
    window.webkit.messageHandlers.betterjitLab.postMessage(text);
    const output = document.getElementById('results');
    output.textContent += text + '\n';
  };
  async function localFetch(url, init = {}) {
    const target = new URL(url, base + '/');
    if (target.origin !== location.origin || !target.href.startsWith(base + '/')) throw new Error('Non-local request rejected');
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 20000);
    try {
      const response = await fetch(target.href, { ...init, signal: abort.signal });
      if (!response.ok) throw new Error(`Lab request failed: HTTP ${response.status}`);
      return response;
    } finally { clearTimeout(timer); }
  }
  async function run(directory) {
    if (busy) throw new Error('A test is already running');
    if (!['fex', 'fexw64'].includes(directory)) throw new Error('Unknown bundled fixture');
    busy = true;
    let checked = 0, failures = 0;
    document.getElementById('results').textContent = '';
    try {
      if (typeof WebAssembly.Suspending !== 'function' || typeof WebAssembly.promising !== 'function')
        throw new Error('This WebKit does not expose JSPI required by the imported FEX live runtime');
      const dump = await (await localFetch(base + '/' + directory + '/config.json')).json();
      await localFetch(base + '/xlat/init?dir=' + directory);
      const live = await FexLive.connect(base, localFetch, null);
      const cfg = live.cfg;
      if (!Number.isInteger(cfg.memPages) || cfg.memPages < 1 || cfg.memPages > 8192)
        throw new Error('Unexpected fixture memory size');
      const memory = new WebAssembly.Memory({ initial: cfg.memPages, maximum: cfg.memPages, shared: !!cfg.shared });
      const image = new Uint8Array(await (await localFetch(base + '/' + directory + '/image.bin')).arrayBuffer());
      new Uint8Array(memory.buffer).set(image, cfg.imageLow);
      const runtime = live.runtime(memory);
      emit({ suite: 'environment', secureContext: isSecureContext, crossOriginIsolated,
             transport: 'loopback-http', gameBackendChanged: false, guestABI: directory });
      for (const kernel of dump.kernels) {
        const warmN = Math.max(1, Math.floor((kernel.n & 0xffffff) / 10)) | (kernel.n & ~0xffffff);
        let start = performance.now();
        await live.call(runtime, memory, kernel.entry, warmN);
        const warmMs = performance.now() - start;
        start = performance.now();
        const checksum = await live.call(runtime, memory, kernel.entry, kernel.n);
        const elapsedMs = performance.now() - start;
        const match = checksum === kernel.chk;
        checked++; if (!match) failures++;
        emit({ suite: 'fex-live', kernel: kernel.name, warmMs, elapsedMs, checksum, expected: kernel.chk, match });
      }
      emit({ suite: 'translator', ...(await live.translatorStats()), client: live.stats });
      const report = { suite: 'summary', checked, failures, passed: checked === dump.kernels.length && checked > 0 && failures === 0 };
      emit(report);
      return report;
    } catch (error) {
      emit({ suite: 'error', message: String(error).replaceAll(base, '<local-lab>') });
      return { checked, failures: failures + 1, passed: false };
    } finally { busy = false; }
  }
  globalThis.BetterJITLab = { run };
})();
