// The page side of the guest kernel: fetches the translator's configuration
// and the file index, starts the kernel worker, and a Web Worker for each
// guest thread it asks for. Everything it prints also goes to /log (the
// Mac harness, tools/webserve.js, keeps it).
//   linux.html?argv=["/opt/wine/bin/wine","cmd"]&env={"K":"V"}&timeout=60  (or argv=/opt/wine/bin/wine|cmd)
(function () {
  'use strict';

  const out = document.getElementById('out');
  const q = new URLSearchParams(location.search);
  const origin = location.origin;
  let pending = [];
  function log(s) {
    out.textContent += s + (s.endsWith('\n') ? '' : '\n');
    pending.push(s.endsWith('\n') ? s : s + '\n');
  }
  const resources=new FexPageResources();
  const startupRequests=new AbortController();
  resources.defer(()=>startupRequests.abort());
  const logTimer=resources.interval(flushLog, 250);
  let stopGuest=null;
  const closePage=()=>{if(stopGuest)stopGuest();else resources.close();};
  resources.on(window,'pagehide',closePage,{once:true});
  globalThis.betterjitClose=closePage;
  resources.defer(()=>{delete globalThis.betterjitClose;});
  function flushLog() {
    if (!pending.length) return;
    const body = pending.join('');
    pending = [];
    fetch(origin + '/log', { method: 'POST', body }).catch(() => {});
  }

  // Memory probe (probeWorkers=N): N workers like guest threads', 8 more
  // every 5 s, then 1000 instances of a unit-like module in each; the times
  // go to the log, for WebContent's footprint (the Mac's xctrace) to match.
  async function probeWorkers(n) {
    const t0 = performance.now(), at = () => ((performance.now() - t0) / 1000).toFixed(1);
    const mem = new WebAssembly.Memory({ initial: 16384, maximum: 65536, shared: true });
    const str = (x) => [x.length, ...[...x].map((c) => c.charCodeAt(0))];
    const sec = (id, b) => [id, b.length, ...b];
    // (import e.mem, e.tb; export run: 60 loads and stores off tb)
    const body = [0];
    for (let i = 0; i < 60; i++) body.push(0x23, 0, 0x23, 0, 0x28, 2, (i * 4) & 0x7f, 0x23, 0, 0x28, 2, 4, 0x6a, 0x36, 2, 8);
    body.push(0x41, 0, 0x0b);
    const len = (v) => { const o = []; do { let b = v & 127; v >>>= 7; if (v) b |= 128; o.push(b); } while (v); return o; };
    const code = [1, ...len(body.length), ...body];
    const bytes = new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, ...sec(1, [1, 0x60, 0, 1, 0x7f]),
      ...sec(2, [2, ...str('e'), ...str('mem'), 2, 3, 0x80, 0x80, 1, 0x80, 0x80, 4, ...str('e'), ...str('tb'), 3, 0x7f, 0]),
      ...sec(3, [1, 0]), ...sec(7, [1, ...str('run'), 0, 0]), 10, ...len(code.length), ...code]);
    const mod = await WebAssembly.compile(bytes);
    const workers = [];
    log(`[probe] ${at()} s: start`);
    while (workers.length < n) {
      for (let i = 0; i < 8 && workers.length < n; i++) {
        const w = new Worker('probe_worker.js');
        w.postMessage({ mem, mod, count: 1 });
        workers.push(w);
      }
      await new Promise((r) => setTimeout(r, 5000));
      log(`[probe] ${at()} s: ${workers.length} workers`);
    }
    for (const w of workers) w.postMessage({ mem, mod, count: 1000 });
    await new Promise((r) => setTimeout(r, 8000));
    log(`[probe] ${at()} s: ${workers.length} workers x 1001 instances`);
    await new Promise((r) => setTimeout(r, 5000));
    log(`[probe] ${at()} s: done`);
  }

  // Memory probe (probeModules=M): M distinct unit-sized modules (~5 KB of
  // wasm), compiled in 4 steps, then instantiated, then run until JSC tiers
  // them up; the times go to the log.
  async function probeModules(m) {
    const t0 = performance.now(), at = () => ((performance.now() - t0) / 1000).toFixed(1);
    const mem = new WebAssembly.Memory({ initial: 16384, maximum: 65536, shared: true });
    const str = (x) => [x.length, ...[...x].map((c) => c.charCodeAt(0))];
    const len = (v) => { const o = []; do { let b = v & 127; v >>>= 7; if (v) b |= 128; o.push(b); } while (v); return o; };
    const sec = (id, b) => [id, ...len(b.length), ...b];
    const make = (seed) => {
      const body = [0];
      for (let i = 0; i < 300; i++) body.push(0x23, 0, 0x23, 0, 0x28, 2, ...len((i * 4 + seed * 8) & 0xfff), 0x23, 0, 0x28, 2, 4, 0x6a, 0x36, 2, 8);
      body.push(0x41, ...len(seed & 0x3f), 0x0b);
      const code = [1, ...len(body.length), ...body];
      return new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, ...sec(1, [1, 0x60, 0, 1, 0x7f]),
        ...sec(2, [2, ...str('e'), ...str('mem'), 2, 3, 0x80, 0x80, 1, 0x80, 0x80, 4, ...str('e'), ...str('tb'), 3, 0x7f, 0]),
        ...sec(3, [1, 0]), ...sec(7, [1, ...str('run'), 0, 0]), ...sec(10, code)]);
    };
    const mods = [];
    let bytes = 0;
    log(`[probe] ${at()} s: start`);
    for (let step = 1; step <= 4; step++) {
      while (mods.length < (m * step) / 4) {
        const b = make(mods.length);
        bytes += b.length;
        mods.push(await WebAssembly.compile(b));
      }
      await new Promise((r) => setTimeout(r, 4000));
      log(`[probe] ${at()} s: ${mods.length} modules compiled (${(bytes / 1e6).toFixed(1)} MB of wasm)`);
    }
    const fns = mods.map((x) => new WebAssembly.Instance(x, { e: { mem, tb: 4096 } }).exports.run);
    await new Promise((r) => setTimeout(r, 4000));
    log(`[probe] ${at()} s: instantiated`);
    for (let k = 0; k < 4; k++) {
      for (const f of fns) for (let j = 0; j < 200; j++) f();
      await new Promise((r) => setTimeout(r, 3000));
      log(`[probe] ${at()} s: ran each ${200 * (k + 1)} times`);
    }
    log(`[probe] ${at()} s: done`);
  }

  // CPU probe (probeCpu=1): one integer loop, timed on the page's thread and
  // in 1, 2, 4, 6 workers at once: whether workers (the guest's threads) run
  // as fast as the page, i.e. on the performance cores.
  async function probeCpu() {
    // run(n): n rounds of an LCG, xor-shifts and a 4 KB table (local memory)
    const b = [0, 97, 115, 109, 1, 0, 0, 0, 1, 6, 1, 96, 1, 127, 1, 127, 3, 2, 1, 0, 5, 3, 1, 0, 1, 7, 7, 1, 3, 114, 117, 110, 0, 0, 10, 62, 1, 60, 1, 2, 127, 65, 1, 33, 1, 2, 64, 3, 64, 32, 2, 32, 0, 78, 13, 1, 32, 1, 65, 141, 204, 229, 0, 108, 65, 223, 230, 187, 227, 3, 106, 33, 1, 32, 1, 65, 252, 31, 113, 32, 1, 54, 2, 0, 32, 2, 65, 1, 106, 33, 2, 12, 0, 11, 11, 32, 1, 11];
    const mod = await WebAssembly.compile(new Uint8Array(b));
    const n = 200000000;
    const f = new WebAssembly.Instance(mod).exports.run;
    f(1000);
    let t0 = performance.now(); f(n);
    log(`[probe] page thread: ${((performance.now() - t0) * 1e6 / n).toFixed(2)} ns/round`);
    for (const k of [1, 2, 4, 6]) {
      const ws = [...Array(k)].map(() => new Worker('probe_worker.js'));
      const res = await Promise.all(ws.map((w) => new Promise((r) => { w.onmessage = (e) => r(e.data.ms); w.postMessage({ op: 'bench', mod, n }); })));
      ws.forEach((w) => w.terminate());
      log(`[probe] ${k} worker(s) at once: ${res.map((ms) => (ms * 1e6 / n).toFixed(2)).join(' ')} ns/round`);
    }
    log('[probe] done');
  }

  async function main() {
    if (q.get('probeCpu')) return probeCpu();
    if (q.get('probeModules')) return probeModules(Number(q.get('probeModules')));
    if (q.get('probeWorkers')) return probeWorkers(Number(q.get('probeWorkers')));
    if (!self.crossOriginIsolated) log('warning: not cross-origin isolated (no SharedArrayBuffer)');
    // argv: a JSON array, or a|b|c (the app's suite lists are comma-separated)
    const av = q.get('argv') || '["/test/hello-static"]';
    const argv = av.startsWith('[') ? JSON.parse(av) : av.split('|').map((a) => decodeURIComponent(a));
    const envObj = Object.assign({ HOME: '/home/user', USER: 'user', PATH: '/opt/wine/bin:/usr/bin:/bin', LANG: 'en_US.UTF-8',
      LD_LIBRARY_PATH: '/opt/wine/lib/wine/x86_64-unix' }, JSON.parse(q.get('env') || '{}'));
    const timeout = Number(q.get('timeout') || 0);
    const t0 = performance.now();
    const get = async (p) => {
      if(resources.closed)throw new Error('Page closed during startup');
      const r = await fetch(origin + p,{signal:startupRequests.signal});
      if (!r.ok) throw new Error(p + ' ' + r.status); return r;
    };
    const cfg = await (await get('/xlat/config?space=0')).json();
    const dispatcher = new Uint8Array(await (await get('/xlat/dispatcher?space=0')).arrayBuffer());
    const state = new Uint8Array(await (await get('/xlat/state?space=0')).arrayBuffer());
    await get('/xlat/drop?space=0');
    const index = await (await get('/fs/index')).json();
    if(resources.closed)return;
    log(`[page] engine ready: ${index.entries.length} files in the index, ${((performance.now() - t0)).toFixed(0)} ms`);

    // The guest's screen (display=WxH, 0: none): windows from Wine's display
    // driver, composed on a canvas; pointer and keys go back as input.
    const displaySize = q.get('display') ?? '1024x768';
    const [DW, DH] = displaySize === '0' ? [0, 0] : displaySize.split('x').map(Number);
    const screen = DW ? new FexCompositor.Compositor(DW, DH) : null;
    const canvas = document.getElementById('screen');
    if (q.get('ui') === 'screen') document.body.classList.add('screen'); // (the screen alone, as big as it fits)
    let input32 = null, drawn = -1;
    // Where each window's client area is on the page, for the app (/win):
    // a window DXMT presents to gets a Metal layer over it there
    const placed = new Map();
    const place = (m) => {
      if (!screen) return;
      if (m.op === 'destroy') {
        if (placed.delete(m.hwnd)) fetch(`${origin}/win?hwnd=${m.hwnd}&gone=1`).catch(() => {});
        return;
      }
      if (m.op !== 'frame') return;
      const r = canvas.getBoundingClientRect(), k = Math.min(r.width / DW, r.height / DH);
      const x0 = r.left + (r.width - DW * k) / 2, y0 = r.top + (r.height - DH * k) / 2, [cx, cy, cw, ch] = m.c;
      const at = `hwnd=${m.hwnd}&x=${(x0 + cx * k).toFixed(1)}&y=${(y0 + cy * k).toFixed(1)}&w=${(cw * k).toFixed(1)}&h=${(ch * k).toFixed(1)}&vis=${m.visible ? 1 : 0}`;
      if (placed.get(m.hwnd)?.at === at) return;
      placed.set(m.hwnd, { m, at });
      fetch(`${origin}/win?${at}`).catch(() => {});
    };
    resources.on(window,'resize', () => { for (const { m } of [...placed.values()]) { placed.delete(m.hwnd); place(m); } });
    if (screen) {
      canvas.width = DW;
      canvas.height = DH;
      const ctx = canvas.getContext('2d'), img = ctx.createImageData(DW, DH);
      const draw = () => {
        if (screen.frame !== drawn) {
          drawn = screen.frame;
          screen.compose(img.data);
          ctx.putImageData(img, 0, 0);
          canvas.classList.add('on');
        }
        resources.frame(draw);
      };
      resources.frame(draw);
      // input: {type 0 mouse (x, y, MOUSEEVENTF_ flags, wheel data) | 1 key (VK, KEYEVENTF_ flags)}
      const send = (type, x, y, flags, data) => {
        if (!input32 || !ksab) return;
        const w = Atomics.load(input32, 0), e = 2 + (((w % 256) + 256) % 256) * 5;
        input32.set([type, x | 0, y | 0, flags, data | 0], e);
        Atomics.store(input32, 0, (w + 1) | 0);
        const k32 = new Int32Array(ksab);
        Atomics.add(k32, 0, 1);
        Atomics.notify(k32, 0);
      };
      // (the picture is fitted into the canvas's box, letterboxed)
      const at = (e) => {
        const r = canvas.getBoundingClientRect(), k = Math.min(r.width / DW, r.height / DH);
        const x0 = r.left + (r.width - DW * k) / 2, y0 = r.top + (r.height - DH * k) / 2;
        return [Math.max(0, Math.min(DW - 1, Math.round((e.clientX - x0) / k))), Math.max(0, Math.min(DH - 1, Math.round((e.clientY - y0) / k)))];
      };
      const MOVE = 0x1, LDOWN = 0x2, LUP = 0x4, RDOWN = 0x8, RUP = 0x10, WHEEL = 0x800, KEYUP = 0x2;
      resources.on(canvas,'pointermove', (e) => send(0, ...at(e), MOVE, 0));
      resources.on(canvas,'pointerdown', (e) => { canvas.focus(); canvas.setPointerCapture(e.pointerId); send(0, ...at(e), MOVE | (e.button === 2 ? RDOWN : LDOWN), 0); e.preventDefault(); });
      resources.on(canvas,'pointerup', (e) => send(0, ...at(e), MOVE | (e.button === 2 ? RUP : LUP), 0));
      resources.on(canvas,'contextmenu', (e) => e.preventDefault());
      resources.on(canvas,'wheel', (e) => { send(0, ...at(e), WHEEL, e.deltaY > 0 ? -120 : 120); e.preventDefault(); }, { passive: false });
      const vk = (e) => {
        const c = e.code;
        if (/^Key[A-Z]$/.test(c)) return c.charCodeAt(3);
        if (/^Digit\d$/.test(c)) return c.charCodeAt(5);
        if (/^F\d+$/.test(c)) return 0x6f + Number(c.slice(1));
        return { Enter: 0x0d, Backspace: 0x08, Tab: 0x09, Escape: 0x1b, Space: 0x20, ArrowLeft: 0x25, ArrowUp: 0x26, ArrowRight: 0x27,
          ArrowDown: 0x28, ShiftLeft: 0x10, ShiftRight: 0x10, ControlLeft: 0x11, ControlRight: 0x11, AltLeft: 0x12, AltRight: 0x12,
          Delete: 0x2e, Home: 0x24, End: 0x23, PageUp: 0x21, PageDown: 0x22, Insert: 0x2d, Minus: 0xbd, Equal: 0xbb, Comma: 0xbc,
          Period: 0xbe, Slash: 0xbf, Semicolon: 0xba, Quote: 0xde, BracketLeft: 0xdb, BracketRight: 0xdd, Backslash: 0xdc, Backquote: 0xc0 }[c] || 0;
      };
      resources.on(canvas,'keydown', (e) => { const v = vk(e); if (v) { send(1, v, 0, 0, 0); e.preventDefault(); } });
      resources.on(canvas,'keyup', (e) => { const v = vk(e); if (v) { send(1, v, 0, KEYUP, 0); e.preventDefault(); } });
      // clicks=x.y.ms|...: taps at screen points, that many ms after the start (testing input)
      for (const c of (q.get('clicks') || '').split('|').filter(Boolean)) {
        const [x, y, ms] = c.split('.').map(Number);
        resources.timeout(() => { send(0, x, y, MOVE, 0); send(0, x, y, MOVE | LDOWN, 0); resources.timeout(() => send(0, x, y, MOVE | LUP, 0), 80); log(`[page] tap ${x},${y}`); }, ms);
      }
      // shot=S: a PNG of the screen after S seconds, to the host's /shot (the app keeps it in Documents)
      if (q.get('shot')) {
        resources.timeout(() => canvas.toBlob((b) => !resources.closed && fetch(`${origin}/shot?name=${encodeURIComponent(q.get('shotName') || 'shot')}`, { method: 'POST', body: b })
          .then(() => log('[page] screen saved')), 'image/png'), Number(q.get('shot')) * 1000);
      }
    }
    // Channels to the app (web/chan_web.js; the app maps their files):
    // chan=1: xlat (units for the threads). (Guest threads open their own GPU
    // channels: thread_web.js; gpuKind=echo: the app's echo, for timing.)
    const chan = (kind, extra, dataSize = 8 << 20) => {
      const mailbox = new SharedArrayBuffer(64), data = new SharedArrayBuffer(dataSize);
      const w = resources.worker(new Worker('chan_web.js'));
      w.onmessage = (e) => { if (e.data.op === 'log') log(e.data.m); };
      w.postMessage(Object.assign({ mailbox, data, origin, name: `${kind}-ring`, kind }, extra));
      return { mailbox, data };
    };
    // chan=1 also: kern (the kernel's guest files and code, in 16 MB pieces)
    const xlatChan = q.get('chan') === '1' ? chan('xlat') : null;
    const kernChan = q.get('chan') === '1' && q.get('kchan') !== '0' ? chan('kern', {}, 16 << 20) : null; // (kchan=0: not the kernel's)
    const bridge = new SharedArrayBuffer(16);
    const b32 = new Int32Array(bridge);
    const bootEpoch = performance.timeOrigin + performance.now() - 1e6;
    const threads = new FexGuestWorkers();
    let frames = 0;
    const slowWait = Number(q.get('slowWait') || 0);
    const units = FexLinuxThread.UnitCache(origin, undefined, Number(q.get('codeEpochMB') ?? 0) << 20); // (0: no epochs; they raised the peak: threads re-request their code faster than JSC frees the old)
    resources.defer(()=>units.close());
    let ksab = null;
    resources.defer(()=>{ksab=null;input32=null;placed.clear();if(screen){screen.windows.clear();screen.z=[];}canvas.width=0;canvas.height=0;});
    // (sample=1, with the translator's profrip=1: web/sampler.js)
    const sampler = q.get('sample') === '1' && cfg.profAddr ? resources.worker(new Worker('sampler.js')) : null;
    if (sampler) sampler.onmessage = (x) => { if (x.data.op === 'log') log(x.data.m); };
    // (every 10 s: how much code the page has compiled: most of WebContent's memory after the guest's)
    const statisticsTimer=resources.interval(() => log(`[page] units: ${units.stats.requests} requests, ${units.stats.compiled} modules compiled (${(units.stats.compiledBytes / 1e6).toFixed(1)} MB); page ${document.visibilityState}${document.hasFocus() ? ', focused' : ''}`), 10000);
    const kernel = resources.worker(new Worker('kworker_web.js'));
    let finished=false,guestTimer=null,stopTimer=null;
    const cleanup = () => {
      if(finished)return false;finished=true;
      stopGuest=null;
      clearInterval(logTimer);clearInterval(statisticsTimer);
      clearTimeout(guestTimer);clearTimeout(stopTimer);
      threads.close();resources.close();
      return true;
    };
    stopGuest=cleanup;
    const finish = (code) => {
      if(!cleanup())return;
      log(`[page] exit ${code} after ${(performance.now() - t0).toFixed(0)} ms`);
      flushLog();document.title = 'done ' + code;
    };
    kernel.onmessage = (e) => {
      const m = e.data;
      switch (m.op) {
        case 'ksab': ksab = m.ksab; input32 = m.inputSab ? new Int32Array(m.inputSab) : null; break;
        case 'display':
          if (screen) screen.message(m.msg);
          place(m.msg);
          // (timing) when the screen first shows something, and its 50th picture
          if (m.msg.op === 'present' && (++frames === 1 || frames === 50)) log(`[page] frame ${frames} at ${((performance.now() - t0) / 1000).toFixed(2)} s`);
          break;
        case 'spawn': {
          const w = new Worker('thread_web.js');
          const tid=m.tid,slot=m.slot,slotBuffer=m.ksab;
          if (sampler) {
            if (!sampler.started) { sampler.started = true; sampler.postMessage({ op: 'init', mem: m.mem, ksab: m.ksab, profAddr: cfg.profAddr }); }
            sampler.postMessage({ op: 'add', tid: m.tid, tb: m.tb, slot: m.slot });
          }
          const free = () => resources.timeout(() => Atomics.store(new Int32Array(slotBuffer), ((256 + slot * 128) >> 2) + 26, 0), 200);
          if(!threads.add(tid,w,free))break;
          w.onmessage = (x) => {
            if(!threads.has(w))return;
            const d = x.data;
            if (d.op === 'module') {
              // (slowWait: when a module is slow, whether it waited to get here or to compile)
              const got = performance.timeOrigin + performance.now(), bytes = d.code.length;
              units.module(d.key, d.code).then((module) => {
                if(!threads.has(w))return;
                const done = performance.timeOrigin + performance.now();
                if (slowWait && done - d.sent > slowWait) log(`[page] module for tid ${tid}: ${(got - d.sent).toFixed(0)} ms to arrive, ${(done - got).toFixed(0)} ms to compile (${bytes} bytes)`);
                threads.reply(w,{ op: 'unit', id: d.id, module, replied: performance.timeOrigin + performance.now() });
              },
                (err) => { if(!threads.has(w))return; log(`[page] module: ${err}`); threads.reply(w,{ op: 'unit', id: d.id }); });
            } else if (d.op === 'unit') {
              units.get(d.space, d.rip).then((r) => threads.reply(w,Object.assign({ op: 'unit', id: d.id }, r)),
                (err) => { if(!threads.has(w))return; log(`[page] unit 0x${d.rip.toString(16)}: ${err}`); threads.reply(w,{ op: 'unit', id: d.id }); });
            } else if (d.op === 'log') log(d.m);
            else if (d.op === 'done') { threads.dispose(w); if (sampler) sampler.postMessage({ op: 'remove', tid }); }
          };
          w.onerror = (err) => log(`[tid ${tid}] worker error: ${err.message}`);
          w.postMessage({ pid: m.pid, tid: m.tid, tb: m.tb, mem: m.mem, wx: m.wx, space: m.space, slot: m.slot, ksab: m.ksab, cfg, dispatcher, xlat: origin, gpuKind: q.get('gpuKind'), gpuStats: q.get('gpuStats') === '1', slowWait: Number(q.get('slowWait') || 0), threadStats: q.get('threadStats') === '1',
            xlatMailbox: xlatChan && xlatChan.mailbox, xlatData: xlatChan && xlatChan.data,
            bootEpoch: m.bootEpoch ?? bootEpoch,
            codeEpoch: units.epoch.buffer, kspinMs: Number(q.get('tspin') ?? 0.02), traceCode: q.get('traceCode') === '1', noRegions: q.get('regions') === '0', regionAfterMs: 1000 * Number(q.get('regionAfter') ?? 30) });
          break;
        }
        case 'kill': {
          threads.kill(m.tid);
          break;
        }
        case 'write': log(new TextDecoder().decode(m.bytes)); break;
        case 'log': log(m.m); break;
        case 'exit':
          log(`[page] units: ${units.stats.requests} requests, ${units.stats.compiled} modules compiled (${(units.stats.compiledBytes / 1e6).toFixed(1)} MB, ${units.stats.epochs} code epochs); translator ${Math.round(units.stats.fetchMs)} ms, compile waits ${Math.round(units.stats.compileMs)} ms`);
          if (m.byNr) log(`[page] ${m.syscalls} kernel syscalls; handlers ${m.handlerMs} ms, shared-memory sync ${m.syncMs} ms, idle ${m.idleMs} ms; files fetched ${m.fetched.files}, range reads ${m.fetched.ranges || 0} (${(m.fetched.bytes / 1e6).toFixed(1)} MB, ${m.fetched.ms.toFixed(0)} ms)`);
          finish(m.code);
          break;
      }
    };
    kernel.onerror = (err) => { log('kernel worker error: ' + err.message); finish(126); };
    kernel.postMessage({ cfg, state, index: index.entries, fsBase: origin, xlat: origin, kernChan, uid: index.uid, gid: index.gid, argv, cwd: q.get('cwd') || '/',
      standardIO:q.get('stdio') === 'captured' ? 'captured' : 'terminal',
      env: Object.entries(envObj).map(([k, v]) => `${k}=${v}`), bridge, bootEpoch, traceExec: q.get('traceExec') === '1', trace: q.get('trace') === '1', traceShm: q.get('traceShm') === '1',
      peek: q.get('peek'), win64: q.get('win64') ?? 'thumper_win10.exe,ucrtbase.dll,d3d11.dll,dxgi.dll', traceMaps: q.get('traceMaps') === '1', spinMs: Number(q.get('kspin') ?? 0.05), traceCode: q.get('traceCode') === '1', sharedSpace: q.get('shared') !== '0', memLog: Number(q.get('memLog') || 0), display: screen ? displaySize : null,
      // a saved system (in OPFS): snapshot=name&snapshotAt=S[&snapshotExit=1] saves one; restore=name[&run=a|b|c] starts from it
      snapshot: q.get('snapshot'), snapshotAt: Number(q.get('snapshotAt') || 30), snapshotExit: q.get('snapshotExit') === '1',
      restore: q.get('restore'), run: q.get('run') ? q.get('run').split('|').map((a) => decodeURIComponent(a)) : null, auto: q.get('auto') });
    if (timeout) guestTimer=resources.timeout(() => {
      log(`[page] timeout after ${timeout} s; units: ${units.stats.requests} requests, ${units.stats.compiled} modules compiled; ` +
        `translator ${Math.round(units.stats.fetchMs)} ms, compile waits ${Math.round(units.stats.compileMs)} ms; threads:`);
      Atomics.store(b32, 2, 1);
      stopTimer=resources.timeout(() => finish(124), 1500);
    }, timeout * 1000);
  }
  // (the app waits for "[page] exit")
  main().catch((e) => { const wasClosed=resources.closed;closePage();if(wasClosed)return;clearInterval(logTimer); log('[page] ' + (e.stack || e)); log('[page] exit 127'); flushLog(); document.title = 'failed'; });
})();
